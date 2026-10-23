import { isBufferOrUint8Array, isKeyedObject } from "../../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import type { ArgDef } from "../../analysis/ArgDef";
import { ArgOptions, ArgTag } from "../../analysis/Types";

/**
 * Accepts an arbitrary JavaScript value and returns a string representing
 * that value in valid OCaml/OxCaml syntax.
 *
 * @param jsValue An arbitrary JavaScript value
 * @param argDef Optional argument definition for type-directed formatting
 * @returns A string formatted as a valid OCaml expression
 */
export function toOxcaml(
  jsValue: unknown,
  argDef?: ArgDef | ArgDefContext
): string {
  return toOxcamlFormat(jsValue, argDef);
} // fn: toOxcaml

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast

/**
 * Converts a snippet of OCaml code containing a literal or constructor expression
 * into a corresponding JavaScript representation.
 *
 * @param text Textual representation of an OCaml value
 * @returns JavaScript value corresponding to `text`
 */
export function fromOxcaml<T>(text: string): T {
  return cast<T>(toJavascriptValue(text));
} // fn: fromOxcaml

// ----------------- From JavaScript value to OCaml string ----------------- //

/**
 * Internal recursive formatter converting JavaScript values to OCaml syntax.
 *
 * @param val The value to format
 * @param argDef Optional argument context
 * @returns Formatted OCaml expression string
 */
function toOxcamlFormat(val: unknown, argDef?: ArgDefContext): string {
  if (val === undefined || val === null) {
    if (argDef?.getTypeRef() === "unit") {
      return "()";
    }
    return "None";
  }

  if (argDef?.isOptional()) {
    const innerArgDef: ArgDefContext = {
      isOptional: () => false,
      getTypeRef: () => argDef.getTypeRef(),
      getBaseTypeRef: () => argDef.getBaseTypeRef(),
      getOptions: () => argDef.getOptions(),
      getType: () => argDef.getType(),
      getChildren: () => argDef.getChildren(),
      getDim: () => argDef.getDim(),
    };
    return `Some (${toOxcamlFormat(val, innerArgDef)})`;
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "number") {
    if (Object.is(val, NaN)) return "nan";
    if (Object.is(val, Infinity)) return "infinity";
    if (Object.is(val, -Infinity)) return "neg_infinity";

    if (argDef) {
      const typeRef = argDef.getTypeRef();
      if (typeRef === "int32") {
        return `${val}l`;
      }
      if (typeRef === "int64") {
        return `${val}L`;
      }
      if (typeRef === "nativeint") {
        return `${val}n`;
      }
      if (
        typeRef === "float" ||
        typeRef === "#float" ||
        !argDef.getOptions().numInteger
      ) {
        return Number.isInteger(val) ? `${val}.0` : String(val);
      }
    }

    return String(val);
  }

  if (typeof val === "bigint") {
    return `${val}L`;
  }

  if (typeof val === "string") {
    if (
      argDef?.getTypeRef() === "char" ||
      (argDef?.getOptions().strLength?.min === 1 &&
        argDef?.getOptions().strLength?.max === 1)
    ) {
      const ch = val.length > 0 ? val[0] : "\0";
      switch (ch) {
        case "'":
          return "'\\''";
        case "\\":
          return "'\\\\'";
        case "\n":
          return "'\\n'";
        case "\r":
          return "'\\r'";
        case "\t":
          return "'\\t'";
        case "\0":
          return "'\\0'";
        default:
          return `'${ch}'`;
      }
    }
    return JSON.stringify(val);
  }

  if (isBufferOrUint8Array(val)) {
    return `(Bytes.of_string ${bytesToOxcamlStringLiteral(val)})`;
  }

  if (Array.isArray(val)) {
    if (argDef && argDef.getType() === ArgTag.TUPLE) {
      const children = argDef.getChildren();
      const items = val.map((item, i) => toOxcamlFormat(item, children[i]));
      return `(${items.join(", ")})`;
    }

    const elemDef: ArgDefContext | undefined =
      argDef?.getChildren()[0] ??
      (argDef && argDef.getDim() > 0
        ? {
            isOptional: () => false,
            getTypeRef: () => argDef.getTypeRef(),
            getBaseTypeRef: () => argDef.getBaseTypeRef(),
            getOptions: () => argDef.getOptions(),
            getType: () => argDef.getType(),
            getChildren: () => [],
            getDim: () => argDef.getDim() - 1,
          }
        : undefined);
    const items = val.map((item) => toOxcamlFormat(item, elemDef));

    if (argDef?.getTypeRef()?.includes("array")) {
      if (items.length === 0) return "[| |]";
      return `[| ${items.join("; ")} |]`;
    }

    if (items.length === 0) return "[]";
    return `[${items.join("; ")}]`;
  }

  if (val !== null && typeof val === "object") {
    const entries: string[] = [];
    if (isKeyedObject(val)) {
      for (const k of Object.keys(val)) {
        const propValue = val[k];
        entries.push(`${k} = ${toOxcamlFormat(propValue)}`);
      }
    }
    return `{ ${entries.join("; ")} }`;
  }

  if (typeof val === "function") {
    throw new Error("Functions are not supported");
  }

  if (typeof val === "symbol") {
    throw new Error("Symbols are not supported");
  }

  return String(val);
} // fn: toOxcamlFormat

/**
 * Converts a Uint8Array into an escaped OCaml string literal.
 *
 * @param bytes Binary buffer to format
 * @returns Escaped string literal inside double quotes
 */
function bytesToOxcamlStringLiteral(bytes: Uint8Array): string {
  let result = '"';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 92) {
      result += "\\\\";
    } else if (b === 34) {
      result += '\\"';
    } else if (b === 10) {
      result += "\\n";
    } else if (b === 13) {
      result += "\\r";
    } else if (b === 9) {
      result += "\\t";
    } else if (b === 0) {
      result += "\\000";
    } else if (b >= 32 && b <= 126) {
      result += String.fromCharCode(b);
    } else {
      result += `\\x${b.toString(16).padStart(2, "0")}`;
    }
  }
  result += '"';
  return result;
} // fn: bytesToOxcamlStringLiteral

// ----------------- From OCaml string to JavaScript value ----------------- //

/**
 * Evaluates an OCaml expression string into a JavaScript value.
 *
 * @param text The OCaml code text to parse
 * @returns The resulting JavaScript value
 */
function toJavascriptValue(text: string): unknown {
  if (!text || typeof text !== "string") {
    throw new Error("Input must be a non-empty string");
  }

  const trimmed = text.trim();
  if (trimmed === "None") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "()") return null;
  if (trimmed === "nan" || trimmed === "NaN") return NaN;
  if (trimmed === "infinity" || trimmed === "Infinity") return Infinity;
  if (
    trimmed === "neg_infinity" ||
    trimmed === "-infinity" ||
    trimmed === "-Infinity"
  ) {
    return -Infinity;
  }
  if (trimmed === "[]") return [];
  if (trimmed === "[| |]" || trimmed === "[||]") return [];

  const tree = Parser.parse("oxcaml", text);
  if (!tree) {
    throw new Error("Parser returned null");
  }

  return astNodeToValue(tree.rootNode);
} // fn: toJavascriptValue

/**
 * Recursively converts a parsed tree-sitter AST node to a JavaScript value.
 *
 * @param node The AST node to evaluate
 * @returns The resulting JavaScript value
 */
function astNodeToValue(node: Parser.SyntaxNode | undefined | null): unknown {
  if (!node) return null;

  switch (node.type) {
    case "compilation_unit":
    case "expression_item":
    case "parenthesized_expression": {
      const expr =
        node.childForFieldName("expression") ?? node.namedChildren[0];
      return astNodeToValue(expr);
    }
    case "sign_expression": {
      const op = node.childForFieldName("operator")?.text ?? "-";
      const expr = node.childForFieldName("expression");
      const val = astNodeToValue(expr);
      if (op === "-") {
        if (typeof val === "bigint") return -val;
        if (typeof val === "number") return -val;
      }
      return val;
    }
    case "number": {
      const text = node.text.replace(/_/g, "");
      if (text.endsWith("L")) {
        return BigInt(text.slice(0, -1));
      }
      if (text.endsWith("l") || text.endsWith("n")) {
        return Number(text.slice(0, -1));
      }
      return Number(text);
    }
    case "boolean":
      return node.text === "true";
    case "string":
      return parseOxcamlStringLiteral(node.text);
    case "character":
      return parseOxcamlCharLiteral(node.text);
    case "unit":
      return null;
    case "constructor_path":
    case "constructor_name": {
      if (node.text === "None") return null;
      return node.text;
    }
    case "application_expression": {
      const fnNode = node.childForFieldName("function");
      const argNode = node.childForFieldName("argument");
      if (fnNode?.text === "Some") {
        return astNodeToValue(argNode);
      }
      if (fnNode?.text === "Bytes.of_string") {
        const str = astNodeToValue(argNode);
        if (typeof str === "string") {
          return new Uint8Array(Buffer.from(str, "binary"));
        }
      }
      return node.text;
    }
    case "list_expression":
    case "array_expression": {
      return node.namedChildren.map((c) => astNodeToValue(c));
    }
    case "tuple_expression": {
      return node.namedChildren.map((c) => astNodeToValue(c));
    }
    case "record_expression": {
      const res: Record<string, unknown> = {};
      for (const field of node.namedChildren) {
        if (field.type === "field_expression") {
          const fieldPath =
            field.childForFieldName("field") ?? field.namedChildren[0];
          const body =
            field.childForFieldName("body") ?? field.namedChildren[1];
          if (fieldPath && body) {
            res[fieldPath.text] = astNodeToValue(body);
          }
        }
      }
      return res;
    }
    case "value_path":
    case "value_name": {
      if (node.text === "nan") return NaN;
      if (node.text === "infinity") return Infinity;
      if (node.text === "neg_infinity") return -Infinity;
      return node.text;
    }
    default:
      return node.text;
  }
} // fn: astNodeToValue

/**
 * Decodes an OCaml string literal into a JavaScript string.
 *
 * @param text Quoted string literal
 * @returns Decoded string
 */
function parseOxcamlStringLiteral(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\0/g, "\0");
    }
  }
  return text;
} // fn: parseOxcamlStringLiteral

/**
 * Decodes an OCaml character literal into a single-character string.
 *
 * @param text Quoted char literal
 * @returns Decoded character string
 */
function parseOxcamlCharLiteral(text: string): string {
  if (text.startsWith("'") && text.endsWith("'")) {
    const inner = text.slice(1, -1);
    if (inner === "\\n") return "\n";
    if (inner === "\\r") return "\r";
    if (inner === "\\t") return "\t";
    if (inner === "\\\\") return "\\";
    if (inner === "\\'") return "'";
    if (inner === "\\0" || inner === "\\000") return "\0";
    return inner;
  }
  return text;
} // fn: parseOxcamlCharLiteral

export type ArgDefContext = {
  isOptional(): boolean;
  getTypeRef(): string | undefined;
  getBaseTypeRef(): string | undefined;
  getOptions(): ArgOptions;
  getType(): ArgTag;
  getChildren(): ArgDefContext[];
  getDim(): number;
};
