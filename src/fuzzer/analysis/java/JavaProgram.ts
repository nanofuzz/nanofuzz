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

export class JavaProgram extends AbstractProgram {
  public static readonly lang: ProgramLanguage = "java";
  public static readonly extensions: readonly string[] = Object.freeze([
    ".java",
  ]);
  protected _ast: Parser.Tree | undefined;
  protected _definedTypeKinds: Map<string, "class" | "interface" | "enum"> =
    new Map();

  /**
   * Constructs a new JavaProgram instance.
   *
   * @param getSource Function that returns program source code
   * @param filename Path of the source file
   * @param options ArgOptions overrides
   * @param parent Parent AbstractProgram if part of a program tree
   */
  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
    if (parent && JavaProgram.lang !== parent.lang) {
      throw new Error(
        `A "${JavaProgram.lang}" program cannot be a child of a "${parent.lang}" program.`
      );
    }
  } // fn: constructor

  /**
   * Returns the programming language analyzed by this class ("java").
   */
  public get lang(): ProgramLanguage {
    return JavaProgram.lang;
  } // fn: lang

  /**
   * Returns the file extensions recognized by this class ([".java"]).
   */
  public get extensions(): readonly string[] {
    return JavaProgram.extensions;
  } // fn: extensions

  /**
   * Returns a Java type annotation string for the given argument.
   *
   * @param arg The ArgDef to format
   * @param options Type annotation options
   * @returns Formatted Java type annotation
   */
  public static getTypeAnnotation(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    const typeRef = arg.getTypeRef();
    if (typeRef && options.useTypeRefs) {
      const outerDims = arg.getTypeRefDims() ?? 0;
      let type = `${typeRef}${"[]".repeat(outerDims)}`;
      if (arg.isOptional()) {
        type = `Optional<${type}>`;
      }
      return type;
    }

    const baseType = JavaProgram.getBaseType(arg, options);
    const dims = arg.getDim();
    let type = `${baseType}${"[]".repeat(dims)}`;

    if (arg.isOptional()) {
      if (dims > 0) {
        type = `Optional<${type}>`;
      } else {
        type = `Optional<${JavaProgram.toBoxedType(baseType)}>`;
      }
    }

    return type;
  } // fn: getTypeAnnotation

  /**
   * Returns the base type string for an argument.
   *
   * @param arg The ArgDef to format
   * @param options Type annotation options
   * @returns Java base type string
   */
  public static getBaseType(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    const typeRef = arg.getTypeRef();
    if (typeRef && JavaProgram.isJavaPrimitiveOrBuiltin(typeRef)) {
      return typeRef;
    }

    const argType = arg.getType();
    switch (argType) {
      case ArgTag.BOOLEAN:
        return "boolean";
      case ArgTag.NUMBER: {
        const opts = arg.getOptions();
        if (!opts.numInteger) {
          return "double";
        }
        const intervals = arg.getIntervals();
        if (intervals && intervals.length > 0) {
          const min = intervals[0].min;
          const max = intervals[0].max;
          if (typeof min === "number" && typeof max === "number") {
            if (min === -128 && max === 127) return "byte";
            if (min === -32768 && max === 32767) return "short";
            if (min === 0 && max === 255) return "byte";
          }
        }
        return "int";
      }
      case ArgTag.BIGINT: {
        return "long";
      }
      case ArgTag.STRING:
        return "String";
      case ArgTag.BYTES:
        return "byte[]";
      case ArgTag.DICTIONARY: {
        const children = arg.getChildren();
        const keyType =
          children.length > 0
            ? JavaProgram.getTypeAnnotation(children[0], options)
            : "String";
        const valType =
          children.length > 1
            ? JavaProgram.getTypeAnnotation(children[1], options)
            : "Object";
        return `Map<${JavaProgram.toBoxedType(keyType)}, ${JavaProgram.toBoxedType(valType)}>`;
      }
      case ArgTag.SET: {
        const children = arg.getChildren();
        const elemType =
          children.length > 0
            ? JavaProgram.getTypeAnnotation(children[0], options)
            : "String";
        return `Set<${JavaProgram.toBoxedType(elemType)}>`;
      }
      case ArgTag.OBJECT: {
        return arg.getTypeRef() ?? "Object";
      }
      case ArgTag.LITERAL: {
        const val = arg.getConstantValue();
        if (typeof val === "string") return "String";
        if (typeof val === "boolean") return "boolean";
        if (typeof val === "number")
          return Number.isInteger(val) ? "int" : "double";
        return arg.getTypeRef() ?? "Object";
      }
      case ArgTag.TUPLE: {
        return "Object[]";
      }
      case ArgTag.UNION: {
        return "Object";
      }
      case ArgTag.UNRESOLVED: {
        throw new Error("Internal error: unresolved types cannot be annotated");
      }
    }
  } // fn: getBaseType

  /**
   * Converts a primitive Java type name to its boxed object wrapper type name.
   *
   * @param typeStr The Java type string
   * @returns Boxed object type string
   */
  public static toBoxedType(typeStr: string): string {
    switch (typeStr) {
      case "boolean":
        return "Boolean";
      case "byte":
        return "Byte";
      case "short":
        return "Short";
      case "int":
        return "Integer";
      case "long":
        return "Long";
      case "float":
        return "Float";
      case "double":
        return "Double";
      case "char":
        return "Character";
      case "void":
        return "Void";
      default:
        return typeStr;
    }
  } // fn: toBoxedType

  /**
   * Converts a boxed Java wrapper type name to its primitive type name.
   *
   * @param typeStr The Java type string
   * @returns Primitive type string if boxed, or original type string
   */
  public static toPrimitiveType(typeStr: string): string {
    switch (typeStr) {
      case "Boolean":
        return "boolean";
      case "Byte":
        return "byte";
      case "Short":
        return "short";
      case "Integer":
        return "int";
      case "Long":
        return "long";
      case "Float":
        return "float";
      case "Double":
        return "double";
      case "Character":
        return "char";
      case "Void":
        return "void";
      default:
        return typeStr;
    }
  } // fn: toPrimitiveType

  /**
   * Checks whether a type name corresponds to a Java primitive or standard built-in type.
   *
   * @param name Type name to check
   * @returns True if the type name is primitive or built-in, false otherwise
   */
  public static isJavaPrimitiveOrBuiltin(name: string): boolean {
    return isJavaPrimitiveOrBuiltinName(name);
  } // fn: isJavaPrimitiveOrBuiltin

  /**
   * Discovers sibling Java source files in the same directory as the target source file.
   *
   * @param sourceFile Absolute or relative path to target Java source file
   * @returns Array of absolute paths to local Java source files
   */
  public static findLocalSourceFiles(sourceFile: string): string[] {
    const norm = path.resolve(sourceFile);
    const dir = path.dirname(norm);
    if (!fs.existsSync(dir)) return [norm];

    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".java")) {
          results.push(path.resolve(dir, entry.name));
        }
      }
    } catch {
      results.push(norm);
    }
    return results;
  } // fn: findLocalSourceFiles

  /**
   * Returns the package name declared in this Java program, or empty string if default package.
   */
  public getPackageName(): string {
    if (!this._ast) return "";
    const pkgNode = this._ast.rootNode.descendantsOfType(
      "package_declaration"
    )[0];
    if (!pkgNode) return "";
    const nameNode = pkgNode.children.find(
      (c) => c.type === "scoped_identifier" || c.type === "identifier"
    );
    return nameNode?.text ?? "";
  } // fn: getPackageName

  /**
   * Returns the fully qualified class name containing the specified function.
   *
   * @param fnName Optional name of method to locate
   * @returns Fully qualified class name
   */
  public getFqClassName(fnName?: string): string {
    const pkg = this.getPackageName();
    let className = "";
    if (this._ast && fnName) {
      const q = Parser.query(
        "java",
        `(method_declaration name: (identifier) @m.name) @m.item`
      );
      const matches = q.matches(this._ast.rootNode);
      for (const m of matches) {
        const nameCap = m.captures.find((c) => c.name === "m.name");
        if (nameCap && nameCap.node.text === fnName) {
          const itemCap = m.captures.find((c) => c.name === "m.item");
          let p = itemCap?.node.parent;
          while (
            p &&
            p.type !== "class_declaration" &&
            p.type !== "record_declaration" &&
            p.type !== "interface_declaration"
          ) {
            p = p.parent;
          }
          if (p) {
            className = p.childForFieldName("name")?.text ?? "";
            break;
          }
        }
      }
    }
    if (!className) {
      const base = path.basename(this._filename, ".java");
      className = base;
    }
    return pkg ? `${pkg}.${className}` : className;
  } // fn: getFqClassName

  /**
   * Resolves a TypeRef against local types, Java primitives, and imported programs.
   *
   * @param typeRef The TypeRef to resolve
   * @returns Resolved TypeRef
   */
  public resolveTypeRef(typeRef: TypeRef): TypeRef {
    const typeName = typeRef.typeRefName;
    if (typeName) {
      if (isJavaFunctionType(typeName)) {
        throw new Error(
          `Unsupported parameter type '${typeName}': function-typed parameters are not supported`
        );
      }
      if (this._definedTypeKinds.has(typeName)) {
        const kind = this._definedTypeKinds.get(typeName);
        const pluralKind = kind === "class" ? "classes" : `${kind}s`;
        throw new Error(
          `Unsupported parameter type '${typeName}': ${pluralKind} are not supported`
        );
      }
    }

    if (typeRef.type && typeRef.type.type !== ArgTag.UNRESOLVED) {
      if (typeRef.type.resolved) {
        return typeRef;
      } else {
        typeRef.type.children.forEach((child) => this.resolveTypeRef(child));
        typeRef.type.resolved = true;
        return typeRef;
      }
    }

    const typeNameResolved = typeRef.typeRefName;
    if (typeNameResolved === undefined || typeNameResolved === "") {
      throw new Error(
        `Internal error: typeRef is undefined in TypeRef (${JSONN.stringify(
          typeRef
        )})`
      );
    }

    if (typeNameResolved === "FuzzTestResult") {
      typeRef.type = {
        type: ArgTag.OBJECT,
        dims: 0,
        children: [],
        resolved: true,
      };
      return typeRef;
    }

    const primitiveResolved = resolveJavaPrimitive(typeNameResolved);
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

    if (typeNameResolved in this._types) {
      const resolved = this.resolveTypeRef(this._types[typeNameResolved]);
      typeRef.type = structuredClone(resolved.type);
      if (typeRef.type) {
        typeRef.type.dims += resolved.dims;
      }
      typeRef.optional = typeRef.optional || resolved.optional;
      return typeRef;
    }

    if (typeNameResolved in this._imports.identifiers) {
      const imp = this._imports.identifiers[typeNameResolved];
      if (
        imp.programPath &&
        imp.programPath !== "?" &&
        fs.existsSync(imp.programPath)
      ) {
        const importedProgram = ProgramFactory.fromFile(
          imp.programPath,
          "java",
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
      `Unsupported parameter type '${typeNameResolved}': type is not supported`
    );
  } // fn: resolveTypeRef

  /**
   * Parses Java program source text into a Tree-sitter AST.
   *
   * @param src Java source code
   */
  protected _parse(src: string): void {
    if (!this._definedTypeKinds) {
      this._definedTypeKinds = new Map();
    } else {
      this._definedTypeKinds.clear();
    }
    this._ast = Parser.parse("java", src) ?? undefined;
  } // fn: _parse

  /**
   * Extracts imported identifiers from all Java import declarations in the program.
   *
   * @returns ProgramImports mapping identifiers to import details
   */
  protected _findImports(): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };
    if (!this._ast) {
      return imports;
    }

    const importQuery = Parser.query(
      "java",
      `
[
  (import_declaration) @import.decl
]
`
    );

    const matches = importQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const node = match.captures.find((c) => c.name === "import.decl")?.node;
      if (!node) continue;
      extractImportDeclaration(node, imports);
    }

    return imports;
  } // fn: _findImports

  /**
   * Discovers and extracts class, record, interface, and enum types defined in the program.
   *
   * @returns Record mapping type names to TypeRef definitions
   */
  protected _findTypes(): Record<IdentifierName, TypeRef> {
    const types: Record<IdentifierName, TypeRef> = {};
    if (!this._ast) {
      return types;
    }

    const typeQuery = Parser.query(
      "java",
      `
[
  (class_declaration
    name: (identifier) @class.name) @class.item
  (record_declaration
    name: (identifier) @record.name) @record.item
  (interface_declaration
    name: (identifier) @interface.name) @interface.item
  (enum_declaration
    name: (identifier) @enum.name) @enum.item
]
`
    );

    const matches = typeQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const classItem = match.captures.find(
        (c) => c.name === "class.item"
      )?.node;
      const recordItem = match.captures.find(
        (c) => c.name === "record.item"
      )?.node;
      const interfaceItem = match.captures.find(
        (c) => c.name === "interface.item"
      )?.node;
      const enumItem = match.captures.find((c) => c.name === "enum.item")?.node;

      const itemNode = classItem ?? recordItem ?? interfaceItem ?? enumItem;
      const nameNode =
        match.captures.find((c) => c.name === "class.name")?.node ??
        match.captures.find((c) => c.name === "record.name")?.node ??
        match.captures.find((c) => c.name === "interface.name")?.node ??
        match.captures.find((c) => c.name === "enum.name")?.node;

      if (!itemNode || !nameNode) continue;

      const isExported = isNodePublic(itemNode);
      const name = nameNode.text;

      let children: TypeRef[] = [];
      if (recordItem) {
        const paramsNode = recordItem.childForFieldName("parameters");
        if (paramsNode) {
          const paramNodes = Parser.getNamedChildrenNoComments(paramsNode);
          children = paramNodes
            .filter((p) => p.type === "formal_parameter")
            .map((p) => {
              const typeNode = p.childForFieldName("type");
              const pNameNode = p.childForFieldName("name");
              const tr = typeNode
                ? this._getTypeRefFromAstNode(typeNode)
                : {
                    module: this._filename,
                    dims: 0,
                    optional: false,
                    isExported: true,
                    type: {
                      type: ArgTag.OBJECT,
                      dims: 0,
                      children: [],
                      resolved: true,
                    },
                  };
              if (pNameNode) tr.name = pNameNode.text;
              return tr;
            });
        }
      }

      if (recordItem) {
        types[name] = {
          module: this._filename,
          name,
          typeRefName: name,
          optional: false,
          dims: 0,
          isExported,
          type: {
            type: ArgTag.OBJECT,
            dims: 0,
            children,
            resolved: children.every((c) => c.type?.resolved),
          },
        };
      } else {
        const kind: "enum" | "interface" | "class" = enumItem
          ? "enum"
          : interfaceItem
            ? "interface"
            : "class";
        this._definedTypeKinds.set(name, kind);
      }
    }

    return types;
  } // fn: _findTypes

  /**
   * Discovers all method declarations in the program and partitions into supported and unsupported.
   *
   * @returns Object containing supported and unsupported functions
   */
  protected _findFunctions(): typeof this._functions {
    if (!this._ast) {
      throw new Error("AST not loaded");
    }

    const supported: AbstractProgram["_functions"]["supported"] = {};
    const unsupported: AbstractProgram["_functions"]["unsupported"] = {};

    const fnQuery = Parser.query(
      "java",
      `
(method_declaration
  type: (_) @method.return
  name: (identifier) @method.name
  parameters: (formal_parameters) @method.params) @method.item
`
    );

    const matches = fnQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const itemNode = match.captures.find(
        (c) => c.name === "method.item"
      )?.node;
      const nameNode = match.captures.find(
        (c) => c.name === "method.name"
      )?.node;
      const paramsNode = match.captures.find(
        (c) => c.name === "method.params"
      )?.node;
      const returnTypeNode = match.captures.find(
        (c) => c.name === "method.return"
      )?.node;

      if (!itemNode || !nameNode || !paramsNode) {
        continue;
      }

      const rawName = nameNode.text;
      if (!isNodeStatic(itemNode)) {
        try {
          const fnRef = this._getFunctionFromNode(
            itemNode,
            nameNode,
            paramsNode,
            returnTypeNode
          );
          unsupported[rawName] = {
            reason: "Class methods are not supported",
            node: JSONN.stringify(itemNode.toString()),
            function: fnRef,
          };
        } catch {
          unsupported[rawName] = {
            reason: "Class methods are not supported",
            node: JSONN.stringify(itemNode.toString()),
            function: {
              module: this._filename,
              name: rawName,
              src: itemNode.text,
              lang: JavaProgram.lang,
              startOffset: itemNode.startIndex,
              endOffset: itemNode.endIndex,
              isExported: isNodePublic(itemNode),
              isVoid: false,
              args: [],
            },
          };
        }
        continue;
      }

      try {
        const fnRef = this._getFunctionFromNode(
          itemNode,
          nameNode,
          paramsNode,
          returnTypeNode
        );
        if (fnRef) {
          let registeredName = fnRef.name;
          if (registeredName in supported) {
            const paramSig = (fnRef.args ?? [])
              .map((a) => a.typeRefName ?? a.name ?? "arg")
              .join("_");
            registeredName = `${fnRef.name}_${paramSig}`;
            let counter = 2;
            while (registeredName in supported) {
              registeredName = `${fnRef.name}_${paramSig}_${counter++}`;
            }
            fnRef.name = registeredName;
          }
          supported[registeredName] = fnRef;
        }
      } catch (e: unknown) {
        const msg = getErrorMessageOrJson(e);
        unsupported[rawName] = {
          reason: msg,
          node: JSONN.stringify(itemNode.toString()),
          function: {
            module: this._filename,
            name: rawName,
            src: itemNode.text,
            lang: JavaProgram.lang,
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

  /**
   * Returns the default type export for the program, if any.
   *
   * @returns Default TypeRef or undefined
   */
  protected _findDefaultTypeExport(): TypeRef | undefined {
    return undefined;
  } // fn: _findDefaultTypeExport

  /**
   * Identifies all method names called within the body of a function.
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

    const tree = Parser.parse("java", fnRef.src);
    if (!tree) {
      throw new Error(
        `Tree-sitter failed to parse Java function "${fnName}" in module "${this._filename}"`
      );
    }

    const query = Parser.query(
      "java",
      `
(method_invocation name: (identifier) @callee.name)
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
   * Constructs a FunctionRef descriptor from a Tree-sitter method declaration AST node.
   *
   * @param itemNode Method declaration AST node
   * @param nameNode Method name identifier node
   * @param paramsNode Formal parameters node
   * @param returnTypeNode Optional return type syntax node
   * @returns FunctionRef representation of the method
   */
  protected _getFunctionFromNode(
    itemNode: Parser.SyntaxNode,
    nameNode: Parser.SyntaxNode,
    paramsNode: Parser.SyntaxNode,
    returnTypeNode?: Parser.SyntaxNode
  ): FunctionRef {
    const isExported = isNodePublic(itemNode);

    // Check return type
    let isVoid = true;
    let returnType: TypeRef | undefined = undefined;

    if (returnTypeNode) {
      if (
        returnTypeNode.type === "void_type" ||
        returnTypeNode.text === "void"
      ) {
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
      if (child.type === "formal_parameter") {
        const pTypeNode = child.childForFieldName("type");
        const pNameNode = child.childForFieldName("name");
        if (!pTypeNode || !pNameNode) continue;

        const paramTypeRef = this._getTypeRefFromAstNode(pTypeNode);
        paramTypeRef.name = pNameNode.text;

        if (hasNullableAnnotation(child)) {
          paramTypeRef.optional = true;
        }
        args.push(paramTypeRef);
      } else if (child.type === "spread_parameter") {
        const pTypeNode = child.children.find(
          (c) => c.type.endsWith("_type") || c.type === "type_identifier"
        );
        const declarator = child.children.find(
          (c) => c.type === "variable_declarator" || c.type === "identifier"
        );
        const pName = declarator?.text ?? "args";
        const paramTypeRef = pTypeNode
          ? this._getTypeRefFromAstNode(pTypeNode)
          : {
              module: this._filename,
              dims: 0,
              optional: false,
              isExported: true,
              type: {
                type: ArgTag.OBJECT,
                dims: 0,
                children: [],
                resolved: true,
              },
            };
        paramTypeRef.name = pName;
        paramTypeRef.dims += 1;
        args.push(paramTypeRef);
      }
    }

    const cmt = extractLeadingDocComment(itemNode);

    const fnRef: FunctionRef = {
      module: this._filename,
      name: nameNode.text,
      src: itemNode.text,
      lang: JavaProgram.lang,
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
   * Converts a Tree-sitter type syntax node into a TypeRef descriptor.
   *
   * @param node Tree-sitter syntax node representing a type
   * @returns Corresponding TypeRef descriptor
   */
  protected _getTypeRefFromAstNode(node: Parser.SyntaxNode): TypeRef {
    const thisType: TypeRef = {
      module: this._filename,
      dims: 0,
      optional: false,
      isExported: true,
    };

    switch (node.type) {
      case "integral_type":
      case "floating_point_type":
      case "boolean_type": {
        const resolved = resolveJavaPrimitive(node.text);
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
      case "void_type": {
        thisType.typeRefName = "void";
        thisType.type = {
          type: ArgTag.OBJECT,
          dims: 0,
          children: [],
          resolved: true,
        };
        return thisType;
      }
      case "type_identifier": {
        const text = node.text;
        if (text === "String" || text === "CharSequence") {
          thisType.typeRefName = text;
          thisType.type = {
            type: ArgTag.STRING,
            dims: 0,
            children: [],
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
        const primitiveResolved = resolveJavaPrimitive(text);
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
      case "scoped_type_identifier": {
        const idChildren = node.children.filter(
          (c) => c.type === "type_identifier"
        );
        if (idChildren.length > 0) {
          return this._getTypeRefFromAstNode(idChildren[idChildren.length - 1]);
        }
        const text = node.text;
        const simpleName = text.includes(".") ? text.split(".").pop()! : text;
        thisType.typeRefName = simpleName;
        thisType.type = {
          type: ArgTag.UNRESOLVED,
          dims: 0,
          children: [],
          resolved: false,
        };
        return thisType;
      }
      case "array_type": {
        const elemNode = node.childForFieldName("element");
        const dimsNode = node.childForFieldName("dimensions");
        const dimCount = dimsNode
          ? (dimsNode.text.match(/\[\]/g) || [1]).length
          : 1;
        if (elemNode && elemNode.text === "byte" && dimCount === 1) {
          thisType.typeRefName = "byte[]";
          thisType.type = {
            type: ArgTag.BYTES,
            dims: 0,
            children: [],
            resolved: true,
          };
          return thisType;
        }
        if (elemNode) {
          const inner = this._getTypeRefFromAstNode(elemNode);
          thisType.typeRefName = inner.typeRefName;
          thisType.dims = inner.dims + dimCount;
          thisType.type = inner.type;
          return thisType;
        }
        thisType.dims = dimCount;
        return thisType;
      }
      case "generic_type": {
        const baseTypeNode = node.children.find(
          (c) =>
            c.type === "type_identifier" || c.type === "scoped_type_identifier"
        );
        const rawBase = baseTypeNode?.text ?? "";
        const baseName = rawBase.includes(".")
          ? rawBase.split(".").pop()!
          : rawBase;

        const typeArgsNode = node.children.find(
          (c) => c.type === "type_arguments"
        );
        const argNodes = typeArgsNode
          ? Parser.getNamedChildrenNoComments(typeArgsNode)
          : [];

        if (baseName === "Optional") {
          thisType.optional = true;
          if (argNodes.length > 0) {
            const inner = this._getTypeRefFromAstNode(argNodes[0]);
            thisType.typeRefName = inner.typeRefName;
            thisType.dims = inner.dims;
            thisType.type = inner.type;
            return thisType;
          }
          thisType.typeRefName = "Optional";
          thisType.type = {
            type: ArgTag.UNRESOLVED,
            dims: 0,
            children: [],
            resolved: false,
          };
          return thisType;
        }

        if (
          baseName === "List" ||
          baseName === "ArrayList" ||
          baseName === "LinkedList" ||
          baseName === "Collection" ||
          baseName === "Iterable"
        ) {
          if (argNodes.length > 0) {
            const inner = this._getTypeRefFromAstNode(argNodes[0]);
            thisType.typeRefName = inner.typeRefName;
            thisType.dims = inner.dims + 1;
            thisType.type = inner.type;
            return thisType;
          }
          thisType.typeRefName = baseName;
          thisType.dims = 1;
          thisType.type = {
            type: ArgTag.UNRESOLVED,
            dims: 0,
            children: [],
            resolved: false,
          };
          return thisType;
        }

        if (
          baseName === "Set" ||
          baseName === "HashSet" ||
          baseName === "LinkedHashSet" ||
          baseName === "TreeSet"
        ) {
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

        if (
          baseName === "Map" ||
          baseName === "HashMap" ||
          baseName === "LinkedHashMap" ||
          baseName === "TreeMap"
        ) {
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

        if (isJavaFunctionType(baseName)) {
          thisType.typeRefName = baseName;
          thisType.type = {
            type: ArgTag.UNRESOLVED,
            dims: 0,
            children: [],
            resolved: false,
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
      case "annotated_type": {
        const isNullable = hasNullableAnnotation(node);
        const unannotatedChild = node.children.find(
          (c) =>
            c.type !== "modifiers" &&
            !c.type.startsWith("marker_annotation") &&
            !c.type.startsWith("annotation")
        );
        if (unannotatedChild) {
          const inner = this._getTypeRefFromAstNode(unannotatedChild);
          if (isNullable) {
            inner.optional = true;
          }
          return inner;
        }
        return thisType;
      }
      case "wildcard": {
        thisType.typeRefName = "?";
        thisType.type = {
          type: ArgTag.UNRESOLVED,
          dims: 0,
          children: [],
          resolved: false,
        };
        return thisType;
      }
      default: {
        const text = node.text;
        const primitive = resolveJavaPrimitive(text);
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
    }
  } // fn: _getTypeRefFromAstNode
} // class: JavaProgram

// ============================================================================
// Helpers
// ============================================================================

/**
 * Checks whether an AST syntax node has a public visibility modifier (`public`),
 * or is implicitly public inside an interface.
 *
 * @param node The AST syntax node to check
 * @returns True if public visibility, false otherwise
 */
function isNodePublic(node: Parser.SyntaxNode): boolean {
  if (
    node.parent?.type === "interface_body" ||
    node.parent?.type === "interface_declaration"
  ) {
    const modifiers = node.children.find((c) => c.type === "modifiers");
    if (modifiers) {
      return !modifiers.children.some((c) => c.text === "private");
    }
    return true;
  }

  const modifiers = node.children.find((c) => c.type === "modifiers");
  if (!modifiers) return false;
  return modifiers.children.some(
    (c) => c.type === "public" || c.text === "public"
  );
} // fn: isNodePublic

/**
 * Checks whether an AST syntax node has a static modifier (`static`).
 *
 * @param node The AST syntax node to check
 * @returns True if static modifier present, false otherwise
 */
function isNodeStatic(node: Parser.SyntaxNode): boolean {
  const modifiers = node.children.find((c) => c.type === "modifiers");
  if (!modifiers) return false;
  return modifiers.children.some(
    (c) => c.type === "static" || c.text === "static"
  );
} // fn: isNodeStatic

/**
 * Checks whether an identifier corresponds to a Java functional interface or function-typed parameter.
 *
 * @param name The type name to check
 * @returns True if the identifier represents a functional/function type, false otherwise
 */
function isJavaFunctionType(name: string): boolean {
  if (name.startsWith("java.util.function.")) return true;
  const simple = name.includes(".") ? name.split(".").pop()! : name;
  const functionTypes = new Set([
    "DoubleSupplier",
    "IntSupplier",
    "LongSupplier",
    "BooleanSupplier",
    "Supplier",
    "Function",
    "BiFunction",
    "DoubleFunction",
    "IntFunction",
    "LongFunction",
    "ToDoubleFunction",
    "ToIntFunction",
    "ToLongFunction",
    "DoubleToIntFunction",
    "DoubleToLongFunction",
    "IntToDoubleFunction",
    "IntToLongFunction",
    "LongToDoubleFunction",
    "LongToIntFunction",
    "ToDoubleBiFunction",
    "ToIntBiFunction",
    "ToLongBiFunction",
    "Consumer",
    "BiConsumer",
    "DoubleConsumer",
    "IntConsumer",
    "LongConsumer",
    "ObjDoubleConsumer",
    "ObjIntConsumer",
    "ObjLongConsumer",
    "Predicate",
    "BiPredicate",
    "DoublePredicate",
    "IntPredicate",
    "LongPredicate",
    "UnaryOperator",
    "BinaryOperator",
    "DoubleUnaryOperator",
    "DoubleBinaryOperator",
    "IntUnaryOperator",
    "IntBinaryOperator",
    "LongUnaryOperator",
    "LongBinaryOperator",
    "Runnable",
    "Callable",
  ]);
  return functionTypes.has(simple);
} // fn: isJavaFunctionType

/**
 * Checks whether an AST syntax node contains `@Nullable` or `@CheckForNull` annotations.
 *
 * @param node The AST syntax node to check
 * @returns True if nullable annotation present, false otherwise
 */
function hasNullableAnnotation(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "marker_annotation" || child.type === "annotation") {
      const text = child.text;
      if (text.includes("Nullable") || text.includes("CheckForNull")) {
        return true;
      }
    }
    if (child.type === "modifiers") {
      if (hasNullableAnnotation(child)) {
        return true;
      }
    }
  }
  return false;
} // fn: hasNullableAnnotation

/**
 * Extracts Javadoc block comments (`/** ... * /`) or line comments (`// ...`)
 * immediately preceding an AST node.
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
    if (text.startsWith("/**")) {
      const stripped = text
        .replace(/^\/\*\*+/, "")
        .replace(/\*+\/$/, "")
        .split("\n")
        .map((line) => line.trim().replace(/^\*\s?/, ""))
        .join("\n")
        .trim();
      comments.unshift(stripped);
    } else if (text.startsWith("//")) {
      comments.unshift(text.replace(/^\/\/\s?/, ""));
    }
    prev = prev.previousNamedSibling;
  }

  return comments.length > 0 ? comments.join("\n") : undefined;
} // fn: extractLeadingDocComment

/**
 * Extracts imported identifiers from a Java `import` declaration node and populates `imports`.
 *
 * @param node The `import_declaration` AST syntax node
 * @param imports ProgramImports collection to populate with imported identifiers
 */
function extractImportDeclaration(
  node: Parser.SyntaxNode,
  imports: ProgramImports
): void {
  const isWildcard = node.children.some(
    (c) => c.type === "asterisk" || c.text === "*"
  );
  const nameNode = node.children.find(
    (c) => c.type === "scoped_identifier" || c.type === "identifier"
  );
  if (!nameNode) return;

  const fullName = nameNode.text;
  if (isWildcard) {
    imports.identifiers["*"] = {
      local: "*",
      imported: "*",
      programPath: fullName,
      resolved: false,
      default: false,
    };
  } else {
    const local = fullName.includes(".")
      ? fullName.split(".").pop()!
      : fullName;
    imports.identifiers[local] = {
      local,
      imported: local,
      programPath: fullName,
      resolved: false,
      default: false,
    };
  }
} // fn: extractImportDeclaration

/**
 * Resolves a Java primitive type name or boxed scalar to its corresponding ArgTag and options.
 *
 * @param name Primitive or boxed scalar name (e.g. "int", "Integer", "String")
 * @returns Object with ArgTag and optional intervals, or undefined if not primitive
 */
function resolveJavaPrimitive(name: string):
  | {
      tag: ArgTag;
      options?: ArgOptionOverride;
    }
  | undefined {
  switch (name) {
    case "boolean":
    case "Boolean":
      return { tag: ArgTag.BOOLEAN };
    case "byte":
    case "Byte":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -128, max: 127 }],
        },
      };
    case "short":
    case "Short":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -32768, max: 32767 }],
        },
      };
    case "int":
    case "Integer":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -2147483648, max: 2147483647 }],
        },
      };
    case "long":
    case "Long":
      return {
        tag: ArgTag.BIGINT,
        options: {
          bigintIntervals: [
            { min: -9223372036854775808n, max: 9223372036854775807n },
          ],
        },
      };
    case "BigInteger":
      return {
        tag: ArgTag.BIGINT,
      };
    case "float":
    case "Float":
    case "double":
    case "Double":
    case "BigDecimal":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: false,
        },
      };
    case "char":
    case "Character":
      return {
        tag: ArgTag.STRING,
        options: {
          strLength: { min: 1, max: 1 },
        },
      };
    case "String":
    case "CharSequence":
      return { tag: ArgTag.STRING };
    default:
      return undefined;
  }
} // fn: resolveJavaPrimitive

/**
 * Checks whether an identifier corresponds to a Java primitive or built-in scalar type name.
 *
 * @param name The type name to check
 * @returns True if the identifier is a primitive or built-in, false otherwise
 */
function isJavaPrimitiveOrBuiltinName(name: string): boolean {
  const builtins = new Set([
    "boolean",
    "Boolean",
    "byte",
    "Byte",
    "short",
    "Short",
    "int",
    "Integer",
    "long",
    "Long",
    "BigInteger",
    "float",
    "Float",
    "double",
    "Double",
    "BigDecimal",
    "char",
    "Character",
    "String",
    "CharSequence",
    "Object",
    "void",
    "Void",
  ]);
  return builtins.has(name);
} // fn: isJavaPrimitiveOrBuiltinName
