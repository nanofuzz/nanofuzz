import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { JavaCompiler } from "./JavaCompiler";
import * as CompilerFactory from "../CompilerFactory";
import { JavaCompilerError } from "../Types";

describe("fuzzer/compilers/java/JavaCompiler: ", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-java-test-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("resolves javac and java toolchain executables", () => {
    const javac = JavaCompiler.resolveJavac();
    expect(javac).toBeDefined();
    expect(typeof javac).toBe("string");
    expect(JavaCompiler.canExecute(javac!)).toBeTrue();

    const java = JavaCompiler.resolveJava(javac);
    expect(java).toBeDefined();
    expect(typeof java).toBe("string");
    expect(JavaCompiler.canExecute(java!)).toBeTrue();

    expect(
      JavaCompiler.canExecute("non_existent_binary_xyz_12345")
    ).toBeFalse();
  });

  it("detects pom.xml in ancestor directories for Maven projects", () => {
    const runtimeJava = path.resolve(
      "./packages/runtime/java/src/main/java/com/nanofuzz/runtime/FuzzTestResult.java"
    );
    const compiler = new JavaCompiler(runtimeJava);

    expect(compiler.projectType).toBe("maven");
    expect(compiler.pomXmlPath).toBeDefined();
    expect(compiler.pomXmlPath?.endsWith("pom.xml")).toBeTrue();
    expect(compiler.projectPath).toBe(path.resolve("./packages/runtime/java"));
    expect(compiler.projectConfigPath).toBe(compiler.pomXmlPath);

    const deps = compiler.getCompiledDependencies();
    expect(deps).toContain(runtimeJava);
    expect(deps.length).toBeGreaterThan(1);
  });

  it("detects build.gradle for Gradle projects", () => {
    const gradleDir = path.join(tempDir, "gradle_app");
    const srcDir = path.join(gradleDir, "src", "main", "java");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(gradleDir, "build.gradle"), "// gradle config");
    const javaFile = path.join(srcDir, "App.java");
    fs.writeFileSync(javaFile, "public class App {}");

    const compiler = new JavaCompiler(javaFile);
    expect(compiler.projectType).toBe("gradle");
    expect(compiler.gradleBuildPath).toBeDefined();
    expect(compiler.projectPath).toBe(gradleDir);
  });

  it("handles standalone Java files without project descriptor", () => {
    const standaloneJava = path.join(tempDir, "Standalone.java");
    fs.writeFileSync(
      standaloneJava,
      "public class Standalone { public static int val = 42; }"
    );

    const compiler = new JavaCompiler(standaloneJava);
    expect(compiler.projectType).toBe("standalone");
    expect(compiler.pomXmlPath).toBeUndefined();
    expect(compiler.gradleBuildPath).toBeUndefined();
    expect(compiler.projectPath).toBe(tempDir);
  });

  it("compiles a valid Java file and records compilation metadata", () => {
    const standaloneJava = path.join(tempDir, "Calculator.java");
    fs.writeFileSync(
      standaloneJava,
      "public class Calculator { public static int add(int a, int b) { return a + b; } }"
    );

    const compiler = new JavaCompiler(standaloneJava);
    expect(compiler.isStale()).toBe("notcompiled");

    const compiledFile = compiler.compileSync();
    expect(compiledFile).toBe(standaloneJava);
    expect(fs.existsSync(compiler.classesDir)).toBeTrue();
    expect(
      fs.existsSync(path.join(compiler.classesDir, "Calculator.class"))
    ).toBeTrue();

    // After compilation, it should not be stale
    expect(compiler.isStale()).toBeFalse();
  });

  it("compiles a Java file importing com.nanofuzz.runtime without errors", () => {
    const sampleJava = path.join(tempDir, "HarnessSample.java");
    fs.writeFileSync(
      sampleJava,
      `import com.nanofuzz.runtime.Assert;
import com.nanofuzz.runtime.FuzzTestResult;

public class HarnessSample {
    public static void test(FuzzTestResult r) {
        Assert.that(r != null, "result required");
    }
}
`
    );

    const compiler = new JavaCompiler(sampleJava);
    const compiledFile = compiler.compileSync();
    expect(compiledFile).toBe(sampleJava);
    expect(
      fs.existsSync(path.join(compiler.classesDir, "HarnessSample.class"))
    ).toBeTrue();
    expect(compiler.isStale()).toBeFalse();
  });

  it("detects source file changes and reports staleness", () => {
    const sampleJava = path.join(tempDir, "MathDemo.java");
    fs.writeFileSync(
      sampleJava,
      "public class MathDemo { public static int doubleVal(int x) { return x * 2; } }"
    );

    const compiler = new JavaCompiler(sampleJava);
    expect(compiler.isStale()).toBe("notcompiled");

    compiler.compileSync();
    expect(compiler.isStale()).toBeFalse();

    // Modify source file with a future timestamp to simulate an edit
    const futureTime = new Date(Date.now() + 5000);
    fs.writeFileSync(
      sampleJava,
      "public class MathDemo { public static int doubleVal(int x) { return x * 4; } }"
    );
    fs.utimesSync(sampleJava, futureTime, futureTime);

    expect(compiler.isStale()).toBe("sourcechanged");
  });

  it("detects config file changes in Maven projects and reports staleness", () => {
    const projDir = path.join(tempDir, "maven_proj");
    const srcDir = path.join(projDir, "src", "main", "java");
    fs.mkdirSync(srcDir, { recursive: true });

    const pomFile = path.join(projDir, "pom.xml");
    fs.writeFileSync(
      pomFile,
      `<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>test</artifactId><version>1.0</version></project>`
    );

    const mainFile = path.join(srcDir, "Main.java");
    fs.writeFileSync(
      mainFile,
      "public class Main { public static void main(String[] args) {} }"
    );

    const compiler = new JavaCompiler(mainFile);
    compiler.compileSync();
    expect(compiler.isStale()).toBeFalse();

    // Modify pom.xml with a future timestamp
    const futureTime = new Date(Date.now() + 5000);
    fs.writeFileSync(
      pomFile,
      `<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>test</artifactId><version>1.1</version></project>`
    );
    fs.utimesSync(pomFile, futureTime, futureTime);

    expect(compiler.isStale()).toBe("configchanged");
  });

  it("throws JavaCompilerError with diagnostic line and col on syntax errors", () => {
    const brokenJava = path.join(tempDir, "Broken.java");
    fs.writeFileSync(
      brokenJava,
      `public class Broken {
    public static int bad(int a) {
        return a + undefinedVariable;
    }
}
`
    );

    const compiler = new JavaCompiler(brokenJava);
    let thrownError: unknown;
    try {
      compiler.compileSync();
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError instanceof JavaCompilerError).toBeTrue();
    if (thrownError instanceof JavaCompilerError) {
      expect(thrownError.details.inputFile).toBe(brokenJava);
      expect(thrownError.details.diagnostics).toBeDefined();
      expect(thrownError.details.diagnostics!.length).toBeGreaterThan(0);

      const diag = thrownError.details.diagnostics![0];
      expect(diag.level).toBe("error");
      expect(diag.message).toContain("cannot find symbol");
      expect(diag.span?.line).toBe(3);
      expect(diag.span?.col).toBeGreaterThan(0);
    }
  });

  it("integrates with CompilerFactory", () => {
    const sampleJava = path.join(tempDir, "FactoryTest.java");
    fs.writeFileSync(sampleJava, "public class FactoryTest {}");

    expect(CompilerFactory.needsCompilation(sampleJava)).toBeTrue();

    const compiler = CompilerFactory.fromSourcefile(sampleJava);
    expect(compiler).toBeDefined();
    expect(compiler instanceof JavaCompiler).toBeTrue();
  });
});
