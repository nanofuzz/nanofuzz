#!/usr/bin/env node
const { build, file } = require("estrella");
const common = {
  entry: "./src/extension.ts",
  bundle: true,
  sourcemap: "inline",
  tsconfig: "./tsconfig.json",
  platform: "node",
  external: ["path", "fs", "crypto", "vscode", "typescript"],
};
/*
build({
  ...common,
  outfile: "./build/dist/index.esm.js",
  format: "esm",
  minify: false,
  tslint: "off",
  run: "yarn run build-decls",
});
*/
build({
  ...common,
  outfile: "./build/extension/extension.js",
  platform: "node",
  minify: false,
  format: "cjs",
  sourcemap: "both",
});
