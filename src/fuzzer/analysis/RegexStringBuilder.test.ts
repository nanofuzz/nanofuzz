import seedrandom from "seedrandom";
import { ArgDef } from "./ArgDef";
import { create } from "./RegexStringBuilder";

const options = ArgDef.getDefaultOptions();

// Adapted from fast-check's stringMatching tests:
// https://github.com/dubzzz/fast-check/blob/main/packages/fast-check/test/unit/arbitrary/stringMatching.spec.ts
// (We aspire to be as broadly compatible as fast-check.)
describe("fuzzer/analysis/RegexStringBuilder:", () => {
  it("generates strings matching supported real-world patterns", () => {
    const realWorldOptions = {
      ...options,
      strLength: { min: 0, max: 256 },
    };
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
      // CSS color with negated class
      "\\A(?:#|0x)(?:[a-f0-9]{3}|[a-f0-9]{6})|(?:rgb|hsl)a?\\([^)]*\\)\\Z",
      // Emojis with Unicode property escape
      "\\A\\p{Letter}+\\Z",
      // Unicode codepoint ranges
      "\\A[\\u{1F600}-\\u{1F64F}]+\\Z",
      // Negative lookahead
      '\\A(?:(?!["\\\\])[\\p{L}\\p{N}])+\\Z',
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
      const matcher = new RegExp(
        regex.replace("\\A", "^").replace("\\Z", "$"),
        "u"
      );
      for (let index = 0; index < 50; index++) {
        const builder = create(
          regex,
          seedrandom(`${regex}:${index}`),
          realWorldOptions
        );
        expect(matcher.test(builder())).toBeTrue();
      }
    }
  });

  it("fails fast for unsupported regexes", () => {
    expect(() =>
      create("\\A(?<invalid)a\\Z", seedrandom("unsupported"), options)
    ).toThrowError(/Unsupported string regex/);
  });

  it("intersects strLength with regex length bounds", () => {
    const boundedOptions = {
      ...options,
      strLength: { min: 3, max: 5 },
    };
    const builder = create(
      "\\A[a-z]+\\Z",
      seedrandom("lengths"),
      boundedOptions
    );
    for (let index = 0; index < 50; index++) {
      const value = builder();
      expect(value.length).toBeGreaterThanOrEqual(3);
      expect(value.length).toBeLessThanOrEqual(5);
    }
  });

  it("fails fast for incompatible regex and strLength bounds", () => {
    expect(() =>
      create("\\A[a-z]{6}\\Z", seedrandom("impossible-lengths"), {
        ...options,
        strLength: { min: 0, max: 5 },
      })
    ).toThrowError(/conflicts with regex length/);
  });

  describe("permutation & alphabet Coverage", () => {
    it("Strategy A: achieves 100% permutation exhaustion for small finite regex domains", () => {
      const testCases = [
        {
          regex: "\\A[a-c]{2}\\Z",
          expectedPermutations: new Set([
            "aa",
            "ab",
            "ac",
            "ba",
            "bb",
            "bc",
            "ca",
            "cb",
            "cc",
          ]),
        },
        {
          regex: "\\A(cat|dog)-(1|2)\\Z",
          expectedPermutations: new Set(["cat-1", "cat-2", "dog-1", "dog-2"]),
        },
        {
          regex: "\\A[01]{3}\\Z",
          expectedPermutations: new Set([
            "000",
            "001",
            "010",
            "011",
            "100",
            "101",
            "110",
            "111",
          ]),
        },
      ];

      for (const { regex, expectedPermutations } of testCases) {
        const builder = create(
          regex,
          seedrandom(`strategy-a:${regex}`),
          options
        );
        const observed = new Set<string>();
        for (let i = 0; i < 1000; i++) {
          observed.add(builder());
        }
        expect(observed.size).toEqual(expectedPermutations.size);
        for (const expected of expectedPermutations) {
          expect(observed.has(expected)).toBeTrue();
        }
      }
    });

    it("Strategy B: achieves 100% alphabet reachability over sampled iterations", () => {
      const testCases = [
        {
          regex: "\\A[a-z]{1,5}\\Z",
          expectedAlphabet: new Set("abcdefghijklmnopqrstuvwxyz".split("")),
        },
        {
          regex: "\\A[\\u{1F600}-\\u{1F610}]+\\Z",
          expectedAlphabet: new Set(
            Array.from({ length: 0x1f610 - 0x1f600 + 1 }, (_, i) =>
              String.fromCodePoint(0x1f600 + i)
            )
          ),
        },
        {
          regex: "\\A\\p{Ll}{1,5}\\Z",
          expectedAlphabet: new Set("abcdefghijklmnopqrstuvwxyz".split("")),
        },
        {
          regex: '\\A(?:(?![\\"\\\\])[a-z])+\\Z',
          expectedAlphabet: new Set("abcdefghijklmnopqrstuvwxyz".split("")),
        },
      ];

      for (const { regex, expectedAlphabet } of testCases) {
        const builder = create(
          regex,
          seedrandom(`strategy-b:${regex}`),
          options
        );
        const observed = new Set<string>();
        for (let i = 0; i < 500; i++) {
          const generated = builder();
          for (const char of Array.from(generated)) {
            observed.add(char);
          }
        }
        expect(observed.size).toEqual(expectedAlphabet.size);
        for (const expectedChar of expectedAlphabet) {
          expect(observed.has(expectedChar)).toBeTrue();
        }
      }
    });
  });
});
