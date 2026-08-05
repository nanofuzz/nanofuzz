#!/usr/bin/env node
import * as fs from "node:fs";
import * as esbuild from "esbuild";
import copyfiles from "copyfiles";
import * as rimraf from "rimraf";
import path from "node:path";
import pkg from "./package.json" with { type: "json" };

// NaNofuzz version
const version = JSON.stringify(pkg.version);

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
    "tree-sitter-python",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "web-tree-sitter",
  ],
  define: {
    "process.env.BUILD_TARGET": JSON.stringify("vscode-exthost"),
    "process.env.NANOFUZZ_VERSION": version,
  },
});

// VSCode Web Extension Front-end UI
await esbuild.build({
  entryPoints: ["./src/ui/FuzzPanelView.ts"],
  outfile: "./build/ui/FuzzPanelView.js",
  bundle: true,
  sourcemap: "inline",
  tsconfig: "./tsconfig.json",
  platform: "browser",
  minify: true,
  format: "esm", // for web-tree-sitter (was iife)
  sourcemap: "both",
  external: ["module", "fs/promises", "path"],
  define: {
    "process.env.BUILD_TARGET": JSON.stringify("vscode-webview"),
    "process.env.NANOFUZZ_VERSION": version,
  },
});

// CLI
await esbuild.build({
  entryPoints: ["./src/ui/Cli.ts"],
  outfile: "./build/cli/cli.cjs",
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
    "typescript",
    "tree-sitter-python",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "web-tree-sitter",
  ],
  plugins: [
    swapModulePlugin({
      vscode: "./spec/helpers/vscode.stub.js",
    }),
  ],
  define: {
    "process.env.BUILD_TARGET": JSON.stringify("node-cli"),
    "process.env.NANOFUZZ_VERSION": version,
  },
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
  define: {
    "process.env.BUILD_TARGET": JSON.stringify("vscode-exthost-worker"),
    "process.env.NANOFUZZ_VERSION": version,
  },
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

/**
 * A plugin to swap in/swap out specific modules during esbuild compilation.
 *
 * @param {Record<string, string>} aliasMap - An object mapping module names to replacement file paths.
 */
function swapModulePlugin(aliasMap) {
  return {
    name: "swapModulePlugin",
    setup(build) {
      for (const [moduleName, replacementPath] of Object.entries(aliasMap)) {
        // Intercept imports that match the exact module name
        const filter = new RegExp(`^${moduleName}$`);

        build.onResolve({ filter }, (args) => {
          return {
            // Resolve the replacement path relative to the current working directory (or absolute)
            path: path.resolve(replacementPath),
          };
        });
      }
    },
  };
}
