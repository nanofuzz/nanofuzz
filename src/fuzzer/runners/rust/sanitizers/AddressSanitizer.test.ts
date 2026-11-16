import { AddressSanitizer } from "./AddressSanitizer";

describe("fuzzer/runners/rust/sanitizers/AddressSanitizer", () => {
  let sanitizer: AddressSanitizer;

  beforeEach(() => {
    sanitizer = new AddressSanitizer();
  });

  it("has id 'address' and displayName 'AddressSanitizer'", () => {
    expect(sanitizer.id).toBe("address");
    expect(sanitizer.displayName).toBe("AddressSanitizer");
  });

  it("returns reproduction command for AddressSanitizer", () => {
    expect(sanitizer.getReproductionCommand()).toContain("-Zsanitizer=address");
    expect(sanitizer.getReproductionCommand()).toContain(
      "-Zbuild-std=core,alloc,std"
    );
  });

  it("configures build flags for address sanitizer", () => {
    const buildConfig = sanitizer.configureBuild({
      EXISTING_VAR: "true",
    });

    expect(buildConfig.rustflags).toContain("-Zsanitizer=address");
    expect(buildConfig.cargoArgs).toContain("-Zbuild-std=core,alloc,std");
    expect(buildConfig.env.RUSTUP_TOOLCHAIN).toBe("nightly");
    expect(buildConfig.env.EXISTING_VAR).toBe("true");
  });

  it("preserves explicit RUSTUP_TOOLCHAIN if already set", () => {
    const buildConfig = sanitizer.configureBuild({
      RUSTUP_TOOLCHAIN: "custom-nightly",
    });
    expect(buildConfig.env.RUSTUP_TOOLCHAIN).toBe("custom-nightly");
  });

  it("configures host environment", () => {
    const hostEnv = sanitizer.configureHostEnv({
      ASAN_OPTIONS: "detect_leaks=0",
    });
    expect(hostEnv.ASAN_OPTIONS).toBe("detect_leaks=0");
  });

  it("detects nightly availability or returns descriptive error", () => {
    const res = sanitizer.detect();
    if (res.available) {
      expect(res.toolchain).toBe("nightly");
    } else {
      expect(res.error).toContain(
        "AddressSanitizer requires a Rust nightly toolchain"
      );
    }
  });

  it("parses heap-buffer-overflow ASan abort error", () => {
    const stderr = `
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000014 at pc 0x555555555123 bp 0x7fffffffe000 sp 0x7fffffffdff8
READ of size 4 at 0x602000000014 thread T0
    #0 0x555555555122 in buggy_access /workspace/src/lib.rs:15:5
    #1 0x555555555200 in main /workspace/src/main.rs:20:9
SUMMARY: AddressSanitizer: heap-buffer-overflow /workspace/src/lib.rs:15:5 in buggy_access
`;

    const diag = sanitizer.parseAbort(stderr, 134);
    expect(diag).not.toBeNull();
    expect(diag?.name).toBe("AddressSanitizerError");
    expect(diag?.summary).toContain("heap-buffer-overflow");
    expect(diag?.stack).toContain("buggy_access");
  });

  it("parses stack-use-after-scope ASan abort error", () => {
    const stderr = `
==999==ERROR: AddressSanitizer: stack-use-after-scope on address 0x7fff1234
WRITE of size 1 at 0x7fff1234 thread T0
    #0 0x123456 in target::dangling /src/target.rs:10:5
`;

    const diag = sanitizer.parseAbort(stderr, null);
    expect(diag).not.toBeNull();
    expect(diag?.name).toBe("AddressSanitizerError");
    expect(diag?.summary).toContain("stack-use-after-scope");
    expect(diag?.stack).toContain("target::dangling");
  });

  it("returns null for non-sanitizer stderr", () => {
    const normalStderr = "fatal error: failed to compile\n";
    expect(sanitizer.parseAbort(normalStderr, 1)).toBeNull();
  });

  it("returns null for empty stderr", () => {
    expect(sanitizer.parseAbort("", 0)).toBeNull();
  });
});
