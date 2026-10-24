import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";
import { RustProgram } from "./RustProgram";
import * as Parser from "../../adapters/ParserAdapter";

describe("fuzzer/analysis/rust/RustProgram: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("identifies Rust source files and recognizes rust language", () => {
    expect(RustProgram.understands({ filename: "test.rs" })).toBeTrue();
    expect(RustProgram.understands({ lang: "rust" })).toBeTrue();
    expect(RustProgram.understands({ filename: "test.py" })).toBeFalse();
    expect(RustProgram.understands({ filename: "test.ts" })).toBeFalse();
  });

  it("parses functions with primitive types, visibility, and return types", () => {
    const src = `
/// Adds two numbers together
pub fn add(a: i32, b: f64) -> f64 {
    (a as f64) + b
}

fn private_helper(flag: bool) {
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust", "lib.rs");
    expect(program.lang).toBe("rust");

    const exportedFns = program.functionsExported;
    expect("add" in exportedFns).toBeTrue();
    expect("private_helper" in exportedFns).toBeFalse();

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

  it("parses integer widths correctly: u8, i8, u16, i16, u32, i64, u64", () => {
    const src = `
pub fn process_nums(
    byte: u8,
    sbyte: i8,
    small_u: u16,
    small_i: i16,
    big_s: i64,
    big_u: u64
) -> () {
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");
    const fnDef = program.functionsExported["process_nums"];
    expect(fnDef).toBeDefined();
    expect(fnDef.isVoid()).toBeTrue();

    const args = fnDef.getArgDefs();
    expect(args.length).toBe(6);

    // u8
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

    // i64 (BIGINT)
    expect(args[4].getType()).toBe(ArgTag.BIGINT);
    expect(args[4].getIntervals()[0].min).toBe(-9223372036854775808n);
    expect(args[4].getIntervals()[0].max).toBe(9223372036854775807n);

    // u64 (BIGINT)
    expect(args[5].getType()).toBe(ArgTag.BIGINT);
    expect(args[5].getIntervals()[0].min).toBe(0n);
    expect(args[5].getIntervals()[0].max).toBe(18446744073709551615n);
  });

  it("parses String, &str, Vec, Option, and tuple types", () => {
    const src = `
pub fn complex_types(
    name: String,
    prefix: &str,
    items: Vec<i32>,
    maybe_count: Option<u32>,
    pair: (bool, f64)
) -> Vec<String> {
    vec![name]
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");
    const fnDef = program.functionsExported["complex_types"];
    expect(fnDef).toBeDefined();

    const args = fnDef.getArgDefs();
    expect(args[0].getName()).toBe("name");
    expect(args[0].getType()).toBe(ArgTag.STRING);

    expect(args[1].getName()).toBe("prefix");
    expect(args[1].getType()).toBe(ArgTag.STRING);

    expect(args[2].getName()).toBe("items");
    expect(args[2].getDim()).toBe(1);
    expect(args[2].getType()).toBe(ArgTag.NUMBER);

    expect(args[3].getName()).toBe("maybe_count");
    expect(args[3].isOptional()).toBeTrue();
    expect(args[3].getType()).toBe(ArgTag.NUMBER);

    expect(args[4].getName()).toBe("pair");
    expect(args[4].getType()).toBe(ArgTag.TUPLE);
    const pairChildren = args[4].getChildren();
    expect(pairChildren.length).toBe(2);
    expect(pairChildren[0].getType()).toBe(ArgTag.BOOLEAN);
    expect(pairChildren[1].getType()).toBe(ArgTag.NUMBER);

    const ret = fnDef.getReturnArg();
    expect(ret).toBeDefined();
    expect(ret?.getDim()).toBe(1);
    expect(ret?.getType()).toBe(ArgTag.STRING);
  });

  it("resolves local type aliases", () => {
    const src = `
type UserId = u32;

pub fn get_user(id: UserId) -> bool {
    id > 0
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");
    expect("UserId" in program.types).toBeTrue();

    const fnDef = program.functionsExported["get_user"];
    expect(fnDef).toBeDefined();
    const arg = fnDef.getArgDefs()[0];
    expect(arg.getType()).toBe(ArgTag.NUMBER);
    expect(arg.getOptions().numInteger).toBeTrue();
    expect(arg.getIntervals()[0].max).toBe(4294967295);
  });

  it("handles async functions and doc comments", () => {
    const src = `
/// Fetches a remote status asynchronously
pub async fn check_status(code: i32) -> bool {
    code == 200
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");
    const fnDef = program.functionsExported["check_status"];
    expect(fnDef).toBeDefined();
    expect(fnDef.isAsync()).toBeTrue();
    expect(fnDef.getCmt()).toContain("Fetches a remote status asynchronously");
  });

  it("flags non-top-level functions (methods, impl blocks, traits, inner functions) as unsupported", () => {
    const src = `
pub struct Counter {
    pub count: i32,
}

impl Counter {
    pub fn new() -> Counter {
        Counter { count: 0 }
    }

    pub fn increment(&mut self, amount: i32) {
        self.count += amount;
    }

    pub fn get_count(&self) -> i32 {
        self.count
    }
}

pub trait Describable {
    fn describe(&self) -> String {
        String::from("default")
    }
}

pub fn outer_func(x: i32) -> i32 {
    fn inner_func(y: i32) -> i32 {
        y * 2
    }
    inner_func(x)
}

mod internal {
    pub fn module_func(x: i32) -> i32 { x }
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");

    // Top-level function outer_func is supported
    expect(program.functions["outer_func"]).toBeDefined();

    // Associated functions and methods in impl blocks are unsupported
    expect(program.functions["new"]).toBeUndefined();
    expect(program.functions["increment"]).toBeUndefined();
    expect(program.functions["get_count"]).toBeUndefined();
    expect(program.functionsNotSupported["new"]).toBeDefined();
    expect(program.functionsNotSupported["increment"]).toBeDefined();
    expect(program.functionsNotSupported["get_count"]).toBeDefined();

    // Trait methods, inner functions, and inline module functions are unsupported
    expect(program.functions["describe"]).toBeUndefined();
    expect(program.functions["inner_func"]).toBeUndefined();
    expect(program.functions["module_func"]).toBeUndefined();
    expect(program.functionsNotSupported["describe"]).toBeDefined();
    expect(program.functionsNotSupported["inner_func"]).toBeDefined();
    expect(program.functionsNotSupported["module_func"]).toBeDefined();
  });

  it("flags generic functions with type parameters as unsupported", () => {
    const src = `
pub fn identity<T>(val: T) -> T {
    val
}

pub fn with_bound<T: std::fmt::Debug>(val: T) {
    println!("{:?}", val);
}

pub fn with_lifetime<'a>(s: &'a str) -> &'a str {
    s
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");

    // Generic type parameters are unsupported
    expect(program.functions["identity"]).toBeUndefined();
    expect(program.functions["with_bound"]).toBeUndefined();
    expect(program.functionsNotSupported["identity"]).toBeDefined();
    expect(program.functionsNotSupported["with_bound"]).toBeDefined();

    // Lifetime parameters only are supported
    expect(program.functions["with_lifetime"]).toBeDefined();
  });

  it("flags functions with unsupported or unresolved argument types as unsupported", () => {
    const src = `
pub struct UserPayload {
    pub id: u64,
}

pub enum ActionKind {
    Start,
    Stop,
}

pub fn handle_struct(payload: UserPayload) -> bool {
    payload.id > 0
}

pub fn handle_enum(kind: ActionKind) -> bool {
    true
}

pub fn handle_unknown(conn: DatabaseConnection) -> bool {
    true
}

pub fn handle_mut_ref(x: &mut i32) {
    *x += 1;
}

pub fn handle_raw_ptr(p: *const i32) -> i32 {
    unsafe { *p }
}

pub fn handle_fn_ptr(cb: fn(i32) -> i32) -> i32 {
    cb(42)
}

pub fn handle_dyn_trait(d: &dyn std::fmt::Display) {
}

pub fn handle_unresolved_collection(items: Vec<UnresolvedItem>) -> usize {
    items.len()
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");

    expect(program.functions["handle_struct"]).toBeUndefined();
    expect(program.functions["handle_enum"]).toBeUndefined();
    expect(program.functions["handle_unknown"]).toBeUndefined();
    expect(program.functions["handle_mut_ref"]).toBeUndefined();
    expect(program.functions["handle_raw_ptr"]).toBeUndefined();
    expect(program.functions["handle_fn_ptr"]).toBeUndefined();
    expect(program.functions["handle_dyn_trait"]).toBeUndefined();
    expect(program.functions["handle_unresolved_collection"]).toBeUndefined();

    expect(program.functionsNotSupported["handle_struct"]).toBeDefined();
    expect(program.functionsNotSupported["handle_struct"].argument).toBe(
      "payload"
    );

    expect(program.functionsNotSupported["handle_enum"]).toBeDefined();
    expect(program.functionsNotSupported["handle_enum"].argument).toBe("kind");

    expect(program.functionsNotSupported["handle_unknown"]).toBeDefined();
    expect(program.functionsNotSupported["handle_unknown"].argument).toBe(
      "conn"
    );

    expect(program.functionsNotSupported["handle_mut_ref"]).toBeDefined();
    expect(program.functionsNotSupported["handle_raw_ptr"]).toBeDefined();
    expect(program.functionsNotSupported["handle_fn_ptr"]).toBeDefined();
    expect(program.functionsNotSupported["handle_dyn_trait"]).toBeDefined();
    expect(
      program.functionsNotSupported["handle_unresolved_collection"]
    ).toBeDefined();
  });

  it("generates correct Rust type annotations", () => {
    const src = `
pub fn dummy(
    a: i32,
    b: f64,
    c: bool,
    d: String,
    e: Vec<i32>,
    f: Option<String>
) {}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");
    const fnDef = program.functionsExported["dummy"];
    const args = fnDef.getArgDefs();

    expect(RustProgram.getTypeAnnotation(args[0])).toBe("i32");
    expect(RustProgram.getTypeAnnotation(args[1])).toBe("f64");
    expect(RustProgram.getTypeAnnotation(args[2])).toBe("bool");
    expect(RustProgram.getTypeAnnotation(args[3])).toBe("String");
    expect(RustProgram.getTypeAnnotation(args[4])).toBe("Vec<i32>");
    expect(RustProgram.getTypeAnnotation(args[5])).toBe("Option<String>");
  });

  it("identifies callees called within function bodies", () => {
    const src = `
fn helper_a() -> i32 { 1 }
fn helper_b() -> i32 { 2 }

pub fn caller() -> i32 {
    let x = helper_a();
    let y = helper_b();
    x + y
}
`;
    const program = ProgramFactory.fromSource(() => src, "rust");
    const callees = program.getCallees("caller");
    expect(callees.has("helper_a")).toBeTrue();
    expect(callees.has("helper_b")).toBeTrue();
    expect(callees.has("non_existent")).toBeFalse();
  });

  it("recursively discovers local modules and handles #[path = '...'] attributes", () => {
    const tmp = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-mod-test-")
    );
    try {
      const rootRs = path.join(tmp, "root.rs");
      const helperRs = path.join(tmp, "helper.rs");
      const subDir = path.join(tmp, "helper");
      fs.mkdirSync(subDir, { recursive: true });
      const subRs = path.join(subDir, "sub.rs");
      const customRs = path.join(tmp, "my_custom.rs");

      fs.writeFileSync(
        rootRs,
        `mod helper;
#[path = "my_custom.rs"]
mod custom;
pub fn entry() {}
`
      );
      fs.writeFileSync(helperRs, `pub mod sub;\npub fn h() {}\n`);
      fs.writeFileSync(subRs, `pub fn s() {}\n`);
      fs.writeFileSync(customRs, `pub fn c() {}\n`);

      const discovered = RustProgram.findLocalModules(rootRs);
      expect(discovered.length).toBe(3);
      expect(discovered).toContain(fs.realpathSync(helperRs));
      expect(discovered).toContain(fs.realpathSync(subRs));
      expect(discovered).toContain(fs.realpathSync(customRs));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts direct external crate imports while ignoring standard and internal crates", () => {
    const tmp = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-crates-test-")
    );
    try {
      const srcFile = path.join(tmp, "main.rs");
      fs.writeFileSync(
        srcFile,
        `use std::collections::HashMap;
use core::fmt;
use alloc::vec::Vec;
use crate::local_mod;
use super::parent_mod;
use self::sibling;
use nanofuzz_runtime::assume;
use regex::Regex;
use serde::{Serialize, Deserialize};
extern crate itertools;
use itoa as custom_itoa;

pub fn test_fn() {}
`
      );

      const crates = RustProgram.findDirectCrates(srcFile);
      expect(crates.length).toBe(4);
      expect(crates).toContain("regex");
      expect(crates).toContain("serde");
      expect(crates).toContain("itertools");
      expect(crates).toContain("itoa");
      expect(crates).not.toContain("std");
      expect(crates).not.toContain("core");
      expect(crates).not.toContain("alloc");
      expect(crates).not.toContain("crate");
      expect(crates).not.toContain("nanofuzz_runtime");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
