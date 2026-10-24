import fs from "node:fs";
import path from "node:path";
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
        typeRef.type.resolved = typeRef.type.children.every(
          (child) => child.type?.resolved ?? false
        );
        if (!typeRef.type.resolved) {
          throw new Error(
            `Unable to resolve type '${typeRef.typeRefName ?? "unknown"}' in module '${this._filename}'`
          );
        }
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
    if (
      name === "FuzzTestResult" ||
      name.includes("Fn") ||
      typeRef.name === "prng"
    ) {
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
        dims: typeRef.dims,
        children: [],
        ...(primitiveResolved.options
          ? { options: primitiveResolved.options }
          : {}),
        resolved: true,
      };
      return typeRef;
    }

    if (name in this._types) {
      const typeDef = this._types[name];
      if (typeDef.type?.resolved) {
        typeRef.type = structuredClone(typeDef.type);
        if (typeRef.type) {
          typeRef.type.dims += typeDef.dims;
        }
        typeRef.optional = typeRef.optional || typeDef.optional;
        return typeRef;
      } else if (typeDef.typeRefName && typeDef.typeRefName !== name) {
        const resolved = this.resolveTypeRef(typeDef);
        typeRef.type = structuredClone(resolved.type);
        if (typeRef.type) {
          typeRef.type.dims += resolved.dims;
        }
        typeRef.optional = typeRef.optional || resolved.optional;
        return typeRef;
      }
      throw new Error(
        `Unable to resolve type '${name}' in module '${this._filename}'`
      );
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

    throw new Error(
      `Unable to resolve type '${name}' in module '${this._filename}'`
    );
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
(type_item
  name: (type_identifier) @type.name
  type: (_) @type.target) @type.item
`
    );

    const matches = typeQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const typeItem = match.captures.find((c) => c.name === "type.item")?.node;
      const nameNode = match.captures.find((c) => c.name === "type.name")?.node;
      const targetNode = match.captures.find(
        (c) => c.name === "type.target"
      )?.node;
      if (typeItem && nameNode && targetNode) {
        try {
          const typeRef = this._getTypeRefFromAstNode(targetNode);
          typeRef.name = nameNode.text;
          typeRef.isExported = isNodePublic(typeItem);
          types[nameNode.text] = typeRef;
        } catch (e) {
          console.debug(
            `Error getting TypeRef from AST node for ${nameNode.text} in module ${this._filename}, ignoring. Reason: ${e}`
          );
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
    if (itemNode.parent && itemNode.parent.type !== "source_file") {
      throw new Error(
        `Function '${nameNode.text}' is not a top-level module function`
      );
    }

    const typeParamsNode = itemNode.childForFieldName("type_parameters");
    if (typeParamsNode) {
      const allLifetimes = Parser.getNamedChildrenNoComments(
        typeParamsNode
      ).every(
        (child) =>
          child.type === "lifetime_parameter" || child.type === "lifetime"
      );
      if (!allLifetimes) {
        throw new Error(
          `Generic function '${nameNode.text}' with type parameters is not supported`
        );
      }
    }

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
      if (child.type !== "parameter") {
        throw new Error(
          `Unsupported parameter kind '${child.type}' in function '${nameNode.text}'`
        );
      }
      const patternNode = child.childForFieldName("pattern");
      const typeNode = child.childForFieldName("type");
      if (!patternNode || !typeNode) {
        throw new Error(
          `Parameter in function '${nameNode.text}' is missing type or pattern`
        );
      }
      let paramName: string;
      if (patternNode.type === "identifier") {
        paramName = patternNode.text;
      } else if (patternNode.type === "mut_pattern") {
        const inner = Parser.getNamedChildrenNoComments(patternNode).find(
          (c) => c.type === "identifier"
        );
        if (inner) {
          paramName = inner.text;
        } else {
          throw new Error(
            `Unsupported parameter pattern in function '${nameNode.text}'`
          );
        }
      } else {
        throw new Error(
          `Unsupported parameter pattern '${patternNode.type}' in function '${nameNode.text}'`
        );
      }
      const paramTypeRef = this._getTypeRefFromAstNode(typeNode);
      paramTypeRef.name = paramName;
      args.push(paramTypeRef);
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
        throw new Error(`Unsupported primitive type '${node.text}'`);
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
        if (text === "FuzzTestResult") {
          thisType.typeRefName = text;
          thisType.type = {
            type: ArgTag.OBJECT,
            dims: 0,
            children: [],
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
        if (
          node.text.startsWith("&mut") ||
          node.children.some((c) => c.type === "mutable_specifier")
        ) {
          throw new Error(
            `Mutable reference parameter '${node.text}' is not supported`
          );
        }
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
        const rawBaseName = baseTypeNode?.text ?? "";
        const baseName = rawBaseName.includes("::")
          ? rawBaseName.slice(rawBaseName.lastIndexOf("::") + 2)
          : rawBaseName;
        const typeArgsNode = node.childForFieldName("type_arguments");
        const argNodes = typeArgsNode
          ? Parser.getNamedChildrenNoComments(typeArgsNode)
          : [];

        switch (baseName) {
          case "Vec": {
            if (argNodes.length === 0) {
              throw new Error(
                `Missing type argument for Vec in '${node.text}'`
              );
            }
            const inner = this._getTypeRefFromAstNode(argNodes[0]);
            thisType.dims = 1;
            thisType.typeRefName = inner.typeRefName;
            thisType.type = {
              type: inner.type?.type ?? ArgTag.UNRESOLVED,
              dims: inner.dims,
              children: inner.type?.children ?? [],
              ...(inner.type?.options ? { options: inner.type.options } : {}),
              resolved: inner.type?.resolved ?? false,
            };
            return thisType;
          }
          case "Option": {
            if (argNodes.length === 0) {
              throw new Error(
                `Missing type argument for Option in '${node.text}'`
              );
            }
            const inner = this._getTypeRefFromAstNode(argNodes[0]);
            thisType.optional = true;
            thisType.typeRefName = inner.typeRefName;
            thisType.dims = inner.dims;
            thisType.type = inner.type;
            return thisType;
          }
          case "HashMap":
          case "BTreeMap": {
            if (argNodes.length < 2) {
              throw new Error(
                `Missing type arguments for ${baseName} in '${node.text}'`
              );
            }
            thisType.typeRefName = baseName;
            thisType.baseTypeRef = "Map";
            const children = [
              this._getTypeRefFromAstNode(argNodes[0]),
              this._getTypeRefFromAstNode(argNodes[1]),
            ];
            thisType.type = {
              type: ArgTag.DICTIONARY,
              dims: 0,
              children,
              resolved: children.every((c) => c.type?.resolved),
            };
            return thisType;
          }
          case "HashSet":
          case "BTreeSet": {
            if (argNodes.length === 0) {
              throw new Error(
                `Missing type argument for ${baseName} in '${node.text}'`
              );
            }
            thisType.typeRefName = baseName;
            thisType.baseTypeRef = "Set";
            const children = [this._getTypeRefFromAstNode(argNodes[0])];
            thisType.type = {
              type: ArgTag.SET,
              dims: 0,
              children,
              resolved: children.every((c) => c.type?.resolved),
            };
            return thisType;
          }
          default:
            throw new Error(
              `Unsupported generic type '${baseName}' in module '${this._filename}'`
            );
        }
      }
      case "array_type": {
        // [T; N] or [T]
        const elemNode = node.childForFieldName("element");
        thisType.dims = 1;
        if (elemNode) {
          const inner = this._getTypeRefFromAstNode(elemNode);
          thisType.typeRefName = inner.typeRefName;
          thisType.type = {
            type: inner.type?.type ?? ArgTag.NUMBER,
            dims: inner.dims,
            children: inner.type?.children ?? [],
            resolved: inner.type?.resolved ?? false,
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
      case "abstract_type": {
        if (node.text.includes("Fn")) {
          thisType.typeRefName = node.text;
          thisType.type = {
            type: ArgTag.OBJECT,
            dims: 0,
            children: [],
            resolved: true,
          };
          return thisType;
        }
        throw new Error(`Unsupported abstract type '${node.text}'`);
      }
      default: {
        throw new Error(
          `Unsupported type annotation '${node.text}' of kind '${node.type}'`
        );
      }
    }
  } // fn: _getTypeRefFromAstNode

  /**
   * Recursively discovers local module files referenced by `mod <name>;` declarations
   * starting from the given Rust source file.
   *
   * @param sourceFile Root source file to start traversal from
   * @param visited Set of already visited file paths
   * @returns Array of absolute file paths to discovered local module files
   */
  public static findLocalModules(
    sourceFile: string,
    visited: Set<string> = new Set()
  ): string[] {
    return findLocalModules(sourceFile, visited);
  } // fn: findLocalModules

  /**
   * Discovers top-level 3rd-party or external crate identifiers directly imported
   * in the given Rust source file via `use <crate>::...` or `extern crate <crate>;`.
   *
   * @param sourceFile Absolute path to the source file
   * @returns Array of unique crate identifiers
   */
  public static findDirectCrates(sourceFile: string): string[] {
    return findDirectCrates(sourceFile);
  } // fn: findDirectCrates

  /**
   * Converts a Rust type annotation (including borrowed references and slices)
   * into its owned, deserializable type for FuzzTestResult unpacking.
   *
   * @param typeAnnot Raw Rust type annotation (e.g. '&str', '&[i32]', '&MyStruct')
   * @returns Owned Rust type string (e.g. 'String', 'Vec<i32>', 'MyStruct')
   */
  public static toOwnedType(typeAnnot: string): string {
    return toOwnedRustType(typeAnnot);
  } // fn: toOwnedType
} // class: RustProgram

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks whether an AST syntax node has a public visibility modifier (`pub`).
 *
 * @param node The AST syntax node to check
 * @returns True if the node has `pub` visibility, false otherwise
 */
function isNodePublic(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "visibility_modifier") {
      return true;
    }
  }
  return false;
} // fn: isNodePublic

/**
 * Extracts triple-slash documentation comments (`///`) immediately preceding an AST node.
 *
 * @param node The AST syntax node to inspect
 * @returns Combined doc comment string, or undefined if no doc comments exist
 */
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

/**
 * Extracts imported identifiers from a Rust `use` declaration node and populates `imports`.
 *
 * @param node The `use_declaration` AST syntax node
 * @param imports ProgramImports collection to populate with imported identifiers
 */
function extractUseDeclaration(
  node: Parser.SyntaxNode,
  imports: ProgramImports
): void {
  const argNode = node.childForFieldName("argument");
  if (!argNode) return;

  collectUseIdentifiers(argNode, "", imports);
} // fn: extractUseDeclaration

/**
 * Recursively traverses a Rust `use` clause argument node to collect imported identifiers,
 * supporting nested scoped lists (`use a::{b, c};`), aliasing (`use a as b;`), and paths.
 *
 * @param node Current AST syntax node in the use tree
 * @param prefix Accumulated module path prefix (e.g. "std::collections")
 * @param imports ProgramImports collection to populate with imported identifiers
 */
function collectUseIdentifiers(
  node: Parser.SyntaxNode,
  prefix: string,
  imports: ProgramImports
): void {
  switch (node.type) {
    case "scoped_use_list": {
      const pathNode = node.childForFieldName("path");
      const listNode = node.childForFieldName("list");
      const base = pathNode
        ? prefix
          ? `${prefix}::${pathNode.text}`
          : pathNode.text
        : prefix;
      if (listNode) {
        collectUseIdentifiers(listNode, base, imports);
      }
      break;
    }
    case "use_list": {
      for (const child of node.namedChildren) {
        collectUseIdentifiers(child, prefix, imports);
      }
      break;
    }
    case "use_as_clause": {
      const aliasNode = node.childForFieldName("alias");
      const pathNode = node.childForFieldName("path");
      const fullPath = pathNode
        ? prefix
          ? `${prefix}::${pathNode.text}`
          : pathNode.text
        : "";
      if (aliasNode) {
        const local = aliasNode.text;
        imports.identifiers[local] = {
          local,
          imported: pathNode?.text ?? local,
          programPath: fullPath,
          resolved: false,
          default: false,
        };
      }
      break;
    }
    case "scoped_identifier": {
      const nameNode = node.childForFieldName("name");
      const pathNode = node.childForFieldName("path");
      const fullPath = pathNode
        ? prefix
          ? `${prefix}::${pathNode.text}`
          : pathNode.text
        : "";
      const local = nameNode?.text ?? node.text.split("::").pop() ?? node.text;
      const progPath = fullPath ? `${fullPath}::${local}` : node.text;
      imports.identifiers[local] = {
        local,
        imported: local,
        programPath: progPath,
        resolved: false,
        default: false,
      };
      break;
    }
    case "identifier": {
      const local = node.text;
      const progPath = prefix ? `${prefix}::${local}` : local;
      imports.identifiers[local] = {
        local,
        imported: local,
        programPath: progPath,
        resolved: false,
        default: false,
      };
      break;
    }
    default: {
      const text = node.text;
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
      } else if (text && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text)) {
        imports.identifiers[text] = {
          local: text,
          imported: text,
          programPath: text,
          resolved: false,
          default: false,
        };
      }
      break;
    }
  }
} // fn: collectUseIdentifiers

/**
 * Resolves a Rust primitive type name to its corresponding ArgTag and interval/option overrides.
 *
 * @param name Primitive type name (e.g. "bool", "i32", "f64")
 * @returns Object with ArgTag and optional interval/integer overrides, or undefined if not primitive
 */
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

/**
 * Checks whether an identifier corresponds to a Rust primitive or built-in scalar type name.
 *
 * @param name The type name to check
 * @returns True if the identifier is a primitive or built-in, false otherwise
 */
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

/**
 * Finds local Rust modules referenced in a source file, considering both standard module paths and custom paths specified with #[path = "..."].
 *
 * @param sourceFile The path to the Rust source file to analyze for local modules.
 * @param visited A set of already visited files to avoid circular dependencies.
 * @returns An array of file paths corresponding to local modules found in the source file.
 */
function findLocalModules(
  sourceFile: string,
  visited: Set<string> = new Set()
): string[] {
  const norm = fs.existsSync(sourceFile)
    ? fs.realpathSync(sourceFile)
    : path.resolve(sourceFile);
  if (visited.has(norm) || !fs.existsSync(norm)) {
    return [];
  }
  visited.add(norm);

  const results: string[] = [];
  const src = fs.readFileSync(norm, "utf8");
  const tree = Parser.parse("rust", src);
  if (!tree) return results;

  const modQuery = Parser.query(
    "rust",
    `
(mod_item
  name: (identifier) @mod.name
  ";") @mod.decl
`
  );
  const matches = modQuery.matches(tree.rootNode);
  const dir = path.dirname(norm);

  for (const match of matches) {
    const nameNode = match.captures.find((c) => c.name === "mod.name")?.node;
    const declNode = match.captures.find((c) => c.name === "mod.decl")?.node;
    if (!nameNode || !declNode) continue;
    const modName = nameNode.text;

    // Check for #[path = "..."] on attributes preceding the mod declaration
    let customPath: string | undefined;
    let prev = declNode.previousNamedSibling;
    while (prev && prev.type === "attribute_item") {
      const attrText = prev.text;
      const pathMatch = attrText.match(/path\s*=\s*"([^"]+)"/);
      if (pathMatch) {
        customPath = pathMatch[1];
        break;
      }
      prev = prev.previousNamedSibling;
    }

    let candidatePath: string | undefined;
    if (customPath) {
      const resolved = path.resolve(dir, customPath);
      if (fs.existsSync(resolved)) candidatePath = resolved;
    } else {
      const fileStem = path.basename(norm, ".rs");
      const candidates = [
        path.join(dir, `${modName}.rs`),
        path.join(dir, modName, "mod.rs"),
      ];
      if (fileStem !== "lib" && fileStem !== "main" && fileStem !== "mod") {
        candidates.unshift(
          path.join(dir, fileStem, `${modName}.rs`),
          path.join(dir, fileStem, modName, "mod.rs")
        );
      }
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          candidatePath = cand;
          break;
        }
      }
    }

    if (candidatePath) {
      const realCandidate = fs.existsSync(candidatePath)
        ? fs.realpathSync(candidatePath)
        : path.resolve(candidatePath);
      if (!visited.has(realCandidate)) {
        results.push(realCandidate);
        results.push(...findLocalModules(realCandidate, visited));
      }
    }
  }

  return results;
} // fn: findLocalModules

const BUILTIN_CRATES = new Set([
  "std",
  "core",
  "alloc",
  "crate",
  "super",
  "self",
  "nanofuzz_runtime",
  "nanofuzz-runtime",
]);

/**
 * Finds directly imported external crate identifiers from a Rust source file.
 *
 * @param sourceFile The path to the Rust source file.
 * @returns Array of unique external crate identifiers.
 */
function findDirectCrates(sourceFile: string): string[] {
  const norm = fs.existsSync(sourceFile)
    ? fs.realpathSync(sourceFile)
    : path.resolve(sourceFile);
  if (!fs.existsSync(norm)) {
    return [];
  }

  const crates = new Set<string>();
  const src = fs.readFileSync(norm, "utf8");
  const tree = Parser.parse("rust", src);
  if (!tree) return [];

  const query = Parser.query(
    "rust",
    `
(use_declaration) @use.decl
(extern_crate_declaration
  name: (identifier) @extern.name) @extern.decl
`
  );
  const matches = query.matches(tree.rootNode);

  for (const match of matches) {
    const externName = match.captures.find(
      (c) => c.name === "extern.name"
    )?.node;
    if (externName) {
      const name = externName.text.trim();
      if (name && !BUILTIN_CRATES.has(name)) {
        crates.add(name);
      }
      continue;
    }

    const useNode = match.captures.find((c) => c.name === "use.decl")?.node;
    if (!useNode) continue;
    const argNode = useNode.childForFieldName("argument");
    if (!argNode) continue;

    const raw = argNode.text.trim();
    const root = raw.split("::")[0].trim().split(/\s+/)[0];
    if (
      root &&
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(root) &&
      !BUILTIN_CRATES.has(root)
    ) {
      crates.add(root);
    }
  }

  return Array.from(crates);
} // fn: findDirectCrates

/**
 * Normalizes borrowed reference and slice type annotations into owned types suitable for deserialization.
 * For example, converts `&str` to `String`, `&[T]` to `Vec<T>`, and `&T` to `T`.
 *
 * @param typeAnnot Raw Rust type annotation string
 * @returns Corresponding owned Rust type string
 */
function toOwnedRustType(typeAnnot: string): string {
  const trimmed = typeAnnot.trim();
  const stripped = trimmed.replace(/^&'([a-zA-Z_][a-zA-Z0-9_]*)\s+/, "&");
  if (stripped === "&str" || stripped === "str") {
    return "String";
  }
  if (stripped.startsWith("&[") && stripped.endsWith("]")) {
    const inner = stripped.slice(2, -1).trim();
    return `Vec<${inner}>`;
  }
  if (stripped.startsWith("&")) {
    return stripped.slice(1).trim();
  }
  return trimmed;
} // fn: toOwnedRustType
