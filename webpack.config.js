const path = require("path");
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin");
const webpack = require("webpack");

// --------------------------------------------------------------------------
// Configuration Pieces and Parts
// --------------------------------------------------------------------------
// Shared WebPack config
const common = {
  node: {
    __dirname: false, // leave the __dirname-behaviour intact
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
    ],
    noParse: [
      require.resolve("typescript/lib/typescript.js"), // https://github.com/microsoft/TypeScript/issues/39436
      require.resolve(
        "@typescript-eslint/typescript-estree/dist/create-program/shared.js"
      ),
    ],
  },
  devtool: "source-map",
  externals: {
    vscode: "commonjs vscode",
    worker_threads: "commonjs worker_threads",
  },
  mode: "none",
};

// Outputs
const outputCommon = {
  filename: "[name]",
  path: path.resolve(__dirname, "dist"),
  libraryTarget: "commonjs",
};

// Targets
const targetWebWorker = {
  target: "webworker",
  plugins: [
    new NodePolyfillPlugin(),
    new webpack.DefinePlugin({
      "process.versions": "{ node: '16.15.1' }", // Plug gap in process polyfill
    }),
  ],
  resolve: {
    mainFields: ["browser", "module", "main"],
    extensions: [".tsx", ".ts", ".js"],
    fallback: {
      fs: false,
    },
  },
};
const targetNode = {
  target: "node",
  resolve: {
    mainFields: ["module", "main"],
    extensions: [".tsx", ".ts", ".js"],
  },
};

// --------------------------------------------------------------------------
// Final Build Directives
// --------------------------------------------------------------------------
module.exports = [
  // Node outputs
  {
    ...common,
    ...targetNode,
    output: { ...outputCommon },
    entry: {
      "extension.node.js": "./src/extension.ts",
      "workers/FuzzWorker.node.js": "./src/fuzzer/FuzzWorker.ts",
    },
  },
  // WebWorker outputs
  {
    ...common,
    ...targetWebWorker,
    output: outputCommon,
    entry: {
      "extension.web.js": "./src/extension.ts",
      "workers/FuzzWorker.web.js": "./src/fuzzer/FuzzWorker.ts",
    },
  },
];
