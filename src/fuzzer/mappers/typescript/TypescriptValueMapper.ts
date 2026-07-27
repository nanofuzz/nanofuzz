import * as JSONN from "../../../Jsonn";
import Parser from "tree-sitter";
import TypescriptGrammar from "tree-sitter-typescript";
import { isKeyedObject } from "../../../Util";

// Type definitions are broken in tree-sitter-typescript
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const Typescript: Parser.Language =
  TypescriptGrammar.typescript as Parser.Language;

/**
 * Accepts an arbitrary JavaScript value and returns a string representing
 * that value in valid TypeScript/JavaScript format.
 * Supports `undefined` explicitly (both in object properties and array items).
 *
 * @param `jsValue` An arbitrary JavaScript value
 * @returns A string formatted as a valid TypeScript expression
 */
export function toTypescript(jsValue: unknown): string {
  return toJavascriptValues(jsValue);
}

/**
 * Converts a snippet of Javacript code containing a value into
 * a corresponding Javascript representation.
 *
 * @param `text` textual representation of a Javascript value
 * @returns Javascript value corresponding to `text`
 */
export function fromTypescript<T>(text: string): T {
  return toJavascriptValue(text) as T;
}

// ------------- From Javascript value to Javascript string -------------

/**
 * Recursively converts Javascript booleans, null/undefined, arrays, and objects
 * to match Python structures.
 *
 * @param `val` arbitrary Javascript value
 * @returns `val` where JS values are mapped to Python values
 */
function toJavascriptValues(val: unknown): string {
  if (val === undefined) {
    return "undefined";
  }

  if (val === null) {
    return "null";
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "number") {
    if (Object.is(val, NaN)) return "NaN";
    if (Object.is(val, Infinity)) return "Infinity";
    if (Object.is(val, -Infinity)) return "-Infinity";
    return String(val);
  }

  if (typeof val === "string") {
    return JSON.stringify(val); // handles quotes and escapes
  }

  if (Array.isArray(val)) {
    const items = val.map((item) => toJavascriptValues(item));
    return `[${items.join(", ")}]`;
  }

  if (val !== null && typeof val === "object") {
    const entries: string[] = [];
    if (isKeyedObject(val)) {
      for (const key of Object.keys(val)) {
        const propValue = val[key];
        const formattedKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
          ? key
          : JSON.stringify(key); // Quote key if not a valid identifier
        const formattedValue = toJavascriptValues(propValue);
        entries.push(`${formattedKey}: ${formattedValue}`);
      }
    }
    return `{${entries.join(", ")}}`;
  }

  if (typeof val === "function") {
    throw new Error("Functions are not supported");
  }

  if (typeof val === "bigint") {
    throw new Error("Bigints are not supported");
  }

  if (typeof val === "symbol") {
    throw new Error("Symbols are not supported");
  }

  return String(val);
}

// ------------- From Javascript string to Javascript value -------------

/**
 * Accepts a Javascript literal string (the output of `valueToTypescript`)
 * and parses it back into a corresponding JavaScript value.
 *
 * @param `text` string formatted as a Javascript literal
 * @returns The corresponding JavaScript value
 */
function toJavascriptValue(text: string): unknown {
  if (!text || typeof text !== "string") {
    throw new Error("Input must be a non-empty string");
  }

  const trimmed = text.trim();
  if (trimmed === "undefined") return undefined;
  if (trimmed === "NaN") return NaN;
  if (trimmed === "Infinity") return Infinity;
  if (trimmed === "-Infinity") return -Infinity;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Use tree-sitter to parse the Javascript
  const parser = new Parser();
  parser.setLanguage(Typescript);
  const tree = parser.parse(text);
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  const collectReplacements = (node: Parser.SyntaxNode) => {
    switch (node.type) {
      case "undefined":
        if (node.text === "undefined") {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: JSONN.getPlaceholder("undefined"),
          });
        }
        break;
      default:
        // Recursively traverse children
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) {
            collectReplacements(child);
          }
        }
        break;
    }
  };
  collectReplacements(tree.rootNode);

  // Apply replacements in right to left order
  replacements.sort((a, b) => b.start - a.start);
  let modifiedText = text;
  for (const r of replacements) {
    modifiedText =
      modifiedText.slice(0, r.start) + r.text + modifiedText.slice(r.end);
  }

  // Offload the rest to JSONN
  return JSONN.parse(`${JSONN.predicate}${modifiedText}`);
}
