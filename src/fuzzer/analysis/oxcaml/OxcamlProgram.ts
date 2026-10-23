import fs from "node:fs";
import path from "node:path";
import { AbstractProgram } from "../AbstractProgram";
import {
  FunctionRef,
  ProgramImports,
  IdentifierName,
  TypeRef,
  ArgOptions,
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

export class OxcamlProgram extends AbstractProgram {
  public static readonly lang: ProgramLanguage = "oxcaml";
  public static readonly extensions: readonly string[] = Object.freeze([
    ".ml",
    ".mli",
  ]);
  protected _ast: Parser.Tree | undefined;

  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
    if (parent && OxcamlProgram.lang !== parent.lang) {
      throw new Error(
        `A "${OxcamlProgram.lang}" program cannot be a child of a "${parent.lang}" program.`
      );
    }
  } // constructor

  public get lang(): ProgramLanguage {
    return OxcamlProgram.lang;
  } // fn: lang

  public get extensions(): readonly string[] {
    return OxcamlProgram.extensions;
  } // fn: extensions

  /**
   * Returns an OCaml/OxCaml type annotation string for the given argument.
   */
  public static getTypeAnnotation(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    const typeRef = arg.getTypeRef();
    if (typeRef && options.useTypeRefs) {
      const outerDims = arg.getTypeRefDims() ?? 0;
      let type = typeRef;
      if (outerDims > 0) {
        type = `${type}${" list".repeat(outerDims)}`;
      }
      if (arg.isOptional()) {
        type = `${type} option`;
      }
      return type;
    }

    const baseType = OxcamlProgram.getBaseType(arg, options);
    const dims = arg.getDim();
    let type = baseType;
    if (dims > 0) {
      const needsParens = baseType.includes(" ") || baseType.includes("*");
      const elemType = needsParens ? `(${baseType})` : baseType;
      type = `${elemType}${" list".repeat(dims)}`;
    }

    if (arg.isOptional()) {
      type = `${type} option`;
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
    if (typeRef && isOxcamlPrimitiveOrBuiltin(typeRef)) {
      return typeRef;
    }

    const argType = arg.getType();
    switch (argType) {
      case ArgTag.BOOLEAN:
        return "bool";
      case ArgTag.NUMBER: {
        const opts = arg.getOptions();
        if (!opts.numInteger) {
          return "float";
        }
        if (typeRef === "int32") return "int32";
        if (typeRef === "nativeint") return "nativeint";
        if (typeRef === "#int") return "#int";
        return "int";
      }
      case ArgTag.BIGINT:
        return "int64";
      case ArgTag.STRING: {
        const opts = arg.getOptions();
        if (opts.strLength?.min === 1 && opts.strLength?.max === 1) {
          return "char";
        }
        return "string";
      }
      case ArgTag.BYTES:
        return "bytes";
      case ArgTag.TUPLE: {
        const children = arg.getChildren();
        return `(${children.map((c) => OxcamlProgram.getTypeAnnotation(c, options)).join(" * ")})`;
      }
      case ArgTag.DICTIONARY: {
        const children = arg.getChildren();
        const keyType =
          children.length > 0
            ? OxcamlProgram.getTypeAnnotation(children[0], options)
            : "string";
        const valType =
          children.length > 1
            ? OxcamlProgram.getTypeAnnotation(children[1], options)
            : "string";
        return `(${keyType}, ${valType}) Hashtbl.t`;
      }
      case ArgTag.SET: {
        const children = arg.getChildren();
        const elemType =
          children.length > 0
            ? OxcamlProgram.getTypeAnnotation(children[0], options)
            : "string";
        return `${elemType} Set.t`;
      }
      case ArgTag.OBJECT:
        return arg.getTypeRef() ?? "unit";
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
          .map((c) => OxcamlProgram.getTypeAnnotation(c, options))
          .join(" | ");
      }
      case ArgTag.UNRESOLVED:
        throw new Error("Internal error: unresolved types cannot be annotated");
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
    if (name === "FuzzTestResult" || name === "fuzz_test_result") {
      typeRef.type = {
        type: ArgTag.OBJECT,
        dims: 0,
        children: [],
        resolved: true,
      };
      return typeRef;
    }

    const primitiveResolved = resolveOxcamlPrimitive(name);
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
        fs.existsSync(imp.programPath)
      ) {
        const importedProgram = ProgramFactory.fromFile(
          imp.programPath,
          "oxcaml",
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
    this._ast = Parser.parse("oxcaml", src) ?? undefined;
  } // fn: _parse

  protected _findImports(): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };
    if (!this._ast) {
      return imports;
    }

    const openQuery = Parser.query(
      "oxcaml",
      `
[
  (open_module (module_path) @open.path)
]
`
    );

    const matches = openQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const pathNode = match.captures.find((c) => c.name === "open.path")?.node;
      if (!pathNode) continue;
      const modPath = pathNode.text;
      imports.programs[modPath] = modPath;

      // Check if local file exists relative to current module
      if (this._filename) {
        const dir = path.dirname(this._filename);
        const candidateFile = path.join(dir, `${modPath.toLowerCase()}.ml`);
        if (fs.existsSync(candidateFile)) {
          imports.identifiers[modPath] = {
            local: modPath,
            imported: modPath,
            programPath: candidateFile,
            resolved: true,
            default: false,
          };
        }
      }
    }

    return imports;
  } // fn: _findImports

  protected _findTypes(): Record<IdentifierName, TypeRef> {
    const types: Record<IdentifierName, TypeRef> = {};
    if (!this._ast) {
      return types;
    }

    const typeQuery = Parser.query(
      "oxcaml",
      `
[
  (type_definition (type_binding (type_constructor) @type.name) @type.binding) @type.def
]
`
    );

    const matches = typeQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const nameNode = match.captures.find((c) => c.name === "type.name")?.node;
      const bindingNode = match.captures.find(
        (c) => c.name === "type.binding"
      )?.node;
      if (!nameNode || !bindingNode) continue;

      const typeName = nameNode.text;
      const targetNode = bindingNode.namedChildren[1];
      if (!targetNode) continue;

      if (targetNode.type === "record_declaration") {
        const children: TypeRef[] = [];
        for (const child of Parser.getNamedChildrenNoComments(targetNode)) {
          if (child.type === "field_declaration") {
            const fieldNameNode =
              child.childForFieldName("name") ?? child.namedChildren[0];
            const fieldTypeNode = child.namedChildren[1];
            if (fieldNameNode && fieldTypeNode) {
              const fieldTypeRef = this._getTypeRefFromAstNode(fieldTypeNode);
              fieldTypeRef.name = fieldNameNode.text;
              children.push(fieldTypeRef);
            }
          }
        }
        types[typeName] = {
          module: this._filename,
          name: typeName,
          typeRefName: typeName,
          optional: false,
          dims: 0,
          isExported: !typeName.startsWith("_"),
          type: {
            type: ArgTag.OBJECT,
            dims: 0,
            children,
            resolved: true,
          },
        };
      } else if (targetNode.type === "variant_declaration") {
        types[typeName] = {
          module: this._filename,
          name: typeName,
          typeRefName: typeName,
          optional: false,
          dims: 0,
          isExported: !typeName.startsWith("_"),
          type: {
            type: ArgTag.OBJECT,
            dims: 0,
            children: [],
            resolved: true,
          },
        };
      } else {
        const typeRef = this._getTypeRefFromAstNode(targetNode);
        typeRef.name = typeName;
        typeRef.isExported = !typeName.startsWith("_");
        types[typeName] = typeRef;
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

    // Determine exported functions via .mli if present
    const mliExports = this._getMliExports();

    const fnQuery = Parser.query(
      "oxcaml",
      `
(value_definition
  (let_binding
    pattern: (value_name) @function.name) @function.binding) @function.item
`
    );

    const matches = fnQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const itemNode = match.captures.find(
        (c) => c.name === "function.item"
      )?.node;
      const bindingNode = match.captures.find(
        (c) => c.name === "function.binding"
      )?.node;
      const nameNode = match.captures.find(
        (c) => c.name === "function.name"
      )?.node;

      if (!itemNode || !bindingNode || !nameNode) {
        continue;
      }

      const name = nameNode.text;
      const isExported = mliExports
        ? mliExports.has(name)
        : !name.startsWith("_");

      try {
        const fnRef = this._getFunctionFromNode(
          itemNode,
          bindingNode,
          nameNode,
          isExported
        );
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
            lang: OxcamlProgram.lang,
            startOffset: itemNode.startIndex,
            endOffset: itemNode.endIndex,
            isExported,
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

  protected _findCallees(fnName: string): Set<string> {
    const callees = new Set<string>();
    const unsupp = this._functions.unsupported[fnName];
    const unsuppFn =
      unsupp && "function" in unsupp ? unsupp.function : undefined;
    const fnRef = this._functions.supported[fnName] ?? unsuppFn;
    if (!fnRef || !fnRef.src) return callees;

    const tree = Parser.parse("oxcaml", fnRef.src);
    if (!tree) {
      throw new Error(
        `Tree-sitter failed to parse OCaml function "${fnName}" in module "${this._filename}"`
      );
    }

    const query = Parser.query(
      "oxcaml",
      `
[
  (application_expression function: (value_path) @callee.path)
  (application_expression function: (value_path (value_name) @callee.name))
  (application_expression function: (value_path (module_path) (value_name) @callee.name))
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
    bindingNode: Parser.SyntaxNode,
    nameNode: Parser.SyntaxNode,
    isExported: boolean
  ): FunctionRef {
    // Return type
    const returnTypeNode = bindingNode.childForFieldName("type");
    let isVoid = false;
    let returnType: TypeRef | undefined = undefined;

    if (returnTypeNode) {
      if (returnTypeNode.text === "unit") {
        isVoid = true;
      } else {
        returnType = this._getTypeRefFromAstNode(returnTypeNode);
      }
    }

    // Parameters
    const args: TypeRef[] = [];
    const children = Parser.getNamedChildrenNoComments(bindingNode);
    for (const child of children) {
      if (child.type === "parameter") {
        const paramRef = this._getParameterTypeRef(child);
        if (paramRef) {
          args.push(paramRef);
        }
      }
    }

    const cmt = extractLeadingDocComment(itemNode);

    const fnRef: FunctionRef = {
      module: this._filename,
      name: nameNode.text,
      src: itemNode.text,
      lang: OxcamlProgram.lang,
      startOffset: itemNode.startIndex,
      endOffset: itemNode.endIndex,
      isExported,
      isVoid,
      args,
      ...(returnType ? { returnType } : {}),
      ...(cmt ? { cmt } : {}),
    };

    return fnRef;
  } // fn: _getFunctionFromNode

  protected _getParameterTypeRef(
    paramNode: Parser.SyntaxNode
  ): TypeRef | undefined {
    const text = paramNode.text.trim();
    // Special case: unit argument `()` indicates zero-argument function
    if (text === "()" || paramNode.type === "unit") {
      return undefined;
    }

    const isOptional = text.startsWith("?");

    let paramName: string;
    let typeNode: Parser.SyntaxNode | undefined = undefined;

    const namedChildren = Parser.getNamedChildrenNoComments(paramNode);
    if (namedChildren.length === 0) {
      paramName = text.replace(/^[~?]/, "").replace(/^[()]/, "").trim();
    } else {
      const firstChild = namedChildren[0];
      if (firstChild.type === "typed_pattern") {
        const patternChild = firstChild.namedChildren[0];
        paramName = patternChild ? patternChild.text : "";
        typeNode = firstChild.namedChildren[1];
      } else if (firstChild.type === "value_pattern") {
        paramName = firstChild.text;
        if (namedChildren.length > 1) {
          typeNode = namedChildren[1];
        }
      } else {
        paramName = firstChild.text;
      }
    }

    paramName = paramName.replace(/^[~?]/, "").trim();

    let typeRef: TypeRef;
    if (typeNode) {
      typeRef = this._getTypeRefFromAstNode(typeNode);
    } else {
      throw new Error(`Missing type annotation: ${paramName}`);
    }

    typeRef.name = paramName;
    if (isOptional) {
      typeRef.optional = true;
    }

    return typeRef;
  } // fn: _getParameterTypeRef

  protected _getTypeRefFromAstNode(node: Parser.SyntaxNode): TypeRef {
    const thisType: TypeRef = {
      module: this._filename,
      dims: 0,
      optional: false,
      isExported: true,
    };

    switch (node.type) {
      case "type_constructor_path":
      case "type_constructor": {
        const text = node.text;
        const primitive = resolveOxcamlPrimitive(text);
        if (primitive) {
          thisType.typeRefName = text;
          thisType.type = {
            type: primitive.tag,
            dims: 0,
            children: [],
            ...(primitive.options ? { options: primitive.options } : {}),
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
      case "hash_type": {
        // OxCaml unboxed types, e.g. #int, #float
        const text = node.text;
        const primitive = resolveOxcamlPrimitive(text);
        if (primitive) {
          thisType.typeRefName = text;
          thisType.type = {
            type: primitive.tag,
            dims: 0,
            children: [],
            ...(primitive.options ? { options: primitive.options } : {}),
            resolved: true,
          };
          return thisType;
        }
        thisType.typeRefName = text;
        return thisType;
      }
      case "parenthesized_type": {
        const inner = Parser.getNamedChildrenNoComments(node)[0];
        if (inner) {
          return this._getTypeRefFromAstNode(inner);
        }
        return thisType;
      }
      case "constructed_type": {
        // Postfix type construction: e.g. 'a list, 'a array, 'a option
        const children = Parser.getNamedChildrenNoComments(node);
        if (children.length >= 2) {
          const ctorNode = children[children.length - 1];
          const ctorName = ctorNode.text;
          const argNode = children[0];

          if (ctorName === "list") {
            const inner = this._getTypeRefFromAstNode(argNode);
            thisType.dims = inner.dims + 1;
            thisType.typeRefName = inner.typeRefName;
            thisType.type = inner.type;
            return thisType;
          }

          if (ctorName === "array") {
            const inner = this._getTypeRefFromAstNode(argNode);
            thisType.dims = inner.dims + 1;
            thisType.typeRefName = inner.typeRefName;
            thisType.type = inner.type;
            return thisType;
          }

          if (ctorName === "option") {
            const inner = this._getTypeRefFromAstNode(argNode);
            thisType.optional = true;
            thisType.dims = inner.dims;
            thisType.typeRefName = inner.typeRefName;
            thisType.type = inner.type;
            return thisType;
          }

          if (ctorName === "Hashtbl.t" || ctorName === "Map.t") {
            const keyRef = this._getTypeRefFromAstNode(children[0]);
            const valRef =
              children.length > 2
                ? this._getTypeRefFromAstNode(children[1])
                : keyRef;
            thisType.typeRefName = ctorName;
            thisType.type = {
              type: ArgTag.DICTIONARY,
              dims: 0,
              children: [keyRef, valRef],
              resolved: true,
            };
            return thisType;
          }

          // Generic custom type
          thisType.typeRefName = ctorName;
          const typeArgs = children
            .slice(0, -1)
            .map((c) => this._getTypeRefFromAstNode(c));
          thisType.type = {
            type: ArgTag.OBJECT,
            dims: 0,
            children: typeArgs,
            resolved: false,
          };
          return thisType;
        }
        return thisType;
      }
      case "tuple_type": {
        const tupleElements = Parser.getNamedChildrenNoComments(node);
        const children = tupleElements.map((elem) =>
          this._getTypeRefFromAstNode(elem)
        );
        thisType.type = {
          type: ArgTag.TUPLE,
          dims: 0,
          children,
          resolved: children.every((c) => c.type?.resolved),
        };
        return thisType;
      }
      default: {
        thisType.typeRefName = node.text;
        return thisType;
      }
    }
  } // fn: _getTypeRefFromAstNode

  protected _getMliExports(): Set<string> | undefined {
    if (!this._filename || !this._filename.endsWith(".ml")) {
      return undefined;
    }
    const mliPath = `${this._filename.slice(0, -3)}.mli`;
    if (!fs.existsSync(mliPath)) {
      return undefined;
    }

    try {
      const mliContent = fs.readFileSync(mliPath, "utf-8");
      const exports = new Set<string>();
      const valRegex = /^\s*val\s+([a-zA-Z0-9_']+)/gm;
      let match: RegExpExecArray | null;
      while ((match = valRegex.exec(mliContent)) !== null) {
        exports.add(match[1]);
      }
      return exports;
    } catch {
      return undefined;
    }
  } // fn: _getMliExports
} // class: OxcamlProgram

/**
 * Resolves standard OCaml and OxCaml primitive types to their ArgTag representations.
 */
function resolveOxcamlPrimitive(
  name: string
): { tag: ArgTag; options?: Record<string, unknown> } | undefined {
  switch (name) {
    case "int":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -2147483648, max: 2147483647 }],
        },
      };
    case "int32":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -2147483648, max: 2147483647 }],
        },
      };
    case "int64":
      return {
        tag: ArgTag.BIGINT,
        options: {
          bigintIntervals: [
            { min: -9223372036854775808n, max: 9223372036854775807n },
          ],
        },
      };
    case "nativeint":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
        },
      };
    case "float":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: false,
        },
      };
    case "bool":
      return {
        tag: ArgTag.BOOLEAN,
      };
    case "char":
      return {
        tag: ArgTag.STRING,
        options: {
          strLength: { min: 1, max: 1 },
        },
      };
    case "string":
      return {
        tag: ArgTag.STRING,
      };
    case "bytes":
      return {
        tag: ArgTag.BYTES,
      };
    case "unit":
      return {
        tag: ArgTag.OBJECT,
      };
    case "#int":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -2147483648, max: 2147483647 }],
        },
      };
    case "#float":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: false,
        },
      };
    default:
      return undefined;
  }
} // fn: resolveOxcamlPrimitive

/**
 * Returns true if the type name is an OCaml/OxCaml primitive or built-in type.
 */
function isOxcamlPrimitiveOrBuiltin(name: string): boolean {
  return (
    name === "int" ||
    name === "int32" ||
    name === "int64" ||
    name === "nativeint" ||
    name === "float" ||
    name === "bool" ||
    name === "char" ||
    name === "string" ||
    name === "bytes" ||
    name === "unit" ||
    name === "#int" ||
    name === "#float"
  );
} // fn: isOxcamlPrimitiveOrBuiltin

/**
 * Extracts leading doc comments preceding an OCaml definition node.
 */
function extractLeadingDocComment(node: Parser.SyntaxNode): string | undefined {
  let prev = node.previousNamedSibling;
  if (!prev) {
    prev = node.previousSibling;
  }
  if (prev && prev.type === "comment") {
    let text = prev.text.trim();
    if (text.startsWith("(**")) {
      text = text.slice(3);
    } else if (text.startsWith("(*")) {
      text = text.slice(2);
    }
    if (text.endsWith("*)")) {
      text = text.slice(0, -2);
    }
    return text.trim();
  }
  return undefined;
} // fn: extractLeadingDocComment
