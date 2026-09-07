import seedrandom from "seedrandom";
import { ArgOptions } from "./Types";

type RegexNode =
  | { type: "chars"; chars: readonly string[] }
  | { type: "sequence"; nodes: RegexNode[] }
  | { type: "choice"; nodes: RegexNode[] }
  | { type: "repeat"; node: RegexNode; min: number; max: number }
  | { type: "assertion"; kind: "wordBoundary" | "nonWordBoundary" }
  | { type: "lookahead"; negative: boolean; node: RegexNode };

type LengthBounds = { min: number; max: number };

const DIGIT_CHARS: readonly string[] = Object.freeze("0123456789".split(""));
const WORD_CHARS: readonly string[] = Object.freeze(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".split("")
);
const SPACE_CHARS: readonly string[] = Object.freeze([" ", "\t", "\n", "\r"]);

/**
 * Builds a structural string generator for the supported regular-expression
 * subset. Unsupported constructs throw before any client input is made.
 *
 * @param regex regular expression to satisfy
 * @param prng pseudo-random number generator
 * @param options string generation options
 * @returns a generator that produces strings matching the regex
 */
export const create = (
  regex: string,
  prng: seedrandom.prng,
  options: ArgOptions
): (() => string) => {
  const source = regex.replace(/^\\A/, "^").replace(/\\Z$/, "$");
  let index = 0;

  const fail = (message: string): never => {
    throw new Error(`Unsupported string regex '${regex}': ${message}`);
  };

  const filterCharset = (testRegex: RegExp): string[] => {
    const charSetChars = Array.from(options.strCharset);
    const matched = charSetChars.filter((c) => testRegex.test(c));
    if (matched.length > 0) return matched;
    const fallbackPool = Array.from(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ \t\n\r"
    );
    return fallbackPool.filter((c) => testRegex.test(c));
  };

  const charsForEscape = (escape: string): readonly string[] => {
    switch (escape) {
      case "d":
        return DIGIT_CHARS;
      case "D":
        return Array.from(options.strCharset).filter((c) => !/\d/.test(c));
      case "w":
        return WORD_CHARS;
      case "W":
        return Array.from(options.strCharset).filter((c) => !/\w/.test(c));
      case "s":
        return SPACE_CHARS;
      case "S":
        return Array.from(options.strCharset).filter((c) => !/\s/.test(c));
      default:
        if ("\\.^$|?*+()[]{}-'\"/".includes(escape) || /[^\w\s]/.test(escape)) return [escape];
        return fail(`escape \\${escape}`);
    }
  };

  const parseEscapeSequence = (): readonly string[] => {
    if (source[index] !== "\\") {
      fail("expected escape sequence");
    }
    const rest = source.slice(index + 1);

    // Unicode property escapes \p{Property} / \P{Property}
    const unicodePropMatch = rest.match(/^([pP])\{([A-Za-z0-9_]+)\}/);
    if (unicodePropMatch) {
      const isNegated = unicodePropMatch[1] === "P";
      const prop = unicodePropMatch[2];
      index += 1 + unicodePropMatch[0].length;
      try {
        const re = new RegExp(
          "^\\" + (isNegated ? "P" : "p") + "{" + prop + "}$",
          "u"
        );
        return filterCharset(re);
      } catch {
        fail(`unicode property escape \\${unicodePropMatch[0]}`);
      }
    }

    // Unicode code point escape \u{HEX}
    const unicodeHexMatch = rest.match(/^u\{([0-9a-fA-F]+)\}/);
    if (unicodeHexMatch) {
      index += 1 + unicodeHexMatch[0].length;
      const cp = parseInt(unicodeHexMatch[1], 16);
      if (isNaN(cp)) fail("invalid unicode codepoint");
      return [String.fromCodePoint(cp)];
    }

    // Unicode 4-hex escape \uXXXX or 2-hex escape \xXX
    const unicode4Match = rest.match(
      /^(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/
    );
    if (unicode4Match) {
      index += 1 + unicode4Match[0].length;
      const hex = unicode4Match[1] ?? unicode4Match[2];
      const cp = parseInt(hex, 16);
      return [String.fromCodePoint(cp)];
    }

    // Single character escapes \n, \r, \t, \f, \v, \0
    if (rest.startsWith("n")) {
      index += 2;
      return ["\n"];
    }
    if (rest.startsWith("r")) {
      index += 2;
      return ["\r"];
    }
    if (rest.startsWith("t")) {
      index += 2;
      return ["\t"];
    }
    if (rest.startsWith("0")) {
      index += 2;
      return ["\0"];
    }

    // Standard single escapes (\d, \D, \w, \W, \s, \S, or escaped symbol)
    index++; // consume '\'
    const char = source[index++];
    return charsForEscape(char);
  };

  const parseClassItem = (): readonly string[] => {
    if (source[index] === "\\") {
      return parseEscapeSequence();
    }
    const char = source[index++];
    return [char];
  };

  const parseClass = (): RegexNode => {
    index++; // consume '['
    let isNegated = false;
    if (source[index] === "^") {
      isNegated = true;
      index++;
    }
    const chars: string[] = [];
    while (index < source.length && source[index] !== "]") {
      const item1 = parseClassItem();
      if (source[index] === "-" && source[index + 1] !== "]") {
        index++; // consume '-'
        const item2 = parseClassItem();
        if (item1.length === 1 && item2.length === 1) {
          const startCp = item1[0].codePointAt(0);
          const endCp = item2[0].codePointAt(0);
          if (
            startCp !== undefined &&
            endCp !== undefined &&
            startCp <= endCp
          ) {
            for (let code = startCp; code <= endCp; code++) {
              chars.push(String.fromCodePoint(code));
            }
          } else {
            fail("character class range");
          }
        } else {
          chars.push(...item1, "-", ...item2);
        }
      } else {
        chars.push(...item1);
      }
    }
    if (source[index++] !== "]") fail("character class");

    let finalChars = Array.from(new Set(chars));
    if (isNegated) {
      const excluded = new Set(finalChars);
      finalChars = Array.from(options.strCharset).filter(
        (c) => !excluded.has(c)
      );
      if (!finalChars.length) {
        const fallback = Array.from(
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ "
        );
        finalChars = fallback.filter((c) => !excluded.has(c));
      }
    }
    if (!finalChars.length) fail("character class");
    return { type: "chars", chars: finalChars };
  };

  const parseAtom = (): RegexNode => {
    const char = source[index++];
    if (char === "[") {
      index--;
      return parseClass();
    }
    if (char === "(") {
      if (source[index] === "?") {
        if (source[index + 1] === ":") {
          index += 2;
        } else if (source[index + 1] === "!" || source[index + 1] === "=") {
          const isNegative = source[index + 1] === "!";
          index += 2;
          const node = parseChoice();
          if (source[index++] !== ")") fail("unclosed group");
          return { type: "lookahead", negative: isNegative, node };
        } else {
          fail("special group");
        }
      }
      const node = parseChoice();
      if (source[index++] !== ")") fail("unclosed group");
      return node;
    }
    if (char === "\\") {
      const next = source[index];
      if (next === "b") {
        index++;
        return { type: "assertion", kind: "wordBoundary" };
      }
      if (next === "B") {
        index++;
        return { type: "assertion", kind: "nonWordBoundary" };
      }
      index--; // back up so parseEscapeSequence can read '\\'
      const escapedChars = parseEscapeSequence();
      return { type: "chars", chars: escapedChars };
    }
    if (char === ".")
      return { type: "chars", chars: Array.from(options.strCharset) };
    if ("^$|)*+?{}]".includes(char)) fail(`token '${char}'`);
    return { type: "chars", chars: [char] };
  };

  const parseQuantifier = (node: RegexNode): RegexNode => {
    const char = source[index];
    if (char === "?") {
      index++;
      return { type: "repeat", node, min: 0, max: 1 };
    }
    if (char === "*") {
      index++;
      return { type: "repeat", node, min: 0, max: options.strLength.max };
    }
    if (char === "+") {
      index++;
      return {
        type: "repeat",
        node,
        min: 1,
        max: Math.max(1, options.strLength.max),
      };
    }
    if (char !== "{") return node;
    const match = source.slice(index).match(/^\{(\d+)(?:,(\d*)?)?\}/);
    if (match === null) return fail("quantifier");
    index += match[0].length;
    const min = Number(match[1]);
    const max =
      match[2] === undefined
        ? min
        : match[2] === ""
          ? options.strLength.max
          : Number(match[2]);
    if (min > max) fail("quantifier range");
    return { type: "repeat", node, min, max };
  };

  const parseSequence = (): RegexNode => {
    const nodes: RegexNode[] = [];
    while (index < source.length && !"|)$".includes(source[index]))
      nodes.push(parseQuantifier(parseAtom()));
    return { type: "sequence", nodes };
  };

  const parseChoice = (): RegexNode => {
    const nodes = [parseSequence()];
    while (source[index] === "|") {
      index++;
      nodes.push(parseSequence());
    }
    return nodes.length === 1 ? nodes[0] : { type: "choice", nodes };
  };

  if (source[index] === "^") index++;
  const root = parseChoice();
  if (source[index] === "$") index++;
  if (index !== source.length) fail("trailing input");

  const boundsFor = (node: RegexNode): LengthBounds => {
    switch (node.type) {
      case "chars":
        return { min: 1, max: 1 };
      case "assertion":
      case "lookahead":
        return { min: 0, max: 0 };
      case "sequence":
        return node.nodes.reduce(
          (bounds, child) => {
            const childBounds = boundsFor(child);
            return {
              min: bounds.min + childBounds.min,
              max: bounds.max + childBounds.max,
            };
          },
          { min: 0, max: 0 }
        );
      case "choice": {
        const childBounds = node.nodes.map(boundsFor);
        return {
          min: Math.min(...childBounds.map((bounds) => bounds.min)),
          max: Math.max(...childBounds.map((bounds) => bounds.max)),
        };
      }
      case "repeat": {
        const childBounds = boundsFor(node.node);
        return {
          min: node.min * childBounds.min,
          max: node.max * childBounds.max,
        };
      }
    }
  };

  const regexBounds = boundsFor(root);
  const effectiveBounds = {
    min: Math.max(regexBounds.min, options.strLength.min),
    max: Math.min(regexBounds.max, options.strLength.max),
  };
  if (effectiveBounds.min > effectiveBounds.max) {
    fail(
      `length range ${options.strLength.min}-${options.strLength.max} conflicts with regex length ${regexBounds.min}-${regexBounds.max}`
    );
  }

  let matcher: RegExp;
  try {
    matcher = new RegExp(source, "u");
  } catch {
    matcher = new RegExp(source);
  }

  const generate = (node: RegexNode): string => {
    switch (node.type) {
      case "chars":
        return node.chars[Math.floor(prng() * node.chars.length)];
      case "sequence":
        return node.nodes.map(generate).join("");
      case "choice": {
        return generate(node.nodes[Math.floor(prng() * node.nodes.length)]);
      }
      case "assertion":
      case "lookahead":
        return "";
      case "repeat": {
        const range = node.max - node.min + 1;
        // Favor shorter expansions so several unbounded repetitions can still
        // fit within the effective string-length range.
        const count = node.min + Math.floor(prng() * prng() * range);
        return Array.from({ length: count }, () => generate(node.node)).join(
          ""
        );
      }
    }
  };

  return () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = generate(root);
      if (
        value.length >= effectiveBounds.min &&
        value.length <= effectiveBounds.max &&
        matcher.test(value)
      ) {
        return value;
      }
    }
    throw new Error(
      `Regex generator could not satisfy the effective length range ${effectiveBounds.min}-${effectiveBounds.max} for '${regex}'`
    );
  };
};
