#!/usr/bin/env node
import * as fs from "node:fs";
import * as esbuild from "esbuild";
import copyfiles from "copyfiles";
import * as rimraf from "rimraf";

// Clear the build folder
rimraf.sync("./build");

// Copy static assets
copyfiles(["./src/ui/*.css", "./build/ui"], true /* flat */, () =>
  console.log("copied css assets")
);
copyfiles(["./src/ui/*.svg", "./build/ui"], true /* flat */, () =>
  console.log("copied svg assets")
);

// Copy PythonRunnerHost.py
copyfiles(
  ["./src/fuzzer/runners/PythonRunnerHost.py", "./build/extension"],
  true,
  () => console.log("copied .py runner")
);

// Copy Python imports
[{ name: "json5" }].forEach((pkg) => {
  fs.cpSync(
    `./.venv/lib/python3.13/site-packages/${pkg.name}`,
    `./build/extension/${pkg.name}`,
    { recursive: true }
  );
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
    "tree-sitter",
    "tree-sitter-python",
  ],
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
  format: "iife", // IIFE format is suitable for browser-based UI
  sourcemap: "both",
  external: [],
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
});
