import * as JSONN from "../../../Jsonn";
import { hexToBytes, isBufferOrUint8Array, isKeyedObject } from "../../../Util";
import * as Parser from "../../adapters/ParserAdapter";

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

  if (isBufferOrUint8Array(val)) {
    return `new Uint8Array([${Array.from(val).join(", ")}])`;
  }

  if (val instanceof Map) {
    const entries: string[] = [];
    for (const [key, value] of val.entries()) {
      entries.push(
        `[${toJavascriptValues(key)}, ${toJavascriptValues(value)}]`
      );
    }
    return `new Map([${entries.join(", ")}])`;
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

// ------------- From Javascript string to Javascript value ------------- //

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

  // Check if trimmed string is standalone Uint8Array.fromHex(...)
  const standaloneHexMatch = trimmed.match(
    /^Uint8Array\.fromHex\s*\(\s*["']([0-9a-fA-F]*)["']\s*\)$/i
  );
  if (standaloneHexMatch) {
    return hexToBytes(standaloneHexMatch[1]);
  }

  // Parse the Javascript value
  const tree = Parser.parse(`typescript`, text);
  if (tree === null) {
    throw new Error(`parser returned null`);
  }
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

      case "new_expression":
      case "call_expression": {
        const text = node.text;
        let bytes: number[] | undefined;

        // 1. Uint8Array.fromHex("000f7fff")
        const fromHexMatch = text.match(
          /^Uint8Array\.fromHex\s*\(\s*["']([0-9a-fA-F]*)["']\s*\)/i
        );
        if (fromHexMatch) {
          bytes = Array.from(hexToBytes(fromHexMatch[1]));
        }

        // 2. Buffer.from("000f7fff", "hex")
        if (!bytes) {
          const bufferHexMatch = text.match(
            /^Buffer\.from\s*\(\s*["']([0-9a-fA-F]*)["']\s*,\s*["']hex["']\s*\)/i
          );
          if (bufferHexMatch) {
            bytes = Array.from(hexToBytes(bufferHexMatch[1]));
          }
        }

        // 3. new Uint8Array([1, 2, 3]), Uint8Array.from([1, 2, 3]), Buffer.from([1, 2, 3]), new Buffer([1, 2, 3])
        if (!bytes) {
          if (
            /^(new\s+Uint8Array|Uint8Array\.from|Buffer\.from|new\s+Buffer)\s*\(\s*\[/.test(
              text
            )
          ) {
            const listMatch = text.match(/\[\s*([\d\s,]*)\s*\]/m);
            if (listMatch) {
              const rawNums = listMatch[1].trim();
              const nums =
                rawNums.length > 0
                  ? rawNums
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0)
                      .map((s) => Number(s))
                  : [];
              if (nums.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
                bytes = nums;
              }
            }
          }
        }

        if (bytes !== undefined) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: `{${JSONN.PlaceHolderUint8ArrayKey}:[${bytes.join(",")}]}`,
          });
        } else {
          const mapMatch = text.match(/^new\s+Map\s*\(\s*(\[[\s\S]*\])\s*\)/i);
          if (mapMatch) {
            replacements.push({
              start: node.startIndex,
              end: node.endIndex,
              text: `{${JSONN.PlaceHolderMapKey}:${mapMatch[1]}}`,
            });
          } else {
            // Recursively traverse children
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child) {
                collectReplacements(child);
              }
            }
          }
        }
        break;
      }

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
  return JSONN.parse(modifiedText);
}
