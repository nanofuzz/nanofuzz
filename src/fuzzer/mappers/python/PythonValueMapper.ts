import * as JSONN from "../../../Jsonn";
import * as Parser from "../../adapters/ParserAdapter";

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

// --------------- From Javascript value to Python string --------------- //

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

  if (
    val instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(val))
  ) {
    return val;
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
 * Converts a Uint8Array into a Python bytes literal string (e.g. b'\xbb{\x01\xed\xf3+').
 */
function bytesToPythonLiteral(bytes: Uint8Array | Buffer): string {
  let result = "b'";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 92) {
      result += "\\\\";
    } else if (b === 39) {
      result += "\\'";
    } else if (b === 10) {
      result += "\\n";
    } else if (b === 13) {
      result += "\\r";
    } else if (b === 9) {
      result += "\\t";
    } else if (b >= 32 && b <= 126) {
      result += String.fromCharCode(b);
    } else {
      result += `\\x${b.toString(16).padStart(2, "0")}`;
    }
  }
  result += "'";
  return result;
}

/**
 * Parses a Python bytes literal string (e.g. b'hello' or b'\xbb{\x01') into a Uint8Array.
 */
function parsePythonBytesLiteral(text: string): Uint8Array {
  const match = text.match(/^(r?b|br)('''|"""|['"])/i);
  if (!match) {
    throw new Error(`Invalid Python bytes literal: ${text}`);
  }
  const prefix = match[1] ?? "";
  const quote = match[2];
  const isRaw = /r/i.test(prefix);

  const startIdx = match[0].length;
  const endIdx = text.lastIndexOf(quote);
  const content = text.slice(startIdx, endIdx);

  const byteList: number[] = [];

  if (isRaw) {
    for (let i = 0; i < content.length; i++) {
      byteList.push(content.charCodeAt(i) & 0xff);
    }
  } else {
    let i = 0;
    while (i < content.length) {
      const char = content[i];
      if (char === "\\" && i + 1 < content.length) {
        const nextChar = content[i + 1];
        switch (nextChar) {
          case "\\":
            byteList.push(92);
            i += 2;
            break;
          case "'":
            byteList.push(39);
            i += 2;
            break;
          case '"':
            byteList.push(34);
            i += 2;
            break;
          case "a":
            byteList.push(7);
            i += 2;
            break;
          case "b":
            byteList.push(8);
            i += 2;
            break;
          case "f":
            byteList.push(12);
            i += 2;
            break;
          case "n":
            byteList.push(10);
            i += 2;
            break;
          case "r":
            byteList.push(13);
            i += 2;
            break;
          case "t":
            byteList.push(9);
            i += 2;
            break;
          case "v":
            byteList.push(11);
            i += 2;
            break;
          case "x":
          case "X": {
            const hex = content.slice(i + 2, i + 4);
            if (hex.length === 2 && /^[0-9a-fA-F]{2}$/.test(hex)) {
              byteList.push(parseInt(hex, 16));
              i += 4;
            } else {
              byteList.push(content.charCodeAt(i) & 0xff);
              i += 1;
            }
            break;
          }
          default: {
            const octalMatch = content.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
            if (octalMatch) {
              byteList.push(parseInt(octalMatch[0], 8));
              i += 1 + octalMatch[0].length;
            } else {
              byteList.push(nextChar.charCodeAt(0) & 0xff);
              i += 2;
            }
            break;
          }
        }
      } else {
        byteList.push(char.charCodeAt(0) & 0xff);
        i += 1;
      }
    }
  }

  return new Uint8Array(byteList);
}

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
  if (
    val instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(val))
  ) {
    return bytesToPythonLiteral(val);
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
  if (trimmed === "None") return null;

  // Check if trimmed string is a standalone bytes literal
  if (/^(r?b|br)('''|"""|['"])/i.test(trimmed)) {
    try {
      return parsePythonBytesLiteral(trimmed);
    } catch {
      // Fallback to AST parsing
    }
  }

  // Parse and replace Python values with Javascript values
  const tree = Parser.parse(`python`, text);
  if (tree === null) {
    throw new Error(`parser returned null`);
  }
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
          text: "null",
        });
        break;
      case "string":
        if (/^(r?b|br)('''|"""|['"])/i.test(node.text)) {
          const uint8 = parsePythonBytesLiteral(node.text);
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: `{${JSONN.PlaceHolderUint8ArrayKey}:[${Array.from(uint8).join(",")}]}`,
          });
        }
        break;
      case "call": {
        const fnNode = node.childForFieldName("function");
        if (fnNode?.text === "bytes") {
          const argsNode = node.childForFieldName("arguments");
          const listNode = argsNode?.namedChildren.find(
            (c) => c.type === "list" || c.type === "tuple"
          );
          if (listNode) {
            const byteValues: number[] = [];
            for (const child of listNode.namedChildren) {
              const num = Number(child.text);
              if (!isNaN(num) && num >= 0 && num <= 255) {
                byteValues.push(num);
              } else {
                break;
              }
            }
            if (byteValues.length === listNode.namedChildren.length) {
              replacements.push({
                start: node.startIndex,
                end: node.endIndex,
                text: `{${JSONN.PlaceHolderUint8ArrayKey}:[${byteValues.join(",")}]}`,
              });
            }
          }
        } else {
          for (const child of node.children) {
            collectReplacements(child);
          }
        }
        break;
      }
      default:
        // Recursively traverse children
        for (const child of node.children) {
          collectReplacements(child);
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
