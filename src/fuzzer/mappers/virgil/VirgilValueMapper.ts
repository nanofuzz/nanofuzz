import * as JSONN from "../../../Jsonn";
import { isBufferOrUint8Array, isKeyedObject } from "../../../Util";
import type { ArgDef } from "../../analysis/ArgDef";
import { ArgTag } from "../../analysis/Types";

export interface ArgDefContext {
  isOptional: () => boolean;
  getTypeRef: () => string | undefined;
  getBaseTypeRef: () => string | undefined;
  getOptions: () => Record<string, unknown>;
  getType: () => ArgTag;
  getChildren: () => ArgDefContext[];
  getDim: () => number;
}

/**
 * Converts a JavaScript value to a valid Virgil source expression.
 */
export function toVirgil(
  jsValue: unknown,
  argDef?: ArgDef | ArgDefContext
): string {
  return toVirgilFormat(jsValue, argDef);
} // fn: toVirgil

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast

/**
 * Converts a snippet of Virgil code (literals, tuples, arrays)
 * into its corresponding JavaScript value.
 */
export function fromVirgil<T>(text: string, argDef?: ArgDef | ArgDefContext): T {
  return cast<T>(toJavascriptValue(text, argDef));
} // fn: fromVirgil

// ----------------- From JavaScript value to Virgil string ----------------- //

function toVirgilFormat(val: unknown, argDef?: ArgDefContext): string {
  if (val === undefined || val === null) {
    return "null";
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "number") {
    if (Object.is(val, NaN)) return "float.nan";
    if (Object.is(val, Infinity)) return "float.infinity";
    if (Object.is(val, -Infinity)) return "-float.infinity";

    if (argDef) {
      const typeRef = argDef.getTypeRef();
      const isFloat =
        typeRef === "float" ||
        typeRef === "f32" ||
        typeRef === "double" ||
        typeRef === "f64" ||
        argDef.getOptions()?.numInteger === false;

      if (isFloat) {
        const s = val.toString();
        return s.includes(".") || s.includes("e") || s.includes("E")
          ? s
          : `${s}.0`;
      }
    }

    if (!Number.isInteger(val)) {
      return val.toString();
    }

    return val.toString();
  }

  if (typeof val === "bigint") {
    return `${val.toString()}L`;
  }

  if (typeof val === "string") {
    return JSON.stringify(val);
  }

  if (isBufferOrUint8Array(val)) {
    const bytes = Array.from(val);
    return `[${bytes.map((b) => b.toString()).join(", ")}]`;
  }

  if (Array.isArray(val)) {
    const childArgDef = argDef?.getChildren()?.[0];
    const elements = val.map((elem) => toVirgilFormat(elem, childArgDef));
    return `[${elements.join(", ")}]`;
  }

  if (isKeyedObject(val)) {
    const typeRef = argDef?.getTypeRef();
    if (typeRef === "#tuple" || typeRef?.startsWith("#(")) {
      const children = argDef?.getChildren() ?? [];
      const keys = Object.keys(val);
      const elems: string[] = [];
      for (let i = 0; i < keys.length; i++) {
        const cArgDef = children[i];
        elems.push(toVirgilFormat(val[keys[i]], cArgDef));
      }
      return `(${elems.join(", ")})`;
    }

    // Default object/record as tuple or struct literal
    const entries = Object.entries(val).map(
      ([, v]) => `${toVirgilFormat(v)}`
    );
    return `(${entries.join(", ")})`;
  }

  return JSONN.stringify(val);
} // fn: toVirgilFormat

// ----------------- From Virgil string to JavaScript value ----------------- //

function toJavascriptValue(text: string, argDef?: ArgDefContext): unknown {
  const trimmed = text.trim();

  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "float.nan" || trimmed === "NaN") return NaN;
  if (trimmed === "float.infinity" || trimmed === "infinity" || trimmed === "Infinity")
    return Infinity;
  if (
    trimmed === "-float.infinity" ||
    trimmed === "-infinity" ||
    trimmed === "-Infinity"
  )
    return -Infinity;

  // BigInt integers with 'L' or 'uL' or 'UL'
  if (/^-?\d[\d_]*[uU]?[lL]$/.test(trimmed)) {
    const clean = trimmed.replace(/[uU]?[lL]$/, "").replace(/_/g, "");
    return BigInt(clean);
  }

  // Float numbers with decimal point
  if (/^-?\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d+)?(?:f|d|f32|f64)?$/i.test(trimmed)) {
    const clean = trimmed.replace(/[fFdD]|f32|f64$/i, "").replace(/_/g, "");
    return Number(clean);
  }

  // Integer numbers
  if (/^-?\d[\d_]*$/.test(trimmed)) {
    const clean = trimmed.replace(/_/g, "");
    if (argDef?.getType() === ArgTag.BIGINT) {
      return BigInt(clean);
    }
    const num = Number(clean);
    if (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER) {
      return BigInt(clean);
    }
    return num;
  }

  // Hexadecimal numbers: 0x...
  if (/^-?0x[0-9a-fA-F_]+[uU]?[lL]?$/.test(trimmed)) {
    const hasL = /[lL]$/i.test(trimmed);
    const clean = trimmed.replace(/[uU]?[lL]$/i, "").replace(/_/g, "");
    if (hasL || argDef?.getType() === ArgTag.BIGINT) {
      return BigInt(clean);
    }
    return Number(clean);
  }

  // String literals: "..."
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return JSONN.parse(trimmed);
  }

  // Array literals: [e1, e2, ...]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    const elements = splitTopLevel(inner);
    const childArgDef = argDef?.getChildren()?.[0];
    return elements.map((e) => toJavascriptValue(e, childArgDef));
  }

  // Tuple literals: (e1, e2, ...)
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return {};
    const elements = splitTopLevel(inner);
    const children = argDef?.getChildren() ?? [];
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < elements.length; i++) {
      const cDef = children[i];
      obj[String(i)] = toJavascriptValue(elements[i], cDef);
    }
    return obj;
  }

  try {
    return JSONN.parse(trimmed);
  } catch {
    return trimmed;
  }
} // fn: toJavascriptValue

function splitTopLevel(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inString = false;
  let quoteChar = "";
  let current = "";

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    if (inString) {
      current += char;
      if (char === quoteChar && prev !== "\\") {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quoteChar = char;
      current += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{" || char === "<") {
      depth++;
      current += char;
    } else if (char === ")" || char === "]" || char === "}" || char === ">") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      if (current.trim().length > 0) {
        result.push(current.trim());
      }
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim().length > 0) {
    result.push(current.trim());
  }

  return result;
} // fn: splitTopLevel
