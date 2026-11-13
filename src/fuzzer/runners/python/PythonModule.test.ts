import { pythonModuleFor } from "./PythonModule";
import { normalizePathForKey } from "../../Util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("fuzzer/runners/python/PythonModule", () => {
  let tmpDir: string;
  let proj: string;

  beforeAll(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-modname-"))
    );
    proj = path.join(tmpDir, "proj");
    for (const file of [
      "pkg/__init__.py",
      "pkg/my.mod.py",
      "pkg/sub/__init__.py",
      "pkg/sub/mod.py",
      "scripts/tool.py",
      "my-pkg/__init__.py",
      "my-pkg/mod.py",
    ]) {
      fs.mkdirSync(path.dirname(path.join(proj, file)), { recursive: true });
      fs.writeFileSync(path.join(proj, file), "");
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const moduleFor = (file: string) => {
    const { name, sourceRoot } = pythonModuleFor(path.join(proj, file));
    return { name, sourceRoot: normalizePathForKey(sourceRoot) };
  };
  const dir = (d: string) => normalizePathForKey(path.join(proj, d));

  it("names a module of a package from the first directory that is not a package", () => {
    expect(moduleFor("pkg/sub/mod.py")).toEqual({
      name: "pkg.sub.mod",
      sourceRoot: dir("."),
    });
  });

  it("names a package's __init__.py as the package", () => {
    expect(moduleFor("pkg/__init__.py")).toEqual({
      name: "pkg",
      sourceRoot: dir("."),
    });
  });

  it("names a file that is not in a package from its own directory", () => {
    expect(moduleFor("scripts/tool.py")).toEqual({
      name: "tool",
      sourceRoot: dir("scripts"),
    });
  });

  it("treats a file whose name is not an identifier as if it were not in a package", () => {
    expect(moduleFor("pkg/my.mod.py")).toEqual({
      name: "my.mod",
      sourceRoot: dir("pkg"),
    });
  });

  it("treats a directory whose name is not an identifier as if it were not a package", () => {
    expect(moduleFor("my-pkg/mod.py")).toEqual({
      name: "mod",
      sourceRoot: dir("my-pkg"),
    });
  });
});
