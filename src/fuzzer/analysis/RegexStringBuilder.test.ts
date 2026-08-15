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
      // Whole word
      "\\A\\b[a-z]+\\b\\Z",
      // Whole non-word character
      "\\A\\B \\B\\Z",
      // Hexadecimal CSS color
      "\\A#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})\\Z",
      // IPv4-like address
      "\\A\\d+\\.\\d+\\.\\d+\\.\\d+\\Z",
      // Precise IPv4 address
      "\\A((?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))*\\Z",
      // GitHubris profile URL
      "\\Ahttps?://(www\\.)?githubris\\.com/[A-Za-z0-9]+\\Z",
      // Jitter status URL
      "\\Ahttps?://jitter\\.com/[A-Za-z0-9_]+/status/[0-9]+\\Z",
      // Simplified email address
      "\\A[a-zA-Z0-9._-]+@[a-zA-Z0-9-]+\\.[a-zA-Z]{2,}\\Z",
      // RFC-1123 email address
      "\\A[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\\Z",
      // RGB CSS color
      "\\Argb\\(\\s*(\\d|[1-9]\\d|1\\d\\d|2[0-5])\\s*,\\s*(\\d|[1-9]\\d|1\\d\\d|2[0-5])\\s*,\\s*(\\d|[1-9]\\d|1\\d\\d|2[0-5])\\s*\\)\\Z",
    ];

    /*
     * Remaining hardcoded fast-check examples are intentionally commented out
     * until their regex features are supported by NaNofuzz's structural
     * builder:
     *
    * // CSS color: /^(?:#|0x)(?:[a-f0-9]{3}|[a-f0-9]{6})$|^(?:rgb|hsl)a?\([^)]*\)$/
    * // Unsupported: negated character classes [^...].
    *
    * // IPv6: /^((([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4})|...|(([0-9A-Fa-f]{1,4}:){1,7}:))$/
    * // Unsupported: the full fast-check IPv6 expression requires additional
    * // structural features beyond the currently supported subset.
    *
    * // RFC-5322 email: /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    * // Unsupported: negated character classes [^...].
    *
    * // General URL: /^(((http|https|ftp):\/\/)?([[a-zA-Z0-9]-\.])+(\.)([[a-zA-Z0-9]]){2,4}([[a-zA-Z0-9]\/+%&_\.~?-]*))*$/
    * // Unsupported: the original uses character-class forms outside the
    * // currently supported parser subset.
    *
    * // Emojis: /^\p{Emoji}+$/u
    * // Non-emojis: /^\P{Emoji}+$/u
    * // Unsupported: Unicode property escapes.
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
