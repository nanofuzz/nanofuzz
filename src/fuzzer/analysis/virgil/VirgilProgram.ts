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
import * as JSONN from "../../../Jsonn";
import * as Parser from "../../adapters/ParserAdapter";
import { ArgDef } from "../ArgDef";

export class VirgilProgram extends AbstractProgram {
  public static readonly lang: ProgramLanguage = "virgil";
  public static readonly extensions: readonly string[] = Object.freeze([".v3"]);
  protected _ast: Parser.Tree | undefined;

  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
    if (parent && VirgilProgram.lang !== parent.lang) {
      throw new Error(
        `A "${VirgilProgram.lang}" program cannot be a child of a "${parent.lang}" program.`
      );
    }
  }

  public get lang(): ProgramLanguage {
    return VirgilProgram.lang;
  }

  public get extensions(): readonly string[] {
    return VirgilProgram.extensions;
  }

  /**
   * Returns a Virgil type annotation string for the given argument.
   */
  public static getTypeAnnotation(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    const baseType = VirgilProgram.getBaseType(arg, options);
    const dims = arg.getDim();
    if (dims > 0) {
      return `${"Array<".repeat(dims)}${baseType}${">".repeat(dims)}`;
    }
    return baseType;
  } // fn: getTypeAnnotation

  /**
   * Returns the base Virgil type string for the given argument.
   */
  public static getBaseType(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    switch (arg.getType()) {
      case ArgTag.NUMBER: {
        const isInt = arg.getOptions().numInteger ?? true;
        if (!isInt) {
          return "float";
        }
        const intervals = arg.getIntervals();
        if (intervals && intervals.length > 0) {
          const min = intervals[0].min;
          const max = intervals[0].max;
          if (typeof min === "number" && typeof max === "number") {
            if (min >= 0 && max <= 255) return "byte";
            if (min >= -128 && max <= 127) return "i8";
            if (min >= 0 && max <= 65535) return "u16";
            if (min >= -32768 && max <= 32767) return "i16";
            if (min >= 0 && max <= 4294967295) return "u32";
          }
        }
        return "int";
      }
      case ArgTag.BIGINT: {
        const intervals = arg.getIntervals();
        if (intervals && intervals.length > 0) {
          const min = intervals[0].min;
          if (typeof min === "bigint" && min >= 0n) {
            return "u64";
          }
        }
        return "i64";
      }
      case ArgTag.BOOLEAN:
        return "bool";
      case ArgTag.STRING:
        return "string";
      case ArgTag.OBJECT: {
        const typeRef = arg.getTypeRef();
        if (typeRef === "#tuple" || typeRef?.startsWith("#(")) {
          const children = arg.getChildren();
          const elemStr = children
            .map((c) => VirgilProgram.getTypeAnnotation(c, options))
            .join(", ");
          return `(${elemStr})`;
        }
        if (typeRef && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(typeRef)) {
          return typeRef;
        }
        throw new Error(
          `Unsupported Virgil object/complex type in parameter '${arg.getName()}'`
        );
      }
      case ArgTag.TUPLE: {
        const children = arg.getChildren();
        const elemStr = children
          .map((c) => VirgilProgram.getTypeAnnotation(c, options))
          .join(", ");
        return `(${elemStr})`;
      }
      case ArgTag.DICTIONARY:
      case ArgTag.SET:
      case ArgTag.UNION:
      case ArgTag.BYTES:
      case ArgTag.LITERAL:
      case ArgTag.UNRESOLVED:
        throw new Error(
          `VirgilProgram cannot annotate unsupported or unresolved type '${arg.getType()}' in parameter '${arg.getName()}'`
        );
    }
  } // fn: getBaseType

  public resolveTypeRef(typeRef: TypeRef): TypeRef {
    if (typeRef.type && typeRef.type.type !== ArgTag.UNRESOLVED) {
      if (typeRef.type.resolved) {
        return typeRef;
      }
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

    if (!typeRef.typeRefName) {
      throw new Error(
        `Internal error: typeRef is undefined in TypeRef (${JSONN.stringify(typeRef)})`
      );
    }

    const name = typeRef.typeRefName;
    if (name === "FuzzTestResult" || name === "prng") {
      typeRef.type = {
        type: ArgTag.OBJECT,
        dims: 0,
        children: [],
        resolved: true,
      };
      return typeRef;
    }

    const primitiveResolved = resolveVirgilPrimitive(name);
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
      }
    }

    // Gate 3: NEVER return unresolved types -- throw immediately!
    throw new Error(
      `Unsupported or unresolved Virgil type '${name}' in module '${this._filename}'`
    );
  } // fn: resolveTypeRef

  protected _parse(src: string): void {
    this._ast = Parser.parse(VirgilProgram.lang, src) ?? undefined;
  } // fn: _parse

  protected _findImports(): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };
    if (!this._ast) {
      return imports;
    }

    const src = this._src;
    const regex = /import\s+(?:".*"\s+)?component\s+([A-Za-z0-9_]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(src)) !== null) {
      const compName = match[1];
      imports.identifiers[compName] = {
        local: compName,
        imported: compName,
        programPath: "",
        resolved: false,
        default: false,
      };
    }

    return imports;
  } // fn: _findImports

  protected _findTypes(): Record<IdentifierName, TypeRef> {
    return {};
  } // fn: _findTypes

  protected _findFunctions(): typeof this._functions {
    if (!this._ast) {
      throw new Error("AST not loaded");
    }

    const supported: AbstractProgram["_functions"]["supported"] = {};
    const unsupported: AbstractProgram["_functions"]["unsupported"] = {};

    const query = Parser.query(
      VirgilProgram.lang,
      `
(method
  name: (ident_param name: (identifier) @method.name)
  parameters: (var_param_decls)? @method.params
  returnType: (type_ref)? @method.return) @method.item
`
    );
    const matches = query.matches(this._ast.rootNode);

    for (const match of matches) {
      const methodNode = match.captures.find(
        (c) => c.name === "method.item"
      )?.node;
      const nameNode = match.captures.find(
        (c) => c.name === "method.name"
      )?.node;
      if (!methodNode || !nameNode) continue;

      const fnName = nameNode.text.trim();
      try {
        const fnRef = this._buildFunctionRef(methodNode, nameNode, match);
        supported[fnName] = fnRef;
      } catch (e: unknown) {
        const msg = getErrorMessageOrJson(e);
        unsupported[fnName] = {
          reason: msg,
          function: {
            module: this._filename,
            name: fnName,
            src: methodNode.text,
            lang: VirgilProgram.lang,
            startOffset: methodNode.startIndex,
            endOffset: methodNode.endIndex,
            isExported: false,
            isVoid: false,
            args: [],
          },
        };
      }
    }

    return { supported, unsupported };
  } // fn: _findFunctions

  protected _buildFunctionRef(
    methodNode: Parser.SyntaxNode,
    nameNode: Parser.SyntaxNode,
    match: Parser.QueryMatch
  ): FunctionRef {
    // Check if inside a class (methods with instance 'this' state are flagged as unsupported)
    let curr: Parser.SyntaxNode | null = methodNode.parent;
    let isInsideClass = false;
    while (curr) {
      if (curr.type === "class_decl") {
        isInsideClass = true;
        break;
      }
      curr = curr.parent;
    }

    if (isInsideClass) {
      throw new Error(
        `Class method '${nameNode.text}' is not a top-level or component function; test via a wrapper function instead.`
      );
    }

    // Determine visibility: methods preceded by 'private' are private; default is exported / public
    let isExported = true;
    const parentDefMember = methodNode.parent;
    if (parentDefMember && parentDefMember.text.trim().startsWith("private")) {
      isExported = false;
    }

    // Return type
    const returnCap = match.captures.find(
      (c: Parser.QueryCapture) => c.name === "method.return"
    );
    let isVoid = true;
    let returnType: TypeRef | undefined = undefined;

    if (returnCap && returnCap.node.text.trim() !== "void") {
      isVoid = false;
      returnType = this._getTypeRefFromNode(returnCap.node);
      returnType.name = returnCap.node.text.trim();
    }

    // Parameters
    const paramsCap = match.captures.find(
      (c: Parser.QueryCapture) => c.name === "method.params"
    );
    const args: TypeRef[] = [];

    if (paramsCap) {
      const paramDecls = Parser.getNamedChildrenNoComments(paramsCap.node);
      for (const p of paramDecls) {
        const pNameNode = p.childForFieldName("name");
        const pTypeNode = p.childForFieldName("type");
        if (!pNameNode || !pTypeNode) {
          throw new Error(
            `Malformed parameter in Virgil function '${nameNode.text}'`
          );
        }
        const pName = pNameNode.text.trim();
        const pTypeRef = this._getTypeRefFromNode(pTypeNode);
        pTypeRef.name = pName;
        args.push(pTypeRef);
      }
    }

    let outerDecl: Parser.SyntaxNode = methodNode;
    while (
      outerDecl.parent &&
      outerDecl.parent.type !== "source_file" &&
      outerDecl.parent.type !== "component_decl"
    ) {
      outerDecl = outerDecl.parent;
    }

    const cmt = extractLeadingDocComment(outerDecl);

    const fnRef: FunctionRef = {
      module: this._filename,
      name: nameNode.text.trim(),
      src: (parentDefMember?.type === "def_member"
        ? parentDefMember
        : methodNode
      ).text,
      lang: VirgilProgram.lang,
      startOffset: methodNode.startIndex,
      endOffset: methodNode.endIndex,
      isExported,
      isVoid,
      args,
      ...(returnType ? { returnType } : {}),
      ...(cmt ? { cmt } : {}),
    };

    return fnRef;
  } // fn: _buildFunctionRef

  protected _getTypeRefFromNode(typeNode: Parser.SyntaxNode): TypeRef {
    const rawText = typeNode.text.trim();

    // Check for array type (ends with [])
    let dims = 0;
    let baseText = rawText;
    while (baseText.endsWith("[]")) {
      dims++;
      baseText = baseText.slice(0, -2).trim();
    }

    // Check for Array<T> generic syntax
    let arrayGenericMatch = baseText.match(/^Array<(.+)>$/);
    while (arrayGenericMatch) {
      dims++;
      baseText = arrayGenericMatch[1].trim();
      arrayGenericMatch = baseText.match(/^Array<(.+)>$/);
    }

    // Check for tuple: (T1, T2, ...)
    if (baseText.startsWith("(") && baseText.endsWith(")")) {
      const inner = baseText.slice(1, -1).trim();
      const tupleTypeRef: TypeRef = {
        name: "",
        typeRefName: "#tuple",
        dims,
        optional: false,
        isExported: false,
        module: this._filename,
        type: {
          type: ArgTag.OBJECT,
          dims,
          children: [],
          resolved: false,
        },
      };

      if (inner.length > 0) {
        const parts = splitTypeArgs(inner);
        for (let i = 0; i < parts.length; i++) {
          const childRef = this._createTypeRefFromTypeName(parts[i]);
          childRef.name = String(i);
          this.resolveTypeRef(childRef);
          tupleTypeRef.type!.children.push(childRef);
        }
        tupleTypeRef.type!.resolved = true;
      }
      return tupleTypeRef;
    }

    // Closures or function types: (T) -> R
    if (baseText.includes("->")) {
      throw new Error(
        `Unsupported function/closure type '${baseText}' in parameter`
      );
    }

    // Raw pointer and address types
    if (
      baseText === "Pointer" ||
      baseText === "Address" ||
      baseText.startsWith("Pointer<")
    ) {
      throw new Error(`Unsupported Virgil type '${baseText}' in parameter`);
    }

    const typeRef: TypeRef = {
      name: "",
      typeRefName: baseText,
      dims,
      baseTypeRef: baseText,
      optional: false,
      isExported: false,
      module: this._filename,
    };

    return this.resolveTypeRef(typeRef);
  } // fn: _getTypeRefFromNode

  protected _createTypeRefFromTypeName(typeName: string): TypeRef {
    let dims = 0;
    let base = typeName.trim();
    while (base.endsWith("[]")) {
      dims++;
      base = base.slice(0, -2).trim();
    }
    let arrayGenericMatch = base.match(/^Array<(.+)>$/);
    while (arrayGenericMatch) {
      dims++;
      base = arrayGenericMatch[1].trim();
      arrayGenericMatch = base.match(/^Array<(.+)>$/);
    }
    const typeRef: TypeRef = {
      name: "",
      typeRefName: base,
      dims,
      baseTypeRef: base,
      optional: false,
      isExported: false,
      module: this._filename,
    };
    return typeRef;
  } // fn: _createTypeRefFromTypeName

  protected _findDefaultTypeExport(): TypeRef | undefined {
    return undefined;
  } // fn: _findDefaultTypeExport

  protected _findCallees(_fnName: string): Set<string> {
    return new Set<string>();
  } // fn: _findCallees

  /**
   * Discovers all local module files for the project scope starting from sourceFile.
   * Finds all `.v3` files within the containing project directory.
   */
  public static findLocalModules(
    sourceFile: string,
    visited: Set<string> = new Set()
  ): string[] {
    const norm = fs.existsSync(sourceFile)
      ? fs.realpathSync(path.resolve(sourceFile))
      : path.resolve(sourceFile);

    const projectRoot = findProjectRoot(norm);
    const results: string[] = [];

    function walkDir(dir: string): void {
      if (!fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (
              entry.name !== "node_modules" &&
              entry.name !== ".git" &&
              entry.name !== "vendor" &&
              entry.name !== "third_party"
            ) {
              walkDir(fullPath);
            }
          } else if (entry.isFile() && entry.name.endsWith(".v3")) {
            const real = fs.realpathSync(fullPath);
            if (!visited.has(real) && real !== norm) {
              visited.add(real);
              results.push(real);
            }
          }
        }
      } catch {
        // ignore permission or read errors
      }
    }

    walkDir(projectRoot);
    return results;
  } // fn: findLocalModules

  /**
   * Discovers external directly imported component/library names,
   * strictly excluding Virgil built-in internals (System, Virgil, etc.).
   */
  public static findDirectImports(sourceFile: string): string[] {
    const norm = fs.existsSync(sourceFile)
      ? fs.realpathSync(path.resolve(sourceFile))
      : path.resolve(sourceFile);
    if (!fs.existsSync(norm)) return [];

    const src = fs.readFileSync(norm, "utf8");
    const imports = new Set<string>();
    const regex = /import\s+(?:".*"\s+)?component\s+([A-Za-z0-9_]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(src)) !== null) {
      const compName = match[1];
      if (compName && !BUILTIN_VIRGIL_MODULES.has(compName)) {
        imports.add(compName);
      }
    }

    return Array.from(imports);
  } // fn: findDirectImports
} // class: VirgilProgram

const BUILTIN_VIRGIL_MODULES = new Set([
  "System",
  "Virgil",
  "Runtime",
  "Memory",
  "Pointer",
  "Address",
  "Array",
  "Range",
  "nanofuzz_runtime",
]);

function resolveVirgilPrimitive(
  name: string
): { tag: ArgTag; options?: ArgOptionOverride } | undefined {
  switch (name) {
    case "bool":
    case "boolean":
      return { tag: ArgTag.BOOLEAN };
    case "byte":
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
    case "int":
    case "i32":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: true,
          numIntervals: [{ min: -2147483648, max: 2147483647 }],
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
    case "i64":
      return {
        tag: ArgTag.BIGINT,
        options: {
          bigintIntervals: [
            { min: -9223372036854775808n, max: 9223372036854775807n },
          ],
        },
      };
    case "u64":
      return {
        tag: ArgTag.BIGINT,
        options: {
          bigintIntervals: [
            { min: 0n, max: 18446744073709551615n },
          ],
        },
      };
    case "float":
    case "f32":
    case "double":
    case "f64":
      return {
        tag: ArgTag.NUMBER,
        options: {
          numInteger: false,
        },
      };
    case "string":
      return { tag: ArgTag.STRING };
    default:
      return undefined;
  }
} // fn: resolveVirgilPrimitive

function splitTypeArgs(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(" || char === "<" || char === "[") {
      depth++;
      current += char;
    } else if (char === ")" || char === ">" || char === "]") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
} // fn: splitTypeArgs

function extractLeadingDocComment(node: Parser.SyntaxNode): string | undefined {
  const comments: string[] = [];
  let prev = node.previousNamedSibling;

  while (
    prev &&
    (prev.type === "comment" ||
      prev.type === "line_comment" ||
      prev.type === "block_comment")
  ) {
    const text = prev.text.trim();
    if (text.startsWith("///") || text.startsWith("//") || text.startsWith("/*")) {
      comments.unshift(
        text.replace(/^(\/\/\/?|\/\*+)\s?/, "").replace(/\*+\/$/, "").trim()
      );
    }
    prev = prev.previousNamedSibling;
  }

  return comments.length > 0 ? comments.join("\n") : undefined;
} // fn: extractLeadingDocComment

function findProjectRoot(startFile: string): string {
  let curr = path.dirname(startFile);
  while (curr !== path.dirname(curr)) {
    if (
      fs.existsSync(path.join(curr, ".git")) ||
      fs.existsSync(path.join(curr, "package.json")) ||
      fs.existsSync(path.join(curr, "Makefile"))
    ) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return path.dirname(startFile);
} // fn: findProjectRoot
