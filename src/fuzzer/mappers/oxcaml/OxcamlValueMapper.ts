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
      getName: () => argDef.getName(),
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

  if (argDef?.getTypeRef() === "Buffer.t") {
    const str =
      typeof val === "string"
        ? val
        : isBufferOrUint8Array(val)
          ? Buffer.from(val).toString("utf-8")
          : String(val);
    return `(let b = Buffer.create 16 in Buffer.add_string b ${JSON.stringify(str)}; b)`;
  }

  if (
    argDef?.getTypeRef() === "bigstring" ||
    argDef?.getTypeRef() === "Bigstring.t" ||
    argDef?.getTypeRef() === "Bigarray.Array1.t"
  ) {
    const bytes = isBufferOrUint8Array(val)
      ? val
      : new TextEncoder().encode(String(val));
    return `(let s = ${bytesToOxcamlStringLiteral(bytes)} in let ba = Bigarray.Array1.create Bigarray.char Bigarray.c_layout (String.length s) in String.iteri (fun i c -> ba.{i} <- c) s; ba)`;
  }

  if (typeof val === "string") {
    if (val.startsWith("`")) {
      return val;
    }

    const typeRef = argDef?.getTypeRef();
    if (
      typeRef &&
      /^[A-Z][A-Za-z0-9_]*$/.test(val) &&
      !isOxcamlBuiltin(typeRef)
    ) {
      return val;
    }

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

  if (isKeyedObject(val) && "tag" in val && typeof val.tag === "string") {
    const tag = val.tag;
    if (!("value" in val) || val.value === undefined) {
      return tag;
    }
    const children = argDef?.getChildren() ?? [];
    const variantChild = children.find((c) => c.getName() === tag);
    const valueDef = variantChild
      ?.getChildren()
      ?.find((c) => c.getName() === "value");
    if (Array.isArray(val.value)) {
      if (valueDef && valueDef.getType() === ArgTag.TUPLE) {
        const tupleChildren = valueDef.getChildren();
        const tupleStrs = val.value.map((elem, i) =>
          toOxcamlFormat(elem, tupleChildren[i])
        );
        return `${tag} (${tupleStrs.join(", ")})`;
      }
      const elemStrs = val.value.map((elem) => toOxcamlFormat(elem));
      return `${tag} (${elemStrs.join(", ")})`;
    }
    return `${tag} (${toOxcamlFormat(val.value, valueDef)})`;
  }

  if (isKeyedObject(val) && "ok" in val) {
    const okDef = argDef?.getChildren()[0];
    return `Ok (${toOxcamlFormat(val.ok, okDef)})`;
  }

  if (isKeyedObject(val) && "error" in val) {
    const errDef = argDef?.getChildren()[1];
    return `Error (${toOxcamlFormat(val.error, errDef)})`;
  }

  if (
    val instanceof Set ||
    (argDef &&
      argDef.getType() === ArgTag.SET &&
      (val instanceof Set || Array.isArray(val)))
  ) {
    const elemDef = argDef?.getChildren()[0];
    const rawItems =
      val instanceof Set
        ? Array.from(val.values())
        : Array.isArray(val)
          ? val
          : [];
    const items = rawItems.map((item) => toOxcamlFormat(item, elemDef));
    const typeRef = argDef?.getTypeRef() ?? "";
    const bare = typeRef.replace(/\.t$/, "");
    const setMod =
      typeRef && typeRef.includes(".")
        ? (bare.split(/\s+/).pop() ?? "Set")
        : "Set";
    if (items.length === 0) {
      return `${setMod}.empty`;
    }
    return `${setMod}.of_list [${items.join("; ")}]`;
  }

  if (
    val instanceof Map ||
    (argDef &&
      argDef.getType() === ArgTag.DICTIONARY &&
      (val instanceof Map ||
        (val !== null && typeof val === "object" && !Array.isArray(val))))
  ) {
    const keyDef = argDef?.getChildren()[0];
    const valDef = argDef?.getChildren()[1];
    const typeRef = argDef?.getTypeRef() ?? "";
    const isHashtbl = typeRef.includes("Hashtbl");
    const isMap = typeRef.includes("Map");

    const entries: string[] = [];
    if (val instanceof Map) {
      for (const [k, v] of val.entries()) {
        entries.push(
          `(${toOxcamlFormat(k, keyDef)}, ${toOxcamlFormat(v, valDef)})`
        );
      }
    } else if (isKeyedObject(val)) {
      for (const k of Object.keys(val)) {
        entries.push(
          `(${toOxcamlFormat(k, keyDef)}, ${toOxcamlFormat(val[k], valDef)})`
        );
      }
    }

    if (isHashtbl) {
      if (entries.length === 0) return "(Hashtbl.create 0)";
      return `(Hashtbl.of_seq (List.to_seq [${entries.join("; ")}]))`;
    }
    if (isMap) {
      const bare = typeRef.replace(/\.t$/, "");
      const mapMod = bare.split(/\s+/).pop() ?? "Map";
      if (entries.length === 0) return `${mapMod}.empty`;
      return `(${mapMod}.of_seq (List.to_seq [${entries.join("; ")}]))`;
    }
    return `[${entries.join("; ")}]`;
  }

  if (Array.isArray(val)) {
    if (argDef && argDef.getType() === ArgTag.TUPLE && argDef.getDim() === 0) {
      const children = argDef.getChildren();
      const items = val.map((item, i) => toOxcamlFormat(item, children[i]));
      const typeRef = argDef.getTypeRef();
      if (typeRef === "#tuple" || typeRef?.startsWith("#(")) {
        return `#(${items.join(", ")})`;
      }
      return `(${items.join(", ")})`;
    }

    const elemDef: ArgDefContext | undefined =
      argDef?.getChildren()[0] ??
      (argDef && argDef.getDim() > 0
        ? {
            isOptional: () => false,
            getName: () => argDef.getName(),
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
    const typeRef = argDef?.getTypeRef();
    if (typeRef === "#record" || typeRef?.startsWith("#{")) {
      return `#{ ${entries.join("; ")} }`;
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
  if (trimmed === "(Hashtbl.create 0)" || trimmed === "Hashtbl.create 0") {
    return new Map();
  }

  const cleanText =
    (trimmed.startsWith("#(") && trimmed.endsWith(")")) ||
    (trimmed.startsWith("#{") && trimmed.endsWith("}"))
      ? trimmed.slice(1)
      : trimmed;

  const tree = Parser.parse("oxcaml", cleanText);
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
    case "constructor_name":
    case "tag": {
      if (node.text === "None") return null;
      return node.text;
    }
    case "application_expression": {
      const fnNode =
        node.childForFieldName("function") ?? node.namedChildren[0];
      const argNode =
        node.childForFieldName("argument") ?? node.namedChildren[1];
      const fnText = fnNode ? fnNode.text : "";
      if (fnText === "Some") {
        return astNodeToValue(argNode);
      }
      if (fnText === "Ok") {
        return { ok: astNodeToValue(argNode) };
      }
      if (fnText === "Error") {
        return { error: astNodeToValue(argNode) };
      }
      if (fnText === "Bytes.of_string") {
        const str = astNodeToValue(argNode);
        if (typeof str === "string") {
          return new Uint8Array(Buffer.from(str, "binary"));
        }
      }
      if (/^[A-Z][A-Za-z0-9_]*$/.test(fnText) || fnText.startsWith("`")) {
        const argVal = astNodeToValue(argNode);
        return { tag: fnText, value: argVal };
      }
      if (fnText.endsWith(".of_list") || fnText === "Set.of_list") {
        const argVal = astNodeToValue(argNode);
        if (Array.isArray(argVal)) {
          return new Set(argVal);
        }
      }
      if (fnText === "Hashtbl.of_seq") {
        const argVal = astNodeToValue(argNode);
        if (Array.isArray(argVal)) {
          const entries: [unknown, unknown][] = [];
          for (const item of argVal) {
            if (Array.isArray(item) && item.length >= 2) {
              entries.push([item[0], item[1]]);
            }
          }
          return new Map(entries);
        }
      }
      if (fnText.endsWith(".of_seq") || fnText === "Map.of_seq") {
        const argVal = astNodeToValue(argNode);
        if (Array.isArray(argVal)) {
          const entries: [unknown, unknown][] = [];
          for (const item of argVal) {
            if (Array.isArray(item) && item.length >= 2) {
              entries.push([item[0], item[1]]);
            }
          }
          return new Map(entries);
        }
      }
      if (fnText === "List.to_seq") {
        return astNodeToValue(argNode);
      }
      if (fnText === "List.fold_left") {
        const lastChild = node.namedChildren[node.namedChildren.length - 1];
        const pairs = astNodeToValue(lastChild);
        if (Array.isArray(pairs)) {
          const entries: [unknown, unknown][] = [];
          for (const item of pairs) {
            if (Array.isArray(item) && item.length >= 2) {
              entries.push([item[0], item[1]]);
            }
          }
          return new Map(entries);
        }
      }
      if (argNode) {
        return astNodeToValue(argNode);
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
    case "let_expression": {
      if (node.text.includes("Buffer.create")) {
        const strNode = node.descendantsOfType("string")[0];
        if (strNode) {
          return parseOxcamlStringLiteral(strNode.text);
        }
        return "";
      }
      if (node.text.includes("Bigarray.Array1.create")) {
        const strNode = node.descendantsOfType("string")[0];
        if (strNode) {
          const str = parseOxcamlStringLiteral(strNode.text);
          return new Uint8Array(Buffer.from(str, "binary"));
        }
        return new Uint8Array(0);
      }
      const body = node.childForFieldName("body");
      return astNodeToValue(body);
    }
    case "value_path":
    case "value_name": {
      if (node.text.endsWith(".empty") || node.text === "empty") {
        if (node.text.toLowerCase().includes("map")) return new Map();
        return new Set();
      }
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
    const inner = text.slice(1, -1);
    let result = "";
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "\\" && i + 1 < inner.length) {
        const next = inner[i + 1];
        if (next === "n") {
          result += "\n";
          i++;
        } else if (next === "r") {
          result += "\r";
          i++;
        } else if (next === "t") {
          result += "\t";
          i++;
        } else if (next === "b") {
          result += "\b";
          i++;
        } else if (next === "\\") {
          result += "\\";
          i++;
        } else if (next === '"') {
          result += '"';
          i++;
        } else if (next === "'") {
          result += "'";
          i++;
        } else if (next === "x" && i + 3 < inner.length) {
          const hex = inner.slice(i + 2, i + 4);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            result += String.fromCharCode(parseInt(hex, 16));
            i += 3;
          } else {
            result += "\\" + next;
            i++;
          }
        } else if (/^[0-9]/.test(next) && i + 3 < inner.length) {
          const digits = inner.slice(i + 1, i + 4);
          if (/^[0-9]{3}$/.test(digits)) {
            result += String.fromCharCode(parseInt(digits, 10));
            i += 3;
          } else {
            result += "\\" + next;
            i++;
          }
        } else {
          result += next;
          i++;
        }
      } else {
        result += inner[i];
      }
    }
    return result;
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
  getName(): string;
  getTypeRef(): string | undefined;
  getBaseTypeRef(): string | undefined;
  getOptions(): ArgOptions;
  getType(): ArgTag;
  getChildren(): ArgDefContext[];
  getDim(): number;
};

function isOxcamlBuiltin(type: string): boolean {
  return [
    "int",
    "float",
    "bool",
    "string",
    "char",
    "bytes",
    "unit",
    "int32",
    "int64",
    "nativeint",
    "#int",
    "#float",
    "Buffer.t",
    "bigstring",
  ].includes(type);
} // fn: isOxcamlBuiltin
