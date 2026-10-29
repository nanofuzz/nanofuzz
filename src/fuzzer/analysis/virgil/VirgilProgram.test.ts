import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";
import { VirgilProgram } from "./VirgilProgram";
import * as Parser from "../../adapters/ParserAdapter";

describe("fuzzer/analysis/virgil/VirgilProgram: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-virgil-test-")
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

  it("identifies Virgil source files and recognizes virgil language", () => {
    expect(VirgilProgram.understands({ filename: "test.v3" })).toBeTrue();
    expect(VirgilProgram.understands({ lang: "virgil" })).toBeTrue();
    expect(VirgilProgram.understands({ filename: "test.rs" })).toBeFalse();
    expect(VirgilProgram.understands({ filename: "test.py" })).toBeFalse();
    expect(VirgilProgram.understands({ filename: "test.ts" })).toBeFalse();
  });

  it("parses functions with primitive types, visibility, comments, and return types", () => {
    const src = `
// Adds two numbers together
def add(a: int, b: float) -> float {
    return a + b;
}

private def private_helper(flag: bool) -> void {
}
`;
    const program = ProgramFactory.fromSource(() => src, "virgil", "lib.v3");
    expect(program.lang).toBe("virgil");

    const exportedFns = program.functionsExported;
    expect("add" in exportedFns).toBeTrue();
    expect("private_helper" in exportedFns).toBeFalse();

    const addFn = exportedFns["add"];
    expect(addFn.getName()).toBe("add");
    expect(addFn.isExported()).toBeTrue();
    expect(addFn.isVoid()).toBeFalse();
    expect(addFn.getCmt()).toBe("Adds two numbers together");

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
    expect(returnArg?.getOptions().numInteger).toBeFalse();
  });

  it("parses integer widths correctly: u8/byte, i8, u16, i16, u32, i64, u64", () => {
    const src = `
def process_nums(
    b: byte,
    s8: i8,
    u16_val: u16,
    i16_val: i16,
    u32_val: u32,
    i64_val: i64,
    u64_val: u64
) -> void {
}
`;
    const program = ProgramFactory.fromSource(() => src, "virgil");
    const fnDef = program.functionsExported["process_nums"];
    expect(fnDef).toBeDefined();
    expect(fnDef.isVoid()).toBeTrue();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(7);

    // byte / u8
    expect(args[0].getType()).toBe(ArgTag.NUMBER);
    expect(args[0].getIntervals()[0].min).toBe(0);
    expect(args[0].getIntervals()[0].max).toBe(255);

    // i8
    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(args[1].getIntervals()[0].min).toBe(-128);
    expect(args[1].getIntervals()[0].max).toBe(127);

    // u16
    expect(args[2].getType()).toBe(ArgTag.NUMBER);
    expect(args[2].getIntervals()[0].min).toBe(0);
    expect(args[2].getIntervals()[0].max).toBe(65535);

    // i16
    expect(args[3].getType()).toBe(ArgTag.NUMBER);
    expect(args[3].getIntervals()[0].min).toBe(-32768);
    expect(args[3].getIntervals()[0].max).toBe(32767);

    // u32
    expect(args[4].getType()).toBe(ArgTag.NUMBER);
    expect(args[4].getIntervals()[0].min).toBe(0);
    expect(args[4].getIntervals()[0].max).toBe(4294967295);

    // i64
    expect(args[5].getType()).toBe(ArgTag.BIGINT);
    expect(args[5].getOptions().bigintIntervals![0].min).toBe(
      -9223372036854775808n
    );
    expect(args[5].getOptions().bigintIntervals![0].max).toBe(
      9223372036854775807n
    );

    // u64
    expect(args[6].getType()).toBe(ArgTag.BIGINT);
    expect(args[6].getOptions().bigintIntervals![0].min).toBe(0n);
    expect(args[6].getOptions().bigintIntervals![0].max).toBe(
      18446744073709551615n
    );
  });

  it("parses string, bool, and array types", () => {
    const src = `
def process_data(msg: string, flags: Array<bool>, matrix: Array<Array<int>>) -> Array<string> {
    return [msg];
}
`;
    const program = ProgramFactory.fromSource(() => src, "virgil");
    const fnDef = program.functionsExported["process_data"];
    expect(fnDef).toBeDefined();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(3);

    expect(args[0].getType()).toBe(ArgTag.STRING);
    expect(args[0].getDim()).toBe(0);

    expect(args[1].getType()).toBe(ArgTag.BOOLEAN);
    expect(args[1].getDim()).toBe(1);

    expect(args[2].getType()).toBe(ArgTag.NUMBER);
    expect(args[2].getDim()).toBe(2);

    const ret = fnDef.getReturnArg();
    expect(ret?.getType()).toBe(ArgTag.STRING);
    expect(ret?.getDim()).toBe(1);
  });

  it("parses tuple parameters correctly", () => {
    const src = `
def tuple_func(pair: (bool, int), triple: (string, float, int)) -> (int, string) {
    return (pair.1, triple.0);
}
`;
    const program = ProgramFactory.fromSource(() => src, "virgil");
    const fnDef = program.functionsExported["tuple_func"];
    expect(fnDef).toBeDefined();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(2);

    expect(args[0].getType()).toBe(ArgTag.OBJECT);
    expect(args[0].getTypeRef()).toBe("#tuple");
    const pairChildren = args[0].getChildren();
    expect(pairChildren.length).toBe(2);
    expect(pairChildren[0].getType()).toBe(ArgTag.BOOLEAN);
    expect(pairChildren[1].getType()).toBe(ArgTag.NUMBER);

    const tripleChildren = args[1].getChildren();
    expect(tripleChildren.length).toBe(3);
    expect(tripleChildren[0].getType()).toBe(ArgTag.STRING);
    expect(tripleChildren[1].getType()).toBe(ArgTag.NUMBER);
    expect(tripleChildren[2].getType()).toBe(ArgTag.NUMBER);
  });

  it("Gate 3: throws on unsupported types and NEVER returns UNRESOLVED ArgDef", () => {
    const src = `
def pointer_func(ptr: Pointer) -> void {
}

def closure_func(callback: (int) -> int) -> int {
    return callback(42);
}

class Counter {
    var val: int;
    def increment() -> void {
        val++;
    }
}
`;
    const program = ProgramFactory.fromSource(() => src, "virgil");

    // All unsupported functions must be flagged in functionsNotSupported
    expect(program.functions["pointer_func"]).toBeUndefined();
    expect(program.functions["closure_func"]).toBeUndefined();
    expect(program.functions["increment"]).toBeUndefined();

    expect(program.functionsNotSupported["pointer_func"]).toBeDefined();
    expect(program.functionsNotSupported["pointer_func"].reason).toContain(
      "Unsupported Virgil type 'Pointer'"
    );

    expect(program.functionsNotSupported["closure_func"]).toBeDefined();
    expect(program.functionsNotSupported["closure_func"].reason).toContain(
      "Unsupported function/closure type"
    );

    expect(program.functionsNotSupported["increment"]).toBeDefined();
    expect(program.functionsNotSupported["increment"].reason).toContain(
      "Class method 'increment' is not a top-level or component function"
    );

    // Verify no function in program.functions has any ArgTag.UNRESOLVED
    for (const fn of Object.values(program.functions)) {
      for (const arg of fn.getArgDefs()) {
        expect(arg.getType()).not.toBe(ArgTag.UNRESOLVED);
      }
    }
  });

  it("discovers local module files for project scope", () => {
    const mainV3 = path.join(tempDir, "main.v3");
    const helperV3 = path.join(tempDir, "helper.v3");
    const subDir = path.join(tempDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });
    const subV3 = path.join(subDir, "sub.v3");

    fs.writeFileSync(mainV3, "def main() -> void {}\n");
    fs.writeFileSync(helperV3, "def help() -> void {}\n");
    fs.writeFileSync(subV3, "def sub_fn() -> void {}\n");

    const localModules = VirgilProgram.findLocalModules(mainV3);
    expect(localModules.length).toBe(2);
    expect(localModules.some((f) => f.includes("helper.v3"))).toBeTrue();
    expect(localModules.some((f) => f.includes("sub.v3"))).toBeTrue();
  });

  it("discovers direct external imports excluding Virgil builtins", () => {
    const fileV3 = path.join(tempDir, "app.v3");
    const src = `
import component System;
import component Virgil;
import component Extism;
import component MathLib;

def compute() -> int {
    return 42;
}
`;
    fs.writeFileSync(fileV3, src);

    const directImports = VirgilProgram.findDirectImports(fileV3);
    expect(directImports).toContain("Extism");
    expect(directImports).toContain("MathLib");
    expect(directImports).not.toContain("System");
    expect(directImports).not.toContain("Virgil");
  });
});
