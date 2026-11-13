import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Information needed to import a Python source file, similar to pytest's
 * default import mode: the file's module name and source root. For example:
 *
 *   proj/
 *     mypkg/
 *       __init__.py
 *       target.py
 *     scripts/
 *       helper.py
 *       tool.py           imports `helper`
 *
 *  - `proj/mypkg/target.py` is in a package (`mypkg` has an `__init__.py`):
 *    - name: `mypkg.target`
 *    - sourceRoot: `proj`, the first directory up that is not a package
 *  - `proj/scripts/tool.py` is not in a package:
 *    - name: `tool`
 *    - sourceRoot: `proj/scripts`, the file's own directory
 *
 * To test a function, NaNofuzz imports its file (e.g., as `mypkg.target`).
 * Python looks up every imported name, the file's own imports included, in
 * the directories on its module search path (sys.path), in order. So the
 * source root goes first, for these names to resolve to the project's own
 * files: `mypkg.target` to `proj/mypkg/target.py` even if another `mypkg` is
 * installed (e.g., an older release of the project), and `tool.py`'s
 * `import helper` to `proj/scripts/helper.py`.
 *
 * Note: as with pytest's default, a file that is not in a package cannot
 * import from the project's root: e.g., `proj/scripts/tool.py` cannot
 * `import mypkg`, as `proj` is not on sys.path. To support such files,
 * consider also adding the project's root (the file's workspace folder; or,
 * in the CLI, the current directory) to the end of sys.path.
 */
export type PythonModule = {
  /** Name to import the file by: e.g., `mypkg.target`, or just `tool` */
  name: string;
  /** Directory that `name` is relative to, inferred from where the file is
   * (see above): first on sys.path */
  sourceRoot: string;
};

/**
 * Returns how to import a Python source file (see `PythonModule`)
 *
 * @param `filename` Python source file
 * @returns the file's module name and source root
 */
export function pythonModuleFor(filename: string): PythonModule {
  let file = path.resolve(filename);
  try {
    // Resolve symlinks, similar to coverage.py and the runner host, so that
    // they all work with the same file and directories
    file = fs.realpathSync(file);
  } catch {
    // The path cannot be resolved (e.g., the file does not exist): use it as
    // given; if the file is indeed missing, the runner host would fail to
    // load it
  }
  const stem = path.basename(file, path.extname(file));
  const name = stem === "__init__" ? [] : [stem];
  let sourceRoot = path.dirname(file);
  // Only a file whose name is a Python identifier can be imported as part of
  // its package. Any other file (e.g., `my-file.py`) is treated as if it were
  // not in a package, and is loaded from its own directory. Likewise, a
  // directory whose name is not an identifier (e.g., `my-pkg`) is treated as
  // if it were not a package, even with an `__init__.py`.
  if (isPythonIdentifier(stem)) {
    while (
      isPythonIdentifier(path.basename(sourceRoot)) &&
      fs.existsSync(path.join(sourceRoot, "__init__.py"))
    ) {
      const parent = path.dirname(sourceRoot);
      if (parent === sourceRoot) break;
      name.unshift(path.basename(sourceRoot));
      sourceRoot = parent;
    }
  }
  return { name: name.length ? name.join(".") : stem, sourceRoot };
} // fn: pythonModuleFor

/**
 * Returns true if `name` is a Python identifier, as Python's
 * `str.isidentifier()` does (by the same Unicode properties), and so can name
 * a module or package in an import
 *
 * @param name the name to check
 * @returns true if `name` is a Python identifier
 */
function isPythonIdentifier(name: string): boolean {
  return /^[\p{XID_Start}_]\p{XID_Continue}*$/u.test(name);
} // fn: isPythonIdentifier
