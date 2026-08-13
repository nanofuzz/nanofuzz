import { AbstractProgram } from "../AbstractProgram";
import {
  FunctionRef,
  ProgramImports,
  ProgramPath,
  IdentifierName,
  TypeRef,
  ArgOptions,
  ArgOptionOverride,
  ArgTag,
  ArgType,
  TypeAnnotationOptions,
  TypeAnnotationOptionDefaults,
  ProgramLanguage,
} from "../Types";
import { getErrorMessageOrJson } from "../../Util";
import * as ValueMapper from "../../mappers/ValueMapper";
import * as ProgramFactory from "../ProgramFactory";
import * as JSONN from "../../../Jsonn";
import * as Parser from "../../adapters/ParserAdapter";
import * as fs from "node:fs";
import * as path from "node:path";
import { PythonRunner } from "../../runners/PythonRunner";
import { ArgDef } from "../ArgDef";
import { isArgType } from "../Util";

export class PythonProgram extends AbstractProgram {
  public static readonly lang = "python";
  public static readonly extensions = Object.freeze([".py"]);
  protected _ast: Parser.Tree | undefined;

  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
    if (parent && PythonProgram.lang !== parent.lang) {
      throw new Error(
        `A "${PythonProgram.lang}" program cannot be a child of a "${parent.lang}" program.`
      );
    }
  }

  protected _parse(src: string): void {
    this._ast = Parser.parse("python", src) ?? undefined;
  }

  protected _findImports(): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    const ast = this._ast;

    const traverse = Parser.query(
      "python",
      `
[
  (import_statement) @import.stmt
  (import_from_statement) @import.stmt
]
`
    );
    const matches = traverse.matches(ast.rootNode);

    // Records a single import binding, mirroring the TypeScript backend's
    // `ProgramImport` field semantics:
    //   - `imported` is the concrete imported name, or "*" for a whole-module
    //     (namespace-style) binding whose members are resolved lazily.
    //   - `resolved` means the imported *name* is concrete (a named import),
    //     NOT whether the file exists on disk. Whole-module and wildcard
    //     bindings are `false` so `_resolveTypeRef` expands their members.
    // Whether the module was located on disk is tracked separately (`found`)
    // and only governs the `programs` map. Each candidate module reference is
    // tried in order; the first that maps to a real file wins.
    const addImport = (
      local: IdentifierName,
      imported: IdentifierName,
      resolved: boolean,
      ...moduleRefs: string[]
    ): void => {
      let result = this._resolveImportModule(moduleRefs[0]);
      for (let i = 1; i < moduleRefs.length && !result.found; i++) {
        result = this._resolveImportModule(moduleRefs[i]);
      }
      imports.identifiers[local] = {
        local,
        imported,
        programPath: result.programPath,
        resolved,
        default: false, // Python has no ES-style default import
      };
      // Only track modules we actually located on disk; unresolved
      // stdlib/third-party names are not local programs.
      if (result.found) {
        imports.programs[result.programPath] = "?";
      }
    };

    for (const match of matches) {
      const stmtNode = match.captures.find(
        (c) => c.name === "import.stmt"
      )?.node;
      if (stmtNode === undefined) {
        continue;
      }
      const nameNodes = stmtNode.childrenForFieldName("name");

      if (stmtNode.type === "import_statement") {
        // `import a.b.c` / `import a as b` / `import a, b`
        // Each binds a whole module namespace, analogous to a TypeScript
        // `import * as foo` — so `imported` is "*" and `resolved` is false.
        for (const nameNode of nameNodes) {
          if (nameNode.type === "aliased_import") {
            const original = nameNode.childForFieldName("name")?.text;
            const alias = nameNode.childForFieldName("alias")?.text;
            if (original === undefined || alias === undefined) {
              continue;
            }
            addImport(alias, "*", false, original);
          } else {
            // `dotted_name` (or a bare identifier)
            addImport(nameNode.text, "*", false, nameNode.text);
          }
        }
      } else {
        // import_from_statement: `from <module> import <names | *>`
        const moduleNode = stmtNode.childForFieldName("module_name");
        if (!moduleNode) {
          continue;
        }
        const moduleRef = moduleNode.text;

        // Build the dotted reference for a submodule `name` of `moduleRef`,
        // preserving relative-import dot levels (e.g. `.` + `d` => `.d`,
        // not `..d`).
        const submoduleRef = (name: string): string =>
          moduleRef.endsWith(".") ? moduleRef + name : `${moduleRef}.${name}`;

        // `from x import *` — whole-namespace, no concrete name (like a
        // TypeScript namespace import).
        if (stmtNode.namedChildren.some((c) => c.type === "wildcard_import")) {
          const result = this._resolveImportModule(moduleRef);
          imports.identifiers[`*:${moduleRef}`] = {
            local: "*",
            imported: "*",
            programPath: result.programPath,
            resolved: false,
            default: false,
          };
          // Only track modules we actually located on disk.
          if (result.found) {
            imports.programs[result.programPath] = "?";
          }
          continue;
        }

        // `from <moduleRef> import <name>`: `name` is EITHER a member defined
        // in `moduleRef` OR a submodule file (`moduleRef/name.py`). CPython
        // checks the package attribute FIRST and only imports the submodule if
        // the package does not export the name, so a member shadows a
        // same-named submodule. We therefore bind member-first:
        //   - when the package/module is located, point at it as a leaf named
        //     import (`resolved: true`); `_resolveTypeRef` falls back to the
        //     submodule only if the package turns out not to export the name;
        //   - when the package itself is not locatable (e.g. a namespace
        //     package with no `__init__.py`), bind the submodule directly as a
        //     namespace so member access (`name.Foo`) still expands.
        // This is the disambiguation a TypeScript named import never needs.
        const addFromImport = (local: string, name: string): void => {
          const asMember = this._resolveImportModule(moduleRef);
          if (asMember.found) {
            imports.identifiers[local] = {
              local,
              imported: name,
              programPath: asMember.programPath,
              resolved: true,
              default: false,
            };
            imports.programs[asMember.programPath] = "?";
          } else {
            const asSubmodule = this._resolveImportModule(submoduleRef(name));
            imports.identifiers[local] = {
              local,
              imported: asSubmodule.found ? "*" : name,
              programPath: asSubmodule.programPath,
              resolved: !asSubmodule.found,
              default: false,
            };
            if (asSubmodule.found) {
              imports.programs[asSubmodule.programPath] = "?";
            }
          }
        };

        for (const nameNode of nameNodes) {
          if (nameNode.type === "aliased_import") {
            const original = nameNode.childForFieldName("name")?.text;
            const alias = nameNode.childForFieldName("alias")?.text;
            if (original === undefined || alias === undefined) {
              continue;
            }
            addFromImport(alias, original);
          } else {
            addFromImport(nameNode.text, nameNode.text);
          }
        }
      }
    }

    return imports;
  }

  /**
   * Resolves a Python module reference to an on-disk `.py` file path.
   * Relative imports resolve against the current module's directory.
   * Absolute imports are tried, in order, against: the root program's
   * directory (CPython's `sys.path[0]` when the root is run as a script),
   * then each entry of the interpreter's `sys.path` (stdlib, site-packages)
   * so installed third-party packages resolve too. Ancestor directories of
   * the root are deliberately NOT searched: a module reachable only by
   * walking up from the entry script's directory would not be importable at
   * runtime. Unlike the TypeScript resolver there is no throwing fallback —
   * references that resolve nowhere (e.g. compiled/namespace packages) are
   * returned as-is with `found: false` rather than breaking analysis.
   *
   * @param moduleRef A module reference: an absolute dotted name (`a.b.c`) or
   *   a relative import (`.pkg`, `..pkg.sub`, or a lone `.`)
   * @returns The resolved file path (or the original reference when not found)
   *   and whether a real file was located on disk
   */
  protected _resolveImportModule(moduleRef: string): {
    programPath: ProgramPath;
    found: boolean;
  } {
    // Turn a dotted subpath (e.g. "a.b.c") into candidate files under `base`.
    const probe = (base: string, dotted: string): string | undefined => {
      const sub = dotted.split(".").filter((p) => p.length > 0);
      const joined = path.join(base, ...sub);
      const candidates =
        sub.length > 0
          ? [joined + ".py", path.join(joined, "__init__.py")]
          : [path.join(base, "__init__.py")];
      return candidates.find((c) => fs.existsSync(c));
    };

    const notFound = { programPath: moduleRef, found: false };
    const fromDir = path.dirname(this._filename);

    if (moduleRef.startsWith(".")) {
      // Relative import: leading dots select the level (1 = current package).
      const dots = moduleRef.length - moduleRef.replace(/^\.+/, "").length;
      const dotted = moduleRef.slice(dots);
      let base = fromDir;
      for (let i = 0; i < dots - 1; i++) {
        base = path.dirname(base);
      }
      const found = probe(base, dotted);
      return found ? { programPath: found, found: true } : notFound;
    }

    // Absolute import: project source first, then the interpreter's own
    // search path for external (stdlib/third-party) packages.
    const rootDir = path.dirname(this._root.filename);
    const searchDirs = [rootDir, ...PythonRunner.envFor(this._filename).paths];
    for (const dir of searchDirs) {
      const found = probe(dir, moduleRef);
      if (found) {
        return { programPath: found, found: true };
      }
    }
    return notFound;
  }

  /**
   * Determines whether an AST node is block scoped
   * Note: Requires that nodes have the parent property set
   *
   * @param `node` The node to check
   * @returns `true` if the node is block scoped, `false` otherwise
   */
  protected static isBlockScoped(node: Parser.SyntaxNode): boolean {
    let thisNode = node;
    while (thisNode.parent) {
      if (thisNode.parent.type === "block") {
        return true; // block scoped
      } else {
        thisNode = thisNode.parent; // move up the tree
      }
    }
    return false; // at root; block not encountered
  } // fn: isBlockScoped()

  protected _findTypes(): Record<IdentifierName, TypeRef> {
    const filename = this._filename;
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    const ast = this._ast;
    // List of nodes
    const types: Record<string, TypeRef> = {};

    const typeQuery = Parser.query(
      "python",
      `
(type_alias_statement
  left: (type (identifier)) @type.name
  right: (type) @type.value) @type.def
`
    );
    const typeMatches = typeQuery.matches(ast.rootNode);
    for (const match of typeMatches) {
      const nameNode = match.captures.find((c) => c.name === "type.name");
      const valueNode = match.captures.find((c) => c.name === "type.value");
      if (!nameNode || !valueNode) {
        continue;
      }
      if (
        !PythonProgram.isBlockScoped(
          match.captures.find((c) => c.name === "type.def")!.node
        )
      ) {
        const name = nameNode.node.text;
        if (name in types) {
          throw new Error(
            `Duplicate type alias '${name}' found in module '${filename}'`
          );
        }
        types[name] = this._getTypeRefFromAstNode(valueNode.node);
      }
    }

    // TypedDict has fixed, named fields, so it is represented by the
    // existing object type rather than a dynamic mapping type. Resolve the
    // standard spelling, qualified spellings, and an imported alias; do not
    // treat ordinary `dict[...]` annotations as objects.
    const isTypedDictBase = (node: Parser.Node): boolean => {
      if (
        [
          "TypedDict",
          "typing.TypedDict",
          "typing_extensions.TypedDict",
        ].includes(node.text)
      ) {
        return true;
      }
      return this._imports.identifiers[node.text]?.imported === "TypedDict";
    };

    // 1. Class-based TypedDict: class Foo(TypedDict): ...
    for (const classNode of ast.rootNode.namedChildren.filter(
      (node) => node.type === "class_definition"
    )) {
      const superclasses = classNode.childForFieldName("superclasses");
      const inheritedFields =
        superclasses?.namedChildren.flatMap((node) => {
          const base = types[node.text];
          return base?.type?.type === ArgTag.OBJECT ? base.type.children : [];
        }) ?? [];
      const isTypedDict =
        superclasses?.namedChildren.some(isTypedDictBase) ||
        inheritedFields.length > 0;
      if (!isTypedDict) continue;

      const nameNode = classNode.childForFieldName("name");
      const bodyNode = classNode.childForFieldName("body");
      if (!nameNode || !bodyNode) continue;
      if (nameNode.text in types) {
        throw new Error(
          `Duplicate type alias '${nameNode.text}' found in module '${filename}'`
        );
      }

      const children: TypeRef[] = [...inheritedFields];
      for (const statement of bodyNode.namedChildren) {
        const assignment = statement.namedChildren.find(
          (node) => node.type === "assignment"
        );
        const fieldName = assignment?.childForFieldName("left");
        const fieldType = assignment?.childForFieldName("type");
        if (
          !assignment ||
          !fieldName ||
          !fieldType ||
          fieldName.type !== "identifier"
        ) {
          continue;
        }
        const field = this._getTypeRefFromAstNode(fieldType);
        field.name = fieldName.text;
        children.push(field);
      }

      types[nameNode.text] = {
        module: this._filename,
        dims: 0,
        optional: false,
        isExported: true,
        type: { type: ArgTag.OBJECT, dims: 0, children },
      };
    }

    // 2. Functional-style TypedDict: Foo = TypedDict('Foo', {'in': int, 'out': str})
    for (const expressionNode of ast.rootNode.namedChildren.filter(
      (node) => node.type === "expression_statement"
    )) {
      for (const assignmentNode of expressionNode.children.filter(
        (node) => node.type === "assignment"
      )) {
        const left = assignmentNode.childForFieldName("left");
        const right = assignmentNode.childForFieldName("right");
        if (
          !left ||
          !right ||
          left.type !== "identifier" ||
          right.type !== "call"
        ) {
          continue;
        }

        const funcNode = right.childForFieldName("function");
        if (!funcNode || !isTypedDictBase(funcNode)) {
          continue;
        }

        const argumentsNode = right.childForFieldName("arguments");
        if (!argumentsNode) continue;

        // The second argument of TypedDict('Name', {fields}) should be a dictionary
        const dictArg = argumentsNode.namedChildren.find(
          (node) => node.type === "dictionary"
        );
        if (!dictArg) continue;

        if (left.text in types) {
          throw new Error(
            `Duplicate type alias '${left.text}' found in module '${filename}'`
          );
        }

        const children: TypeRef[] = [];
        for (const pair of dictArg.namedChildren.filter(
          (node) => node.type === "pair"
        )) {
          const keyNode = pair.childForFieldName("key");
          const valueNode = pair.childForFieldName("value");
          if (!keyNode || !valueNode) continue;

          // Extract field name (handles both quoted strings and identifiers as keys)
          let fieldName = keyNode.text;
          if (keyNode.type === "string") {
            const content = keyNode.namedChildren.find(
              (c) => c.type === "string_content"
            );
            fieldName = content?.text ?? fieldName.replace(/^['"]|['"]$/g, "");
          }

          const field = this._getTypeRefFromAstNode(valueNode);
          field.name = fieldName;
          children.push(field);
        }

        types[left.text] = {
          module: this._filename,
          dims: 0,
          optional: false,
          isExported: true,
          type: { type: ArgTag.OBJECT, dims: 0, children },
        };
      }
    }
    return types;
  }

  /**
   * Returns the literal value from a `Literal[...]` generic_type node.
   *
   * Mirrors the TypeScript `_getLiteralValueFromNode`, but tree-sitter is a
   * concrete syntax tree with no computed `.value`, so we navigate to the
   * value node (`generic_type -> type_parameter -> type -> <value>`) and
   * interpret its raw text ourselves.
   *
   * @param node The `Literal[...]` generic_type node
   * @returns The literal value as an ArgType
   */
  protected _getLiteralValueFromNode(node: Parser.SyntaxNode): ArgType {
    // generic_type -> type_parameter -> type -> <value>
    const argsNode = node.namedChildren.find(
      (c) => c.type === "type_parameter"
    );
    let valueNode = argsNode?.namedChildren[0];
    if (valueNode?.type === "type") {
      valueNode = valueNode.firstNamedChild ?? undefined;
    }
    if (!valueNode) {
      throw new Error(`Missing literal value in '${node.text}'`);
    }

    switch (valueNode.type) {
      case "integer":
      case "float":
        // Number() handles hex/oct/bin prefixes (0x, 0o, 0b); strip Python's
        // digit separators (1_000), which Number() does not accept.
        return Number(valueNode.text.replace(/_/g, ""));
      case "true":
        return true;
      case "false":
        return false;
      case "string": {
        // The unquoted text lives in `string_content`; an empty string
        // (`Literal[""]`) has no such child.
        const content = valueNode.namedChildren.find(
          (c) => c.type === "string_content"
        );
        return content?.text ?? "";
      }
      default:
        throw new Error(
          `Unsupported literal value '${valueNode.type}' in type annotation: ${node.text}`
        );
    }
  } // fn: _getLiteralValueFromNode()

  /**
   * Returns the type tag, number of dimensions, and type reference name
   * for the given AST type node.
   *
   * @param node The AST type node
   * @param options ArgOptions
   * @returns [type tag, dimensions, type reference name, literal value, overrides]
   */
  protected _getTypeFromAstNode(
    node: Parser.SyntaxNode,
    options: ArgOptions
  ): [ArgTag, number, string?, ArgType?, ArgOptionOverride?] {
    switch (node.type) {
      case "type":
        if (node.firstChild) {
          return this._getTypeFromAstNode(node.firstChild, options);
        } else {
          throw new Error(`Wrong node of type "type" in _getTypeFromAstNode`);
        }
      case "identifier":
        switch (node.text) {
          case "int":
            // Python int and float share NanoFuzz's NUMBER tag. Keep the
            // integer constraint as an option so input generation can still
            // distinguish the two without another ArgTag.
            return [
              ArgTag.NUMBER,
              0,
              undefined,
              undefined,
              { numInteger: true },
            ];
          case "float":
            return [
              ArgTag.NUMBER,
              0,
              undefined,
              undefined,
              { numInteger: false },
            ];
          case "complex":
            return [ArgTag.NUMBER, 0];
          case "str":
            return [ArgTag.STRING, 0];
          case "bool":
            return [ArgTag.BOOLEAN, 0];
          default:
            return [ArgTag.UNRESOLVED, 0, node.text];
        }
      case "none":
        return [ArgTag.LITERAL, 0, undefined, undefined];
      case "generic_type":
      case "subscript": {
        const { base, args } = this._getGenericParts(node);
        switch (base) {
          case "list":
          case "List":
          case "Sequence":
          case "MutableSequence":
          case "Iterable":
          case "Collection":
          case "set":
          case "Set":
          case "frozenset":
          case "FrozenSet": {
            // sets use JSON-array inputs
            const arg = args[0];
            if (!arg) throw new Error(`Missing element type in '${node.text}'`);

            const [type, dims, typeName, literalValue, typeOptions] =
              this._getTypeFromAstNode(arg, options);
            return [type, dims + 1, typeName, literalValue, typeOptions];
          }

          case "tuple":
          case "Tuple":
            return [ArgTag.TUPLE, 0];
          case "Union":
            return [ArgTag.UNION, 0];
          case "Optional":
            return [ArgTag.UNION, 0];
          case "Literal":
            return [
              ArgTag.LITERAL,
              0,
              undefined,
              this._getLiteralValueFromNode(node),
            ];
          default:
            return [ArgTag.UNRESOLVED, 0, base];
        }
      }
      case "union_type":
      case "binary_operator":
        return [ArgTag.UNION, 0];
      case "member_type":
      case "attribute":
        return [ArgTag.UNRESOLVED, 0, node.text];
      default:
        throw new Error(
          "Unsupported type annotation: " + JSONN.stringify(node.toString())
        );
    }
  } // fn: _getTypeFromAstNode()

  /**
   * Extracts the base name and arguments from built-in and qualified generic
   * annotations. Tree-sitter uses different node shapes for those spellings,
   * so keeping the normalization here ensures container cases behave
   * identically.
   */
  protected _getGenericParts(node: Parser.SyntaxNode): {
    base: string;
    args: Parser.SyntaxNode[];
  } {
    if (node.type === "generic_type") {
      const base = node.namedChildren.find(
        (child) => child.type === "identifier"
      );
      const parameters = node.namedChildren.find(
        (child) => child.type === "type_parameter"
      );
      if (!base || !parameters)
        throw new Error(`Malformed generic type: ${node.text}`);
      return { base: base.text, args: parameters.namedChildren };
    }

    const base = node.childForFieldName("value");
    const args = node.childrenForFieldName("subscript");
    if (!base || !args.length)
      throw new Error(`Malformed subscript type: ${node.text}`);
    return { base: base.text.split(".").at(-1) ?? base.text, args };
  }

  /**
   * Returns the child TypeRef objects for a composite type node (union/tuple).
   *
   * Mirrors the TypeScript `_getChildrenFromNode`; this is the only place that
   * recurses back into `_getTypeRefFromAstNode` to build a TypeRef per child.
   * Leaves have no children; array-likes peel to their element (like the TS
   * `TSArrayType` case) so dims stay on the parent.
   *
   * @param node The AST type node
   * @returns An array of child TypeRef objects
   */
  protected _getChildrenFromNode(node: Parser.SyntaxNode): TypeRef[] {
    switch (node.type) {
      // Unwrap the `type` wrapper and recurse.
      case "type": {
        const child = node.firstNamedChild;
        if (!child) {
          throw new Error(`Empty 'type' node in _getChildrenFromNode`);
        }
        return this._getChildrenFromNode(child);
      }

      // Leaves have no children.
      case "identifier":
      case "none":
      case "string":
      case "member_type":
      case "attribute":
        return [];

      // PEP 604 `A | B` parses to `binary_operator`; `union_type` is handled
      // defensively. Each operand is a child; drop `None` arms, whose
      // nullability is carried by `TypeRef.optional` instead.
      case "binary_operator":
      case "union_type":
        return node.namedChildren
          .filter(
            (arm) =>
              (arm.type === "type" ? arm.firstNamedChild : arm)?.type !== "none"
          )
          .map((arm) => this._getTypeRefFromAstNode(arm));

      case "generic_type":
      case "subscript": {
        const { base, args } = this._getGenericParts(node);
        switch (base) {
          // Array-likes: peel to the element and recurse (mirror TSArrayType),
          // so `list[A | B]` yields the union's children with dims on the
          // parent.
          case "list":
          case "List":
          case "Sequence":
          case "MutableSequence":
          case "Iterable":
          case "Collection":
          case "set":
          case "Set":
          case "frozenset":
          case "FrozenSet":
            // Sets are modeled as arrays because fuzzer inputs are JSON.
            // The Python runner can reconstruct a set at its boundary later.
            return this._getChildrenFromNode(args[0]);
          // Composites: each argument (`type` node) is a child.
          case "Union":
          case "tuple":
          case "Tuple":
          case "Optional":
            return args.map((c) => this._getTypeRefFromAstNode(c));
          // Literal / references / unknown generics have no children here.
          default:
            return [];
        }
      }

      default:
        throw new Error(
          "Unsupported type annotation: " + JSONN.stringify(node.toString())
        );
    }
  } // fn: _getChildrenFromNode()

  protected _getTypeRefFromAstNode(node: Parser.SyntaxNode): TypeRef {
    // Add the type alias to the running list
    const thisType: TypeRef = {
      module: this._filename,
      dims: 0, // override later if needed
      optional: false, // override later if needed
      isExported: true,
    };

    let typeNode = node;
    switch (node.type) {
      case "identifier": {
        // A bare identifier is either an unannotated parameter (no type — a
        // hard error, as in the TS backend) or a type reference used as a
        // union arm (`A | B`, whose operands are bare identifiers). Only a
        // parameter list carries no type; anything else is a type reference.
        const parentType = node.parent?.type;
        if (parentType === "parameters" || parentType === "lambda_parameters") {
          throw new Error(`Missing type annotation: ${node.toString()}`);
        }
        break; // type-position identifier: classify below (typeNode = node)
      }
      case "type": {
        break;
      }
      case "typed_parameter":
      case "typed_default_parameter": {
        // `name` is the parameter (variable) name — the `identifier` child —
        // matching the TS backend, which sets `name` to the entity name, not
        // the type. The type itself comes from the `type` field.
        const pattern = node.namedChildren.find(
          (c) =>
            c.type === "list_splat_pattern" ||
            c.type === "dictionary_splat_pattern"
        );
        thisType.name =
          node.namedChildren.find((c) => c.type === "identifier")?.text ??
          pattern?.firstNamedChild?.text;
        typeNode = node.childForFieldName("type") ?? node;
        break;
      }
      default:
        // Any other type-expression node. Union arms reach here as
        // `generic_type`, `binary_operator`, `none`, `member_type`, `string`,
        // etc.; classify directly (typeNode = node). The classifier throws on
        // genuinely unsupported nodes.
        break;
    }

    // python has no ? to mark parameters as optional. Its optional type is in fact a union between the type and None, so we don't need to handle optional here. optional stays false

    // Get the node's type and dimensions
    const [type, dims, typeRefNode, literalValue, typeOptions] =
      this._getTypeFromAstNode(typeNode, this._options);

    // Create the TypeRef data structure
    switch (type) {
      case ArgTag.STRING:
      case ArgTag.BOOLEAN:
      case ArgTag.NUMBER: {
        thisType.type = {
          dims: dims,
          type: type,
          children: [],
          ...(typeOptions ? { options: typeOptions } : {}),
          resolved: true,
        };
        break;
      }
      case ArgTag.LITERAL: {
        thisType.type = {
          dims: dims,
          type: type,
          children: [],
          value: literalValue,
          resolved: true,
        };
        break;
      }
      case ArgTag.UNION:
      case ArgTag.TUPLE: {
        thisType.type = {
          dims: dims,
          type: type,
          children: this._getChildrenFromNode(typeNode),
        };
        break;
      }
      case ArgTag.UNRESOLVED: {
        thisType.dims = dims;
        thisType.typeRefName = typeRefNode; // Unresolved type reference
        break;
      }
      case ArgTag.OBJECT:
        throw new Error(`Unexpected object type in Python annotation`);
    }
    return thisType;
  }

  protected _getLambdaFromNode(
    captures: Parser.QueryCapture[]
  ): FunctionRef | undefined {
    const nameNode = captures.find((c) => c.name === "function.name");
    const defNode = captures.find((c) => c.name === "function.def");
    if (!nameNode || !defNode) {
      return undefined;
    }
    const argsNode = defNode.node.namedChildren.find(
      (c) => c.type === "lambda_parameters" || c.type === "parameters"
    );
    const bodyNode = defNode.node.lastNamedChild;
    if (!bodyNode) {
      return undefined;
    }

    // A lambda is only `void` if its single expression body is 'none' (e.g. lambda: None)
    const isVoid = bodyNode.type === "none";

    return {
      module: this._filename,
      name: nameNode.node.text,
      src: defNode.node.text,
      lang: PythonProgram.lang,
      startOffset: defNode.node.startIndex,
      endOffset: defNode.node.endIndex,
      isExported: true,
      isVoid,
      args: argsNode
        ? argsNode.namedChildren
            .filter(
              (arg) =>
                arg.type === "identifier" ||
                arg.type === "typed_parameter" ||
                arg.type === "typed_default_parameter"
            )
            .map((arg) => this._getTypeRefFromAstNode(arg))
        : [], // e.g., `lambda: None`
      returnType: undefined,
      cmt: undefined,
    };
  }

  // standard functions
  protected _getFunctionFromNode(
    captures: Parser.QueryCapture[]
  ): FunctionRef | undefined {
    let returnType = undefined;
    let isVoid = false;
    const nameNode = captures.find((c) => c.name === "function.name");
    const typeNode = captures.find((c) => c.name === "function.return_type");
    const defNode = captures.find((c) => c.name === "function.def");
    const argsNode = captures.find((c) => c.name === "function.params");
    if (!nameNode || !defNode) {
      return undefined;
    }

    // Extract for Hypothesis @given(...) first
    const hypothesisArgMap: Record<string, TypeRef> = {};
    const currentNode: Parser.Node | null = defNode.node.parent;
    if (currentNode?.type === "decorated_definition") {
      for (const child of currentNode.namedChildren) {
        if (child.type === "decorator") {
          // Check if decorator calls 'given'
          const callNode = child.namedChildren.find((n) => n.type === "call");
          const funcNode = callNode?.childForFieldName("function");
          const decoName = funcNode?.text.split(".").pop();
          if (decoName === "given") {
            const argsNode = callNode?.childForFieldName("arguments");
            if (argsNode) {
              for (const argChild of argsNode.namedChildren) {
                if (argChild.type === "keyword_argument") {
                  const paramName = argChild.childForFieldName("name")?.text;
                  const strategyValue = argChild.childForFieldName("value");
                  if (
                    paramName &&
                    strategyValue &&
                    strategyValue.type === "call"
                  ) {
                    const hypothesisTypeRef =
                      this._getTypeRefFromStrategy(strategyValue);
                    if (hypothesisTypeRef !== undefined) {
                      hypothesisArgMap[paramName] = hypothesisTypeRef;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } // if: has hypothesis @givens

    // Extract native argument type refs
    const parameterNodes =
      argsNode?.node.namedChildren.filter(
        (arg) =>
          arg.type === "identifier" ||
          arg.type === "typed_parameter" ||
          arg.type === "typed_default_parameter"
      ) ?? [];

    // Hypothesis strategies have precedence over native type annotations
    const finalArgs: TypeRef[] = [];
    for (const paramNode of parameterNodes) {
      // Get parameter name
      let paramName: string | undefined;
      if (paramNode.type === "identifier") {
        paramName = paramNode.text;
      } else {
        const pattern = paramNode.namedChildren.find(
          (c) =>
            c.type === "list_splat_pattern" ||
            c.type === "dictionary_splat_pattern"
        );
        paramName =
          paramNode.namedChildren.find((c) => c.type === "identifier")?.text ??
          pattern?.firstNamedChild?.text;
      }

      // If a hypothesis strategy exists for this parameter, use it.
      // Otherwise, parse the native type annotation
      if (paramName && paramName in hypothesisArgMap) {
        const hypType = hypothesisArgMap[paramName];
        hypType.name = paramName;
        finalArgs.push(hypType);
      } else {
        finalArgs.push(this._getTypeRefFromAstNode(paramNode));
      }
    } // for: parameter AST node

    // Docstring extraction logic...
    const docstringNode = defNode.node
      .childForFieldName("body")
      ?.namedChild(0)
      ?.namedChild(0);
    const stringNodes =
      docstringNode?.type === "concatenated_string"
        ? docstringNode.namedChildren
        : docstringNode
          ? [docstringNode]
          : [];
    const cmt =
      stringNodes.length > 0 &&
      stringNodes.every(
        (node) => node.type === "string" && !/^[^'"]*[bf]/i.test(node.text)
      )
        ? docstringNode?.text
        : undefined;

    // Determine if this a `void` function
    const bodyNode = defNode.node.childForFieldName("body");
    const bodyIsVoid =
      !!bodyNode && PythonProgram._isFunctionBodyVoid(bodyNode);
    try {
      if (typeNode) {
        isVoid = typeNode.node.namedChild(0)?.type === "none";
        if (!isVoid) {
          returnType = this._getTypeRefFromAstNode(typeNode.node);
        }
      } else {
        isVoid = bodyIsVoid;
      }
    } catch {
      if (!isVoid) {
        // !!! console.debug('Unsupported return type for function "' + name + '".');
        // what can i say
      }
    }

    return {
      module: this._filename,
      name: nameNode.node.text,
      src: defNode.node.text,
      lang: PythonProgram.lang,
      startOffset: defNode.node.startIndex,
      endOffset: defNode.node.endIndex,
      isExported: true,
      isVoid,
      args: finalArgs,
      returnType,
      cmt,
    };
  } // fn: getFunctionFromNode

  /**
   * Parses a Hypothesis strategy (e.g., st.text(...), st.integer(...)) info a
   * NaNofuzz TypeRef while also handling constraints and unsupported features
   *
   * Hypothesis strategy reference:
   * https://hypothesis.readthedocs.io/en/latest/reference/strategies.html
   *
   * We don't support all strategies. Just the ones that we can map to a
   * NaNofuzz ArgDef. For example, we don't support `builds` or `composite`.
   *
   * @param `node` AST Node
   * @returns TypeRef of AST node
   */
  protected _getTypeRefFromStrategy(node: Parser.Node): TypeRef | undefined {
    const thisType: TypeRef = {
      module: this._filename,
      dims: 0,
      optional: false,
      isExported: false,
    };

    // Helper to extract keyword argument values from a call expression
    const getKwdArg = (
      callNode: Parser.Node,
      name: string,
      pos: number
    ): Parser.Node | undefined => {
      const argsNode = callNode.childForFieldName("arguments");
      if (!argsNode) return undefined;
      let currentPos = 0;
      for (const child of argsNode.namedChildren) {
        if (child.type === "keyword_argument") {
          // Find by name
          const kwdName = child.childForFieldName("name")?.text;
          if (kwdName === name) {
            return child.childForFieldName("value") ?? undefined;
          }
        } else {
          // Find by position
          if (currentPos === pos) {
            return child;
          }
          currentPos++;
        }
      }
      return undefined;
    };

    // Helper to parse primitive values (int, float, bool, string) from AST nodes
    const parseLiteral = (valNode: Parser.Node | undefined): unknown => {
      if (!valNode) return undefined;
      if (valNode.type === "integer" || valNode.type === "float") {
        return Number(valNode.text.replace(/_/g, ""));
      }
      if (valNode.type === "true") return true;
      if (valNode.type === "false") return false;
      if (valNode.type === "string") {
        const content = valNode.namedChildren.find(
          (c) => c.type === "string_content"
        );
        return content?.text ?? valNode.text.replace(/^['"]|['"]$/g, "");
      }
      return undefined;
    };

    // Determine strategy function name (e.g., text, integers, lists, sampled_from)
    const functionNode = node.childForFieldName("function");
    const funcName = functionNode?.text.split(".").pop() ?? "";

    switch (funcName) {
      case "text": {
        const alphabet = parseLiteral(getKwdArg(node, "alphabet", 0));
        const minSize = parseLiteral(getKwdArg(node, "min_size", 1));
        const maxSize = parseLiteral(getKwdArg(node, "max_size", 2));

        const options: ArgOptionOverride = {};
        if (minSize !== undefined || maxSize !== undefined) {
          const dftInterval = ArgDef.getDefaultIntervals(
            ArgTag.STRING,
            this._options
          );
          options.strLength = {
            min: Number(minSize ?? dftInterval[0].min),
            max: Number(maxSize ?? dftInterval[0].max),
          };
        }
        if (alphabet !== undefined) options.strCharset = String(alphabet);

        thisType.type = {
          type: ArgTag.STRING,
          dims: 0,
          children: [],
          options,
          resolved: true,
        };
        break;
      }

      case "integers": {
        const minVal = parseLiteral(getKwdArg(node, "min_value", 0));
        const maxVal = parseLiteral(getKwdArg(node, "max_value", 1));

        const options: ArgOptionOverride = { numInteger: true };
        if (minVal !== undefined || maxVal !== undefined) {
          const dftInterval = ArgDef.getDefaultIntervals(
            ArgTag.NUMBER,
            this._options
          );
          options.numIntervals = [
            {
              min: Number(minVal ?? dftInterval[0].min),
              max: Number(maxVal ?? dftInterval[0].max),
            },
          ];
        }

        thisType.type = {
          type: ArgTag.NUMBER,
          dims: 0,
          children: [],
          options,
          resolved: true,
        };
        break;
      }

      case "floats": {
        // Note: we ignore "allow_nan" and "allow_infinity" because\
        //       we don't presently generate those values
        ["allow_subnormal", "width", "exclude_min", "exclude_max"].forEach(
          (kwd) => {
            if (getKwdArg(node, kwd, -1)) {
              console.warn(`The '${kwd}' property is not yet supported.`);
            }
          }
        );

        const minVal = parseLiteral(getKwdArg(node, "min_value", 0));
        const maxVal = parseLiteral(getKwdArg(node, "max_value", 1));

        const options: ArgOptionOverride = { numInteger: false };
        if (minVal !== undefined || maxVal !== undefined) {
          const dftInterval = ArgDef.getDefaultIntervals(
            ArgTag.NUMBER,
            this._options
          );
          options.numIntervals = [
            {
              min: Number(minVal ?? dftInterval[0].min),
              max: Number(maxVal ?? dftInterval[0].max),
            },
          ];
        }

        thisType.type = {
          type: ArgTag.NUMBER,
          dims: 0,
          children: [],
          options,
          resolved: true,
        };
        break;
      }

      case "booleans": {
        thisType.type = {
          type: ArgTag.BOOLEAN,
          dims: 0,
          children: [],
          resolved: true,
        };
        break;
      }

      case "none": {
        thisType.type = {
          type: ArgTag.LITERAL,
          dims: 0,
          children: [],
          resolved: true,
          value: undefined,
        };
        break;
      }

      case "just": {
        const argsNode = node.childForFieldName("arguments");
        const lit = parseLiteral(argsNode?.namedChildren[0]);
        if (isArgType(lit)) {
          thisType.type = {
            type: ArgTag.LITERAL,
            dims: 0,
            children: [],
            resolved: true,
            value: lit,
          };
        } else {
          console.warn(
            `Unsupported literal in 'sampled_from': ${JSONN.stringify(lit)}.`
          );
        }
        break;
      }

      case "sets":
      case "lists": {
        ["unique", "unique_by"].forEach((kwd) => {
          if (getKwdArg(node, kwd, -1)) {
            console.warn(`The '${kwd}' property is not yet supported.`);
          }
        });

        const elementsArg = getKwdArg(node, "elements", 0);
        let innerTypeRef: TypeRef | undefined;
        if (elementsArg && elementsArg.type === "call") {
          innerTypeRef = this._getTypeRefFromStrategy(elementsArg);
          if (innerTypeRef === undefined) {
            return undefined;
          }
        } else {
          // Fallback if elements is a type class like int, str, etc.
          innerTypeRef = {
            module: this._filename,
            dims: 0,
            optional: false,
            isExported: false,
            type: {
              type: ArgTag.UNRESOLVED,
              dims: 0,
              children: [],
              resolved: false,
            },
            typeRefName: elementsArg?.text ?? "Any",
          };
        }

        const minSize = parseLiteral(getKwdArg(node, "min_size", 1));
        const maxSize = parseLiteral(getKwdArg(node, "max_size", 2));
        const dftInterval = ArgDef.getDefaultOptions().dftDimLength;

        // Nested array types increase dims of child spec
        const innerResolvedType = innerTypeRef.type ?? {
          type: ArgTag.UNRESOLVED,
          dims: 0,
          children: [],
          resolved: false,
          options: {},
        };
        if (innerResolvedType.options === undefined) {
          innerResolvedType.options = {};
        }
        if (innerResolvedType.options.dimLength === undefined) {
          innerResolvedType.options.dimLength = [];
        }
        innerResolvedType.options.dimLength.push({
          min: Number(minSize ?? dftInterval.min),
          max: Number(maxSize ?? dftInterval.max),
        });

        thisType.type = {
          type: innerResolvedType.type,
          dims: innerResolvedType.dims + 1,
          children: innerResolvedType.children,
          options: innerResolvedType.options,
          resolved: true,
        };
        break;
      }

      case "tuples": {
        const argsNode = node.childForFieldName("arguments");
        const children: TypeRef[] = [];

        if (argsNode) {
          for (const argNode of argsNode.namedChildren) {
            // Check if the argument is another hypothesis strategy call
            const childTypeRef = this._getTypeRefFromStrategy(argNode);
            if (childTypeRef && argNode.type === "call") {
              children.push(childTypeRef);
            } else {
              return undefined;
            }
          }
        }

        thisType.type = {
          type: ArgTag.TUPLE,
          dims: 0,
          children,
          resolved: true,
        };
        break;
      }

      case "sampled_from": {
        const argsNode = node.childForFieldName("arguments");
        const listArg = argsNode?.namedChildren[0];
        const literalValues: ArgType[] = [];

        if (listArg && (listArg.type === "list" || listArg.type === "tuple")) {
          for (const item of listArg.namedChildren) {
            const lit = parseLiteral(item);
            if (isArgType(lit)) {
              literalValues.push(lit);
            } else {
              console.warn(
                `Unsupported literal in 'sampled_from': ${JSONN.stringify(lit)}.`
              );
            }
          }
        }

        // Represent sampled_from as a UNION of LITERALs
        thisType.type = {
          type: ArgTag.UNION,
          dims: 0,
          children: literalValues.map((val) => ({
            module: this._filename,
            dims: 0,
            optional: false,
            isExported: false,
            type: {
              type: ArgTag.LITERAL,
              dims: 0,
              children: [],
              value: val,
              resolved: true,
            },
          })),
          resolved: true,
        };
        break;
      }

      case "fixed_dictionaries": {
        const argsNode = node.childForFieldName("arguments");
        if (!argsNode) break;

        const children: TypeRef[] = [];

        // Helper to parse a dictionary AST node into TypeRef children
        const parseDictArg = (dictArg: Parser.Node, isOptional: boolean) => {
          for (const pair of dictArg.namedChildren.filter(
            (n) => n.type === "pair"
          )) {
            const keyNode = pair.childForFieldName("key");
            const valueNode = pair.childForFieldName("value");
            if (!keyNode || !valueNode) continue;

            // Extract field name (handles quoted strings or identifiers as keys)
            let fieldName = keyNode.text;
            if (keyNode.type === "string") {
              const content = keyNode.namedChildren.find(
                (c) => c.type === "string_content"
              );
              fieldName =
                content?.text ?? fieldName.replace(/^['"]|['"]$/g, "");
            }

            let fieldTypeRef: TypeRef | undefined =
              this._getTypeRefFromStrategy(valueNode);
            if (!(fieldTypeRef && valueNode.type === "call")) {
              fieldTypeRef = {
                module: this._filename,
                dims: 0,
                optional: false,
                isExported: false,
                type: {
                  type: ArgTag.UNRESOLVED,
                  dims: 0,
                  children: [],
                  resolved: false,
                },
                typeRefName: valueNode.text,
              };
            }

            fieldTypeRef.name = fieldName;
            fieldTypeRef.optional = isOptional;
            children.push(fieldTypeRef);
          }
        }; // fn: parseDictArg

        // Required mappings
        const positionalDict = argsNode.namedChildren.find(
          (n) => n.type === "dictionary"
        );
        const keywordMapping = getKwdArg(node, "mapping", 0);
        const mainDict =
          keywordMapping && keywordMapping.type === "dictionary"
            ? keywordMapping
            : positionalDict;
        if (mainDict) {
          parseDictArg(mainDict, false);
        }

        // Optional mappings
        const optionalDict = getKwdArg(node, "optional", -1);
        if (optionalDict && optionalDict.type === "dictionary") {
          parseDictArg(optionalDict, true);
        }

        thisType.type = {
          type: ArgTag.OBJECT,
          dims: 0,
          children,
          resolved: true,
        };
        break;
      }

      case "one_of": {
        const argsNode = node.childForFieldName("arguments");
        const children: TypeRef[] = [];

        if (argsNode) {
          for (const argNode of argsNode.namedChildren) {
            const child = this._getTypeRefFromStrategy(argNode);
            if (child && argNode.type === "call") {
              children.push(child);
            } else {
              return undefined;
            }
          }
        }

        thisType.type = {
          type: ArgTag.UNION,
          dims: 0,
          children,
          resolved: true,
        };
        break;
      }

      default:
        console.warn(
          `Unsupported or unrecognized Hypothesis strategy: '${funcName}'.`
        );
        return undefined;
    }

    return thisType;
  } // fn: getTpeRefFromHypothesisStrategy

  protected _findFunctions(): typeof this._functions {
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    // const ast = this._ast;
    const supported: AbstractProgram["_functions"]["supported"] = {};
    const unsupported: AbstractProgram["_functions"]["unsupported"] = {};

    // Traverse the AST to find function definitions
    const functionQuery = Parser.query(
      "python",
      `
(function_definition
  name: (identifier) @function.name
  parameters: (parameters) @function.params
  return_type: (type)? @function.return_type
  body: (block)) @function.def
`
    );
    const functionMatches = functionQuery.matches(this._ast.rootNode);
    for (const match of functionMatches) {
      const nameNode = match.captures.find((c) => c.name === "function.name");
      if (!nameNode) {
        continue;
      }
      const name = nameNode.node.text;
      try {
        const maybeFunction = this._getFunctionFromNode(match.captures);
        if (maybeFunction) {
          supported[maybeFunction.name] = maybeFunction;
        }
      } catch (e: unknown) {
        const msg = getErrorMessageOrJson(e);
        console.debug(
          `Error processing function '${name}' in module '${this._filename}': ${msg}`
        );
        const defNode = match.captures.find((c) => c.name === "funciton.def");

        unsupported[name] = {
          reason: msg,
          node: JSONN.stringify(defNode?.node.toString()),
        };
      }
    }
    const lambdaQuery = Parser.query(
      "python",
      `
(assignment
  left: (identifier) @function.name
  right: (lambda) @function.def)
`
    );
    const lambdaMatches = lambdaQuery.matches(this._ast.rootNode);
    for (const match of lambdaMatches) {
      const nameNode = match.captures.find((c) => c.name === "function.name");
      if (!nameNode) {
        continue;
      }
      const name = nameNode.node.text;
      try {
        const maybeFunction = this._getLambdaFromNode(match.captures);
        if (maybeFunction) {
          supported[maybeFunction.name] = maybeFunction;
        }
      } catch (e: unknown) {
        const msg = getErrorMessageOrJson(e);
        console.debug(
          `Error processing lambda '${name}' in module '${this._filename}': ${msg}`
        );
        const defNode = match.captures.find((c) => c.name === "funciton.def");

        unsupported[name] = {
          reason: msg,
          node: JSONN.stringify(defNode?.node.toString()),
        };
      }
    }

    return { supported, unsupported };
  }

  /**
   * Python has no default export
   *
   * @returns undefined
   */
  protected _findDefaultTypeExport(): TypeRef | undefined {
    return undefined;
  }

  /**
   * Determines whether a function body lacks return statements or
   * if all return statements return None or no data.
   *
   * @param `node` AST node of function
   * @returns `true` if implicitly `void`; false, otherwise
   */
  protected static _isFunctionBodyVoid(node: Parser.SyntaxNode): boolean {
    const returnStatements: Parser.SyntaxNode[] = [];

    const collectReturns = (node: Parser.SyntaxNode) => {
      // Ignore nested functions and lambdas
      if (node.type === "function_definition" || node.type === "lambda") {
        return;
      }
      if (node.type === "return_statement") {
        returnStatements.push(node);
      }
      for (const child of node.children) {
        collectReturns(child);
      }
    };

    collectReturns(node);

    // No return statements -> void
    if (returnStatements.length === 0) {
      return true;
    }

    // Check if ALL return statements return nothing or `None`
    for (const ret of returnStatements) {
      const namedChildren = ret.namedChildren;
      if (namedChildren.length > 0) {
        const expr = namedChildren[0];
        // If any return statement returns something other than 'none', it is not void
        if (expr.type !== "none") {
          return false;
        }
      }
    }

    // No return statements with a value found
    return true;
  }

  public resolveTypeRef(typeRef: TypeRef): TypeRef {
    // Handle any resolved or partially-resolved type references
    if (typeRef.type) {
      if (typeRef.type.resolved) {
        // Base case: We found a fully-resolved type reference
        return typeRef; // Return resolved type
      } else {
        // Type is only partially resolved
        typeRef.type.children.forEach((child) => this.resolveTypeRef(child));
        typeRef.type.resolved = true;
        return typeRef; // Return resolved type
      }
    }

    if (!typeRef.typeRefName) {
      throw new Error(
        `Internal error: typeRef is undefined in Typeref (${JSONN.stringify(
          typeRef
        )})`
      );
    }

    // Type is not yet resolved. Look up and resolve the type reference
    if (typeRef.typeRefName in this._types) {
      // Resolve and use the local type reference
      const resolvedType = this.resolveTypeRef(
        this._types[typeRef.typeRefName]
      );
      typeRef.type = structuredClone(resolvedType.type);

      if (typeRef.type) {
        typeRef.type.dims += resolvedType.dims;
      }
      typeRef.optional = typeRef.optional || resolvedType.optional;

      return typeRef; // this._types[typeRef.typeRefName];
    } else if (typeRef.typeRefName === "Any") {
      typeRef.type = {
        type: this.options.anyType,
        dims: this.options.anyDims,
        children: [],
        resolved: true,
      };
      return typeRef;
    } else {
      // Follow the imported type reference
      // Split the local name into parts (e.g., "foo.bar" => ["foo", "bar"])
      // TODO: This should be more flexible
      const localNameParts = typeRef.typeRefName.split(".");

      let importName: string = "";
      // Lookup the import reference
      for (let index = 0; index < localNameParts.length; index++) {
        const name = localNameParts.slice(0, index + 1).join(".");
        if (name in this._imports.identifiers) {
          importName = name;
          break;
        }
      }

      if (importName === "" || !(importName in this._imports.identifiers)) {
        // try looking over from-import statements in the form from foo import *
        const wildcards = Object.values(this._imports.identifiers).filter(
          (imp) => imp.local === "*"
        );
        for (const wildcard of wildcards.reverse()) {
          const wildcardProgram = ProgramFactory.fromFile(
            wildcard.programPath,
            this.lang,
            this._options,
            this
          );
          if (localNameParts[0] in wildcardProgram.typesExported) {
            this._imports.identifiers[localNameParts[0]] = {
              local: localNameParts[0],
              imported: localNameParts[0],
              programPath: wildcard.programPath,
              resolved: true,
              default: false,
            };
            importName = localNameParts[0];
            break;
          }
        }
      }
      if (importName === "") {
        throw new Error(
          `Internal error: ${this._filename} did not find local import for ${typeRef.typeRefName}`
        );
      }
      const importRef = this._imports.identifiers[importName];

      // Get the imported module
      let importProgram = ProgramFactory.fromFile(
        importRef.programPath,
        this.lang,
        this._options,
        this
      );

      // Submodule fallback for `from <pkg> import <name>`. We bound member-first
      // (pointing at the package), matching CPython's attribute-before-submodule
      // precedence. If the package does not actually export the name, it must be
      // a submodule (`pkg/<name>.py` or `pkg/<name>/__init__.py`): rebind as a
      // namespace so member access (`name.Foo`) expands below. When the package
      // DOES export the name, we skip this and the member correctly shadows any
      // same-named submodule.
      if (
        importRef.resolved &&
        !(importRef.imported in importProgram.typesExported)
      ) {
        const pkgDir = path.dirname(importProgram.filename);
        const submodule = [
          path.join(pkgDir, importRef.imported + ".py"),
          path.join(pkgDir, importRef.imported, "__init__.py"),
        ].find((c) => fs.existsSync(c));
        if (submodule) {
          importRef.programPath = submodule;
          importRef.imported = "*";
          importRef.resolved = false;
          this._imports.programs[submodule] = "?";
          importProgram = ProgramFactory.fromFile(
            submodule,
            this.lang,
            this._options,
            this
          );
        }
      }

      // Resolve unresolved imports
      if (!importRef.resolved) {
        // python does not have default exports
        // Namespace import: create concrete imports for each of the imports
        for (const exported of Object.values(importProgram.typesExported)) {
          const localName = importName + "." + exported.name;
          this._imports.identifiers[localName] = {
            local: localName,
            imported: exported.name ?? "__default",
            programPath: exported.module,
            resolved: true,
            default: false,
          };
        }

        // Remove the original unresolved import reference
        //delete this._imports.identifiers[importName];
      }

      // Find the imported type reference that corresponds with
      // this type reference
      //
      // TODO: Need to handle other naming patterns here
      if (typeRef.typeRefName in this._imports.identifiers) {
        const importName =
          this._imports.identifiers[typeRef.typeRefName].imported;

        if (importName in importProgram.typesExported) {
          // Resolve named export
          const resolvedType = importProgram.resolveTypeRef(
            importProgram.typesExported[importName]
          );
          typeRef.type = structuredClone(resolvedType.type);

          if (typeRef.type) {
            typeRef.type.dims += resolvedType.dims;
          }
          typeRef.optional = typeRef.optional || resolvedType.optional;
        } else {
          // Unable to find exported type
          throw new Error(
            `Unable to find exported type '${importName}' in module '${importProgram.filename}' when processing imports for module '${this._filename}`
          );
        }
      } else {
        throw new Error(
          `Internal error: ${this._filename} did not find import: ${typeRef.typeRefName}`
        );
      }

      return typeRef;
    }
  }

  public get lang(): ProgramLanguage {
    return PythonProgram.lang;
  }

  public get extensions(): readonly string[] {
    return PythonProgram.extensions;
  }

  /**
   * Returns a string that works as the type annotation for the argument.
   *
   * @param `arg` ArgDef to describe
   * @param `options` Description options
   * @returns a string that works as the type annotation for the argument
   */
  public static getTypeAnnotation(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    // Get the base type annotation
    const baseType = PythonProgram.getBaseType(arg, options);
    const dims = arg.getDim();

    // Add the dimensions to the annotation
    let type = `${"List[".repeat(dims)}${baseType}${"]".repeat(dims)}`;

    // Add optionality (if specified and not already part of the union type)
    if (
      arg.isOptional() &&
      !(
        arg.getType() === ArgTag.UNION &&
        arg.getDim() === 0 &&
        arg
          .getChildren()
          .some(
            (child) =>
              child.getType() === ArgTag.LITERAL &&
              child.isConstant() &&
              child.getConstantValue() === undefined
          )
      )
    ) {
      type = `Union[${type}, None]`;
    }
    return type;
  } // fn: getTypeAnnotation()

  /**
   * Returns the base type of this ArgDef, i.e., its type without any
   * dimensions or optionality.
   */
  protected static getBaseType(
    arg: ArgDef,
    options: TypeAnnotationOptions = TypeAnnotationOptionDefaults
  ): string {
    const typeRef = arg.getTypeRef();
    if (typeRef && options.useTypeRefs) {
      return typeRef;
    }

    switch (arg.getType()) {
      case ArgTag.OBJECT: {
        // Literal object, no type. Recursively walk the children to build the type.
        const childTypeAnnotations = arg.getChildren().map((child) => {
          let type = PythonProgram.getTypeAnnotation(child, options);
          if (child.isOptional() && !options.useOptionality) {
            type = `NotRequired[${type}]`;
          }
          return `'${child.getName()}': ${type}`;
        });
        return `TypedDict('${arg.getName()}',{${childTypeAnnotations.join(", ")} }`;
      }

      case ArgTag.UNION: {
        const childTypeAnnotations = arg
          .getChildren()
          .map((child) => PythonProgram.getTypeAnnotation(child, options));
        return `Union[${childTypeAnnotations.join(", ")}]`;
      }

      case ArgTag.LITERAL: {
        return `Literal[${ValueMapper.toLang("python", arg.getConstantValue())}]`;
      }

      case ArgTag.TUPLE: {
        const childTypeAnnotations = arg
          .getChildren()
          .map((child) => PythonProgram.getTypeAnnotation(child, options));
        return `tuple[${childTypeAnnotations.join(", ")}]`;
      }

      case ArgTag.BOOLEAN:
        return "bool";

      case ArgTag.NUMBER:
        return arg.getOptions().numInteger ? "int" : "float";

      case ArgTag.STRING:
        return "str";

      case ArgTag.UNRESOLVED:
        throw new Error(`Internal error: unresolved types cannot be annotated`);
    }
  } // fn: getBaseType()
} // class: PythonProgram
