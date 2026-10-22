import fs from "node:fs";
import { AbstractProgram } from "../AbstractProgram";
import {
  FunctionRef,
  ProgramImports,
  IdentifierName,
  TypeRef,
  ArgOptions,
  ArgOptionOverride,
  ArgTag,
  TypeAnnotationOptions,
  TypeAnnotationOptionDefaults,
  ProgramLanguage,
} from "../Types";
import { getErrorMessageOrJson } from "../../Util";
import * as ProgramFactory from "../ProgramFactory";
import * as JSONN from "../../../Jsonn";
import * as Parser from "../../adapters/ParserAdapter";
import { ArgDef } from "../ArgDef";

export class RustProgram extends AbstractProgram {
  public static readonly lang: ProgramLanguage = "rust";
  public static readonly extensions: readonly string[] = Object.freeze([".rs"]);
  protected _ast: Parser.Tree | undefined;

  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
    if (parent && RustProgram.lang !== parent.lang) {
      throw new Error(
        `A "${RustProgram.lang}" program cannot be a child of a "${parent.lang}" program.`
      );
    }
  }

  public get lang(): ProgramLanguage {
    return RustProgram.lang;
  }

  public get extensions(): readonly string[] {
    return RustProgram.extensions;
  }

  /**
   * Returns a Rust type annotation string for the given argument.
   */
  public static getTypeAnnotation(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    const typeRef = arg.getTypeRef();
    if (typeRef && options.useTypeRefs) {
      const outerDims = arg.getTypeRefDims() ?? 0;
      let type = `${"Vec<".repeat(outerDims)}${typeRef}${">".repeat(outerDims)}`;
      if (arg.isOptional()) {
        type = `Option<${type}>`;
      }
      return type;
    }

    const baseType = RustProgram.getBaseType(arg, options);
    const dims = arg.getDim();
    let type = `${"Vec<".repeat(dims)}${baseType}${">".repeat(dims)}`;

    if (arg.isOptional()) {
      type = `Option<${type}>`;
    }

    return type;
  } // fn: getTypeAnnotation

  /**
   * Returns the base type string for an argument.
   */
  public static getBaseType(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    const typeRef = arg.getTypeRef();
    if (typeRef && isRustPrimitiveOrBuiltin(typeRef)) {
      return typeRef;
    }

    const argType = arg.getType();
    switch (argType) {
      case ArgTag.BOOLEAN:
        return "bool";
      case ArgTag.NUMBER: {
        const opts = arg.getOptions();
        if (!opts.numInteger) {
          return "f64";
        }
        const intervals = arg.getIntervals();
        if (intervals && intervals.length > 0) {
          const min = intervals[0].min;
          const max = intervals[0].max;
          if (typeof min === "number" && typeof max === "number") {
            if (min === 0 && max === 255) return "u8";
            if (min === -128 && max === 127) return "i8";
            if (min === 0 && max === 65535) return "u16";
            if (min === -32768 && max === 32767) return "i16";
            if (min === 0 && max === 4294967295) return "u32";
          }
        }
        return "i32";
      }
      case ArgTag.BIGINT: {
        const intervals = arg.getIntervals();
        if (intervals && intervals.length > 0) {
          const min = intervals[0].min;
          if (typeof min === "bigint" && min === 0n) return "u64";
        }
        return "i64";
      }
      case ArgTag.STRING:
        return "String";
      case ArgTag.BYTES:
        return "Vec<u8>";
      case ArgTag.TUPLE: {
        const children = arg.getChildren();
        return `(${children.map((c) => RustProgram.getTypeAnnotation(c, options)).join(", ")})`;
      }
      case ArgTag.DICTIONARY: {
        const children = arg.getChildren();
        const keyType =
          children.length > 0
            ? RustProgram.getTypeAnnotation(children[0], options)
            : "String";
        const valType =
          children.length > 1
            ? RustProgram.getTypeAnnotation(children[1], options)
            : "String";
        return `std::collections::HashMap<${keyType}, ${valType}>`;
      }
      case ArgTag.SET: {
        const children = arg.getChildren();
        const elemType =
          children.length > 0
            ? RustProgram.getTypeAnnotation(children[0], options)
            : "String";
        return `std::collections::HashSet<${elemType}>`;
      }
      case ArgTag.OBJECT: {
        return arg.getTypeRef() ?? "struct";
      }
      case ArgTag.LITERAL: {
        const val = arg.getConstantValue();
        if (typeof val === "string") return `"${val}"`;
        if (typeof val === "boolean") return val ? "true" : "false";
        if (typeof val === "number") return `${val}`;
        return arg.getTypeRef() ?? "()";
      }
      case ArgTag.UNION: {
        const children = arg.getChildren();
        return children
          .map((c) => RustProgram.getTypeAnnotation(c, options))
          .join(" | ");
      }
      case ArgTag.UNRESOLVED: {
        throw new Error("Internal error: unresolved types cannot be annotated");
      }
    }
  } // fn: getBaseType

  public resolveTypeRef(typeRef: TypeRef): TypeRef {
    if (typeRef.type && typeRef.type.type !== ArgTag.UNRESOLVED) {
      if (typeRef.type.resolved) {
        return typeRef;
      } else {
        typeRef.type.children.forEach((child) => this.resolveTypeRef(child));
        typeRef.type.resolved = true;
        return typeRef;
      }
    }

    if (!typeRef.typeRefName) {
      throw new Error(
        `Internal error: typeRef is undefined in TypeRef (${JSONN.stringify(
          typeRef
        )})`
      );
    }

    const name = typeRef.typeRefName;
    if (name === "FuzzTestResult") {
      typeRef.type = {
        type: ArgTag.OBJECT,
        dims: 0,
        children: [],
        resolved: true,
      };
      return typeRef;
    }

    const primitiveResolved = resolveRustPrimitive(name);
    if (primitiveResolved) {
      typeRef.type = {
        type: primitiveResolved.tag,
        dims: 0,
        children: [],
        ...(primitiveResolved.options
          ? { options: primitiveResolved.options }
          : {}),
        resolved: true,
      };
      return typeRef;
    }

    if (name in this._types) {
      const resolved = this.resolveTypeRef(this._types[name]);
      typeRef.type = structuredClone(resolved.type);
      if (typeRef.type) {
        typeRef.type.dims += resolved.dims;
      }
      typeRef.optional = typeRef.optional || resolved.optional;
      return typeRef;
    }

    if (name in this._imports.identifiers) {
      const imp = this._imports.identifiers[name];
      if (
        imp.programPath &&
        imp.programPath !== "?" &&
        !imp.programPath.includes("::") &&
        fs.existsSync(imp.programPath)
      ) {
        const importedProgram = ProgramFactory.fromFile(
          imp.programPath,
          "rust",
          this._options,
          this
        );
        const importedType = importedProgram.types[imp.imported];
        if (importedType) {
          const resolved = importedProgram.resolveTypeRef(importedType);
          typeRef.type = structuredClone(resolved.type);
          if (typeRef.type) {
            typeRef.type.dims += resolved.dims;
          }
          typeRef.optional = typeRef.optional || resolved.optional;
          return typeRef;
        }
      }
    }

    // Default unresolved type
    typeRef.type = {
      type: ArgTag.OBJECT,
      dims: 0,
      children: [],
      resolved: true,
    };
    return typeRef;
  } // fn: resolveTypeRef

  protected _parse(src: string): void {
    this._ast = Parser.parse("rust", src) ?? undefined;
  } // fn: _parse

  protected _findImports(): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };
    if (!this._ast) {
      return imports;
    }

    const useQuery = Parser.query(
      "rust",
      `
[
  (use_declaration) @use.decl
]
`
    );

    const matches = useQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const node = match.captures.find((c) => c.name === "use.decl")?.node;
      if (!node) continue;
      extractUseDeclaration(node, imports);
    }

    return imports;
  } // fn: _findImports

  protected _findTypes(): Record<IdentifierName, TypeRef> {
    const types: Record<IdentifierName, TypeRef> = {};
    if (!this._ast) {
      return types;
    }

    const typeQuery = Parser.query(
      "rust",
      `
[
  (type_item
    name: (type_identifier) @type.name
    type: (_) @type.target) @type.item
  (struct_item
    name: (type_identifier) @struct.name) @struct.item
  (enum_item
    name: (type_identifier) @enum.name) @enum.item
]
`
    );

    const matches = typeQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const typeItem = match.captures.find((c) => c.name === "type.item")?.node;
      if (typeItem) {
        const nameNode = match.captures.find(
          (c) => c.name === "type.name"
        )?.node;
        const targetNode = match.captures.find(
          (c) => c.name === "type.target"
        )?.node;
        if (nameNode && targetNode) {
          const isExported = isNodePublic(typeItem);
          const typeRef = this._getTypeRefFromAstNode(targetNode);
          typeRef.name = nameNode.text;
          typeRef.isExported = isExported;
          types[nameNode.text] = typeRef;
        }
        continue;
      }

      const structItem = match.captures.find(
        (c) => c.name === "struct.item"
      )?.node;
      if (structItem) {
        const nameNode = match.captures.find(
          (c) => c.name === "struct.name"
        )?.node;
        if (nameNode) {
          types[nameNode.text] = {
            module: this._filename,
            name: nameNode.text,
            typeRefName: nameNode.text,
            optional: false,
            dims: 0,
            isExported: isNodePublic(structItem),
            type: {
              type: ArgTag.OBJECT,
              dims: 0,
              children: [],
              resolved: true,
            },
          };
        }
        continue;
      }

      const enumItem = match.captures.find((c) => c.name === "enum.item")?.node;
      if (enumItem) {
        const nameNode = match.captures.find(
          (c) => c.name === "enum.name"
        )?.node;
        if (nameNode) {
          types[nameNode.text] = {
            module: this._filename,
            name: nameNode.text,
            typeRefName: nameNode.text,
            optional: false,
            dims: 0,
            isExported: isNodePublic(enumItem),
            type: {
              type: ArgTag.OBJECT,
              dims: 0,
              children: [],
              resolved: true,
            },
          };
        }
      }
    }

    return types;
  } // fn: _findTypes

  protected _findFunctions(): typeof this._functions {
    if (!this._ast) {
      throw new Error("AST not loaded");
    }

    const supported: AbstractProgram["_functions"]["supported"] = {};
    const unsupported: AbstractProgram["_functions"]["unsupported"] = {};

    const fnQuery = Parser.query(
      "rust",
      `
(function_item
  name: (identifier) @function.name
  parameters: (parameters) @function.params
  body: (block) @function.body) @function.item
`
    );

    const matches = fnQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const itemNode = match.captures.find(
        (c) => c.name === "function.item"
      )?.node;
      const nameNode = match.captures.find(
        (c) => c.name === "function.name"
      )?.node;
      const paramsNode = match.captures.find(
        (c) => c.name === "function.params"
      )?.node;
      if (!itemNode || !nameNode || !paramsNode) {
        continue;
      }

      const name = nameNode.text;
      try {
        const fnRef = this._getFunctionFromNode(itemNode, nameNode, paramsNode);
        if (fnRef) {
          supported[fnRef.name] = fnRef;
        }
      } catch (e: unknown) {
        const msg = getErrorMessageOrJson(e);
        unsupported[name] = {
          reason: msg,
          node: JSONN.stringify(itemNode.toString()),
          function: {
            module: this._filename,
            name,
            src: itemNode.text,
            lang: RustProgram.lang,
            startOffset: itemNode.startIndex,
            endOffset: itemNode.endIndex,
            isExported: isNodePublic(itemNode),
            isVoid: false,
            args: [],
          },
        };
      }
    }

    return { supported, unsupported };
  } // fn: _findFunctions

  protected _findDefaultTypeExport(): TypeRef | undefined {
    return undefined;
  } // fn: _findDefaultTypeExport

  /**
   * Identifies all function and method names called within the body of a function.
   *
   * @param fnName Name of function to inspect
   * @returns Set of callee names
   */
  protected _findCallees(fnName: string): Set<string> {
    const callees = new Set<string>();
    const unsupp = this._functions.unsupported[fnName];
    const unsuppFn =
      unsupp && "function" in unsupp ? unsupp.function : undefined;
    const fnRef = this._functions.supported[fnName] ?? unsuppFn;
    if (!fnRef || !fnRef.src) return callees;

    const tree = Parser.parse("rust", fnRef.src);
    if (!tree) {
      throw new Error(
        `Tree-sitter failed to parse Rust function "${fnName}" in module "${this._filename}"`
      );
    }

    const query = Parser.query(
      "rust",
      `
[
  (call_expression function: (identifier) @callee.name)
  (call_expression function: (field_expression field: (field_identifier) @callee.name))
  (call_expression function: (scoped_identifier name: (identifier) @callee.name))
]
`
    );
    const matches = query.matches(tree.rootNode);
    for (const match of matches) {
      const cap = match.captures.find((c) => c.name === "callee.name");
      if (cap) {
        callees.add(cap.node.text);
      }
    }

    return callees;
  } // fn: _findCallees

  protected _getFunctionFromNode(
    itemNode: Parser.SyntaxNode,
    nameNode: Parser.SyntaxNode,
    paramsNode: Parser.SyntaxNode
  ): FunctionRef {
    const isExported = isNodePublic(itemNode);
    const modifiersNode = itemNode.children.find(
      (c) => c.type === "function_modifiers"
    );
    const isAsync = modifiersNode?.text.includes("async") ? true : undefined;

    // Check return type
    const returnTypeNode = itemNode.childForFieldName("return_type");
    let isVoid = true;
    let returnType: TypeRef | undefined = undefined;

    if (returnTypeNode) {
      if (returnTypeNode.type === "unit_type") {
        isVoid = true;
      } else {
        isVoid = false;
        returnType = this._getTypeRefFromAstNode(returnTypeNode);
      }
    }

    // Extract parameters
    const args: TypeRef[] = [];
    const paramChildren = Parser.getNamedChildrenNoComments(paramsNode);
    for (const child of paramChildren) {
      if (child.type === "parameter") {
        const patternNode = child.childForFieldName("pattern");
        const typeNode = child.childForFieldName("type");
        if (!patternNode || !typeNode) {
          continue;
        }
        const paramTypeRef = this._getTypeRefFromAstNode(typeNode);
        paramTypeRef.name = patternNode.text;
        args.push(paramTypeRef);
      }
    }

    const cmt = extractLeadingDocComment(itemNode);

    const fnRef: FunctionRef = {
      module: this._filename,
      name: nameNode.text,
      src: itemNode.text,
      lang: RustProgram.lang,
      startOffset: itemNode.startIndex,
      endOffset: itemNode.endIndex,
      isExported,
      isVoid,
      args,
      ...(isAsync ? { isAsync: true } : {}),
      ...(returnType ? { returnType } : {}),
      ...(cmt ? { cmt } : {}),
    };

    return fnRef;
  } // fn: _getFunctionFromNode

  protected _getTypeRefFromAstNode(node: Parser.SyntaxNode): TypeRef {
    const thisType: TypeRef = {
      module: this._filename,
      dims: 0,
      optional: false,
      isExported: true,
    };

    switch (node.type) {
      case "primitive_type": {
        const resolved = resolveRustPrimitive(node.text);
        if (resolved) {
          thisType.typeRefName = node.text;
          thisType.type = {
            type: resolved.tag,
            dims: 0,
            children: [],
            ...(resolved.options ? { options: resolved.options } : {}),
            resolved: true,
          };
          return thisType;
        }
        thisType.typeRefName = node.text;
        return thisType;
      }
      case "type_identifier": {
        const text = node.text;
        if (text === "String") {
          thisType.typeRefName = text;
          thisType.type = {
            type: ArgTag.STRING,
            dims: 0,
            children: [],
            resolved: true,
          };
          return thisType;
        }
        const primitiveResolved = resolveRustPrimitive(text);
        if (primitiveResolved) {
          thisType.typeRefName = text;
          thisType.type = {
            type: primitiveResolved.tag,
            dims: 0,
            children: [],
            ...(primitiveResolved.options
              ? { options: primitiveResolved.options }
              : {}),
            resolved: true,
          };
          return thisType;
        }
        thisType.typeRefName = text;
        thisType.type = {
          type: ArgTag.UNRESOLVED,
          dims: 0,
          children: [],
          resolved: false,
        };
        return thisType;
      }
      case "reference_type": {
        // e.g. &str, &[T], &T
        const innerTypeNode =
          node.childForFieldName("type") ??
          Parser.getNamedChildrenNoComments(node).at(-1);
        if (!innerTypeNode) {
          thisType.typeRefName = "str";
          thisType.type = {
            type: ArgTag.STRING,
            dims: 0,
            children: [],
            resolved: true,
          };
          return thisType;
        }
        if (
          innerTypeNode.type === "primitive_type" &&
          innerTypeNode.text === "str"
        ) {
          thisType.typeRefName = "&str";
          thisType.type = {
            type: ArgTag.STRING,
            dims: 0,
            children: [],
            resolved: true,
          };
          return thisType;
        }
        return this._getTypeRefFromAstNode(innerTypeNode);
      }
      case "generic_type": {
        const baseTypeNode = node.childForFieldName("type");
        const baseName = baseTypeNode?.text ?? "";
        const typeArgsNode = node.childForFieldName("type_arguments");
        const argNodes = typeArgsNode
          ? Parser.getNamedChildrenNoComments(typeArgsNode)
          : [];

        if (baseName === "Vec") {
          thisType.dims = 1;
          if (argNodes.length > 0) {
            const inner = this._getTypeRefFromAstNode(argNodes[0]);
            thisType.typeRefName = inner.typeRefName;
            thisType.type = {
              type: inner.type?.type ?? ArgTag.UNRESOLVED,
              dims: inner.dims,
              children: inner.type?.children ?? [],
              ...(inner.type?.options ? { options: inner.type.options } : {}),
              resolved: inner.type?.resolved ?? false,
            };
          } else {
            thisType.typeRefName = "i32";
            thisType.type = {
              type: ArgTag.NUMBER,
              dims: 0,
              children: [],
              resolved: true,
            };
          }
          return thisType;
        }

        if (baseName === "Option") {
          thisType.optional = true;
          if (argNodes.length > 0) {
            const inner = this._getTypeRefFromAstNode(argNodes[0]);
            thisType.typeRefName = inner.typeRefName;
            thisType.dims = inner.dims;
            thisType.type = inner.type;
            return thisType;
          }
        }

        if (baseName === "HashMap" || baseName === "BTreeMap") {
          thisType.typeRefName = baseName;
          thisType.baseTypeRef = "Map";
          const children = argNodes.map((c) => this._getTypeRefFromAstNode(c));
          thisType.type = {
            type: ArgTag.DICTIONARY,
            dims: 0,
            children,
            resolved: children.every((c) => c.type?.resolved),
          };
          return thisType;
        }

        if (baseName === "HashSet" || baseName === "BTreeSet") {
          thisType.typeRefName = baseName;
          thisType.baseTypeRef = "Set";
          const children = argNodes.map((c) => this._getTypeRefFromAstNode(c));
          thisType.type = {
            type: ArgTag.SET,
            dims: 0,
            children,
            resolved: children.every((c) => c.type?.resolved),
          };
          return thisType;
        }

        thisType.typeRefName = baseName;
        thisType.type = {
          type: ArgTag.UNRESOLVED,
          dims: 0,
          children: argNodes.map((c) => this._getTypeRefFromAstNode(c)),
          resolved: false,
        };
        return thisType;
      }
      case "array_type": {
        // [T; N] or [T]
        const elemNode = node.childForFieldName("element");
        thisType.dims = 1;
        if (elemNode) {
          const inner = this._getTypeRefFromAstNode(elemNode);
          thisType.type = {
            type: inner.type?.type ?? ArgTag.NUMBER,
            dims: inner.dims,
            children: inner.type?.children ?? [],
            resolved: inner.type?.resolved ?? true,
          };
        } else {
          thisType.type = {
            type: ArgTag.NUMBER,
            dims: 0,
            children: [],
            resolved: true,
          };
        }
        return thisType;
      }
      case "tuple_type": {
        const children = Parser.getNamedChildrenNoComments(node).map((c) =>
          this._getTypeRefFromAstNode(c)
        );
        thisType.type = {
          type: ArgTag.TUPLE,
          dims: 0,
          children,
          resolved: children.every((c) => c.type?.resolved),
        };
        return thisType;
      }
      case "unit_type": {
        thisType.type = {
          type: ArgTag.OBJECT,
          dims: 0,
          children: [],
          resolved: true,
        };
        return thisType;
      }
      default: {
        thisType.typeRefName = node.text;
        thisType.type = {
          type: ArgTag.UNRESOLVED,
          dims: 0,
          children: [],
          resolved: false,
        };
        return thisType;
      }
    }
  } // fn: _getTypeRefFromAstNode
} // class: RustProgram

// ============================================================================
// Helper Functions
// ============================================================================

function isNodePublic(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "visibility_modifier") {
      return true;
    }
  }
  return false;
} // fn: isNodePublic

function extractLeadingDocComment(node: Parser.SyntaxNode): string | undefined {
  const comments: string[] = [];
  let prev = node.previousNamedSibling;

  while (
    prev &&
    (prev.type === "line_comment" || prev.type === "block_comment")
  ) {
    const text = prev.text.trim();
    if (text.startsWith("///")) {
      comments.unshift(text.replace(/^\/\/\/\s?/, ""));
    }
    prev = prev.previousNamedSibling;
  }

  return comments.length > 0 ? comments.join("\n") : undefined;
} // fn: extractLeadingDocComment

function extractUseDeclaration(
  node: Parser.SyntaxNode,
  imports: ProgramImports
): void {
  const argNode = node.childForFieldName("argument");
  if (!argNode) return;

  const text = argNode.text;
  if (text.includes("::")) {
    const parts = text.split("::");
    const local = parts[parts.length - 1];
    imports.identifiers[local] = {
      local,
      imported: local,
      programPath: text,
      resolved: false,
      default: false,
    };
  } else {
    imports.identifiers[text] = {
      local: text,
      imported: text,
      programPath: text,
      resolved: false,
      default: false,
    };
  }
} // fn: extractUseDeclaration

function resolveRustPrimitive(name: string):
  | {
      tag: ArgTag;
      options?: ArgOptionOverride;
    }
  | undefined {
  switch (name) {
    case "bool":
      return { tag: ArgTag.BOOLEAN };
    case "u8":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: 0, max: 255 }],
        },
      };
    case "i8":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -128, max: 127 }],
        },
      };
    case "u16":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: 0, max: 65535 }],
        },
      };
    case "i16":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -32768, max: 32767 }],
        },
      };
    case "u32":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: 0, max: 4294967295 }],
        },
      };
    case "i32":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -2147483648, max: 2147483647 }],
        },
      };
    case "usize":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: 0, max: 4294967295 }],
        },
      };
    case "isize":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -2147483648, max: 2147483647 }],
        },
      };
    case "u64":
      return {
        tag: ArgTag.BIGINT,
        options: {
          bigintIntervals: [{ min: 0n, max: 18446744073709551615n }],
        },
      };
    case "i64":
      return {
        tag: ArgTag.BIGINT,
        options: {
          bigintIntervals: [
            { min: -9223372036854775808n, max: 9223372036854775807n },
          ],
        },
      };
    case "u128":
    case "i128":
      return {
        tag: ArgTag.BIGINT,
      };
    case "f32":
    case "f64":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: false,
        },
      };
    case "str":
      return { tag: ArgTag.STRING };
    case "char":
      return {
        tag: ArgTag.STRING,
        options: {
          strLength: { min: 1, max: 1 },
        },
      };
    default:
      return undefined;
  }
} // fn: resolveRustPrimitive

function isRustPrimitiveOrBuiltin(name: string): boolean {
  const builtins = new Set([
    "bool",
    "u8",
    "i8",
    "u16",
    "i16",
    "u32",
    "i32",
    "u64",
    "i64",
    "u128",
    "i128",
    "usize",
    "isize",
    "f32",
    "f64",
    "str",
    "String",
    "char",
    "&str",
  ]);
  return builtins.has(name);
} // fn: isRustPrimitiveOrBuiltin
