import seedrandom from "seedrandom";
import { ArgOptions } from "./Types";

type RegexNode =
  | { type: "chars"; chars: string[] }
  | { type: "sequence"; nodes: RegexNode[] }
  | { type: "choice"; nodes: RegexNode[] }
  | { type: "repeat"; node: RegexNode; min: number; max: number }
  | { type: "assertion"; kind: "wordBoundary" | "nonWordBoundary" };

type LengthBounds = { min: number; max: number };

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
  const charsForEscape = (escape: string): string[] => {
    switch (escape) {
      case "d":
        return "0123456789".split("");
      case "w":
        return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".split(
          ""
        );
      case "s":
        return [" ", "\t", "\n", "\r"];
      default:
        if ("\\.^$|?*+()[]{}".includes(escape)) return [escape];
        return fail(`escape \\${escape}`);
    }
  };
  const parseClass = (): RegexNode => {
    index++;
    if (source[index] === "^") fail("negated character class");
    const chars: string[] = [];
    while (index < source.length && source[index] !== "]") {
      const start = source[index++];
      if (start === "\\") {
        chars.push(...charsForEscape(source[index++]));
        continue;
      }
      if (source[index] === "-" && source[index + 1] !== "]") {
        index++;
        const end = source[index++];
        if (
          end === "\\" ||
          start.codePointAt(0) === undefined ||
          end.codePointAt(0) === undefined
        )
          fail("character class range");
        for (
          let code = start.codePointAt(0)!;
          code <= end.codePointAt(0)!;
          code++
        )
          chars.push(String.fromCodePoint(code));
      } else chars.push(start);
    }
    if (source[index++] !== "]" || !chars.length) fail("character class");
    return { type: "chars", chars };
  };
  const parseAtom = (): RegexNode => {
    const char = source[index++];
    if (char === "[") {
      index--;
      return parseClass();
    }
    if (char === "(") {
      // Capturing and non-capturing groups have identical generation
      // semantics. Other `(?...)` forms remain unsupported because they
      // affect matching without consuming text.
      if (source[index] === "?") {
        if (source[index + 1] !== ":") fail("special group");
        index += 2;
      }
      const node = parseChoice();
      if (source[index++] !== ")") fail("unclosed group");
      return node;
    }
    if (char === "\\") {
      const escaped = source[index++];
      if (escaped === "b") {
        return { type: "assertion", kind: "wordBoundary" };
      }
      if (escaped === "B") {
        return { type: "assertion", kind: "nonWordBoundary" };
      }
      return { type: "chars", chars: charsForEscape(escaped) };
    }
    if (char === ".")
      return { type: "chars", chars: options.strCharset.split("") };
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
  const matcher = new RegExp(source);
  const generate = (node: RegexNode): string => {
    switch (node.type) {
      case "chars":
        return node.chars[Math.floor(prng() * node.chars.length)];
      case "sequence":
        return node.nodes.map(generate).join("");
      case "choice": {
        return generate(node.nodes[Math.floor(prng() * node.nodes.length)]);
      }
      case "assertion": return "";
      case "repeat": {
        const range = node.max - node.min + 1;
        // Favor shorter expansions so several unbounded repetitions can still
        // fit within the effective string-length range.
        const count =
          node.min + Math.floor(prng() * prng() * range);
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
