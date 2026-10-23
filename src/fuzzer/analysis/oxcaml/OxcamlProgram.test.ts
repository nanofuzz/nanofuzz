import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";
import { OxcamlProgram } from "./OxcamlProgram";
import * as Parser from "../../adapters/ParserAdapter";

describe("fuzzer/analysis/oxcaml/OxcamlProgram: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("identifies OCaml/OxCaml source files and recognizes oxcaml language", () => {
    expect(OxcamlProgram.understands({ filename: "test.ml" })).toBeTrue();
    expect(OxcamlProgram.understands({ filename: "test.mli" })).toBeTrue();
    expect(OxcamlProgram.understands({ lang: "oxcaml" })).toBeTrue();
    expect(OxcamlProgram.understands({ filename: "test.py" })).toBeFalse();
    expect(OxcamlProgram.understands({ filename: "test.rs" })).toBeFalse();
    expect(OxcamlProgram.understands({ filename: "test.ts" })).toBeFalse();
  });

  it("parses functions with primitive types, visibility, and return types", () => {
    const src = `
(** Adds two numbers together *)
let add (a : int) (b : float) : float =
  (float_of_int a) +. b

let _private_helper (flag : bool) : unit =
  ()
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml", "lib.ml");
    expect(program.lang).toBe("oxcaml");

    const exportedFns = program.functionsExported;
    expect("add" in exportedFns).toBeTrue();
    expect("_private_helper" in exportedFns).toBeFalse();

    const addFn = exportedFns["add"];
    expect(addFn.getName()).toBe("add");
    expect(addFn.isExported()).toBeTrue();
    expect(addFn.isVoid()).toBeFalse();

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

  it("parses integer widths correctly: int, int32, int64, nativeint", () => {
    const src = `
let process_nums (a : int) (b : int32) (c : int64) (d : nativeint) : unit =
  ()
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const fnDef = program.functionsExported["process_nums"];
    expect(fnDef).toBeDefined();
    expect(fnDef.isVoid()).toBeTrue();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(4);

    // int
    expect(args[0].getType()).toBe(ArgTag.NUMBER);
    expect(args[0].getOptions().numInteger).toBeTrue();
    expect(args[0].getIntervals()[0].min).toBe(-2147483648);
    expect(args[0].getIntervals()[0].max).toBe(2147483647);

    // int32
    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(args[1].getOptions().numInteger).toBeTrue();
    expect(args[1].getIntervals()[0].min).toBe(-2147483648);
    expect(args[1].getIntervals()[0].max).toBe(2147483647);

    // int64 (BIGINT)
    expect(args[2].getType()).toBe(ArgTag.BIGINT);
    expect(args[2].getIntervals()[0].min).toBe(-9223372036854775808n);
    expect(args[2].getIntervals()[0].max).toBe(9223372036854775807n);

    // nativeint
    expect(args[3].getType()).toBe(ArgTag.NUMBER);
    expect(args[3].getOptions().numInteger).toBeTrue();
  });

  it("parses OxCaml unboxed types: #int, #float", () => {
    const src = `
let unboxed_math (x : #int) (y : #float) : #float =
  y
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const fnDef = program.functionsExported["unboxed_math"];
    expect(fnDef).toBeDefined();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(2);

    expect(args[0].getType()).toBe(ArgTag.NUMBER);
    expect(args[0].getOptions().numInteger).toBeTrue();

    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(args[1].getOptions().numInteger).toBeFalse();

    const returnArg = fnDef.getReturnArg();
    expect(returnArg?.getType()).toBe(ArgTag.NUMBER);
    expect(returnArg?.getOptions().numInteger).toBeFalse();
  });

  it("parses string, char, bytes, and bool types", () => {
    const src = `
let text_and_flags (s : string) (c : char) (b : bytes) (flag : bool) : string =
  s
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const fnDef = program.functionsExported["text_and_flags"];
    expect(fnDef).toBeDefined();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(4);

    expect(args[0].getType()).toBe(ArgTag.STRING);
    expect(args[1].getType()).toBe(ArgTag.STRING);
    expect(args[1].getOptions().strLength?.min).toBe(1);
    expect(args[1].getOptions().strLength?.max).toBe(1);

    expect(args[2].getType()).toBe(ArgTag.BYTES);
    expect(args[3].getType()).toBe(ArgTag.BOOLEAN);
  });

  it("parses list, array, option, and tuple types", () => {
    const src = `
let complex_types
  (items : int list)
  (matrix : float array array)
  (label : string option)
  (coord : int * string) : int * string =
  coord
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const fnDef = program.functionsExported["complex_types"];
    expect(fnDef).toBeDefined();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(4);

    // int list
    expect(args[0].getName()).toBe("items");
    expect(args[0].getDim()).toBe(1);
    expect(args[0].getType()).toBe(ArgTag.NUMBER);
    expect(args[0].getOptions().numInteger).toBeTrue();

    // float array array
    expect(args[1].getName()).toBe("matrix");
    expect(args[1].getDim()).toBe(2);
    expect(args[1].getType()).toBe(ArgTag.NUMBER);
    expect(args[1].getOptions().numInteger).toBeFalse();

    // string option
    expect(args[2].getName()).toBe("label");
    expect(args[2].isOptional()).toBeTrue();
    expect(args[2].getType()).toBe(ArgTag.STRING);

    // int * string tuple
    expect(args[3].getName()).toBe("coord");
    expect(args[3].getType()).toBe(ArgTag.TUPLE);
    const tupleChildren = args[3].getChildren();
    expect(tupleChildren.length).toBe(2);
    expect(tupleChildren[0].getType()).toBe(ArgTag.NUMBER);
    expect(tupleChildren[1].getType()).toBe(ArgTag.STRING);

    // Return type
    const returnArg = fnDef.getReturnArg();
    expect(returnArg?.getType()).toBe(ArgTag.TUPLE);
  });

  it("parses labeled and optional parameters", () => {
    const src = `
let greet ~(name : string) ?(greeting : string = "Hello") (times : int) : string =
  name
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const fnDef = program.functionsExported["greet"];
    expect(fnDef).toBeDefined();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(3);

    expect(args[0].getName()).toBe("name");
    expect(args[0].getType()).toBe(ArgTag.STRING);

    expect(args[1].getName()).toBe("greeting");
    expect(args[1].isOptional()).toBeTrue();
    expect(args[1].getType()).toBe(ArgTag.STRING);

    expect(args[2].getName()).toBe("times");
    expect(args[2].getType()).toBe(ArgTag.NUMBER);
  });

  it("parses zero-argument functions using unit parameter ()", () => {
    const src = `
let run () : unit =
  ()
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const fnDef = program.functionsExported["run"];
    expect(fnDef).toBeDefined();
    expect(fnDef.isVoid()).toBeTrue();
    expect(fnDef.getArgDefs().length).toBe(0);
  });

  it("generates correct OCaml type annotations via getTypeAnnotation", () => {
    const src = `
let demo
  (a : int)
  (b : float)
  (c : bool)
  (d : string)
  (e : int list)
  (f : string option)
  (g : int * float) : unit = ()
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const fnDef = program.functionsExported["demo"];
    const args = fnDef.getArgDefs();

    expect(OxcamlProgram.getTypeAnnotation(args[0])).toBe("int");
    expect(OxcamlProgram.getTypeAnnotation(args[1])).toBe("float");
    expect(OxcamlProgram.getTypeAnnotation(args[2])).toBe("bool");
    expect(OxcamlProgram.getTypeAnnotation(args[3])).toBe("string");
    expect(OxcamlProgram.getTypeAnnotation(args[4])).toBe("int list");
    expect(OxcamlProgram.getTypeAnnotation(args[5])).toBe("string option");
    expect(OxcamlProgram.getTypeAnnotation(args[6])).toBe("(int * float)");
  });

  it("extracts type definitions (records and variants) and open modules", () => {
    const src = `
open Base
open Stdlib.List

type point = { x : float; y : float }
type color = Red | Green | Blue

let get_x (p : point) : float = p.x
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");

    expect(program.types["point"]).toBeDefined();
    expect(program.types["color"]).toBeDefined();

    const getXFn = program.functionsExported["get_x"];
    expect(getXFn).toBeDefined();
    const args = getXFn.getArgDefs();
    expect(args[0].getName()).toBe("p");
  });

  it("detects callees within a function body", () => {
    const src = `
let helper (x : int) : int = x + 1
let compute (x : int) : int =
  let a = helper x in
  String.length (string_of_int a)
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const computeFn = program.functionsExported["compute"];
    expect(computeFn).toBeDefined();

    const callees = computeFn.getCallees();
    expect(callees.has("helper")).toBeTrue();
    expect(callees.has("string_of_int")).toBeTrue();
  });

  it("classifies functions with missing type annotations as unsupported", () => {
    const src = `
let unannotated a b = a + b
`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    expect(program.functionsExported["unannotated"]).toBeUndefined();
    expect(program.functionsNotSupported["unannotated"]).toBeDefined();
    expect(program.functionsNotSupported["unannotated"].reason).toContain(
      "Missing type annotation"
    );
  });
});
