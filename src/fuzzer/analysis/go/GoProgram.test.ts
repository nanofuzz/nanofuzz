import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";
import { GoProgram } from "./GoProgram";
import * as Parser from "../../adapters/ParserAdapter";

describe("fuzzer/analysis/go/GoProgram: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("identifies Go source files and recognizes go language", () => {
    expect(GoProgram.understands({ filename: "math.go" })).toBeTrue();
    expect(GoProgram.understands({ lang: "go" })).toBeTrue();
    expect(GoProgram.understands({ filename: "math_test.go" })).toBeFalse();
    expect(GoProgram.understands({ filename: "test.py" })).toBeFalse();
    expect(GoProgram.understands({ filename: "test.rs" })).toBeFalse();
    expect(GoProgram.understands({ filename: "test.ts" })).toBeFalse();
    expect(GoProgram.understands({ filename: "test.java" })).toBeFalse();
  });

  it("parses functions with primitives, visibility, comments, and return types", () => {
    const src = `
package mathutil

// Add sums two numbers.
func Add(a int, b float64) int {
    return a + int(b)
}

func helper(flag bool) {
}
`;
    const program = ProgramFactory.fromSource(() => src, "go", "mathutil.go");
    expect(program.lang).toBe("go");

    const exportedFns = program.functionsExported;
    expect("Add" in exportedFns).toBeTrue();
    expect("helper" in exportedFns).toBeFalse();

    const allFns = program.functions;
    expect("helper" in allFns).toBeTrue();

    const addFn = exportedFns["Add"];
    expect(addFn.getName()).toBe("Add");
    expect(addFn.isExported()).toBeTrue();
    expect(addFn.isVoid()).toBeFalse();
    expect(addFn.getCmt()).toContain("Add sums two numbers.");

    const args = addFn.getArgDefs();
    expect(args.length).toBe(2);
    expect(args[0].getName()).toBe("a");
    expect(args[0].getType()).toBe(ArgTag.NUMBER);
    expect(args[0].getOptions().numInteger).toBeTrue();

    expect(args[1].getName()).toBe("b");
    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(args[1].getOptions().numInteger).toBeFalse();

    const returnArg = addFn.getReturnArg();
    expect(returnArg).toBeDefined();
    expect(returnArg?.getType()).toBe(ArgTag.NUMBER);
    expect(returnArg?.getOptions().numInteger).toBeTrue();
  });

  it("parses multi-parameter declaration syntax (e.g., a, b int)", () => {
    const src = `
package example

func SumThree(a, b, c int) int {
    return a + b + c
}
`;
    const program = ProgramFactory.fromSource(() => src, "go", "sum.go");
    const fn = program.functions["SumThree"];
    expect(fn).toBeDefined();
    const args = fn.getArgDefs();
    expect(args.length).toBe(3);
    expect(args[0].getName()).toBe("a");
    expect(args[1].getName()).toBe("b");
    expect(args[2].getName()).toBe("c");
    expect(args[0].getType()).toBe(ArgTag.NUMBER);
    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(args[2].getType()).toBe(ArgTag.NUMBER);
  });

  it("parses multiple return types as tuple", () => {
    const src = `
package example

func Divide(a, b int) (int, error) {
    if b == 0 {
        return 0, nil
    }
    return a / b, nil
}
`;
    const program = ProgramFactory.fromSource(() => src, "go", "div.go");
    const fn = program.functions["Divide"];
    expect(fn).toBeDefined();
    expect(fn.isVoid()).toBeFalse();
    const ret = fn.getReturnArg();
    expect(ret).toBeDefined();
    expect(ret?.getType()).toBe(ArgTag.TUPLE);
    const children = ret?.getChildren();
    expect(children?.length).toBe(2);
    expect(children?.[0].getType()).toBe(ArgTag.NUMBER);
    expect(children?.[1].getType()).toBe(ArgTag.OBJECT);
  });

  it("parses slices, fixed arrays, maps, and pointers", () => {
    const src = `
package collections

func Process(items []string, counts [3]int, lookup map[string]int, ptr *int) bool {
    return true
}
`;
    const program = ProgramFactory.fromSource(() => src, "go", "coll.go");
    const fn = program.functions["Process"];
    expect(fn).toBeDefined();
    const args = fn.getArgDefs();
    expect(args.length).toBe(4);

    // slice
    expect(args[0].getDim()).toBe(1);
    expect(args[0].getType()).toBe(ArgTag.STRING);
    expect(GoProgram.getTypeAnnotation(args[0])).toBe("[]string");

    // fixed array
    expect(args[1].getDim()).toBe(1);
    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(GoProgram.getTypeAnnotation(args[1])).toBe("[3]int");

    // map
    expect(args[2].getType()).toBe(ArgTag.DICTIONARY);
    expect(args[2].getBaseTypeRef()).toBe("map");
    expect(GoProgram.getTypeAnnotation(args[2])).toBe("map[string]int");

    // pointer
    expect(args[3].isOptional()).toBeTrue();
    expect(GoProgram.getTypeAnnotation(args[3])).toBe("*int");
  });

  it("extracts type declarations (structs) and resolves callees", () => {
    const src = `
package user

type User struct {
    Name string
    Age  int
}

func Validate(u User) bool {
    check(u.Name)
    return true
}

func check(name string) {
}
`;
    const program = ProgramFactory.fromSource(() => src, "go", "user.go");
    const types = program.types;
    expect("User" in types).toBeTrue();
    expect(types["User"].type?.type).toBe(ArgTag.OBJECT);

    const fn = program.functions["Validate"];
    expect(fn).toBeDefined();
    const callees = fn.getCallees();
    expect(callees.has("check")).toBeTrue();
  });
});
