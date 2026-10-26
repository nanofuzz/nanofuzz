import { getSanitizerAdapter } from "./Registry";
import { NoneSanitizer } from "./NoneSanitizer";
import { BorrowSanitizer } from "./BorrowSanitizer";
import { AddressSanitizer } from "./AddressSanitizer";

describe("fuzzer/runners/rust/sanitizers/Registry", () => {
  it("resolves default 'none' sanitizer", () => {
    const adapter = getSanitizerAdapter();
    expect(adapter).toBeDefined();
    expect(adapter instanceof NoneSanitizer).toBeTrue();
    expect(adapter.id).toBe("none");
  });

  it("resolves explicit 'none' sanitizer", () => {
    const adapter = getSanitizerAdapter("none");
    expect(adapter).toBeDefined();
    expect(adapter instanceof NoneSanitizer).toBeTrue();
  });

  it("resolves 'borrow' sanitizer", () => {
    const adapter = getSanitizerAdapter("borrow");
    expect(adapter).toBeDefined();
    expect(adapter instanceof BorrowSanitizer).toBeTrue();
    expect(adapter.id).toBe("borrow");
  });

  it("resolves 'address' sanitizer", () => {
    const adapter = getSanitizerAdapter("address");
    expect(adapter).toBeDefined();
    expect(adapter instanceof AddressSanitizer).toBeTrue();
    expect(adapter.id).toBe("address");
  });

  it("throws on unknown sanitizer name without fallback", () => {
    expect(() => getSanitizerAdapter("nonexistent_sanitizer")).toThrowError(
      /Unknown Rust sanitizer 'nonexistent_sanitizer'/
    );
  });
});
