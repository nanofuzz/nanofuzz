import { BorrowSanitizer } from "./BorrowSanitizer";

describe("fuzzer/runners/rust/sanitizers/BorrowSanitizer", () => {
  let sanitizer: BorrowSanitizer;

  beforeEach(() => {
    sanitizer = new BorrowSanitizer();
  });

  it("has id 'borrow'", () => {
    expect(sanitizer.id).toBe("borrow");
  });

  it("configures build flags for borrow sanitizer", () => {
    const buildConfig = sanitizer.configureBuild({
      EXISTING_VAR: "true",
    });

    expect(buildConfig.rustflags).toContain("-Zsanitizer=borrow");
    expect(buildConfig.cargoArgs).toContain("-Zbuild-std=core,alloc,std");
    expect(buildConfig.env.RUSTUP_TOOLCHAIN).toBe("bsan");
    expect(buildConfig.env.EXISTING_VAR).toBe("true");
  });

  it("configures host environment", () => {
    const hostEnv = sanitizer.configureHostEnv({
      RUST_BACKTRACE: "1",
    });

    expect(hostEnv.RUST_BACKTRACE).toBe("1");
  });

  it("returns graceful error on detect when toolchain is missing", () => {
    // When tested on Darwin without bsan installed, it should return available: false with an explicit error
    const result = sanitizer.detect();
    if (!result.available) {
      expect(result.error).toBeDefined();
      expect(result.error?.length).toBeGreaterThan(0);
    } else {
      expect(result.toolchain).toBe("bsan");
    }
  });

  it("parses standard LLVM BorrowSanitizer abort error", () => {
    const stderr = `
==12345==ERROR: BorrowSanitizer: conflicting write to active shared borrow at 0x7ffee1234567
    #0 0x555555562143 in target::foo (src/target_instrumented.rs:42)
    #1 0x555555562400 in main (src/main.rs:100)
SUMMARY: BorrowSanitizer: conflicting write to active shared borrow
`;

    const diag = sanitizer.parseAbort(stderr, null);
    expect(diag).not.toBeNull();
    expect(diag?.name).toBe("BorrowSanitizerError");
    expect(diag?.summary).toContain(
      "conflicting write to active shared borrow"
    );
    expect(diag?.stack).toContain("target::foo");
  });

  it("parses bsan fatal error format", () => {
    const stderr = `
fatal error: BorrowSanitizer detected aliasing contract violation: mutable reference alias created
stack backtrace:
   0: bsan_rt::trap
   1: target::unsafe_alias
`;

    const diag = sanitizer.parseAbort(stderr, 134);
    expect(diag).not.toBeNull();
    expect(diag?.name).toBe("BorrowSanitizerError");
    expect(diag?.summary).toContain("aliasing contract violation");
    expect(diag?.stack).toContain("target::unsafe_alias");
  });

  it("returns null for non-sanitizer stderr and panics", () => {
    const normalPanic = `
thread 'main' panicked at src/lib.rs:10:5:
assertion \`left == right\` failed
  left: 2
 right: 3
stack backtrace:
   0: rust_begin_unwind
`;

    const diag = sanitizer.parseAbort(normalPanic, 101);
    expect(diag).toBeNull();
  });

  it("returns null for empty stderr", () => {
    expect(sanitizer.parseAbort("", 0)).toBeNull();
  });
});
