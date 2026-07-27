import * as JSONN from "../../../Jsonn";
import Parser from "tree-sitter";
import PythonGrammar from "tree-sitter-python";

// Type definitions are broken in tree-sitter-python
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const Python: Parser.Language = PythonGrammar as Parser.Language;

/**
 * Converts an arbitrary JavaScript value of type `unknown` into a Python literal string.
 * - `true` -> `True`
 * - `false` -> `False`
 * - `null` / `undefined` -> `None`
 * - Objects -> Python dictionaries (`{...}`)
 * - Arrays -> Python lists (`[...]`)
 *
 * @param `jsValue` An arbitrary JavaScript value
 * @returns A string formatted as a valid Python literal expression
 */
export function toPython(jsValue: unknown): string {
  return toPythonFormat(toPythonValues(jsValue));
}

/**
 * Converts a snippet of Python code containing a value into
 * a corresponding Javascript representation.
 *
 * @param `text` textual representation of a Python value
 * @returns Javascript value corresponding to `text`
 */
export function fromPython<T>(text: string): T {
  return toJavascriptValues(text) as T;
}

// --------------- From Javascript value to Python string ---------------

/**
 * Recursively converts Javascript booleans, null/undefined, arrays, and objects
 * to match Python structures.
 *
 * @param `val` arbitrary Javascript value
 * @returns `val` where JS values are mapped to Python values
 */
function toPythonValues(val: unknown): unknown {
  if (val === undefined || val === null) {
    return PythonNone;
  }

  if (Array.isArray(val)) {
    return val.map(toPythonValues);
  }

  if (val !== null && typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      result[k] = toPythonValues(v);
    }
    return result;
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

  return val; // Passthrough strings, numbers, booleans
}

// Python's `None` value
const PythonNone = Symbol("PythonNone");

/**
 * Outputs a value in Python syntax instead of JS
 *
 * @param `val` Python value (but still in JS)
 * @returns string representation of `val` in Python format
 */
function toPythonFormat(val: unknown): string {
  if (val === PythonNone) {
    return "None";
  }
  if (typeof val === "boolean") {
    return val ? "True" : "False";
  }
  if (typeof val === "string") {
    return JSON.stringify(val); // handles strings quotes and escapes
  }
  if (typeof val === "number") {
    return String(val);
  }

  if (Array.isArray(val)) {
    const items = val.map(toPythonFormat);
    return `[${items.join(", ")}]`;
  }

  if (val !== null && typeof val === "object") {
    const entries = Object.entries(val).map(([k, v]) => {
      return `${JSON.stringify(k)}: ${toPythonFormat(v)}`;
    });
    return `{${entries.join(", ")}}`;
  }

  return String(val);
}

// --------------- From Python string to Javascript value ---------------

/**
 * Accepts a Python literal string (the output of `valueToPython`)
 * and parses it back into a corresponding JavaScript value.
 *
 * @param `text` string formatted as a Python literal (e.g., `{"a": True, "b": None}`)
 * @returns The corresponding JavaScript value
 */
function toJavascriptValues(text: string): unknown {
  if (!text || typeof text !== "string") {
    throw new Error("Input must be a non-empty string");
  }

  const trimmed = text.trim();
  if (trimmed === "True") return true;
  if (trimmed === "False") return false;
  if (trimmed === "None") return undefined;

  // Use tree-sitter to replace Python values with Javascript values
  const parser = new Parser();
  parser.setLanguage(Python);
  const tree = parser.parse(text);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const collectReplacements = (node: Parser.SyntaxNode) => {
    switch (node.type) {
      case "true":
        replacements.push({
          start: node.startIndex,
          end: node.endIndex,
          text: "true",
        });
        break;
      case "false":
        replacements.push({
          start: node.startIndex,
          end: node.endIndex,
          text: "false",
        });
        break;
      case "none":
        replacements.push({
          start: node.startIndex,
          end: node.endIndex,
          text: JSONN.getPlaceholder("undefined"),
        });
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
  const result = JSONN.parse(`${JSONN.predicate}${modifiedText}`);
  return result === null ? undefined : result;
}
