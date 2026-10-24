import * as JSONN from "../../../Jsonn";
import { isBufferOrUint8Array, isKeyedObject } from "../../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import type { ArgDef } from "../../analysis/ArgDef";
import { ArgOptions, ArgTag } from "../../analysis/Types";

/**
 * Accepts an arbitrary JavaScript value and returns a string representing
 * that value in valid Java format.
 *
 * @param jsValue An arbitrary JavaScript value
 * @param argDef Optional argument definition for type-directed formatting
 * @returns A string formatted as a valid Java expression
 */
export function toJava(
  jsValue: unknown,
  argDef?: ArgDef | ArgDefContext
): string {
  return toJavaFormat(jsValue, argDef);
} // fn: toJava

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast

/**
 * Converts a snippet of Java code containing a literal or constructor expression
 * into a corresponding JavaScript representation.
 *
 * @param text Textual representation of a Java value
 * @returns JavaScript value corresponding to text
 */
export function fromJava<T>(text: string): T {
  return cast<T>(toJavascriptValue(text));
} // fn: fromJava

// ----------------- From JavaScript value to Java string ----------------- //

/**
 * Recursively converts a JavaScript value to a valid Java source string.
 *
 * @param val Arbitrary JavaScript value
 * @param argDef Optional ArgDef or ArgDefContext for type-directed formatting
 * @returns Formatted Java expression string
 */
function toJavaFormat(val: unknown, argDef?: ArgDefContext): string {
  if (val === undefined || val === null) {
    if (argDef?.isOptional()) {
      return "Optional.empty()";
    }
    return "null";
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
    return `Optional.of(${toJavaFormat(val, innerArgDef)})`;
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "number") {
    const isFloat =
      argDef?.getTypeRef() === "float" || argDef?.getTypeRef() === "Float";
    if (Object.is(val, NaN)) return isFloat ? "Float.NaN" : "Double.NaN";
    if (Object.is(val, Infinity))
      return isFloat ? "Float.POSITIVE_INFINITY" : "Double.POSITIVE_INFINITY";
    if (Object.is(val, -Infinity))
      return isFloat ? "-Float.POSITIVE_INFINITY" : "-Double.POSITIVE_INFINITY";

    if (argDef) {
      const typeRef = argDef.getTypeRef();
      if (typeRef === "byte" || typeRef === "Byte") {
        return `(byte) ${val}`;
      }
      if (typeRef === "short" || typeRef === "Short") {
        return `(short) ${val}`;
      }
      if (typeRef === "long" || typeRef === "Long") {
        return `${val}L`;
      }
      if (typeRef === "float" || typeRef === "Float") {
        return `${Number.isInteger(val) ? `${val}.0` : val}f`;
      }
      if (typeRef === "double" || typeRef === "Double") {
        return `${Number.isInteger(val) ? `${val}.0` : val}d`;
      }
      if (!argDef.getOptions().numInteger && Number.isInteger(val)) {
        return `${val}.0`;
      }
    }

    return String(val);
  }

  if (typeof val === "bigint") {
    if (argDef?.getTypeRef() === "BigInteger") {
      return `new java.math.BigInteger("${val}")`;
    }
    return `${val}L`;
  }

  if (typeof val === "string") {
    if (
      argDef?.getTypeRef() === "char" ||
      argDef?.getTypeRef() === "Character"
    ) {
      return formatJavaCharLiteral(val);
    }
    return JSON.stringify(val);
  }

  if (isBufferOrUint8Array(val)) {
    if (val.length === 0) {
      return "new byte[]{}";
    }
    const elements = Array.from(val).map((b) =>
      b > 127 ? `(byte) ${b - 256}` : `(byte) ${b}`
    );
    return `new byte[]{ ${elements.join(", ")} }`;
  }

  if (
    val instanceof Set ||
    (argDef && argDef.getType() === ArgTag.SET && Array.isArray(val))
  ) {
    const elemDef = argDef?.getChildren()[0];
    const rawItems =
      val instanceof Set
        ? Array.from(val.values())
        : Array.isArray(val)
          ? val
          : [];
    if (rawItems.length === 0) {
      return "java.util.Set.of()";
    }
    const seen = new Set<string>();
    const uniqueItems: unknown[] = [];
    for (const item of rawItems) {
      const k = JSONN.stringify(item);
      if (!seen.has(k)) {
        seen.add(k);
        uniqueItems.push(item);
      }
    }
    const items = uniqueItems.map((item) => toJavaFormat(item, elemDef));
    return `java.util.Set.of(${items.join(", ")})`;
  }

  if (
    val instanceof Map ||
    (argDef &&
      argDef.getType() === ArgTag.DICTIONARY &&
      (argDef.getBaseTypeRef() === "Map" ||
        argDef.getTypeRef() === "Map" ||
        argDef.getTypeRef() === "HashMap" ||
        argDef.getTypeRef() === "LinkedHashMap" ||
        argDef.getTypeRef() === "TreeMap") &&
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val))
  ) {
    const keyDef = argDef?.getChildren()[0];
    const valDef = argDef?.getChildren()[1];
    const entries: Array<[string, string]> = [];

    if (val instanceof Map) {
      for (const [k, v] of val.entries()) {
        entries.push([toJavaFormat(k, keyDef), toJavaFormat(v, valDef)]);
      }
    } else if (isKeyedObject(val)) {
      for (const k of Object.keys(val)) {
        entries.push([toJavaFormat(k, keyDef), toJavaFormat(val[k], valDef)]);
      }
    }

    if (entries.length === 0) {
      return "java.util.Map.of()";
    }
    if (entries.length <= 10) {
      return `java.util.Map.of(${entries.map(([k, v]) => `${k}, ${v}`).join(", ")})`;
    }
    return `java.util.Map.ofEntries(${entries.map(([k, v]) => `java.util.Map.entry(${k}, ${v})`).join(", ")})`;
  }

  if (Array.isArray(val)) {
    const isList =
      argDef?.getBaseTypeRef() === "List" ||
      argDef?.getTypeRef() === "List" ||
      argDef?.getTypeRef() === "ArrayList";

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

    const items = val.map((item) => toJavaFormat(item, elemDef));

    if (isList) {
      return `java.util.List.of(${items.join(", ")})`;
    }

    const dims = argDef ? Math.max(1, argDef.getDim()) : 1;
    const baseType = inferArrayBaseType(val, argDef);
    return `new ${baseType}${"[]".repeat(dims)}{ ${items.join(", ")} }`;
  }

  if (val !== null && typeof val === "object") {
    if (isKeyedObject(val)) {
      const entries: string[] = [];
      for (const k of Object.keys(val)) {
        const propValue = val[k];
        entries.push(`${k}: ${toJavaFormat(propValue)}`);
      }
      const typeRef = argDef?.getTypeRef();
      if (typeRef && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(typeRef)) {
        return `new ${typeRef}(${Object.values(val)
          .map((v) => toJavaFormat(v))
          .join(", ")})`;
      }
      return `{ ${entries.join(", ")} }`;
    }
  }

  if (typeof val === "function") {
    throw new Error("Functions are not supported");
  }

  if (typeof val === "symbol") {
    throw new Error("Symbols are not supported");
  }

  return String(val);
} // fn: toJavaFormat

// ----------------- From Java string to JavaScript value ----------------- //

/**
 * Converts a textual Java representation into a corresponding JavaScript value.
 *
 * @param text Textual representation of a Java expression
 * @returns Converted JavaScript value
 */
function toJavascriptValue(text: string): unknown {
  if (!text || typeof text !== "string") {
    throw new Error("Input must be a non-empty string");
  }

  const trimmed = text.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true" || trimmed === "Boolean.TRUE") return true;
  if (trimmed === "false" || trimmed === "Boolean.FALSE") return false;
  if (
    trimmed === "Optional.empty()" ||
    trimmed === "java.util.Optional.empty()"
  ) {
    return null;
  }
  if (
    trimmed === "Double.NaN" ||
    trimmed === "Float.NaN" ||
    trimmed === "NaN"
  ) {
    return NaN;
  }
  if (
    trimmed === "Double.POSITIVE_INFINITY" ||
    trimmed === "Float.POSITIVE_INFINITY" ||
    trimmed === "Infinity"
  ) {
    return Infinity;
  }
  if (
    trimmed === "-Double.POSITIVE_INFINITY" ||
    trimmed === "Double.NEGATIVE_INFINITY" ||
    trimmed === "-Float.POSITIVE_INFINITY" ||
    trimmed === "Float.NEGATIVE_INFINITY" ||
    trimmed === "-Infinity"
  ) {
    return -Infinity;
  }

  // Standalone byte array literal: new byte[]{ ... }
  if (/^new\s+byte\s*\[\s*\]\s*\{/i.test(trimmed)) {
    return parseJavaByteArrayLiteral(trimmed);
  }

  // Standalone char literal: 'x'
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return parseJavaCharLiteral(trimmed);
  }

  // Standalone integer with long suffix: e.g. 100L, -42L
  if (/^-?\d[\d_]*[lL]$/.test(trimmed)) {
    return BigInt(trimmed.replace(/_/g, "").slice(0, -1));
  }

  // Standalone float with f suffix: e.g. 3.14f, 1.0f
  if (/^-?\d[\d_]*(?:\.\d[\d_]*)?[fF]$/.test(trimmed)) {
    return Number(trimmed.replace(/_/g, "").slice(0, -1));
  }

  // Standalone double with d suffix: e.g. 3.14d
  if (/^-?\d[\d_]*(?:\.\d[\d_]*)?[dD]$/.test(trimmed)) {
    return Number(trimmed.replace(/_/g, "").slice(0, -1));
  }

  // Standalone cast expression: e.g. (byte) 42, (short) -10
  const castMatch = trimmed.match(
    /^\((?:byte|short|int|long)\)\s*(-?\d[\d_]*)$/
  );
  if (castMatch) {
    const num = Number(castMatch[1].replace(/_/g, ""));
    return num;
  }

  const isArrayInit =
    trimmed.startsWith("{") && trimmed.endsWith("}") && !trimmed.includes(":");
  const isObjectLiteral =
    (trimmed.startsWith("{") &&
      trimmed.endsWith("}") &&
      trimmed.includes(":")) ||
    /^[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*\}$/.test(trimmed);

  if (!isObjectLiteral) {
    const parseCode = isArrayInit
      ? `class _V { Object[] _v = ${trimmed}; }`
      : `class _V { Object _v = ${trimmed}; }`;
    const tree = Parser.parse("java", parseCode);
    if (tree && !tree.rootNode.hasError) {
      const varDecl = tree.rootNode.descendantsOfType("variable_declarator")[0];
      const valNode = varDecl?.childForFieldName("value");
      if (valNode) {
        return evalJavaAstNode(valNode);
      }
    }
  }

  return parseJavaObjectLiteral(trimmed);
} // fn: toJavascriptValue

/**
 * Evaluates a Tree-sitter Java AST expression node into a JavaScript value.
 *
 * @param node Tree-sitter AST syntax node representing an expression
 * @returns Evaluated JavaScript value
 */
function evalJavaAstNode(node: Parser.SyntaxNode): unknown {
  switch (node.type) {
    case "null_literal":
      return null;
    case "true":
      return true;
    case "false":
      return false;
    case "decimal_integer_literal":
    case "hex_integer_literal":
    case "binary_integer_literal": {
      const clean = node.text.replace(/_/g, "");
      if (/[lL]$/.test(clean)) {
        return BigInt(clean.slice(0, -1));
      }
      return Number(clean);
    }
    case "decimal_floating_point_literal":
    case "hex_floating_point_literal": {
      const clean = node.text.replace(/_/g, "").replace(/[fFdD]$/, "");
      return Number(clean);
    }
    case "character_literal":
      return parseJavaCharLiteral(node.text);
    case "string_literal":
      return parseJavaStringLiteral(node.text);
    case "cast_expression": {
      const typeNode = node.childForFieldName("type");
      const valNode = node.childForFieldName("value");
      const inner = valNode ? evalJavaAstNode(valNode) : null;
      if (typeof inner === "number") {
        if (typeNode?.text === "byte") {
          return (inner << 24) >> 24;
        }
        if (typeNode?.text === "short") {
          return (inner << 16) >> 16;
        }
        if (typeNode?.text === "int") {
          return inner | 0;
        }
      }
      return inner;
    }
    case "unary_expression": {
      const op = node.children.find(
        (c) => c.type === "-" || c.type === "+" || c.type === "!"
      )?.text;
      const operandNode =
        node.childForFieldName("operand") ?? node.namedChildren[0];
      const operand = operandNode ? evalJavaAstNode(operandNode) : 0;
      if (op === "-") {
        if (typeof operand === "bigint") return -operand;
        if (typeof operand === "number") return -operand;
      }
      if (op === "!") return !operand;
      return operand;
    }
    case "parenthesized_expression": {
      const innerNode = node.namedChildren[0];
      return innerNode ? evalJavaAstNode(innerNode) : null;
    }
    case "field_access": {
      const text = node.text;
      if (text.endsWith(".NaN")) return NaN;
      if (text.endsWith(".POSITIVE_INFINITY")) return Infinity;
      if (text.endsWith(".NEGATIVE_INFINITY")) return -Infinity;
      if (text.endsWith("Boolean.TRUE")) return true;
      if (text.endsWith("Boolean.FALSE")) return false;
      if (text.endsWith("Integer.MAX_VALUE")) return 2147483647;
      if (text.endsWith("Integer.MIN_VALUE")) return -2147483648;
      if (text.endsWith("Long.MAX_VALUE")) return 9223372036854775807n;
      if (text.endsWith("Long.MIN_VALUE")) return -9223372036854775808n;
      if (text.endsWith("Byte.MAX_VALUE")) return 127;
      if (text.endsWith("Byte.MIN_VALUE")) return -128;
      if (text.endsWith("Short.MAX_VALUE")) return 32767;
      if (text.endsWith("Short.MIN_VALUE")) return -32768;
      return text;
    }
    case "identifier": {
      const text = node.text;
      if (text === "NaN") return NaN;
      if (text === "Infinity") return Infinity;
      if (text === "true") return true;
      if (text === "false") return false;
      if (text === "null") return null;
      return text;
    }
    case "array_creation_expression": {
      const typeNode = node.childForFieldName("type");
      const initNode = node.childForFieldName("value");
      if (typeNode?.text === "byte" && initNode) {
        const elements = parseArrayElements(initNode);
        return new Uint8Array(
          elements.map((b) => (Number(b) < 0 ? Number(b) + 256 : Number(b)))
        );
      }
      return initNode ? parseArrayElements(initNode) : [];
    }
    case "array_initializer":
      return parseArrayElements(node);
    case "method_invocation": {
      const nameNode = node.childForFieldName("name");
      const objNode = node.childForFieldName("object");
      const argsNode = node.childForFieldName("arguments");
      const methodName = nameNode?.text;
      const objName = objNode?.text;
      const args = argsNode
        ? Parser.getNamedChildrenNoComments(argsNode).map(evalJavaAstNode)
        : [];

      if (methodName === "toString" && objNode) {
        return String(evalJavaAstNode(objNode));
      }
      if (
        (objName === "String" || objName === "java.lang.String") &&
        methodName === "valueOf" &&
        args.length > 0
      ) {
        return String(args[0]);
      }
      if (
        (objName === "List" || objName === "java.util.List") &&
        methodName === "of"
      ) {
        return args;
      }
      if (
        (objName === "Arrays" || objName === "java.util.Arrays") &&
        methodName === "asList"
      ) {
        return args;
      }
      if (
        (objName === "Set" || objName === "java.util.Set") &&
        methodName === "of"
      ) {
        return new Set(args);
      }
      if (
        (objName === "Map" || objName === "java.util.Map") &&
        methodName === "of"
      ) {
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < args.length; i += 2) {
          map.set(args[i], args[i + 1]);
        }
        return map;
      }
      if (
        (objName === "Map" || objName === "java.util.Map") &&
        methodName === "ofEntries"
      ) {
        const map = new Map<unknown, unknown>();
        for (const entry of args) {
          if (Array.isArray(entry) && entry.length === 2) {
            map.set(entry[0], entry[1]);
          }
        }
        return map;
      }
      if (
        methodName === "entry" &&
        args.length === 2 &&
        (!objName || objName === "Map" || objName === "java.util.Map")
      ) {
        return [args[0], args[1]];
      }
      if (objName === "Optional" || objName === "java.util.Optional") {
        if (methodName === "empty") return null;
        if (methodName === "of" || methodName === "ofNullable") {
          return args.length > 0 ? args[0] : null;
        }
      }
      if (
        (objName === "BigInteger" || objName === "java.math.BigInteger") &&
        methodName === "valueOf" &&
        args.length > 0
      ) {
        return BigInt(String(args[0]));
      }
      return args;
    }
    case "object_creation_expression": {
      const typeNode = node.childForFieldName("type");
      const argsNode = node.childForFieldName("arguments");
      const rawTypeName = typeNode?.text ?? "";
      const typeName = rawTypeName.replace(/<.*>$/, "");
      const args = argsNode
        ? Parser.getNamedChildrenNoComments(argsNode).map(evalJavaAstNode)
        : [];

      if (typeName === "String" || typeName === "java.lang.String") {
        return args.length > 0 ? String(args[0]) : "";
      }
      if (
        typeName.endsWith("HashSet") ||
        typeName.endsWith("TreeSet") ||
        typeName.endsWith("LinkedHashSet")
      ) {
        if (args.length > 0 && Array.isArray(args[0])) return new Set(args[0]);
        if (args.length > 0 && args[0] instanceof Set) return new Set(args[0]);
        return new Set();
      }
      if (
        typeName.endsWith("HashMap") ||
        typeName.endsWith("TreeMap") ||
        typeName.endsWith("LinkedHashMap")
      ) {
        return new Map();
      }
      if (typeName.endsWith("ArrayList") || typeName.endsWith("LinkedList")) {
        if (args.length > 0 && Array.isArray(args[0])) return args[0];
        return [];
      }
      if (typeName === "BigInteger" || typeName === "java.math.BigInteger") {
        return BigInt(String(args[0]));
      }
      if (typeName === "BigDecimal" || typeName === "java.math.BigDecimal") {
        return Number(args[0]);
      }
      return { constructor: typeName, args };
    }
    default:
      return node.text;
  }
} // fn: evalJavaAstNode

/**
 * Extracts and evaluates all element syntax nodes from an array initializer.
 *
 * @param initNode The array_initializer syntax node
 * @returns Array of evaluated JavaScript element values
 */
function parseArrayElements(initNode: Parser.SyntaxNode): unknown[] {
  const namedChildren = Parser.getNamedChildrenNoComments(initNode);
  return namedChildren.map(evalJavaAstNode);
} // fn: parseArrayElements

/**
 * Formats a single character into a Java character literal ('...').
 *
 * @param val The character string to format
 * @returns Formatted Java character literal
 */
function formatJavaCharLiteral(val: string): string {
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
    case "\b":
      return "'\\b'";
    case "\f":
      return "'\\f'";
    case "\0":
      return "'\\0'";
    default:
      return `'${ch}'`;
  }
} // fn: formatJavaCharLiteral

/**
 * Parses a Java character literal into a single character string.
 *
 * @param text The character literal text
 * @returns Decoded character string
 */
function parseJavaCharLiteral(text: string): string {
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    const inner = text.slice(1, -1);
    switch (inner) {
      case "\\'":
        return "'";
      case "\\\\":
        return "\\";
      case "\\n":
        return "\n";
      case "\\r":
        return "\r";
      case "\\t":
        return "\t";
      case "\\b":
        return "\b";
      case "\\f":
        return "\f";
      case "\\0":
        return "\0";
      default:
        if (inner.startsWith("\\u") && inner.length === 6) {
          const code = parseInt(inner.slice(2), 16);
          if (!isNaN(code)) return String.fromCharCode(code);
        }
        return inner;
    }
  }
  return text;
} // fn: parseJavaCharLiteral

/**
 * Parses a Java string literal or text block into a decoded string.
 *
 * @param raw Raw string literal text including surrounding quotes
 * @returns Decoded string
 */
function parseJavaStringLiteral(raw: string): string {
  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    const inner = raw.slice(3, -3);
    return inner.replace(/\\"/g, '"');
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      const inner = raw.slice(1, -1);
      return inner.replace(/\\"/g, '"');
    }
  }
  return raw;
} // fn: parseJavaStringLiteral

/**
 * Parses a Java byte array instantiation into a Uint8Array.
 *
 * @param text Byte array instantiation expression
 * @returns Uint8Array containing parsed bytes
 */
function parseJavaByteArrayLiteral(text: string): Uint8Array {
  const match = text.match(/new\s+byte\s*\[\s*\]\s*\{([\s\S]*)\}/i);
  if (!match) return new Uint8Array();
  const inner = match[1].trim();
  if (!inner) return new Uint8Array();
  const items = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const bytes: number[] = [];
  for (const item of items) {
    const clean = item.replace(/^\(byte\)\s*/, "").trim();
    let num = Number(clean);
    if (num < 0) num += 256;
    bytes.push(num & 0xff);
  }
  return new Uint8Array(bytes);
} // fn: parseJavaByteArrayLiteral

/**
 * Normalizes and parses compound Java object / struct / record literals.
 *
 * @param text The literal text
 * @returns Deserialized JavaScript object or value
 */
function parseJavaObjectLiteral(text: string): unknown {
  let normalized = text.trim();
  normalized = normalized.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*\{/, "{");
  normalized = normalizeJavaArrayCreations(normalized);
  normalized = normalized.replace(
    /(\b\d+)L\b/g,
    `{"${JSONN.PlaceHolderBigIntKey}":"$1"}`
  );
  normalized = normalized.replace(
    /\((?:byte|short|int|long|float|double)\)\s*([-\d.]+)/g,
    "$1"
  );
  normalized = normalized.replace(/([-\d.]+)f\b/g, "$1");

  return JSONN.parse(normalized);
} // fn: parseJavaObjectLiteral

/**
 * Normalizes Java array creation expressions (e.g. `new int[]{ ... }`)
 * into JSON array brackets `[ ... ]` using a stack to handle nesting.
 *
 * @param text The Java expression text
 * @returns Normalized text with Java array creations transformed to `[ ... ]`
 */
function normalizeJavaArrayCreations(text: string): string {
  let result = "";
  const stack: string[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      result += quote;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          result += text[i++];
        }
        if (i < text.length) {
          result += text[i++];
        }
      }
      if (i < text.length) {
        result += text[i++];
      }
      continue;
    }

    const slice = text.slice(i);
    const byteMatch = slice.match(/^new\s+byte\s*\[\s*\]\s*\{([^}]*)\}/i);
    if (byteMatch) {
      const nums = byteMatch[1]
        .split(",")
        .map((s) => s.replace(/^\(byte\)\s*/, "").trim())
        .filter((s) => s.length > 0)
        .map((s) => {
          let n = Number(s);
          if (n < 0) n += 256;
          return n & 0xff;
        });
      result += `{"${JSONN.PlaceHolderUint8ArrayKey}":[${nums.join(",")}]}`;
      i += byteMatch[0].length;
      continue;
    }

    const arrMatch = slice.match(
      /^new\s+[a-zA-Z_][a-zA-Z0-9_]*(?:\s*\[\s*\])+\s*\{/
    );
    if (arrMatch) {
      result += "[";
      stack.push("]");
      i += arrMatch[0].length;
      continue;
    }

    if (text[i] === "{") {
      result += "{";
      stack.push("}");
      i++;
      continue;
    }

    if (text[i] === "}") {
      const closing = stack.pop() ?? "}";
      result += closing;
      i++;
      continue;
    }

    result += text[i++];
  }

  return result;
} // fn: normalizeJavaArrayCreations

/**
 * Infers a Java primitive or standard base type for array instantiation.
 *
 * @param val Array of values
 * @param argDef Optional ArgDef context
 * @returns Base type name string
 */
function inferArrayBaseType(val: unknown[], argDef?: ArgDefContext): string {
  if (argDef) {
    const typeRef = argDef.getTypeRef();
    if (typeRef && typeRef !== "Object" && !typeRef.includes("<")) {
      return typeRef.replace(/\[\]/g, "");
    }
    const argType = argDef.getType();
    switch (argType) {
      case ArgTag.BOOLEAN:
        return "boolean";
      case ArgTag.NUMBER: {
        const opts = argDef.getOptions();
        return opts.numInteger ? "int" : "double";
      }
      case ArgTag.BIGINT:
        return "long";
      case ArgTag.STRING:
        return "String";
      case ArgTag.BYTES:
        return "byte";
      case ArgTag.OBJECT:
      case ArgTag.DICTIONARY:
      case ArgTag.SET:
      case ArgTag.LITERAL:
      case ArgTag.UNION:
      case ArgTag.TUPLE:
      case ArgTag.UNRESOLVED:
      default:
        return "Object";
    }
  }
  if (val.length === 0) return "Object";
  if (val.every((x) => typeof x === "number" && Number.isInteger(x)))
    return "int";
  if (val.every((x) => typeof x === "number")) return "double";
  if (val.every((x) => typeof x === "string")) return "String";
  if (val.every((x) => typeof x === "boolean")) return "boolean";
  return "Object";
} // fn: inferArrayBaseType

export type ArgDefContext = {
  isOptional(): boolean;
  getTypeRef(): string | undefined;
  getBaseTypeRef(): string | undefined;
  getOptions(): ArgOptions;
  getType(): ArgTag;
  getChildren(): ArgDefContext[];
  getDim(): number;
};
