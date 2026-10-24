import * as JSONN from "../../../Jsonn";
import { isBufferOrUint8Array, isKeyedObject } from "../../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import type { ArgDef } from "../../analysis/ArgDef";
import { ArgOptions, ArgTag } from "../../analysis/Types";

/**
 * Accepts an arbitrary JavaScript value and returns a string representing
 * that value in valid Rust format.
 *
 * @param `jsValue` An arbitrary JavaScript value
 * @param `argDef` Optional argument definition for type-directed formatting
 * @returns A string formatted as a valid Rust expression
 */
export function toRust(
  jsValue: unknown,
  argDef?: ArgDef | ArgDefContext
): string {
  return toRustFormat(jsValue, argDef);
} // fn: toRust

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast

/**
 * Converts a snippet of Rust code containing a literal or constructor expression
 * into a corresponding JavaScript representation.
 *
 * @param `text` textual representation of a Rust value
 * @returns JavaScript value corresponding to `text`
 */
export function fromRust<T>(text: string): T {
  return cast<T>(toJavascriptValue(text));
} // fn: fromRust

// ----------------- From JavaScript value to Rust string ----------------- //

function toRustFormat(val: unknown, argDef?: ArgDefContext): string {
  if (
    val === undefined ||
    (val === null && argDef?.getBaseTypeRef() !== "Box")
  ) {
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
    return `Some(${toRustFormat(val, innerArgDef)})`;
  }

  if (argDef?.getBaseTypeRef() === "Box") {
    const innerArgDef: ArgDefContext = argDef.getChildren()[0] ?? {
      isOptional: () => false,
      getTypeRef: () => argDef.getTypeRef(),
      getBaseTypeRef: () => undefined,
      getOptions: () => argDef.getOptions(),
      getType: () => argDef.getType(),
      getChildren: () => [],
      getDim: () => argDef.getDim(),
    };
    return `Box::new(${toRustFormat(val, innerArgDef)})`;
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "number") {
    const isF32 = argDef?.getTypeRef() === "f32";
    if (Object.is(val, NaN)) return isF32 ? "f32::NAN" : "f64::NAN";
    if (Object.is(val, Infinity))
      return isF32 ? "f32::INFINITY" : "f64::INFINITY";
    if (Object.is(val, -Infinity))
      return isF32 ? "-f32::INFINITY" : "-f64::INFINITY";

    if (argDef) {
      const typeRef = argDef.getTypeRef();
      if (
        typeRef === "u8" ||
        typeRef === "i8" ||
        typeRef === "u16" ||
        typeRef === "i16" ||
        typeRef === "u32" ||
        typeRef === "i32" ||
        typeRef === "u64" ||
        typeRef === "i64" ||
        typeRef === "u128" ||
        typeRef === "i128" ||
        typeRef === "usize" ||
        typeRef === "isize"
      ) {
        return `${val}${typeRef}`;
      }
      if (typeRef === "f32" || typeRef === "f64") {
        return `${Number.isInteger(val) ? `${val}.0` : val}${typeRef}`;
      }
      if (!argDef.getOptions().numInteger && Number.isInteger(val)) {
        return `${val}.0`;
      }
    }

    return String(val);
  }

  if (typeof val === "bigint") {
    if (argDef) {
      const typeRef = argDef.getTypeRef();
      if (
        typeRef === "u8" ||
        typeRef === "i8" ||
        typeRef === "u16" ||
        typeRef === "i16" ||
        typeRef === "u32" ||
        typeRef === "i32" ||
        typeRef === "u64" ||
        typeRef === "i64" ||
        typeRef === "u128" ||
        typeRef === "i128" ||
        typeRef === "usize" ||
        typeRef === "isize"
      ) {
        return `${val}${typeRef}`;
      }
    }
    return `${val}i64`;
  }

  if (typeof val === "string") {
    if (argDef?.getTypeRef() === "&str") {
      return JSON.stringify(val);
    }
    if (argDef?.getTypeRef() === "char") {
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
    return `String::from(${JSON.stringify(val)})`;
  }

  if (isBufferOrUint8Array(val)) {
    if (argDef?.getTypeRef() === "&[u8]") {
      return bytesToRustLiteral(val);
    }
    return `${bytesToRustLiteral(val)}.to_vec()`;
  }

  if (
    val instanceof Set ||
    (argDef && argDef.getType() === ArgTag.SET && Array.isArray(val))
  ) {
    const elemDef = argDef?.getChildren()[0];
    const isBTree = argDef?.getTypeRef() === "BTreeSet";
    const collName = isBTree ? "BTreeSet" : "HashSet";
    const rawItems =
      val instanceof Set
        ? Array.from(val.values())
        : Array.isArray(val)
          ? val
          : [];
    if (rawItems.length === 0) {
      return `std::collections::${collName}::new()`;
    }
    const items = rawItems.map((item) => toRustFormat(item, elemDef));
    return `std::collections::${collName}::from([${items.join(", ")}])`;
  }

  if (
    val instanceof Map ||
    (argDef &&
      argDef.getType() === ArgTag.DICTIONARY &&
      (argDef.getBaseTypeRef() === "Map" ||
        argDef.getTypeRef() === "HashMap" ||
        argDef.getTypeRef() === "BTreeMap") &&
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val))
  ) {
    const keyDef = argDef?.getChildren()[0];
    const valDef = argDef?.getChildren()[1];
    const isBTree = argDef?.getTypeRef() === "BTreeMap";
    const collName = isBTree ? "BTreeMap" : "HashMap";
    const entries: string[] = [];

    if (val instanceof Map) {
      for (const [k, v] of val.entries()) {
        entries.push(
          `(${toRustFormat(k, keyDef)}, ${toRustFormat(v, valDef)})`
        );
      }
    } else if (isKeyedObject(val)) {
      for (const k of Object.keys(val)) {
        entries.push(
          `(${toRustFormat(k, keyDef)}, ${toRustFormat(val[k], valDef)})`
        );
      }
    }

    if (entries.length === 0) {
      return `std::collections::${collName}::new()`;
    }
    return `std::collections::${collName}::from([${entries.join(", ")}])`;
  }

  if (Array.isArray(val)) {
    if (argDef && argDef.getType() === ArgTag.TUPLE) {
      const children = argDef.getChildren();
      const items = val.map((item, i) => toRustFormat(item, children[i]));
      return `(${items.join(", ")}${val.length === 1 ? "," : ""})`;
    }

    const elemDef: ArgDefContext | undefined =
      argDef?.getChildren()[0] ??
      (argDef && argDef.getDim() > 0
        ? {
            isOptional: () => false,
            getTypeRef: () => argDef.getTypeRef(),
            getBaseTypeRef: () =>
              argDef.getBaseTypeRef() === "VecDeque"
                ? undefined
                : argDef.getBaseTypeRef(),
            getOptions: () => argDef.getOptions(),
            getType: () => argDef.getType(),
            getChildren: () => [],
            getDim: () => argDef.getDim() - 1,
          }
        : undefined);
    const items = val.map((item) => toRustFormat(item, elemDef));

    if (argDef?.getBaseTypeRef() === "VecDeque") {
      if (items.length === 0) {
        return `std::collections::VecDeque::new()`;
      }
      return `std::collections::VecDeque::from([${items.join(", ")}])`;
    }

    if (argDef?.getTypeRef()?.startsWith("&[")) {
      return `&[${items.join(", ")}]`;
    }
    if (
      argDef?.getTypeRef()?.startsWith("[") &&
      argDef.getTypeRef()?.includes(";")
    ) {
      return `[${items.join(", ")}]`;
    }

    return `vec![${items.join(", ")}]`;
  }

  if (val !== null && typeof val === "object") {
    const entries: string[] = [];
    if (isKeyedObject(val)) {
      for (const k of Object.keys(val)) {
        const propValue = val[k];
        const childDef = argDef?.getChildren().find((c) => c.getName?.() === k);
        entries.push(`${k}: ${toRustFormat(propValue, childDef)}`);
      }
    }
    const typeRef = argDef?.getTypeRef();
    if (typeRef && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(typeRef)) {
      return `${typeRef} { ${entries.join(", ")} }`;
    }
    return `{ ${entries.join(", ")} }`;
  }

  if (typeof val === "function") {
    throw new Error("Functions are not supported");
  }

  if (typeof val === "symbol") {
    throw new Error("Symbols are not supported");
  }

  return String(val);
} // fn: toRustFormat

/**
 * Converts a Uint8Array into a Rust byte string literal (b"...").
 */
function bytesToRustLiteral(bytes: Uint8Array): string {
  let result = 'b"';
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
      result += "\\0";
    } else if (b >= 32 && b <= 126) {
      result += String.fromCharCode(b);
    } else {
      result += `\\x${b.toString(16).padStart(2, "0")}`;
    }
  }
  result += '"';
  return result;
} // fn: bytesToRustLiteral

// ----------------- From Rust string to JavaScript value ----------------- //

function toJavascriptValue(text: string): unknown {
  if (!text || typeof text !== "string") {
    throw new Error("Input must be a non-empty string");
  }

  const trimmed = text.trim();
  if (trimmed === "None") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "()") return null;
  if (
    trimmed === "f64::NAN" ||
    trimmed === "f32::NAN" ||
    trimmed === "NAN" ||
    trimmed === "NaN"
  ) {
    return NaN;
  }
  if (
    trimmed === "f64::INFINITY" ||
    trimmed === "f32::INFINITY" ||
    trimmed === "INFINITY" ||
    trimmed === "Infinity"
  ) {
    return Infinity;
  }
  if (
    trimmed === "-f64::INFINITY" ||
    trimmed === "-f32::INFINITY" ||
    trimmed === "-INFINITY" ||
    trimmed === "-Infinity"
  ) {
    return -Infinity;
  }

  // Standalone bytes literal
  if (/^b["']/i.test(trimmed)) {
    if (trimmed.endsWith(".to_vec()")) {
      return parseRustBytesLiteral(trimmed.slice(0, -8).trim());
    }
    return parseRustBytesLiteral(trimmed);
  }

  let normalized = text;
  // Simplify common Rust string constructors and vector macro before AST parsing
  normalized = normalized.replace(
    /String::from\s*\(\s*("(\\.|[^"\\])*")\s*\)/g,
    "$1"
  );
  normalized = normalized.replace(
    /("(\\.|[^"\\])*")\.(?:to_string|to_owned)\(\)/g,
    "$1"
  );
  normalized = normalized.replace(/\bvec!\s*\[/g, "[");

  const trimmedNormalized = normalized.trim();
  const isAnonObject =
    trimmedNormalized.startsWith("{") && trimmedNormalized.endsWith("}");
  const parseInput = isAnonObject ? `_Struct ${trimmedNormalized}` : normalized;

  const tree = Parser.parse("rust", parseInput);
  if (!tree) {
    throw new Error("Parser returned null");
  }

  const replacements: Array<{ start: number; end: number; text: string }> = [];

  const collectReplacements = (node: Parser.SyntaxNode): void => {
    switch (node.type) {
      case "macro_invocation": {
        const macroNode = node.childForFieldName("macro") ?? node.child(0);
        if (macroNode?.text === "vec") {
          const tokenTree = node.children.find((c) => c.type === "token_tree");
          if (tokenTree) {
            replacements.push({
              start: node.startIndex,
              end: tokenTree.startIndex,
              text: "",
            });
            for (let i = 0; i < tokenTree.childCount; i++) {
              const child = tokenTree.child(i);
              if (child) collectReplacements(child);
            }
            return;
          }
        }
        break;
      }

      case "struct_expression": {
        const body = node.childForFieldName("body");
        if (body) {
          replacements.push({
            start: node.startIndex,
            end: body.startIndex,
            text: "",
          });
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (child) collectReplacements(child);
          }
          return;
        }
        break;
      }

      case "tuple_expression": {
        if (node.text === "()") {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: "null",
          });
          return;
        }
        replacements.push({
          start: node.startIndex,
          end: node.startIndex + 1,
          text: "[",
        });
        replacements.push({
          start: node.endIndex - 1,
          end: node.endIndex,
          text: "]",
        });
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) collectReplacements(child);
        }
        return;
      }

      case "integer_literal": {
        const clean = node.text.replace(/_/g, "");
        if (/(?:i64|u64|i128|u128|n)$/i.test(clean)) {
          const digits = clean.replace(/(?:i64|u64|i128|u128|n)$/i, "");
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: `{"${JSONN.PlaceHolderBigIntKey}":"${digits}"}`,
          });
          return;
        }
        if (/(?:i8|u8|i16|u16|i32|u32|isize|usize)$/i.test(clean)) {
          const digits = clean.replace(
            /(?:i8|u8|i16|u16|i32|u32|isize|usize)$/i,
            ""
          );
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: digits,
          });
          return;
        }
        if (clean !== node.text) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: clean,
          });
          return;
        }
        break;
      }

      case "float_literal": {
        const clean = node.text.replace(/_/g, "").replace(/(?:f32|f64)$/i, "");
        if (clean !== node.text) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: clean,
          });
          return;
        }
        break;
      }

      case "string_literal": {
        if (/^b["']/i.test(node.text)) {
          const uint8 = parseRustBytesLiteral(node.text);
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: `{"${JSONN.PlaceHolderUint8ArrayKey}":[${Array.from(uint8).join(",")}]}`,
          });
          return;
        }
        if (/^r(#*)["']/i.test(node.text)) {
          const unraw = parseRustRawString(node.text);
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: JSON.stringify(unraw),
          });
          return;
        }
        break;
      }

      case "raw_string_literal": {
        const unraw = parseRustRawString(node.text);
        replacements.push({
          start: node.startIndex,
          end: node.endIndex,
          text: JSON.stringify(unraw),
        });
        return;
      }

      case "char_literal": {
        const ch = parseRustCharLiteral(node.text);
        replacements.push({
          start: node.startIndex,
          end: node.endIndex,
          text: JSON.stringify(ch),
        });
        return;
      }

      case "scoped_identifier":
      case "identifier": {
        const text = node.text;
        if (
          text === "f64::NAN" ||
          text === "f32::NAN" ||
          text === "NAN" ||
          text === "NaN"
        ) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: "NaN",
          });
          return;
        }
        if (
          text === "f64::INFINITY" ||
          text === "f32::INFINITY" ||
          text === "INFINITY" ||
          text === "Infinity"
        ) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: "Infinity",
          });
          return;
        }
        if (text === "None") {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: "null",
          });
          return;
        }
        break;
      }

      case "reference_expression": {
        const valNode = node.childForFieldName("value") ?? node.children[1];
        if (valNode) {
          replacements.push({
            start: node.startIndex,
            end: valNode.startIndex,
            text: "",
          });
          collectReplacements(valNode);
          return;
        }
        break;
      }

      case "unary_expression": {
        const raw = node.text.replace(/_/g, "");
        if (/^-\s*(?:0x[0-9a-f]+|\d+)(?:i64|u64|i128|u128|n)$/i.test(raw)) {
          const digits = raw
            .replace(/(?:i64|u64|i128|u128|n)$/i, "")
            .replace(/\s+/g, "");
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: `{"${JSONN.PlaceHolderBigIntKey}":"${digits}"}`,
          });
          return;
        }
        if (
          /^-\s*(?:0x[0-9a-f]+|\d+)(?:i8|u8|i16|u16|i32|u32|isize|usize)$/i.test(
            raw
          )
        ) {
          const digits = raw
            .replace(/(?:i8|u8|i16|u16|i32|u32|isize|usize)$/i, "")
            .replace(/\s+/g, "");
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: digits,
          });
          return;
        }
        if (node.text.includes("INFINITY") || node.text.includes("Infinity")) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: "-Infinity",
          });
          return;
        }
        break;
      }

      case "call_expression": {
        const fnNode = node.childForFieldName("function");
        const argsNode = node.childForFieldName("arguments");
        const fnText = fnNode?.text;

        if (fnText === "Some") {
          const innerArg = argsNode
            ? Parser.getFirstNamedChildNoComments(argsNode)
            : undefined;
          if (innerArg) {
            replacements.push({
              start: node.startIndex,
              end: innerArg.startIndex,
              text: "",
            });
            replacements.push({
              start: innerArg.endIndex,
              end: node.endIndex,
              text: "",
            });
            collectReplacements(innerArg);
            return;
          }
        }

        if (fnText === "String::from") {
          const innerArg = argsNode
            ? Parser.getFirstNamedChildNoComments(argsNode)
            : undefined;
          if (innerArg) {
            replacements.push({
              start: node.startIndex,
              end: innerArg.startIndex,
              text: "",
            });
            replacements.push({
              start: innerArg.endIndex,
              end: node.endIndex,
              text: "",
            });
            collectReplacements(innerArg);
            return;
          }
        }

        if (fnText === "Box::new" || fnText === "std::boxed::Box::new") {
          const innerArg = argsNode
            ? Parser.getFirstNamedChildNoComments(argsNode)
            : undefined;
          if (innerArg) {
            replacements.push({
              start: node.startIndex,
              end: innerArg.startIndex,
              text: "",
            });
            replacements.push({
              start: innerArg.endIndex,
              end: node.endIndex,
              text: "",
            });
            collectReplacements(innerArg);
            return;
          }
        }

        if (
          fnText === "VecDeque::new" ||
          fnText === "std::collections::VecDeque::new"
        ) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: "[]",
          });
          return;
        }

        if (
          fnText === "VecDeque::from" ||
          fnText === "std::collections::VecDeque::from"
        ) {
          const arrNode = argsNode
            ? Parser.getNamedChildrenNoComments(argsNode).find(
                (c) => c.type === "array_expression"
              )
            : undefined;
          if (arrNode) {
            replacements.push({
              start: node.startIndex,
              end: arrNode.startIndex,
              text: "",
            });
            replacements.push({
              start: arrNode.endIndex,
              end: node.endIndex,
              text: "",
            });
            for (let i = 0; i < arrNode.childCount; i++) {
              const child = arrNode.child(i);
              if (child) collectReplacements(child);
            }
            return;
          }
        }

        if (
          fnText === "HashSet::new" ||
          fnText === "std::collections::HashSet::new" ||
          fnText === "BTreeSet::new"
        ) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: `{"${JSONN.PlaceHolderSetKey}":[]}`,
          });
          return;
        }

        if (
          fnText === "HashSet::from" ||
          fnText === "std::collections::HashSet::from" ||
          fnText === "BTreeSet::from"
        ) {
          const arrNode = argsNode
            ? Parser.getNamedChildrenNoComments(argsNode).find(
                (c) => c.type === "array_expression"
              )
            : undefined;
          if (arrNode) {
            replacements.push({
              start: node.startIndex,
              end: arrNode.startIndex,
              text: `{"${JSONN.PlaceHolderSetKey}":`,
            });
            replacements.push({
              start: arrNode.endIndex,
              end: node.endIndex,
              text: "}",
            });
            for (let i = 0; i < arrNode.childCount; i++) {
              const child = arrNode.child(i);
              if (child) collectReplacements(child);
            }
            return;
          }
        }

        if (
          fnText === "HashMap::new" ||
          fnText === "std::collections::HashMap::new" ||
          fnText === "BTreeMap::new"
        ) {
          replacements.push({
            start: node.startIndex,
            end: node.endIndex,
            text: `{"${JSONN.PlaceHolderMapKey}":[]}`,
          });
          return;
        }

        if (
          fnText === "HashMap::from" ||
          fnText === "std::collections::HashMap::from" ||
          fnText === "BTreeMap::from"
        ) {
          const arrNode = argsNode
            ? Parser.getNamedChildrenNoComments(argsNode).find(
                (c) => c.type === "array_expression"
              )
            : undefined;
          if (arrNode) {
            replacements.push({
              start: node.startIndex,
              end: arrNode.startIndex,
              text: `{"${JSONN.PlaceHolderMapKey}":`,
            });
            replacements.push({
              start: arrNode.endIndex,
              end: node.endIndex,
              text: "}",
            });
            for (let i = 0; i < arrNode.childCount; i++) {
              const child = arrNode.child(i);
              if (child) collectReplacements(child);
            }
            return;
          }
        }

        if (fnNode?.type === "field_expression") {
          const fieldNode = fnNode.childForFieldName("field");
          const targetNode = fnNode.childForFieldName("value");
          const fieldName = fieldNode?.text;

          if (
            (fieldName === "to_string" || fieldName === "to_owned") &&
            targetNode
          ) {
            replacements.push({
              start: targetNode.endIndex,
              end: node.endIndex,
              text: "",
            });
            collectReplacements(targetNode);
            return;
          }

          if (fieldName === "to_vec" && targetNode) {
            replacements.push({
              start: targetNode.endIndex,
              end: node.endIndex,
              text: "",
            });
            collectReplacements(targetNode);
            return;
          }
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) collectReplacements(child);
    }
  };

  collectReplacements(tree.rootNode);

  replacements.sort((a, b) => b.start - a.start);
  let modifiedText = parseInput;
  for (const r of replacements) {
    modifiedText =
      modifiedText.slice(0, r.start) + r.text + modifiedText.slice(r.end);
  }

  return JSONN.parse(modifiedText);
} // fn: toJavascriptValue

/**
 * Parses a Rust byte string literal (b"..." or b'...') into a Uint8Array.
 */
function parseRustBytesLiteral(text: string): Uint8Array {
  const match = text.match(/^(?:br#*|b)(["'])/i);
  if (!match) {
    throw new Error(`Invalid Rust bytes literal: ${text}`);
  }
  const quote = match[1];
  const isRaw = /^br/i.test(text);

  const startIdx = text.indexOf(quote) + 1;
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
          case '"':
            byteList.push(34);
            i += 2;
            break;
          case "'":
            byteList.push(39);
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
          case "0":
            byteList.push(0);
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
          default:
            byteList.push(nextChar.charCodeAt(0) & 0xff);
            i += 2;
            break;
        }
      } else {
        byteList.push(char.charCodeAt(0) & 0xff);
        i += 1;
      }
    }
  }

  return new Uint8Array(byteList);
} // fn: parseRustBytesLiteral

/**
 * Parses a Rust raw string literal (e.g. r#"hello "world""#).
 */
function parseRustRawString(text: string): string {
  const match = text.match(/^r(#*)(["'])([\s\S]*)\2\1$/);
  if (match) {
    return match[3];
  }
  return text;
} // fn: parseRustRawString

/**
 * Parses a Rust character literal (e.g. 'c' or '\n').
 */
function parseRustCharLiteral(text: string): string {
  if (text.startsWith("'") && text.endsWith("'")) {
    const inner = text.slice(1, -1);
    if (inner === "\\n") return "\n";
    if (inner === "\\r") return "\r";
    if (inner === "\\t") return "\t";
    if (inner === "\\\\") return "\\";
    if (inner === "\\'") return "'";
    if (inner === "\\0") return "\0";
    if (inner.startsWith("\\x")) {
      return String.fromCharCode(parseInt(inner.slice(2), 16));
    }
    if (inner.startsWith("\\u{") && inner.endsWith("}")) {
      return String.fromCodePoint(parseInt(inner.slice(3, -1), 16));
    }
    return inner;
  }
  return text;
} // fn: parseRustCharLiteral

export type ArgDefContext = {
  isOptional(): boolean;
  getTypeRef(): string | undefined;
  getBaseTypeRef(): string | undefined;
  getOptions(): ArgOptions;
  getType(): ArgTag;
  getChildren(): ArgDefContext[];
  getDim(): number;
  getName?(): string;
};
