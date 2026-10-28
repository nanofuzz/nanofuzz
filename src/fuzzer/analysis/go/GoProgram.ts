import * as fs from "node:fs";
import * as path from "node:path";
import { AbstractProgram } from "../AbstractProgram";
import {
  ArgOptionOverride,
  ArgOptions,
  ArgTag,
  FunctionRef,
  IdentifierName,
  ProgramImports,
  ProgramLanguage,
  TypeRef,
} from "../Types";
import * as Parser from "../../adapters/ParserAdapter";
import { ArgDef } from "../ArgDef";
import { findInAncestor, getErrorMessageOrJson } from "../../Util";
import * as JSONN from "../../../Jsonn";

export class GoProgram extends AbstractProgram {
  public static readonly lang: ProgramLanguage = "go";
  public static readonly extensions: readonly string[] = Object.freeze([
    ".go",
  ]);
  protected _ast: Parser.Tree | undefined;
  protected _packageName: string = "";

  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
    if (parent && GoProgram.lang !== parent.lang) {
      throw new Error(
        `A "${GoProgram.lang}" program cannot be a child of a "${parent.lang}" program.`
      );
    }
  }

  public get lang(): ProgramLanguage {
    return GoProgram.lang;
  }

  public get extensions(): readonly string[] {
    return GoProgram.extensions;
  }

  public getPackageName(): string {
    if (!this._ast) {
      this._parse(this._src);
    }
    if (!this._ast) return "";
    const pkgNode = this._ast.rootNode.descendantsOfType("package_clause")[0];
    if (!pkgNode) return "";
    const nameNode = pkgNode.children.find(
      (c) => c.type === "package_identifier" || c.type === "identifier"
    );
    return nameNode?.text ?? "";
  }

  public static understands(details: {
    filename?: string;
    lang?: ProgramLanguage;
  }): boolean {
    if (details.lang === GoProgram.lang) {
      return true;
    }
    if (details.filename !== undefined) {
      for (const ext of GoProgram.extensions) {
        if (
          details.filename.endsWith(ext) &&
          !details.filename.endsWith("_test.go")
        ) {
          return true;
        }
      }
    }
    return false;
  } // fn: understands

  /**
   * Returns a Go type annotation string for the given argument definition.
   */
  public static getTypeAnnotation(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    const isPointer =
      arg.getBaseTypeRef() === "pointer" ||
      (arg.isOptional() && arg.getType() === ArgTag.OBJECT);
    const ptrPrefix = isPointer ? "*" : "";

    if (arg.isConstant()) {
      return GoProgram.toGoType(arg, options);
    }

    const dims = arg.getDim();
    if (dims > 0) {
      const typeRef = arg.getTypeRef();
      if (typeRef && typeRef.startsWith("[")) {
        return `${ptrPrefix}${typeRef}`;
      }
      const base = GoProgram.toGoType(arg, options);
      return `${ptrPrefix}${"[]".repeat(dims)}${base}`;
    }

    if (arg.getType() === ArgTag.DICTIONARY) {
      if (arg.getChildren().length >= 2) {
        const kAnnot = GoProgram.getTypeAnnotation(
          arg.getChildren()[0],
          options
        );
        const vAnnot = GoProgram.getTypeAnnotation(
          arg.getChildren()[1],
          options
        );
        return `${ptrPrefix}map[${kAnnot}]${vAnnot}`;
      }
      return `${ptrPrefix}map[string]any`;
    }

    const typeRefName = arg.getTypeRef();
    if (typeRefName && typeRefName !== "") {
      return `${ptrPrefix}${typeRefName}`;
    }

    return `${ptrPrefix}${GoProgram.toGoType(arg, options)}`;
  } // fn: getTypeAnnotation

  /**
   * Returns the base Go type for the given argument.
   */
  public static getBaseType(arg: ArgDef): string {
    const annot = GoProgram.getTypeAnnotation(arg);
    return annot.replace(/^\*+/, "").replace(/^\[\d*\]/, "");
  } // fn: getBaseType

  /**
   * Discovers sibling .go source files in the same directory (excluding tests).
   */
  public static findLocalSourceFiles(sourceFile: string): string[] {
    const dir = path.dirname(sourceFile);
    if (!fs.existsSync(dir)) return [];
    try {
      const files = fs.readdirSync(dir);
      return files
        .filter(
          (f) =>
            typeof f === "string" &&
            f.endsWith(".go") &&
            !f.endsWith("_test.go") &&
            path.resolve(dir, f) !== path.resolve(sourceFile)
        )
        .map((f) => path.resolve(dir, f));
    } catch {
      return [];
    }
  } // fn: findLocalSourceFiles

  /**
   * Discovers the nearest ancestor go.mod path if present.
   */
  public static findGoMod(sourceFile: string): string | undefined {
    return findInAncestor(path.dirname(sourceFile), "go.mod");
  } // fn: findGoMod

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
        `Internal error: typeRefName is undefined in TypeRef (${JSONN.stringify(
          typeRef
        )})`
      );
    }

    const name = typeRef.typeRefName;
    if (name === "any" || name === "error" || name === "interface{}") {
      typeRef.type = {
        type: ArgTag.OBJECT,
        dims: 0,
        children: [],
        resolved: true,
      };
      return typeRef;
    }

    if (name === "FuzzTestResult") {
      typeRef.type = {
        type: ArgTag.OBJECT,
        dims: 0,
        children: [],
        resolved: true,
      };
      return typeRef;
    }

    const primitiveResolved = resolveGoPrimitive(name);
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
        if (typeRef.baseTypeRef && typeRef.type) {
          typeRef.type.baseTypeRef = typeRef.baseTypeRef;
        }
        return typeRef;
      } else if (typeDef.typeRefName && typeDef.typeRefName !== name) {
        const resolved = this.resolveTypeRef(typeDef);
        typeRef.type = structuredClone(resolved.type);
        if (typeRef.type) {
          typeRef.type.dims += resolved.dims;
        }
        typeRef.optional = typeRef.optional || resolved.optional;
        if (typeRef.baseTypeRef && typeRef.type) {
          typeRef.type.baseTypeRef = typeRef.baseTypeRef;
        }
        return typeRef;
      }
      throw new Error(
        `Unable to resolve type '${name}' in module '${this._filename}'`
      );
    }

    throw new Error(
      `Unable to resolve type '${name}' in module '${this._filename}'`
    );
  } // fn: resolveTypeRef

  protected _parse(src: string): void {
    this._ast = Parser.parse("go", src) ?? undefined;
    if (this._ast) {
      const idNode =
        this._ast.rootNode.descendantsOfType("package_identifier")[0];
      if (idNode) {
        this._packageName = idNode.text;
      }
    }
  } // fn: _parse

  protected _findImports(): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };
    if (!this._ast) {
      return imports;
    }

    const importQuery = Parser.query(
      "go",
      `
[
  (import_spec
    name: (package_identifier)? @import.alias
    path: (interpreted_string_literal) @import.path) @import.spec
]
`
    );

    const matches = importQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const pathCap = match.captures.find((c) => c.name === "import.path");
      if (!pathCap) continue;
      const rawPath = pathCap.node.text.replace(/^"|"$/g, "");
      const aliasCap = match.captures.find((c) => c.name === "import.alias");
      const localName = aliasCap ? aliasCap.node.text : path.basename(rawPath);

      imports.identifiers[localName] = {
        local: localName,
        imported: localName,
        programPath: rawPath,
        resolved: false,
        default: true,
      };
      imports.programs[rawPath] = localName;
    }

    return imports;
  } // fn: _findImports

  protected _findTypes(): Record<IdentifierName, TypeRef> {
    const types: Record<IdentifierName, TypeRef> = {};
    if (!this._ast) {
      return types;
    }

    const typeQuery = Parser.query(
      "go",
      `
(type_declaration
  (type_spec
    name: (type_identifier) @type.name
    type: (_) @type.target) @type.spec)
`
    );

    const matches = typeQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const nameNode = match.captures.find((c) => c.name === "type.name")?.node;
      const targetNode = match.captures.find(
        (c) => c.name === "type.target"
      )?.node;
      if (!nameNode || !targetNode) continue;

      const typeName = nameNode.text;
      try {
        const typeRef = this._getTypeRefFromAstNode(targetNode);
        typeRef.name = typeName;
        typeRef.isExported = isExportedName(typeName);
        types[typeName] = typeRef;
      } catch (e) {
        console.debug(
          `Error getting TypeRef from AST node for ${typeName} in module ${this._filename}: ${e}`
        );
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
      "go",
      `
[
  (function_declaration
    name: (identifier) @fn.name
    parameters: (parameter_list) @fn.params) @fn.item
  (method_declaration
    name: (field_identifier) @method.name
    parameters: (parameter_list) @method.params) @method.item
]
`
    );

    const matches = fnQuery.matches(this._ast.rootNode);
    for (const match of matches) {
      const fnItem = match.captures.find((c) => c.name === "fn.item")?.node;
      const methodItem = match.captures.find(
        (c) => c.name === "method.item"
      )?.node;
      const itemNode = fnItem ?? methodItem;
      const nameNode =
        match.captures.find((c) => c.name === "fn.name")?.node ??
        match.captures.find((c) => c.name === "method.name")?.node;
      const paramsNode =
        match.captures.find((c) => c.name === "fn.params")?.node ??
        match.captures.find((c) => c.name === "method.params")?.node;
      const returnNode = itemNode?.childForFieldName("result");

      if (!itemNode || !nameNode || !paramsNode) continue;

      const name = nameNode.text;
      try {
        const fnRef = this._getFunctionFromNode(
          itemNode,
          nameNode,
          paramsNode,
          returnNode ?? undefined
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
            lang: GoProgram.lang,
            startOffset: itemNode.startIndex,
            endOffset: itemNode.endIndex,
            isExported: isExportedName(name),
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

    const tree = Parser.parse("go", fnRef.src);
    if (!tree) {
      throw new Error(
        `Tree-sitter failed to parse Go function "${fnName}" in module "${this._filename}"`
      );
    }

    const query = Parser.query(
      "go",
      `
[
  (call_expression function: (identifier) @callee.name)
  (call_expression function: (selector_expression field: (field_identifier) @callee.name))
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
    paramsNode: Parser.SyntaxNode,
    returnNode?: Parser.SyntaxNode
  ): FunctionRef {
    const typeParamsNode = itemNode.childForFieldName("type_parameters");
    if (typeParamsNode) {
      throw new Error(
        `Generic function '${nameNode.text}' with type parameters is not supported`
      );
    }

    const args: TypeRef[] = [];
    const paramDecls = Parser.getNamedChildrenNoComments(paramsNode);

    for (const pDecl of paramDecls) {
      if (pDecl.type === "parameter_declaration") {
        const typeNode = pDecl.childForFieldName("type");
        if (!typeNode) {
          throw new Error(
            `Parameter declaration missing type in function '${nameNode.text}'`
          );
        }
        const parsedType = this._getTypeRefFromAstNode(typeNode);
        const nameNodes = pDecl.children.filter((c) => c.type === "identifier");
        if (nameNodes.length === 0) {
          args.push({ ...parsedType });
        } else {
          for (const n of nameNodes) {
            args.push({
              ...parsedType,
              name: n.text,
            });
          }
        }
      } else if (pDecl.type === "variadic_parameter_declaration") {
        const typeNode = pDecl.childForFieldName("type");
        const nameChild = pDecl.childForFieldName("name");
        const elemType = typeNode
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
        args.push({
          module: this._filename,
          name: nameChild?.text ?? "args",
          dims: 1,
          optional: true,
          isExported: true,
          type: {
            type: elemType.type?.type ?? ArgTag.OBJECT,
            dims: 0,
            children: elemType.type?.children ?? [],
            resolved: elemType.type?.resolved ?? true,
          },
        });
      }
    }

    let returnType: TypeRef | undefined = undefined;
    let isVoid = true;

    if (returnNode) {
      if (returnNode.type === "parameter_list") {
        const resultDecls = Parser.getNamedChildrenNoComments(returnNode);
        if (resultDecls.length === 0) {
          isVoid = true;
        } else if (resultDecls.length === 1 && resultDecls[0].type === "parameter_declaration") {
          const tNode = resultDecls[0].childForFieldName("type");
          if (tNode) {
            returnType = this._getTypeRefFromAstNode(tNode);
            isVoid = false;
          }
        } else {
          const returnChildren: TypeRef[] = [];
          for (const rd of resultDecls) {
            if (rd.type === "parameter_declaration") {
              const tNode = rd.childForFieldName("type");
              if (tNode) {
                returnChildren.push(this._getTypeRefFromAstNode(tNode));
              }
            } else {
              returnChildren.push(this._getTypeRefFromAstNode(rd));
            }
          }
          returnType = {
            module: this._filename,
            dims: 0,
            optional: false,
            isExported: true,
            type: {
              type: ArgTag.TUPLE,
              dims: 0,
              children: returnChildren,
              resolved: returnChildren.every((c) => c.type?.resolved),
            },
          };
          isVoid = false;
        }
      } else {
        returnType = this._getTypeRefFromAstNode(returnNode);
        isVoid = false;
      }
    }

    const cmtNode = itemNode.previousNamedSibling;
    const cmt =
      cmtNode &&
      (cmtNode.type === "comment" || cmtNode.type === "line_comment")
        ? cmtNode.text
        : undefined;

    const fnRef: FunctionRef = {
      module: this._filename,
      name: nameNode.text,
      src: itemNode.text,
      lang: GoProgram.lang,
      startOffset: itemNode.startIndex,
      endOffset: itemNode.endIndex,
      isExported: isExportedName(nameNode.text),
      isVoid,
      args,
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
      case "type_identifier":
      case "package_identifier":
      case "identifier": {
        const text = node.text;
        const resolved = resolveGoPrimitive(text);
        if (resolved) {
          thisType.typeRefName = text;
          thisType.type = {
            type: resolved.tag,
            dims: 0,
            children: [],
            ...(resolved.options ? { options: resolved.options } : {}),
            resolved: true,
          };
          return thisType;
        }
        if (text === "any" || text === "error" || text === "interface{}") {
          thisType.typeRefName = text;
          thisType.type = {
            type: ArgTag.OBJECT,
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

        thisType.typeRefName = text;
        thisType.type = {
          type: ArgTag.UNRESOLVED,
          dims: 0,
          children: [],
          resolved: false,
        };
        return thisType;
      }

      case "pointer_type": {
        const innerNode =
          node.childForFieldName("type") ??
          Parser.getNamedChildrenNoComments(node).at(-1);
        if (!innerNode) {
          thisType.optional = true;
          thisType.baseTypeRef = "pointer";
          thisType.type = {
            type: ArgTag.OBJECT,
            dims: 0,
            children: [],
            resolved: true,
          };
          return thisType;
        }
        const innerType = this._getTypeRefFromAstNode(innerNode);
        return {
          ...innerType,
          baseTypeRef: "pointer",
          optional: true,
        };
      }

      case "slice_type": {
        const elemNode = node.childForFieldName("element");
        const elemType = elemNode
          ? this._getTypeRefFromAstNode(elemNode)
          : {
              module: this._filename,
              dims: 0,
              optional: false,
              isExported: true,
              type: {
                type: ArgTag.STRING,
                dims: 0,
                children: [],
                resolved: true,
              },
            };
        thisType.dims = elemType.dims + 1;
        thisType.type = {
          type: elemType.type?.type ?? ArgTag.NUMBER,
          dims: 0,
          children: elemType.type?.children ?? [],
          ...(elemType.type?.options ? { options: elemType.type.options } : {}),
          resolved: elemType.type?.resolved ?? false,
        };
        thisType.typeRefName = elemType.typeRefName;
        return thisType;
      }

      case "array_type": {
        const elemNode = node.childForFieldName("element");
        const lenNode = node.childForFieldName("length");
        const elemType = elemNode
          ? this._getTypeRefFromAstNode(elemNode)
          : {
              module: this._filename,
              dims: 0,
              optional: false,
              isExported: true,
              type: {
                type: ArgTag.NUMBER,
                dims: 0,
                children: [],
                resolved: true,
              },
            };
        const lenText = lenNode ? lenNode.text.trim() : "";
        thisType.dims = elemType.dims + 1;
        thisType.typeRefName = `[${lenText}]${elemType.typeRefName ?? "int"}`;
        thisType.baseTypeRef = thisType.typeRefName;
        thisType.type = {
          type: elemType.type?.type ?? ArgTag.NUMBER,
          dims: 0,
          children: elemType.type?.children ?? [],
          ...(elemType.type?.options ? { options: elemType.type.options } : {}),
          resolved: elemType.type?.resolved ?? false,
        };
        return thisType;
      }

      case "map_type": {
        const keyNode = node.childForFieldName("key");
        const valueNode = node.childForFieldName("value");
        const keyType = keyNode
          ? this._getTypeRefFromAstNode(keyNode)
          : {
              module: this._filename,
              dims: 0,
              optional: false,
              isExported: true,
              type: {
                type: ArgTag.STRING,
                dims: 0,
                children: [],
                resolved: true,
              },
            };
        const valueType = valueNode
          ? this._getTypeRefFromAstNode(valueNode)
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
        thisType.baseTypeRef = "map";
        thisType.type = {
          type: ArgTag.DICTIONARY,
          dims: 0,
          children: [keyType, valueType],
          baseTypeRef: "map",
          resolved:
            (keyType.type?.resolved ?? false) &&
            (valueType.type?.resolved ?? false),
        };
        return thisType;
      }

      case "struct_type": {
        const fieldList = node.childForFieldName("fields");
        const children: TypeRef[] = [];
        if (fieldList) {
          const fields = Parser.getNamedChildrenNoComments(fieldList);
          for (const f of fields) {
            if (f.type === "field_declaration") {
              const fTypeNode = f.childForFieldName("type");
              const fNameNodes = f.children.filter(
                (c) => c.type === "field_identifier" || c.type === "identifier"
              );
              if (fTypeNode) {
                const parsedFieldType = this._getTypeRefFromAstNode(fTypeNode);
                if (fNameNodes.length === 0) {
                  children.push({ ...parsedFieldType });
                } else {
                  for (const fn of fNameNodes) {
                    children.push({
                      ...parsedFieldType,
                      name: fn.text,
                    });
                  }
                }
              }
            }
          }
        }
        thisType.type = {
          type: ArgTag.OBJECT,
          dims: 0,
          children,
          resolved: children.every((c) => c.type?.resolved),
        };
        return thisType;
      }

      case "qualified_type": {
        const pkgNode = node.childForFieldName("package");
        const nameNode = node.childForFieldName("name");
        const fq =
          pkgNode && nameNode ? `${pkgNode.text}.${nameNode.text}` : node.text;
        thisType.typeRefName = fq;
        thisType.type = {
          type: ArgTag.OBJECT,
          dims: 0,
          children: [],
          resolved: true,
        };
        return thisType;
      }

      case "interface_type": {
        thisType.type = {
          type: ArgTag.OBJECT,
          dims: 0,
          children: [],
          resolved: true,
        };
        return thisType;
      }

      default: {
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

  private static toGoType(
    arg: ArgDef,
    options: TypeAnnotationOptions
  ): string {
    const typeRefName = arg.getTypeRef();
    if (typeRefName && typeRefName !== "" && typeRefName !== "any") {
      return typeRefName;
    }
    switch (arg.getType()) {
      case ArgTag.BOOLEAN:
        return "bool";
      case ArgTag.STRING:
        return "string";
      case ArgTag.NUMBER: {
        const opts = arg.getOptions();
        if (opts.numInteger) {
          const iv = arg.getIntervals();
          if (iv && iv.length > 0) {
            const min = iv[0].min;
            const max = iv[0].max;
            if (typeof min === "number" && typeof max === "number") {
              if (min >= 0) {
                if (max <= 255) return "uint8";
                if (max <= 65535) return "uint16";
                if (max <= 4294967295) return "uint32";
                return "uint";
              } else {
                if (min >= -128 && max <= 127) return "int8";
                if (min >= -32768 && max <= 32767) return "int16";
                if (min >= -2147483648 && max <= 2147483647) return "int32";
                return "int";
              }
            }
          }
          return "int";
        }
        return "float64";
      }
      case ArgTag.BIGINT:
        return "int64";
      case ArgTag.DICTIONARY:
        if (arg.getChildren().length >= 2) {
          const k = GoProgram.getTypeAnnotation(
            arg.getChildren()[0],
            options
          );
          const v = GoProgram.getTypeAnnotation(
            arg.getChildren()[1],
            options
          );
          return `map[${k}]${v}`;
        }
        return "map[string]any";
      case ArgTag.OBJECT: {
        const name = arg.getTypeRef();
        return name && name !== "" ? name : "any";
      }
      default:
        return "any";
    }
  } // fn: toGoType
} // class: GoProgram

type TypeAnnotationOptions = {
  useTypeRefs?: boolean;
};

const TypeAnnotationOptionDefaults: TypeAnnotationOptions = {
  useTypeRefs: true,
};

function isExportedName(name: string): boolean {
  if (name.length === 0) return false;
  const first = name[0];
  return first >= "A" && first <= "Z";
} // fn: isExportedName

function resolveGoPrimitive(typeStr: string): {
  tag: ArgTag;
  options?: ArgOptionOverride;
} | undefined {
  switch (typeStr) {
    case "bool":
      return { tag: ArgTag.BOOLEAN };
    case "string":
      return { tag: ArgTag.STRING };
    case "int8":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -128, max: 127 }],
        },
      };
    case "int16":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -32768, max: 32767 }],
        },
      };
    case "int32":
    case "rune":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -2147483648, max: 2147483647 }],
        },
      };
    case "int":
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
          numInteger: true,
          bigintIntervals: [
            { min: -9223372036854775808n, max: 9223372036854775807n },
          ],
        },
      };
    case "uint8":
    case "byte":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: 0, max: 255 }],
        },
      };
    case "uint16":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: 0, max: 65535 }],
        },
      };
    case "uint32":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: 0, max: 4294967295 }],
        },
      };
    case "uint":
    case "uintptr":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: 0, max: 4294967295 }],
        },
      };
    case "uint64":
      return {
        tag: ArgTag.BIGINT,
        options: {
          numInteger: true,
          bigintIntervals: [{ min: 0n, max: 18446744073709551615n }],
        },
      };
    case "float32":
    case "float64":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: false,
        },
      };
    default:
      return undefined;
  }
} // fn: resolveGoPrimitive
