#!/usr/bin/env node
const { build, file } = require("estrella");
const common = {
  bundle: true,
  sourcemap: "both",
  tsconfig: "./tsconfig.json",
  platform: "node",
  external: ["vscode"],
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
// Extension
build({
  ...common,
  entry: "./src/extension.ts",
  outfile: "./build/extension.js",
  minify: false,
  format: "cjs",
});
// Worker
build({
  ...common,
  entry: "./src/fuzzer/FuzzWorker.ts",
  outfile: "./build/workers/FuzzWorker.js",
  minify: false,
  format: "cjs",
});
