import { AbstractProgram } from "../AbstractProgram";
import {
  FunctionRef,
  ProgramImports,
  ProgramPath,
  IdentifierName,
  TypeRef,
  ArgOptions,
  ArgTag,
  ArgType,
} from "../Types";
import { getErrorMessageOrJson } from "../../Util";
import * as ProgramFactory from "../ProgramFactory";

import * as JSON5 from "json5";
import Parser, { Query, QueryCapture } from "tree-sitter";
import PythonGrammar from "tree-sitter-python";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

// Type definitions are broken in tree-sitter-python
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const Python: Parser.Language = PythonGrammar as Parser.Language;

export class PythonProgram extends AbstractProgram {
  public static readonly lang = "python";
  public static readonly extensions = Object.freeze([".py"]);
  protected _ast: Parser.Tree | undefined;

  // Cache of `sys.path` entries (site-packages, stdlib, etc.) for the Python
  // interpreter used to resolve external-package imports. `undefined` means
  // "not yet queried"; `[]` means the interpreter query failed (e.g. no
  // Python on PATH), in which case external imports stay unresolved.
  private static _sysPath: string[] | undefined;

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

  protected _parse(_src: string): void {
    const parser = new Parser();
    parser.setLanguage(Python);
    this._ast = parser.parse(_src);
  }

  protected _findImports(): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    const ast = this._ast;

    const traverse = new Query(
      Python,
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
   * Returns the interpreter's `sys.path` (stdlib, site-packages, etc.),
   * queried once per process and cached. Mirrors why the TypeScript resolver
   * can lean on `require.resolve`: only the interpreter that will actually
   * run the code knows where its packages are installed (venvs, `.pth`
   * files, editable installs) — there's no heuristic-free way to guess it
   * from the filesystem alone.
   *
   * @returns Directories on the interpreter's module search path, or `[]` if
   *   the interpreter could not be queried (e.g. no Python on PATH)
   */
  private static _getSysPath(): string[] {
    if (PythonProgram._sysPath === undefined) {
      try {
        const output = execFileSync(
          "python3",
          ["-c", "import sys, json; print(json.dumps(sys.path))"],
          { encoding: "utf8" }
        );
        const entries: unknown = JSON.parse(output);
        PythonProgram._sysPath = Array.isArray(entries)
          ? entries.filter(
              (e): e is string => typeof e === "string" && e !== ""
            )
          : [];
      } catch {
        // No interpreter on PATH, or it failed to run — external imports
        // remain unresolved rather than breaking analysis.
        PythonProgram._sysPath = [];
      }
    }
    return PythonProgram._sysPath;
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
    const searchDirs = [rootDir, ...PythonProgram._getSysPath()];
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
  private static isBlockScoped(node: Parser.SyntaxNode): boolean {
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

    const typeQuery = new Query(
      Python,
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
    const isTypedDictBase = (node: Parser.SyntaxNode): boolean => {
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
    for (const classNode of ast.rootNode.namedChildren.filter(
      (node) => node.type === "class_definition"
    )) {
      const superclasses = classNode.childForFieldName("superclasses");
      const inheritedFields =
        superclasses?.namedChildren.flatMap((node) => {
          const base = types[node.text];
          return base?.type?.type === ArgTag.OBJECT
            ? base.type.children
            : [];
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
        if (!assignment || !fieldName || !fieldType || fieldName.type !== "identifier") {
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
   * @returns [type tag, dimensions, type reference name, literal value]
   */
  protected _getTypeFromAstNode(
    node: Parser.SyntaxNode,
    options: ArgOptions
  ): [ArgTag, number, string?, ArgType?] {
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
          case "float":
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

            const [type, dims, typeName, literalValue] =
              this._getTypeFromAstNode(arg, options);
            return [type, dims + 1, typeName, literalValue];
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
          "Unsupported type annotation: " + JSON5.stringify(node.toString())
        );
    }
  } // fn: _getTypeFromAstNode()

  /**
   * Extracts the base name and arguments from built-in and qualified generic
   * annotations. Tree-sitter uses different node shapes for those spellings,
   * so keeping the normalization here ensures container cases behave
   * identically.
   */
  private _getGenericParts(node: Parser.SyntaxNode): {
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
          "Unsupported type annotation: " + JSON5.stringify(node.toString())
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
    const [type, dims, typeRefNode, literalValue] = this._getTypeFromAstNode(
      typeNode,
      this._options
    );

    // Create the TypeRef data structure
    switch (type) {
      case ArgTag.STRING:
      case ArgTag.BOOLEAN:
      case ArgTag.NUMBER: {
        thisType.type = {
          dims: dims,
          type: type,
          children: [],
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
    captures: QueryCapture[]
  ): FunctionRef | undefined {
    const nameNode = captures.find((c) => c.name === "function.name");
    const bodyNode = captures.find((c) => c.name === "function.body");
    const defNode = captures.find((c) => c.name === "function.def");
    const argsNode = captures.find((c) => c.name === "function.params");
    if (!nameNode || !bodyNode || !defNode) {
      return undefined;
    }
    return {
      module: this._filename,
      name: nameNode.node.text,
      src: defNode.node.text,
      startOffset: defNode.node.startIndex,
      endOffset: defNode.node.endIndex,
      isExported: true,
      isVoid: false,
      args: argsNode?.node.namedChildren
        .filter(
          (arg) =>
            arg.type === "identifier" ||
            arg.type === "typed_parameter" ||
            arg.type === "typed_default_parameter"
        )
        .map((arg) => this._getTypeRefFromAstNode(arg)),
      returnType: undefined,
      cmt: undefined,
    };
  }

  // standard functions
  protected _getFunctionFromNode(
    captures: QueryCapture[]
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
    try {
      if (typeNode) {
        isVoid = typeNode.node.namedChild(0)?.type === "none";
        if (!isVoid) {
          returnType = this._getTypeRefFromAstNode(typeNode.node);
        }
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
      startOffset: defNode.node.startIndex,
      endOffset: defNode.node.endIndex,
      isExported: true,
      isVoid,
      args: argsNode?.node.namedChildren
        .filter(
          (arg) =>
            arg.type === "identifier" ||
            arg.type === "typed_parameter" ||
            arg.type === "typed_default_parameter"
        )
        .map((arg) => this._getTypeRefFromAstNode(arg)),
      returnType,
      // not sure how to get docstring yet
    };
  }

  protected _findFunctions(): typeof this._functions {
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    // const ast = this._ast;
    const supported: AbstractProgram["_functions"]["supported"] = {};
    const unsupported: AbstractProgram["_functions"]["unsupported"] = {};

    // Traverse the AST to find function definitions
    const functionQuery = new Query(
      Python,
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
          node: JSON5.stringify(defNode?.node.toString()),
        };
      }
    }
    const lambdaQuery = new Query(
      Python,
      `
(assignment
  left: (identifier) @function.name
  right: (lambda
    parameters: (lambda_parameters)? @function.params
    body: (_)) @function.def)
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
          node: JSON5.stringify(defNode?.node.toString()),
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

  public _resolveTypeRef(typeRef: TypeRef): TypeRef {
    // Handle any resolved or partially-resolved type references
    if (typeRef.type) {
      if (typeRef.type.resolved) {
        // Base case: We found a fully-resolved type reference
        return typeRef; // Return resolved type
      } else {
        // Type is only partially resolved
        typeRef.type.children.forEach((child) => this._resolveTypeRef(child));
        typeRef.type.resolved = true;
        return typeRef; // Return resolved type
      }
    }

    if (!typeRef.typeRefName) {
      throw new Error(
        `Internal error: typeRef is undefined in Typeref (${JSON5.stringify(
          typeRef
        )})`
      );
    }

    // Type is not yet resolved. Look up and resolve the type reference
    if (typeRef.typeRefName in this._types) {
      // Resolve and use the local type reference
      const resolvedType = this._resolveTypeRef(
        this._types[typeRef.typeRefName]
      );
      typeRef.type = structuredClone(resolvedType.type);

      if (typeRef.type) {
        typeRef.type.dims += resolvedType.dims;
      }
      typeRef.optional = typeRef.optional || resolvedType.optional;

      return typeRef; // this._types[typeRef.typeRefName];
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
          const resolvedType = importProgram._resolveTypeRef(
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

  public get lang(): ProgramFactory.ProgramLanguage {
    return PythonProgram.lang;
  }

  public get extensions(): readonly string[] {
    return PythonProgram.extensions;
  }
}
