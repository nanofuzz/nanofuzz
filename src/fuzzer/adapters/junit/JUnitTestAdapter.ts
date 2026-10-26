import * as Config from "../../../Config";
import { FuzzTests } from "../../Types";
import * as ValueMapper from "../../mappers/ValueMapper";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import { AbstractProgram } from "../../analysis/AbstractProgram";
import { JavaProgram } from "../../analysis/java/JavaProgram";
import { FunctionDef } from "../../analysis/FunctionDef";
import { ArgDef } from "../../analysis/ArgDef";
import * as os from "os";
import * as path from "path";
import * as Parser from "../ParserAdapter";
import { AbstractTestAdapter } from "../AbstractTestAdapter";

export class JUnitTestAdapter extends AbstractTestAdapter {
  protected _testSet: FuzzTests;
  protected _module: string;
  protected _outputFilename?: string;

  constructor(testSet: FuzzTests, module: string, outputFilename?: string) {
    super();
    this._testSet = testSet;
    this._module = module;
    this._outputFilename = outputFilename;
  } // constructor

  /**
   * Returns the name of the tool that uses the generated tests
   */
  public get toolname(): string {
    return "JUnit";
  } // get: toolname

  /**
   * Returns the filename where JUnit/Java tests are persisted.
   */
  public get filename(): string {
    if (this._outputFilename) {
      return this._outputFilename;
    }
    const ext = path.extname(this._module);
    const base = ext ? this._module.slice(0, -ext.length) : this._module;
    return `${base}NanoTest.java`;
  } // get: filename

  /**
   * Converts a set of NaNofuzz saved tests into a JUnit 5 unit test suite.
   *
   * @returns string containing the Java JUnit test class
   */
  public toString(): string {
    const javaData: string[] = [];
    const baseClassName = path.basename(this._module, ".java");
    const testClassName = this._outputFilename
      ? path.basename(this._outputFilename, ".java")
      : `${baseClassName}NanoTest`;

    let pgm: AbstractProgram | undefined;
    try {
      pgm = ProgramFactory.fromFile(this._module, "java");
    } catch {
      // ignore if AST parsing fails
    }

    const javaPgm = pgm instanceof JavaProgram ? pgm : undefined;
    const sourcePackageName = javaPgm ? javaPgm.getPackageName() : "";
    const packageName = this._outputFilename
      ? inferPackageFromOutputPath(this._outputFilename, sourcePackageName)
      : sourcePackageName;
    const fqSourceClass =
      sourcePackageName && sourcePackageName !== packageName
        ? `${sourcePackageName}.${baseClassName}`
        : baseClassName;

    // Header comment
    javaData.push(
      `//`,
      `//              * * * DO NOT MODIFY * * *`,
      `//`,
      `// This file is auto-generated and maintained by ${nanofuzzName}.`,
      `// ${nanofuzzName} will overwrite changes made to this file.`,
      `//`,
      `// ${nanofuzzName} test file version: ${this._testSet.version}`,
      `//`
    );

    if (packageName) {
      javaData.push(`package ${packageName};`, ``);
    }

    // Imports
    javaData.push(
      `import org.junit.jupiter.api.Test;`,
      `import static org.junit.jupiter.api.Assertions.*;`,
      `import com.nanofuzz.runtime.FuzzTestResult;`,
      `import com.nanofuzz.runtime.ValidatorResult;`,
      `import com.nanofuzz.runtime.ImplicitOracle;`,
      `import java.util.Arrays;`,
      `import java.util.List;`,
      ``,
      `@SuppressWarnings("all")`,
      `public class ${testClassName} {`,
      ``
    );

    for (const fn in this._testSet.functions) {
      const thisFn = this._testSet.functions[fn];

      let argDefs: ArgDef[] = [];
      let returnArg: ArgDef | undefined;
      const fnObj: FunctionDef | undefined = pgm?.functions[fn];

      try {
        if (fnObj) {
          argDefs = fnObj.getArgDefs();
          returnArg = fnObj.getReturnArg();
        }
      } catch {
        // ignore if AST parsing fails
      }

      const isStatic = isMethodStatic(fnObj);
      const rawMethodName = getRawMethodName(fn, fnObj);
      const targetCallClass = fqSourceClass;

      let i = -1;
      for (const testId in thisFn.tests) {
        const thisTest = thisFn.tests[testId];
        if (!thisTest.pinned) {
          continue;
        }
        i++;

        const inputStr = thisTest.input
          .map((e, idx) => ValueMapper.toLang("java", e.value, argDefs[idx]))
          .join(", ");

        const callStr = isStatic
          ? `${targetCallClass}.${rawMethodName}(${inputStr})`
          : `new ${targetCallClass}().${rawMethodName}(${inputStr})`;

        // Human expected output
        const expectedOutput = thisTest.expectedOutput;
        if (
          thisFn.options.useHuman &&
          expectedOutput &&
          expectedOutput.length
        ) {
          if (expectedOutput[0].isTimeout) {
            console.error(
              `Expected timeouts not currently supported in ${this.toolname} format`
            );
          } else if (expectedOutput[0].isException) {
            javaData.push(
              `    @Test`,
              `    void test_${fn}_${i}_expect() {`,
              `        assertThrows(Throwable.class, () -> {`,
              `            ${callStr};`,
              `        });`,
              `    }`,
              ``
            );
          } else if (thisFn.isVoid) {
            javaData.push(
              `    @Test`,
              `    void test_${fn}_${i}_expect() {`,
              `        ${callStr};`,
              `    }`,
              ``
            );
          } else if (
            typeof expectedOutput[0].value === "number" &&
            Number.isNaN(expectedOutput[0].value)
          ) {
            javaData.push(
              `    @Test`,
              `    void test_${fn}_${i}_expect() {`,
              `        var actual = ${callStr};`,
              `        assertTrue(Double.isNaN(actual));`,
              `    }`,
              ``
            );
          } else if (Array.isArray(expectedOutput[0].value)) {
            const expectedStr = ValueMapper.toLang(
              "java",
              expectedOutput[0].value,
              returnArg
            );
            const assertFn = isJavaCollectionReturn(returnArg, expectedStr)
              ? "assertEquals"
              : "assertArrayEquals";
            javaData.push(
              `    @Test`,
              `    void test_${fn}_${i}_expect() {`,
              `        var actual = ${callStr};`,
              `        ${assertFn}(${expectedStr}, actual);`,
              `    }`,
              ``
            );
          } else {
            const expectedStr = ValueMapper.toLang(
              "java",
              expectedOutput[0].value,
              returnArg
            );
            javaData.push(
              `    @Test`,
              `    void test_${fn}_${i}_expect() {`,
              `        var actual = ${callStr};`,
              `        assertEquals(${expectedStr}, actual);`,
              `    }`,
              ``
            );
          }
        }

        // Property validators
        if (thisFn.options.useProperty) {
          for (const validator of thisFn.validators) {
            const validatorSuffix = (
              validator.startsWith(fn) ? validator.slice(fn.length) : validator
            ).replace(/^_+/, "");

            const valObj: FunctionDef | undefined = pgm?.functions[validator];
            const valIsStatic = isMethodStatic(valObj);
            const valRawName = getRawMethodName(validator, valObj);
            const valCallTarget = valIsStatic
              ? `${targetCallClass}.${valRawName}`
              : `new ${targetCallClass}().${valRawName}`;

            const valRetType = valObj?.getReturnType()?.name;
            const argsListExpr = inputStr
              ? `Arrays.asList(${inputStr})`
              : `Arrays.asList()`;

            if (valRetType === "void") {
              javaData.push(
                `    @Test`,
                `    void test_${fn}_${i}_prop_${validatorSuffix}() {`,
                `        List<Object> args = ${argsListExpr};`,
                `        Object out = null;`,
                `        boolean exception = false;`,
                `        try {`,
                thisFn.isVoid
                  ? `            ${callStr};`
                  : `            out = ${callStr};`,
                `        } catch (Throwable t) {`,
                `            exception = true;`,
                `        }`,
                `        FuzzTestResult ftr = new FuzzTestResult(args, out, exception, false);`,
                `        try {`,
                `            ${valCallTarget}(ftr);`,
                `        } catch (com.nanofuzz.runtime.UnsatisfiedAssumptionException ignored) {`,
                `            // Assumption not satisfied; test skipped`,
                `        }`,
                `    }`,
                ``
              );
            } else if (valRetType === "boolean") {
              javaData.push(
                `    @Test`,
                `    void test_${fn}_${i}_prop_${validatorSuffix}() {`,
                `        List<Object> args = ${argsListExpr};`,
                `        Object out = null;`,
                `        boolean exception = false;`,
                `        try {`,
                thisFn.isVoid
                  ? `            ${callStr};`
                  : `            out = ${callStr};`,
                `        } catch (Throwable t) {`,
                `            exception = true;`,
                `        }`,
                `        FuzzTestResult ftr = new FuzzTestResult(args, out, exception, false);`,
                `        try {`,
                `            boolean valRes = ${valCallTarget}(ftr);`,
                `            assertTrue(valRes);`,
                `        } catch (com.nanofuzz.runtime.UnsatisfiedAssumptionException ignored) {`,
                `            // Assumption not satisfied; test skipped`,
                `        }`,
                `    }`,
                ``
              );
            } else {
              javaData.push(
                `    @Test`,
                `    void test_${fn}_${i}_prop_${validatorSuffix}() {`,
                `        List<Object> args = ${argsListExpr};`,
                `        Object out = null;`,
                `        boolean exception = false;`,
                `        try {`,
                thisFn.isVoid
                  ? `            ${callStr};`
                  : `            out = ${callStr};`,
                `        } catch (Throwable t) {`,
                `            exception = true;`,
                `        }`,
                `        FuzzTestResult ftr = new FuzzTestResult(args, out, exception, false);`,
                `        try {`,
                `            Object valRes = ${valCallTarget}(ftr);`,
                `            assertNotEquals(ValidatorResult.FAIL, ValidatorResult.from(valRes));`,
                `        } catch (com.nanofuzz.runtime.UnsatisfiedAssumptionException ignored) {`,
                `            // Assumption not satisfied; test skipped`,
                `        }`,
                `    }`,
                ``
              );
            }
          }
        }

        // Heuristic oracle - run only if turned on and no other oracle is present
        if (
          thisFn.options.useImplicit &&
          !(thisFn.options.useProperty && thisFn.validators.length) &&
          !(thisFn.options.useHuman && expectedOutput)
        ) {
          if (thisFn.isVoid) {
            javaData.push(
              `    @Test`,
              `    void test_${fn}_${i}_heuristic() {`,
              `        // As a void function, expect no uncaught exception`,
              `        ${callStr};`,
              `    }`,
              ``
            );
          } else {
            javaData.push(
              `    @Test`,
              `    void test_${fn}_${i}_heuristic() {`,
              `        // Expect no uncaught exception, null, NaN, or infinity`,
              `        var res = ${callStr};`,
              `        assertTrue(ImplicitOracle.check(res));`,
              `    }`,
              ``
            );
          }
        }
      }
    }

    javaData.push(`} // class: ${testClassName}`, ``);
    return javaData.join(os.EOL);
  } // fn: toString
} // class: JUnitTestAdapter

const nanofuzzName = Config.get("nanofuzz.name", "NaNofuzz");

/**
 * Checks whether a Java method is declared with the static modifier.
 *
 * @param fnDef FunctionDef to inspect
 * @returns True if static or unknown; false if an instance method
 */
function isMethodStatic(fnDef?: FunctionDef): boolean {
  if (!fnDef?.getSrc()) return true;
  const src = fnDef.getSrc();
  const name = fnDef.getName();
  const nameIdx = src.indexOf(name);
  if (nameIdx <= 0) return true;
  const header = src.slice(0, nameIdx);
  return /\bstatic\b/.test(header);
} // fn: isMethodStatic

/**
 * Extracts raw method identifier name avoiding synthetic overload suffixes.
 *
 * @param registeredName Name registered in test suite
 * @param fnDef Optional FunctionDef
 * @returns Raw Java method identifier
 */
function getRawMethodName(registeredName: string, fnDef?: FunctionDef): string {
  if (!fnDef?.getSrc()) {
    if (registeredName.includes("_")) {
      return registeredName.split("_")[0];
    }
    return registeredName;
  }
  const src = fnDef.getSrc();
  const tree = Parser.parse("java", src);
  if (!tree) return registeredName;
  const q = Parser.query(
    "java",
    `(method_declaration name: (identifier) @m.name)`
  );
  const matches = q.matches(tree.rootNode);
  if (matches.length > 0) {
    const idNode = matches[0].captures.find((c) => c.name === "m.name")?.node;
    if (idNode) {
      return idNode.text;
    }
  }
  return registeredName;
} // fn: getRawMethodName

/**
 * Checks whether a return type or rendered Java expression represents a Java Collection/List
 * rather than a primitive/object array (`T[]`), so `assertEquals` is used instead of `assertArrayEquals`.
 */
function isJavaCollectionReturn(
  returnArg?: ArgDef,
  expectedStr?: string
): boolean {
  const listType = returnArg?.getBaseTypeRef() ?? returnArg?.getTypeRef();
  if (
    listType === "List" ||
    listType === "ArrayList" ||
    listType === "LinkedList" ||
    listType === "Vector" ||
    listType === "Collection" ||
    listType === "Iterable" ||
    listType === "Queue" ||
    listType === "Deque" ||
    listType === "ArrayDeque" ||
    listType === "PriorityQueue"
  ) {
    return true;
  }
  if (
    expectedStr &&
    (expectedStr.startsWith("new java.util.") ||
      expectedStr.startsWith("java.util.List.") ||
      expectedStr.startsWith("java.util.Arrays.asList("))
  ) {
    return true;
  }
  return false;
} // fn: isJavaCollectionReturn

/**
 * Infers the Java package declaration from an output file path (e.g. under `src/test/java/com/foo/BarTest.java`
 * or `src/main/java/com/foo/BarTest.java`), falling back to `defaultPkg` if no standard root is matched.
 */
function inferPackageFromOutputPath(
  outputFilename: string,
  defaultPkg: string
): string {
  const norm = outputFilename.replace(/\\/g, "/");
  const dir = path.posix.dirname(norm);
  const markers = ["/src/test/java", "/src/main/java", "/src"];
  for (const marker of markers) {
    const idx = dir.lastIndexOf(marker);
    if (idx !== -1) {
      const rel = dir.slice(idx + marker.length).replace(/^\/+|\/+$/g, "");
      if (!rel) {
        return "";
      }
      if (/^[a-zA-Z_][a-zA-Z0-9_]*(\/[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(rel)) {
        return rel.replace(/\//g, ".");
      }
    }
  }
  return defaultPkg;
} // fn: inferPackageFromOutputPath
