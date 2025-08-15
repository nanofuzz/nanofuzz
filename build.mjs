#!/usr/bin/env node
import * as esbuild from "esbuild";

// VSCode Extension
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
  external: ["path", "fs", "crypto", "vscode", "typescript"],
});

// VSCode Web Extension UI
await esbuild.build({
  entryPoints: ["./assets/ui/FuzzPanelMain.ts"],
  bundle: true,
  sourcemap: "inline",
  tsconfig: "./tsconfig.json",
  platform: "browser",
  outfile: "./build/ui/FuzzPanelMain.js",
  minify: true,
  format: "iife", // IIFE format is suitable for browser-based UI
  sourcemap: "both",
  external: [],
});
