import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";
import { JavaProgram } from "./JavaProgram";
import * as Parser from "../../adapters/ParserAdapter";
import { formatFunctionSignature } from "../../../ui/Agent";

describe("fuzzer/analysis/java/JavaProgram: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("identifies Java source files and recognizes java language", () => {
    expect(JavaProgram.understands({ filename: "MathUtil.java" })).toBeTrue();
    expect(JavaProgram.understands({ lang: "java" })).toBeTrue();
    expect(JavaProgram.understands({ filename: "test.py" })).toBeFalse();
    expect(JavaProgram.understands({ filename: "test.rs" })).toBeFalse();
    expect(JavaProgram.understands({ filename: "test.ts" })).toBeFalse();
  });

  it("parses static and instance methods with primitive types, visibility, and return types", () => {
    const src = `
package com.example;

public class Calculator {
    /**
     * Adds two numbers together.
     */
    public static int add(int a, double b) {
        return (int)(a + b);
    }

    private void privateHelper(boolean flag) {
    }
}
`;
    const program = ProgramFactory.fromSource(
      () => src,
      "java",
      "Calculator.java"
    );
    expect(program.lang).toBe("java");

    const exportedFns = program.functionsExported;
    expect("add" in exportedFns).toBeTrue();
    expect("privateHelper" in exportedFns).toBeFalse();

    const addFn = exportedFns["add"];
    expect(addFn.getName()).toBe("add");
    expect(addFn.isExported()).toBeTrue();
    expect(addFn.isVoid()).toBeFalse();
    expect(addFn.getCmt()).toContain("Adds two numbers together.");

    const args = addFn.getArgDefs();
    expect(args.length).toBe(2);
    expect(args[0].getName()).toBe("a");
    expect(args[0].getType()).toBe(ArgTag.NUMBER);
    expect(args[0].getOptions().numInteger).toBeTrue();

    const intervalsA = args[0].getIntervals();
    expect(intervalsA).toBeDefined();
    expect(intervalsA[0].min).toBe(-2147483648);
    expect(intervalsA[0].max).toBe(2147483647);

    expect(args[1].getName()).toBe("b");
    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(args[1].getOptions().numInteger).toBeFalse();

    const returnArg = addFn.getReturnArg();
    expect(returnArg).toBeDefined();
    expect(returnArg?.getType()).toBe(ArgTag.NUMBER);
    expect(returnArg?.getOptions().numInteger).toBeTrue();
  });

  it("parses integer and floating point widths: byte, short, int, long, float, double, char", () => {
    const src = `
public class TypesDemo {
    public static void process(
        byte b,
        short s,
        int i,
        long l,
        float f,
        double d,
        char c,
        boolean flag
    ) {
    }
}
`;
    const program = ProgramFactory.fromSource(() => src, "java");
    const fnDef = program.functionsExported["process"];
    expect(fnDef).toBeDefined();
    expect(fnDef.isVoid()).toBeTrue();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(8);

    // byte
    expect(args[0].getType()).toBe(ArgTag.NUMBER);
    expect(args[0].getIntervals()[0].min).toBe(-128);
    expect(args[0].getIntervals()[0].max).toBe(127);

    // short
    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(args[1].getIntervals()[0].min).toBe(-32768);
    expect(args[1].getIntervals()[0].max).toBe(32767);

    // int
    expect(args[2].getType()).toBe(ArgTag.NUMBER);
    expect(args[2].getIntervals()[0].min).toBe(-2147483648);
    expect(args[2].getIntervals()[0].max).toBe(2147483647);

    // long (BIGINT)
    expect(args[3].getType()).toBe(ArgTag.BIGINT);
    expect(args[3].getIntervals()[0].min).toBe(-9223372036854775808n);
    expect(args[3].getIntervals()[0].max).toBe(9223372036854775807n);

    // float
    expect(args[4].getType()).toBe(ArgTag.NUMBER);
    expect(args[4].getOptions().numInteger).toBeFalse();

    // double
    expect(args[5].getType()).toBe(ArgTag.NUMBER);
    expect(args[5].getOptions().numInteger).toBeFalse();

    // char
    expect(args[6].getType()).toBe(ArgTag.STRING);
    expect(args[6].getOptions().strLength).toEqual({ min: 1, max: 1 });

    // boolean
    expect(args[7].getType()).toBe(ArgTag.BOOLEAN);
  });

  it("parses String, byte[], arrays, List, Set, Map, and Optional", () => {
    const src = `
import java.util.List;
import java.util.Set;
import java.util.Map;
import java.util.Optional;

public class CollectionsDemo {
    public static void test(
        String name,
        byte[] rawBytes,
        int[] numbers,
        String[][] matrix,
        List<Integer> intList,
        Set<String> strSet,
        Map<String, Double> scoreMap,
        Optional<String> optName
    ) {
    }
}
`;
    const program = ProgramFactory.fromSource(() => src, "java");
    const fnDef = program.functionsExported["test"];
    expect(fnDef).toBeDefined();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(8);

    // String
    expect(args[0].getType()).toBe(ArgTag.STRING);

    // byte[] -> BYTES
    expect(args[1].getType()).toBe(ArgTag.BYTES);

    // int[] -> NUMBER array with dim 1
    expect(args[2].getType()).toBe(ArgTag.NUMBER);
    expect(args[2].getDim()).toBe(1);

    // String[][] -> STRING array with dim 2
    expect(args[3].getType()).toBe(ArgTag.STRING);
    expect(args[3].getDim()).toBe(2);

    // List<Integer> -> NUMBER array with dim 1
    expect(args[4].getType()).toBe(ArgTag.NUMBER);
    expect(args[4].getDim()).toBe(1);

    // Set<String> -> SET
    expect(args[5].getType()).toBe(ArgTag.SET);

    // Map<String, Double> -> DICTIONARY
    expect(args[6].getType()).toBe(ArgTag.DICTIONARY);

    // Optional<String> -> STRING with optional true
    expect(args[7].getType()).toBe(ArgTag.STRING);
    expect(args[7].isOptional()).toBeTrue();
  });

  it("disambiguates overloaded methods by parameter signature", () => {
    const src = `
public class OverloadDemo {
    public static int compute(int a) {
        return a * 2;
    }

    public static double compute(double a) {
        return a * 2.0;
    }
}
`;
    const program = ProgramFactory.fromSource(() => src, "java");
    const exportedFns = program.functionsExported;

    expect("compute" in exportedFns).toBeTrue();
    expect("compute_double" in exportedFns).toBeTrue();
    expect(exportedFns["compute"].getArgDefs()[0].getType()).toBe(
      ArgTag.NUMBER
    );
    expect(
      exportedFns["compute"].getArgDefs()[0].getOptions().numInteger
    ).toBeTrue();
    expect(exportedFns["compute_double"].getArgDefs()[0].getType()).toBe(
      ArgTag.NUMBER
    );
    expect(
      exportedFns["compute_double"].getArgDefs()[0].getOptions().numInteger
    ).toBeFalse();
  });

  it("recognizes Java records and extracts component types", () => {
    const src = `
public record Point(int x, int y) {
    public int manhattanDistance() {
        return Math.abs(x) + Math.abs(y);
    }
}
`;
    const program = ProgramFactory.fromSource(() => src, "java");
    expect("Point" in program.types).toBeTrue();
    const pointType = program.types["Point"];
    expect(pointType.name).toBe("Point");
    expect(pointType.type?.children.length).toBe(2);
    expect(pointType.type?.children[0].name).toBe("x");
    expect(pointType.type?.children[0].type?.type).toBe(ArgTag.NUMBER);
    expect(pointType.type?.children[1].name).toBe("y");
    expect(pointType.type?.children[1].type?.type).toBe(ArgTag.NUMBER);

    expect("manhattanDistance" in program.functionsExported).toBeFalse();
    expect("manhattanDistance" in program.functionsNotSupported).toBeTrue();
    expect(program.functionsNotSupported["manhattanDistance"].reason).toBe(
      "Class methods are not supported"
    );
  });

  it("marks class methods and functions with unsupported argument types as unsupported", () => {
    const src = `
import java.util.List;
import java.util.Map;
import java.util.function.DoubleSupplier;

public class TargetClass {
    public enum Color { RED, GREEN, BLUE }
    public class CustomUser { String name; }
    public interface Callback { void run(); }
    public record ColoredPoint(int x, Color color) {}

    // Supported static method
    public static int evaluateExpression(int x) { return x; }

    // Class (instance) method
    public int instanceMethod(int x) { return x * 2; }

    // Function with functional interface parameter
    public static Object[] evaluateExpressionGenerator(DoubleSupplier prng) {
        return new Object[] { 1 };
    }

    // Function with enum parameter
    public static void paint(Color c) {}

    // Function with custom class parameter
    public static void handleUser(CustomUser u) {}

    // Function with interface parameter
    public static void execute(Callback cb) {}

    // Function with Object parameter
    public static void processObj(Object obj) {}

    // Function with array of unsupported enum type
    public static void paintAll(Color[] colors) {}

    // Function with List of unsupported enum type
    public static void paintList(List<Color> colors) {}

    // Function with Map containing unsupported enum type
    public static void paintMap(Map<String, Color> map) {}

    // Function with record containing unsupported enum component
    public static void draw(ColoredPoint cp) {}
}
`;
    const prog = ProgramFactory.fromSource(() => src, "java");

    // Only the method with supported primitive arguments is exported
    expect(prog.functionsExported["evaluateExpression"]).toBeDefined();

    // Class and function-typed parameters remain unsupported.
    expect(
      prog.functionsExported["evaluateExpressionGenerator"]
    ).toBeUndefined();
    expect(prog.functionsExported["instanceMethod"]).toBeUndefined();
    expect(prog.functionsExported["handleUser"]).toBeUndefined();
    expect(prog.functionsExported["execute"]).toBeUndefined();
    expect(prog.functionsExported["processObj"]).toBeUndefined();
    expect(prog.functionsExported["paint"]).toBeDefined();
    expect(prog.functionsExported["paintAll"]).toBeDefined();
    expect(prog.functionsExported["paintList"]).toBeDefined();
    expect(prog.functionsExported["paintMap"]).toBeDefined();
    expect(prog.functionsExported["draw"]).toBeDefined();

    // Class methods marked unsupported
    expect(prog.functionsNotSupported["instanceMethod"]).toBeDefined();
    expect(prog.functionsNotSupported["instanceMethod"].reason).toBe(
      "Class methods are not supported"
    );

    // Functional interface parameter marked unsupported
    expect(
      prog.functionsNotSupported["evaluateExpressionGenerator"]
    ).toBeDefined();
    expect(
      prog.functionsNotSupported["evaluateExpressionGenerator"].argument
    ).toBe("prng");

    // Enum values and collections of enum values are modeled as literal unions.
    expect(prog.functionsNotSupported["paint"]).toBeUndefined();
    expect(prog.functionsNotSupported["paintAll"]).toBeUndefined();
    expect(prog.functionsNotSupported["paintList"]).toBeUndefined();
    expect(prog.functionsNotSupported["paintMap"]).toBeUndefined();
    expect(prog.functionsNotSupported["draw"]).toBeUndefined();
    expect(prog.functionsExported["paint"].getArgDefs()[0].getType()).toBe(
      ArgTag.UNION
    );
    expect(
      prog.functionsExported["paint"]
        .getArgDefs()[0]
        .getChildren()
        .map((child) => child.getConstantValue())
    ).toEqual(["RED", "GREEN", "BLUE"]);
    expect(
      prog.functionsExported["draw"].getArgDefs()[0].getChildren()[1].getType()
    ).toBe(ArgTag.UNION);

    // Class parameter marked unsupported
    expect(prog.functionsNotSupported["handleUser"]).toBeDefined();
    expect(prog.functionsNotSupported["handleUser"].argument).toBe("u");
    expect(prog.functionsNotSupported["handleUser"].reason).toContain(
      "classes are not supported"
    );

    // Interface parameter marked unsupported
    expect(prog.functionsNotSupported["execute"]).toBeDefined();
    expect(prog.functionsNotSupported["execute"].argument).toBe("cb");
    expect(prog.functionsNotSupported["execute"].reason).toContain(
      "interfaces are not supported"
    );

    // Object parameter marked unsupported
    expect(prog.functionsNotSupported["processObj"]).toBeDefined();
    expect(prog.functionsNotSupported["processObj"].argument).toBe("obj");
  });

  it("resolves UUID parameters with UUID-constrained string generation", () => {
    const src = `
import java.util.UUID;
class UuidDemo {
  public static UUID echo(UUID value) { return value; }
}
`;
    const program = ProgramFactory.fromSource(() => src, "java");
    const uuidArg = program.functionsExported["echo"].getArgDefs()[0];

    expect(uuidArg.getType()).toBe(ArgTag.STRING);
    expect(uuidArg.getTypeRef()).toBe("UUID");
    expect(uuidArg.getOptions().strLength).toEqual({ min: 36, max: 36 });
    expect(uuidArg.getOptions().strRegex).toContain("[1-5]");
  });

  it("extracts callees within method body", () => {
    const src = `
public class CalleeDemo {
    public static int work(int x) {
        helper();
        System.out.println(x);
        return transform(x);
    }

    public static void helper() {}
    public static int transform(int x) { return x; }
}
`;
    const program = ProgramFactory.fromSource(() => src, "java");
    const workFn = program.functionsExported["work"];
    expect(workFn).toBeDefined();

    const callees = workFn.getCallees();
    expect(callees.has("helper")).toBeTrue();
    expect(callees.has("println")).toBeTrue();
    expect(callees.has("transform")).toBeTrue();
  });

  it("identifies Java companion validator function", () => {
    const src = `
import com.nanofuzz.runtime.FuzzTestResult;

public class ValidatorDemo {
    public static int add(int a, int b) {
        return a + b;
    }

    public static String addValidator(FuzzTestResult result) {
        return "pass";
    }
}
`;
    const program = ProgramFactory.fromSource(() => src, "java");
    const validatorFn = program.functionsExported["addValidator"];
    expect(validatorFn).toBeDefined();
    expect(validatorFn.isValidator()).toBeTrue();
    expect(validatorFn.getValidatorTargetName()).toBe("add");
  });

  it("formats Java method signature correctly in Agent helper", () => {
    const src = `
public class SignatureDemo {
    public static int multiply(int a, int b) {
        return a * b;
    }
}
`;
    const program = ProgramFactory.fromSource(() => src, "java");
    const multFn = program.functionsExported["multiply"];
    const sig = formatFunctionSignature(multFn, "java");
    expect(sig).toBe("public int multiply(int a, int b)");
  });

  it("finds local sibling Java source files in the same directory", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-java-test-")
    );
    const fileA = path.join(tmpDir, "A.java");
    const fileB = path.join(tmpDir, "B.java");
    fs.writeFileSync(fileA, "public class A {}", "utf8");
    fs.writeFileSync(fileB, "public class B {}", "utf8");

    const siblings = JavaProgram.findLocalSourceFiles(fileA);
    expect(siblings.length).toBe(2);
    expect(siblings).toContain(fileA);
    expect(siblings).toContain(fileB);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
