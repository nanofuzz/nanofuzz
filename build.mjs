#!/usr/bin/env node
import * as fs from "node:fs";
import * as esbuild from "esbuild";
import copyfiles from "copyfiles";
import * as rimraf from "rimraf";
import path from "node:path";

// Clear the build folder
rimraf.sync("./build");

// Copy static assets
copyfiles(["./src/ui/*.css", "./build/ui"], true /* flat */, () =>
  console.log("copied css assets")
);
copyfiles(["./src/ui/*.svg", "./build/ui"], true /* flat */, () =>
  console.log("copied svg assets")
);

// Copy Python assets
copyfiles(
  ["./src/fuzzer/runners/PythonRunnerHost.py", "./build/extension"],
  true,
  () => console.log("copied .py runner")
);
copyfiles(
  ["./src/fuzzer/oracles/ImplicitOracle.py", "./build/extension"],
  true,
  () => console.log("copied .py oracle")
);

// Copy Python imports
if (!fs.existsSync(path.resolve(path.join(".", ".venv")))) {
  throw new Error(
    `Could not find Python virtual environment in ./.venv (see ./CONTRIBUTING.md)`
  );
}
[{ name: "json5" }, { name: "coverage" }].forEach((pkg) => {
  const libdir = findInDescendants("./.venv/lib", pkg.name);
  if (libdir === undefined) {
    throw new Error(
      `Could not find Python package ${pkg.name}. Is it installed in the python virtual environment? (see ./CONTRIBUTING.md)`
    );
  }
  fs.cpSync(libdir, `./build/extension/${pkg.name}`, {
    recursive: true,
  });
  rimraf.sync(`./build/extension/${pkg.name}/__pycache__`);
  console.log(`copied .py ${pkg.name}`);
});

// Copy wasm imports (web-tree-sitter)
[
  "./node_modules/web-tree-sitter/web-tree-sitter.wasm",
  "./node_modules/tree-sitter-python/tree-sitter-python.wasm",
  "./node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
  "./node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
].forEach((wasmFile) => {
  copyfiles([wasmFile, "./build/ui"], true, () =>
    console.log(`copied ${path.basename(wasmFile)}`)
  );
});

// VSCode Web Extension Back-end
await esbuild.build({
  entryPoints: ["./src/extension.ts"],
  outfile: "./build/extension/extension.js",
  bundle: true,
  platform: "node",
  metafile: true,
  minify: false,
  format: "cjs",
  sourcemap: "both",
  tsconfig: "./tsconfig.json",
  external: [
    "path",
    "fs",
    "crypto",
    "vscode",
    "typescript",
    "tree-sitter",
    "tree-sitter-python",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
  ],
  define: { "process.env.TARGET_WEB": "false" },
});

// VSCode Web Extension Front-end UI
await esbuild.build({
  entryPoints: ["./src/ui/FuzzPanelView.ts"],
  bundle: true,
  sourcemap: "inline",
  tsconfig: "./tsconfig.json",
  platform: "browser",
  outfile: "./build/ui/FuzzPanelView.js",
  minify: true,
  format: "esm", // for web-tree-sitter (was iife)
  sourcemap: "both",
  external: ["module", "fs/promises", "path"],
  define: { "process.env.TARGET_WEB": "true" },
});

// CompilerWorker
await esbuild.build({
  entryPoints: ["./src/fuzzer/compilers/CompilerWorker.ts"],
  outfile: "./build/workers/CompilerWorker.js",
  bundle: true,
  platform: "node",
  metafile: true,
  minify: false,
  format: "cjs",
  sourcemap: "both",
  tsconfig: "./tsconfig.json",
  external: ["path", "fs", "typescript"],
  define: { "process.env.TARGET_WEB": "false" },
});

/**
 * Returns the nearest item by searching recursively through descendant paths.
 * Returns `undefined` if not found.
 *
 * @param dir path
 * @param item to find
 * @returns path to closest item (or `undefined`` if not found)
 */
export function findInDescendants(dir, item) {
  const queue = [path.resolve(dir)];
  const visited = new Set();

  while (queue.length > 0) {
    const currentDir = queue.shift();

    // Check if item exists in the current directory
    const targetPath = path.resolve(path.join(currentDir, item));
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }

    // Add subdirectories to the queue
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.resolve(path.join(currentDir, entry.name));
          // Prevent infinite loops from symlinks
          if (!visited.has(subDir)) {
            visited.add(subDir);
            queue.push(subDir);
          }
        }
      }
    } catch (_e) {
      // Ignore directories we don't have permission to read
      continue;
    }
  }

  return undefined;
}
