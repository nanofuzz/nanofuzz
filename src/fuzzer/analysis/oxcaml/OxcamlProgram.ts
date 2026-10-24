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

  /**
   * Constructs an OxcamlProgram instance for the given source and file path.
   *
   * @param getSource Callback returning the source code
   * @param filename Path to the OCaml source file
   * @param options Argument options
   * @param parent Optional parent program in the module hierarchy
   */
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

  /**
   * Returns the programming language for this program ("oxcaml").
   */
  public get lang(): ProgramLanguage {
    return OxcamlProgram.lang;
  } // fn: lang

  /**
   * Returns the file extensions recognized by OxcamlProgram ([".ml", ".mli"]).
   */
  public get extensions(): readonly string[] {
    return OxcamlProgram.extensions;
  } // fn: extensions

  /**
   * Returns an OCaml/OxCaml type annotation string for the given argument.
   *
   * @param arg The ArgDef to format
   * @param options Formatting options for type annotations
   * @returns Formatted OCaml type annotation string
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
   * Returns the base type string for an argument in OCaml/OxCaml syntax.
   *
   * @param arg The ArgDef to inspect
   * @param options Formatting options for type annotations
   * @returns Base type representation in OCaml syntax
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

  /**
   * Resolves a TypeRef object through type aliases, local declarations, and imports
   * to a concrete ArgTag representation.
   *
   * @param typeRef The TypeRef object to resolve
   * @returns Resolved TypeRef
   */
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

  /**
   * Parses OCaml source code into a tree-sitter AST.
   *
   * @param src Source text to parse
   */
  protected _parse(src: string): void {
    this._ast = Parser.parse("oxcaml", src) ?? undefined;
  } // fn: _parse

  /**
   * Analyzes open module statements (`open Module`) and resolves local file imports.
   *
   * @returns A record of imports defined in the program
   */
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

  /**
   * Extracts type definitions (aliases, records, variants) defined in the source file.
   *
   * @returns A dictionary of type names to TypeRef objects
   */
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

  /**
   * Extracts top-level let-bindings and classifies them as supported or unsupported functions.
   *
   * @returns An object with `supported` and `unsupported` function maps
   */
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

    const methodQuery = Parser.query(
      "oxcaml",
      `
[
  (class_binding
    (class_name) @class.name
    body: (object_expression
      (method_definition
        (method_name) @method.name) @method.item))
  (object_expression
    (method_definition
      (method_name) @method.name) @method.item)
]
`
    );

    const methodMatches = methodQuery.matches(this._ast.rootNode);
    for (const match of methodMatches) {
      const itemNode = match.captures.find(
        (c) => c.name === "method.item"
      )?.node;
      const nameNode = match.captures.find(
        (c) => c.name === "method.name"
      )?.node;
      const classNode = match.captures.find(
        (c) => c.name === "class.name"
      )?.node;
      if (!itemNode || !nameNode) continue;

      const name = classNode
        ? `${classNode.text}.${nameNode.text}`
        : nameNode.text;
      unsupported[name] = {
        reason: "Class and object methods are not supported",
        node: JSONN.stringify(itemNode.toString()),
        function: {
          module: this._filename,
          name,
          src: itemNode.text,
          lang: OxcamlProgram.lang,
          startOffset: itemNode.startIndex,
          endOffset: itemNode.endIndex,
          isExported: true,
          isVoid: false,
          args: [],
        },
      };
    }

    return { supported, unsupported };
  } // fn: _findFunctions

  /**
   * Returns the default type export for the program (not applicable for OCaml).
   *
   * @returns undefined
   */
  protected _findDefaultTypeExport(): TypeRef | undefined {
    return undefined;
  } // fn: _findDefaultTypeExport

  /**
   * Identifies function calls within the body of a given function.
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

  /**
   * Constructs a FunctionRef from an AST value definition node.
   *
   * @param itemNode The outer value_definition node
   * @param bindingNode The let_binding node
   * @param nameNode The function identifier node
   * @param isExported True if the function is exposed in the module interface
   * @returns The constructed FunctionRef
   */
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

  /**
   * Parses a single parameter node into a TypeRef, extracting its name and type annotation.
   *
   * @param paramNode The parameter AST node
   * @returns The extracted TypeRef or undefined for unit arguments
   */
  protected _getParameterTypeRef(
    paramNode: Parser.SyntaxNode
  ): TypeRef | undefined {
    const text = paramNode.text.trim();
    // Special case: unit argument `()` indicates zero-argument function
    if (
      text === "()" ||
      paramNode.type === "unit" ||
      paramNode.children.some((c) => c.type === "unit")
    ) {
      return undefined;
    }

    const isOptional = text.startsWith("?");

    let paramName: string;
    let typeNode: Parser.SyntaxNode | undefined = undefined;

    const namedChildren = Parser.getNamedChildrenNoComments(paramNode);
    if (namedChildren.length === 0) {
      throw new Error(`Missing type annotation: ${text}`);
    }

    const firstChild = namedChildren[0];
    if (firstChild.type === "typed_pattern") {
      const patternChild = firstChild.namedChildren[0];
      if (patternChild && patternChild.type !== "value_pattern") {
        throw new Error(`Unsupported parameter pattern: ${paramNode.text}`);
      }
      paramName = patternChild ? patternChild.text : "";
      typeNode = firstChild.namedChildren[1];
    } else if (firstChild.type === "value_pattern") {
      paramName = firstChild.text;
      if (namedChildren.length > 1) {
        typeNode = namedChildren[1];
      }
    } else {
      throw new Error(`Unsupported parameter pattern: ${paramNode.text}`);
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

  /**
   * Maps a tree-sitter OCaml type expression node into a TypeRef structure.
   *
   * @param node The AST type node
   * @returns The constructed TypeRef
   */
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
        let text = node.text;
        if (
          text === "fuzz_test_result" ||
          text === "FuzzTestResult" ||
          text.endsWith(".fuzz_test_result") ||
          text.endsWith(".FuzzTestResult")
        ) {
          text = "FuzzTestResult";
        }
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
        thisType.type = {
          type: ArgTag.UNRESOLVED,
          dims: 0,
          children: [],
          resolved: false,
        };
        return thisType;
      }
      case "function_type": {
        throw new Error(
          `Function-typed parameters are not supported: ${node.text}`
        );
      }
      case "parenthesized_type": {
        const inner = Parser.getNamedChildrenNoComments(node)[0];
        if (inner) {
          return this._getTypeRefFromAstNode(inner);
        }
        throw new Error("Empty parenthesized type expression");
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
        throw new Error(`Invalid constructed type: ${node.text}`);
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
        throw new Error(
          `Unsupported type annotation '${node.text}' (AST node: ${node.type})`
        );
      }
    }
  } // fn: _getTypeRefFromAstNode

  /**
   * Reads the companion `.mli` interface file (if one exists) to extract public `val` signatures.
   *
   * @returns Set of exported identifier names, or undefined if no .mli exists
   */
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

  /**
   * Recursively discovers all local module files imported or referenced by an OCaml source file.
   *
   * @param sourceFile Path to the root OCaml file
   * @param visited Set of already visited file paths to prevent cycles
   * @returns Array of unique resolved module file paths
   */
  public static findLocalModules(
    sourceFile: string,
    visited: Set<string> = new Set()
  ): string[] {
    const norm = fs.existsSync(sourceFile)
      ? fs.realpathSync(path.resolve(sourceFile))
      : path.resolve(sourceFile);
    if (visited.has(norm)) return [];
    visited.add(norm);

    if (!fs.existsSync(norm)) return [];
    const dir = path.dirname(norm);
    const src = fs.readFileSync(norm, "utf8");
    const tree = Parser.parse("oxcaml", src);
    if (!tree) return [];

    const query = Parser.query(
      "oxcaml",
      `
[
  (open_module (module_path) @mod.name)
  (value_path (module_path) @mod.name)
]
`
    );
    const matches = query.matches(tree.rootNode);
    const results: string[] = [];

    for (const m of matches) {
      const node = m.captures.find((c) => c.name === "mod.name")?.node;
      if (!node) continue;
      const rootMod = node.text.split(".")[0];
      const candidate = path.join(dir, `${rootMod.toLowerCase()}.ml`);
      if (fs.existsSync(candidate)) {
        const realCandidate = fs.realpathSync(candidate);
        if (!visited.has(realCandidate)) {
          results.push(realCandidate);
          results.push(
            ...OxcamlProgram.findLocalModules(realCandidate, visited)
          );
        }
      }
    }

    return results;
  } // fn: findLocalModules

  /**
   * Identifies all direct external library dependencies referenced by an OCaml source file.
   *
   * @param sourceFile Path to the target source file
   * @returns Array of external library names
   */
  public static findDirectLibraries(sourceFile: string): string[] {
    return findDirectLibraries(sourceFile);
  } // fn: findDirectLibraries
} // class: OxcamlProgram

/**
 * Resolves standard OCaml and OxCaml primitive types to their ArgTag representations.
 *
 * @param name Type name string (e.g. "int", "float", "#int")
 * @returns Object with ArgTag and generator options, or undefined if not a primitive
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
 *
 * @param name Type name to test
 * @returns True if the type name is a primitive or built-in
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
 *
 * @param node The AST definition node
 * @returns Docstring text if present, or undefined
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

const BUILTIN_OCAML_MODULES = new Set([
  "Stdlib",
  "List",
  "Array",
  "String",
  "Char",
  "Bytes",
  "Int",
  "Int32",
  "Int64",
  "Nativeint",
  "Float",
  "Bool",
  "Unit",
  "Printf",
  "Format",
  "Scanf",
  "Sys",
  "Printexc",
  "Pervasives",
  "Gc",
  "Random",
  "Hashtbl",
  "Map",
  "Set",
  "Queue",
  "Stack",
  "Buffer",
  "Option",
  "Result",
  "Seq",
  "Uchar",
  "Digest",
  "Nanofuzz_runtime",
  "Yojson",
]);

/**
 * Discovers direct external library references in an OCaml source file.
 *
 * @param sourceFile Path to target OCaml file
 * @returns Array of external library name candidates
 */
function findDirectLibraries(sourceFile: string): string[] {
  const norm = fs.existsSync(sourceFile)
    ? fs.realpathSync(path.resolve(sourceFile))
    : path.resolve(sourceFile);
  if (!fs.existsSync(norm)) {
    return [];
  }

  const libs = new Set<string>();
  const src = fs.readFileSync(norm, "utf8");
  const tree = Parser.parse("oxcaml", src);
  if (!tree) return [];

  const query = Parser.query(
    "oxcaml",
    `
[
  (open_module (module_path) @mod.name)
  (value_path (module_path) @mod.name)
]
`
  );
  const matches = query.matches(tree.rootNode);

  const localFileStems = new Set(
    OxcamlProgram.findLocalModules(norm).map((f) =>
      path.basename(f, path.extname(f)).toLowerCase()
    )
  );
  localFileStems.add(path.basename(norm, path.extname(norm)).toLowerCase());

  for (const m of matches) {
    const node = m.captures.find((c) => c.name === "mod.name")?.node;
    if (!node) continue;
    const rootMod = node.text.split(".")[0].trim();
    if (
      rootMod &&
      !BUILTIN_OCAML_MODULES.has(rootMod) &&
      !localFileStems.has(rootMod.toLowerCase())
    ) {
      libs.add(rootMod.toLowerCase());
    }
  }

  return Array.from(libs);
} // fn: findDirectLibraries
