import seedrandom from "seedrandom";
import { ArgDef } from "./ArgDef";
import { create } from "./RegexStringBuilder";

const options = ArgDef.getDefaultOptions();

// Adapted from fast-check's stringMatching tests:
// https://github.com/dubzzz/fast-check/blob/main/packages/fast-check/test/unit/arbitrary/stringMatching.spec.ts
// (We aspire to be as broadly compatible as fast-check.)
describe("fuzzer/analysis/RegexStringBuilder:", () => {
  it("generates strings matching supported real-world patterns", () => {
    const regexes = [
      // Identifier
      "\\A[a-zA-Z_][a-zA-Z0-9_]{0,4}\\Z",
      // Animal label
      "\\A(cat|dog)-\\d{2}\\Z",
      // Hexadecimal CSS color
      "\\A#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})\\Z",
      // IPv4-like address
      "\\A\\d+\\.\\d+\\.\\d+\\.\\d+\\Z",
      // GitHub profile URL
      "\\Ahttps?://(www\\.)?github\\.com/[A-Za-z0-9]+\\Z",
      // Twitter status URL
      "\\Ahttps?://twitter\\.com/[A-Za-z0-9_]+/status/[0-9]+\\Z",
      // Simplified email address
      "\\A[a-zA-Z0-9._-]+@[a-zA-Z0-9-]+\\.[a-zA-Z]{2,}\\Z",
      // RGB CSS color
      "\\Argb\\(\\s*(\\d|[1-9]\\d|1\\d\\d|2[0-5])\\s*,\\s*(\\d|[1-9]\\d|1\\d\\d|2[0-5])\\s*,\\s*(\\d|[1-9]\\d|1\\d\\d|2[0-5])\\s*\\)\\Z",
    ];

    /*
     * Remaining hardcoded fast-check examples are intentionally commented out
     * until their regex features are supported by NaNofuzz's structural
     * builder:
     *
     * // CSS color and precise IPv4: unsupported non-capturing groups (?:...).
     * // IPv6: unsupported non-capturing groups and word-boundary assertions.
     * // RFC-1123 email: unsupported non-capturing groups (?:...).
     * // RFC-5322 email: unsupported negated character classes [^...].
     * // General URL: unsupported character-class forms.
     * // Emojis and non-emojis: unsupported Unicode property escapes \p and \P.
     */

    for (const regex of regexes) {
      const matcher = new RegExp(regex.replace("\\A", "^").replace("\\Z", "$"));
      for (let index = 0; index < 50; index++) {
        const builder = create(regex, seedrandom(`${regex}:${index}`), options);
        expect(matcher.test(builder())).toBeTrue();
      }
    }
  });

  it("fails fast for unsupported regexes", () => {
    expect(() =>
      create("\\A(?=a)a\\Z", seedrandom("unsupported"), options)
    ).toThrowError(/Unsupported string regex/);
  });
});
