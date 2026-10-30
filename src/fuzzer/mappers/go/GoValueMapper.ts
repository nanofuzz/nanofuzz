import * as JSONN from "../../../Jsonn";
import { isBufferOrUint8Array, isKeyedObject } from "../../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import type { ArgDef } from "../../analysis/ArgDef";
import { ArgOptions, ArgTag } from "../../analysis/Types";

export type ArgDefContext = {
  isOptional: () => boolean;
  getName?: () => string;
  getTypeRef: () => string | undefined;
  getBaseTypeRef: () => string | undefined;
  getOptions: () => ArgOptions;
  getType: () => ArgTag;
  getChildren: () => (ArgDef | ArgDefContext)[];
  getDim: () => number;
};

/**
 * Accepts an arbitrary JavaScript value and returns a string representing
 * that value in valid Go format.
 *
 * @param jsValue An arbitrary JavaScript value
 * @param argDef Optional argument definition for type-directed formatting
 * @returns A string formatted as a valid Go expression
 */
export function toGo(
  jsValue: unknown,
  argDef?: ArgDef | ArgDefContext
): string {
  return toGoFormat(jsValue, argDef);
} // fn: toGo

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast

/**
 * Converts a snippet of Go code containing a literal or constructor expression
 * into a corresponding JavaScript representation.
 *
 * @param text Textual representation of a Go value
 * @returns JavaScript value corresponding to text
 */
export function fromGo<T>(text: string, argDef?: ArgDef | ArgDefContext): T {
  return cast<T>(toJavascriptValue(text, argDef));
} // fn: fromGo

// ----------------- From JavaScript value to Go string ----------------- //

function toGoFormat(val: unknown, argDef?: ArgDefContext): string {
  const isPointer =
    argDef?.getBaseTypeRef() === "pointer" ||
    (argDef?.isOptional() && argDef?.getType() === ArgTag.OBJECT);

  if (val === undefined || val === null) {
    return "nil";
  }

  if (isPointer && argDef && argDef.getType() !== ArgTag.OBJECT) {
    const innerArgDef: ArgDefContext = {
      isOptional: () => false,
      getName: () => (argDef.getName ? argDef.getName() : "elem"),
      getTypeRef: () => argDef.getTypeRef()?.replace(/^\*+/, ""),
      getBaseTypeRef: () => undefined,
      getOptions: () => argDef.getOptions(),
      getType: () => argDef.getType(),
      getChildren: () => argDef.getChildren(),
      getDim: () => argDef.getDim(),
    };
    const innerVal = toGoFormat(val, innerArgDef);
    const typeName = inferGoTypeName(innerArgDef);
    return `func() *${typeName} { v := ${innerVal}; return &v }()`;
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "number") {
    if (Object.is(val, NaN)) return "math.NaN()";
    if (Object.is(val, Infinity)) return "math.Inf(1)";
    if (Object.is(val, -Infinity)) return "math.Inf(-1)";

    if (argDef) {
      const typeRef = argDef.getTypeRef();
      if (
        typeRef === "int8" ||
        typeRef === "int16" ||
        typeRef === "int32" ||
        typeRef === "uint8" ||
        typeRef === "uint16" ||
        typeRef === "uint32" ||
        typeRef === "uint" ||
        typeRef === "byte" ||
        typeRef === "rune"
      ) {
        return `${typeRef}(${val})`;
      }
      if (typeRef === "float32" || typeRef === "float64") {
        return `${typeRef}(${Number.isInteger(val) ? `${val}.0` : val})`;
      }
      if (!argDef.getOptions().numInteger && Number.isInteger(val)) {
        return `${val}.0`;
      }
    }

    return String(val);
  }

  if (typeof val === "bigint") {
    const typeRef = argDef?.getTypeRef();
    if (typeRef === "uint64") {
      return `uint64(${val.toString()})`;
    }
    return `int64(${val.toString()})`;
  }

  if (typeof val === "string") {
    return JSON.stringify(val);
  }

  if (isBufferOrUint8Array(val)) {
    return `[]byte{${Array.from(val).join(", ")}}`;
  }

  if (Array.isArray(val)) {
    const dims = argDef ? Math.max(1, argDef.getDim()) : 1;
    const elemDef =
      argDef?.getChildren()[0] ??
      (argDef && argDef.getDim() > 0
        ? {
            isOptional: () => false,
            getName: () => (argDef.getName ? argDef.getName() : "elem"),
            getTypeRef: () => argDef.getTypeRef(),
            getBaseTypeRef: () => argDef.getBaseTypeRef(),
            getOptions: () => argDef.getOptions(),
            getType: () => argDef.getType(),
            getChildren: () => [],
            getDim: () => argDef.getDim() - 1,
          }
        : undefined);

    const elemTypeName = elemDef
      ? inferGoTypeName(elemDef)
      : inferArrayElementType(val);
    const items = val.map((item) => toGoFormat(item, elemDef));

    const prefix = dims > 1 ? "[]".repeat(dims) : "[]";
    return `${prefix}${elemTypeName}{${items.join(", ")}}`;
  }

  if (val !== null && typeof val === "object") {
    if (isKeyedObject(val)) {
      const isDict =
        argDef?.getType() === ArgTag.DICTIONARY ||
        argDef?.getBaseTypeRef() === "map";

      if (isDict) {
        const kDef = argDef?.getChildren()[0];
        const vDef = argDef?.getChildren()[1];
        const kType = kDef ? inferGoTypeName(kDef) : "string";
        const vType = vDef ? inferGoTypeName(vDef) : "any";

        const entries: string[] = [];
        for (const k of Object.keys(val)) {
          const propVal = val[k];
          entries.push(`${JSON.stringify(k)}: ${toGoFormat(propVal, vDef)}`);
        }
        return `map[${kType}]${vType}{${entries.join(", ")}}`;
      }

      const typeRef = argDef?.getTypeRef();
      const structName =
        typeRef && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(typeRef)
          ? typeRef
          : undefined;

      const entries: string[] = [];
      for (const k of Object.keys(val)) {
        const propVal = val[k];
        entries.push(`${JSON.stringify(k)}: ${toGoFormat(propVal)}`);
      }

      if (structName) {
        const ptrPrefix = isPointer ? "&" : "";
        const structEntries = Object.keys(val).map(
          (k) => `${k}: ${toGoFormat(val[k])}`
        );
        return `${ptrPrefix}${structName}{${structEntries.join(", ")}}`;
      }

      return `map[string]any{${entries.join(", ")}}`;
    }
  }

  if (typeof val === "function") {
    throw new Error("Functions are not supported");
  }

  if (typeof val === "symbol") {
    throw new Error("Symbols are not supported");
  }

  return String(val);
} // fn: toGoFormat

function inferGoTypeName(def: ArgDefContext): string {
  const ref = def.getTypeRef();
  if (ref && ref !== "" && ref !== "any") {
    return ref;
  }
  switch (def.getType()) {
    case ArgTag.BOOLEAN:
      return "bool";
    case ArgTag.STRING:
      return "string";
    case ArgTag.NUMBER:
      return def.getOptions().numInteger ? "int" : "float64";
    case ArgTag.BIGINT:
      return "int64";
    case ArgTag.DICTIONARY:
      return "map[string]any";
    case ArgTag.OBJECT:
    case ArgTag.BYTES:
    case ArgTag.TUPLE:
    case ArgTag.SET:
    case ArgTag.LITERAL:
    case ArgTag.UNION:
    case ArgTag.UNRESOLVED:
    default:
      return "any";
  }
} // fn: inferGoTypeName

function inferArrayElementType(arr: unknown[]): string {
  if (arr.length === 0) return "any";
  const first = arr[0];
  if (typeof first === "number") {
    return Number.isInteger(first) ? "int" : "float64";
  }
  if (typeof first === "string") return "string";
  if (typeof first === "boolean") return "bool";
  if (typeof first === "bigint") return "int64";
  return "any";
} // fn: inferArrayElementType

// ----------------- From Go string to JavaScript value ----------------- //

function toJavascriptValue(
  text: string,
  _argDef?: ArgDef | ArgDefContext
): unknown {
  if (!text || typeof text !== "string") {
    throw new Error("Input must be a non-empty string");
  }

  const trimmed = text.trim();
  if (trimmed === "nil") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "math.NaN()" || trimmed === "NaN" || trimmed === "nan") {
    return NaN;
  }
  if (
    trimmed === "math.Inf(1)" ||
    trimmed === "+Inf" ||
    trimmed === "Infinity"
  ) {
    return Infinity;
  }
  if (
    trimmed === "math.Inf(-1)" ||
    trimmed === "-Inf" ||
    trimmed === "-Infinity"
  ) {
    return -Infinity;
  }

  // Raw string literal
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }

  // Simple string literal
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSONN.parse(trimmed);
    } catch {
      // fallback
    }
  }

  // Primitive casts: int64(123), uint8(42), etc.
  const castMatch = /^(int64|uint64)\(([-+]?\d+)\)$/.exec(trimmed);
  if (castMatch) {
    return BigInt(castMatch[2]);
  }
  const numCastMatch =
    /^(int|int8|int16|int32|uint|uint8|uint16|uint32|byte|rune|uintptr)\(([-+]?\d+)\)$/.exec(
      trimmed
    );
  if (numCastMatch) {
    return parseInt(numCastMatch[2], 10);
  }
  const floatCastMatch =
    /^(float32|float64)\(([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\)$/.exec(
      trimmed
    );
  if (floatCastMatch) {
    return parseFloat(floatCastMatch[2]);
  }

  // Bare number literal
  const cleanNum = trimmed.replace(/_/g, "");
  if (/^[-+]?\d+$/.test(cleanNum)) {
    const n = Number(cleanNum);
    if (n >= Number.MIN_SAFE_INTEGER && n <= Number.MAX_SAFE_INTEGER) {
      return n;
    }
    return BigInt(cleanNum);
  }
  if (/^[-+]?\d+\.\d+(?:[eE][-+]?\d+)?$/.test(cleanNum)) {
    return parseFloat(cleanNum);
  }

  // Use tree-sitter-go to transform complex Go literals to valid JSONN
  const tree = Parser.parse("go", `var _ = ${trimmed}`);
  if (!tree) {
    throw new Error(`Failed to parse Go value: ${text}`);
  }

  const replacements: Array<{ start: number; end: number; text: string }> = [];

  const visit = (node: Parser.SyntaxNode): void => {
    switch (node.type) {
      case "unary_expression": {
        const op = node.child(0);
        if (op?.text === "&") {
          replacements.push({
            start: node.startIndex,
            end: op.endIndex,
            text: "",
          });
        }
        break;
      }

      case "composite_literal": {
        const typeNode = node.childForFieldName("type") ?? node.child(0);
        const bodyNode =
          node.childForFieldName("body") ??
          node.children.find((c) => c.type === "literal_value");
        if (bodyNode) {
          replacements.push({
            start: node.startIndex,
            end: bodyNode.startIndex,
            text: "",
          });
          const typeText = typeNode?.text ?? "";
          if (typeText.startsWith("[]") || /^\[\d*\]/.test(typeText)) {
            replacements.push({
              start: bodyNode.startIndex,
              end: bodyNode.startIndex + 1,
              text: "[",
            });
            replacements.push({
              start: bodyNode.endIndex - 1,
              end: bodyNode.endIndex,
              text: "]",
            });
          }
        }
        break;
      }

      case "keyed_element": {
        const keyNode = node.child(0);
        if (keyNode) {
          const rawKey = keyNode.text;
          const quotedKey =
            rawKey.startsWith('"') && rawKey.endsWith('"')
              ? rawKey
              : JSONN.stringify(rawKey.replace(/^['`]|['`]$/g, ""));
          replacements.push({
            start: keyNode.startIndex,
            end: keyNode.endIndex,
            text: quotedKey,
          });
        }
        break;
      }

      case "rune_literal": {
        const inner = node.text.slice(1, -1);
        replacements.push({
          start: node.startIndex,
          end: node.endIndex,
          text: JSONN.stringify(inner),
        });
        break;
      }

      case "call_expression": {
        const fnNode = node.childForFieldName("function");
        const argsNode = node.childForFieldName("arguments");
        if (fnNode?.type === "func_literal") {
          const body = fnNode.childForFieldName("body");
          const shortVar = body?.descendantsOfType("short_var_declaration")[0];
          const right = shortVar?.childForFieldName("right");
          if (right) {
            replacements.push({
              start: node.startIndex,
              end: node.endIndex,
              text: right.text,
            });
            return;
          }
        }
        if (fnNode && argsNode) {
          const fnName = fnNode.text;
          const innerText = argsNode.text.slice(1, -1).trim();
          if (fnName === "int64" || fnName === "uint64") {
            replacements.push({
              start: node.startIndex,
              end: node.endIndex,
              text: `{"${JSONN.PlaceHolderBigIntKey}":"${innerText}"}`,
            });
            return;
          }
          if (
            fnName === "int" ||
            fnName === "int8" ||
            fnName === "int16" ||
            fnName === "int32" ||
            fnName === "uint" ||
            fnName === "uint8" ||
            fnName === "uint16" ||
            fnName === "uint32" ||
            fnName === "float32" ||
            fnName === "float64" ||
            fnName === "byte" ||
            fnName === "rune"
          ) {
            replacements.push({
              start: node.startIndex,
              end: node.endIndex,
              text: innerText,
            });
            return;
          }
        }
        break;
      }

      case "int_literal": {
        const clean = node.text.replace(/_/g, "");
        if (clean !== node.text) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: clean,
          });
        }
        break;
      }

      case "raw_string_literal": {
        const unquoted = node.text.slice(1, -1);
        replacements.push({
          start: node.startIndex,
          end: node.endIndex,
          text: JSONN.stringify(unquoted),
        });
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  }; // fn: visit

  visit(tree.rootNode);

  replacements.sort((a, b) => b.start - a.start);
  let transformed = `var _ = ${trimmed}`;
  for (const r of replacements) {
    transformed =
      transformed.slice(0, r.start) + r.text + transformed.slice(r.end);
  }

  const exprText = transformed.replace(/^var _ =\s*/, "").trim();
  const jsonReady = exprText;

  return JSONN.parse(jsonReady);
} // fn: toJavascriptValue
