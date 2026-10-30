#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as esbuild from "esbuild";
import copyfiles from "copyfiles";
import * as rimraf from "rimraf";
import * as ChildProcess from "node:child_process";
import path from "node:path";
import pkg from "./package.json" with { type: "json" };

// NaNofuzz version
const version = JSON.stringify(pkg.version);

// Clear the build folder
fs.rmSync("./build", { recursive: true, force: true });

// Copy static assets synchronously
fs.mkdirSync("./build/ui", { recursive: true });
fs.copyFileSync("./src/ui/FuzzPanelView.css", "./build/ui/FuzzPanelView.css");
console.log("copied css assets");
fs.copyFileSync("./src/ui/icon.svg", "./build/ui/icon.svg");
console.log("copied svg assets");

// Copy Python assets
copyfiles(
  ["./src/fuzzer/runners/python/PythonRunnerHost.py", "./build/extension"],
  true,
  () => console.log("copied .py runner")
);
copyfiles(
  ["./src/fuzzer/oracles/ImplicitOracle.py", "./build/extension"],
  true,
  () => console.log("copied .py oracle")
);

// Copy Rust assets
copyfiles(
  ["./src/fuzzer/runners/rust/RustRunnerHost.template.rs", "./build/extension"],
  true,
  () => console.log("copied .rs runner template")
);

// Copy OCaml assets
copyfiles(
  [
    "./src/fuzzer/runners/oxcaml/OxcamlRunnerHost.template.ml",
    "./build/extension",
  ],
  true,
  () => console.log("copied .ml runner template")
);

// Copy Python runtime package (nanofuzz_runtime)
const pyRuntimeSrc = path.resolve(
  "./packages/runtime/python/src/nanofuzz_runtime"
);
if (fs.existsSync(pyRuntimeSrc)) {
  const destPyRuntime = path.resolve("./build/extension/nanofuzz_runtime");
  fs.mkdirSync(destPyRuntime, { recursive: true });
  fs.cpSync(pyRuntimeSrc, destPyRuntime, { recursive: true });
  console.log("copied nanofuzz_runtime");
}

// Build and copy TypeScript runtime package (@nanofuzz/runtime)
const tsRuntimeDir = path.resolve("./packages/runtime/typescript");
if (fs.existsSync(tsRuntimeDir)) {
  if (!fs.existsSync(path.join(tsRuntimeDir, "build", "cjs"))) {
    ChildProcess.execSync("yarn build", {
      cwd: tsRuntimeDir,
      stdio: "inherit",
    });
  }
  const destTsRuntime = path.resolve(
    "./build/extension/node_modules/@nanofuzz/runtime"
  );
  fs.mkdirSync(path.dirname(destTsRuntime), { recursive: true });
  fs.cpSync(tsRuntimeDir, destTsRuntime, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules`),
  });
  console.log("copied @nanofuzz/runtime");
}

// Build and copy Rust runtime crate (nanofuzz-runtime)
const rustRuntimeDir = path.resolve("./packages/runtime/rust");
if (fs.existsSync(rustRuntimeDir)) {
  const rustTargetDeps = path.join(rustRuntimeDir, "target", "debug", "deps");
  const hasRlib =
    fs.existsSync(rustTargetDeps) &&
    fs
      .readdirSync(rustTargetDeps)
      .some((f) => f.startsWith("libnanofuzz_runtime") && f.endsWith(".rlib"));

  if (!hasRlib) {
    const cargoBin = resolveCargo();
    if (cargoBin) {
      ChildProcess.execFileSync(cargoBin, ["build"], {
        cwd: rustRuntimeDir,
        stdio: "inherit",
      });
    } else {
      console.warn(
        "WARNING: Cargo not found. Rust runtime crate was not prebuilt (see ./CONTRIBUTING.md)"
      );
    }
  }

  const destRustRuntime = path.resolve("./build/extension/nanofuzz-runtime");
  fs.mkdirSync(destRustRuntime, { recursive: true });
  fs.cpSync(rustRuntimeDir, destRustRuntime, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}target`),
  });
  console.log("copied nanofuzz-runtime");
}

// Build and copy OCaml runtime library (nanofuzz_runtime)
const oxRuntimeDir = path.resolve("./packages/runtime/oxcaml");
if (fs.existsSync(oxRuntimeDir)) {
  const duneBin = resolveDune();
  if (duneBin) {
    try {
      const duneDir = path.dirname(duneBin);
      const pathEnvKey =
        Object.keys(process.env).find((k) => k.toLowerCase() === "path") ||
        "PATH";
      ChildProcess.execFileSync(duneBin, ["build"], {
        cwd: oxRuntimeDir,
        env: {
          ...process.env,
          [pathEnvKey]: `${duneDir}${path.delimiter}${process.env[pathEnvKey] || ""}`,
        },
        stdio: "inherit",
      });
    } catch {
      console.warn("WARNING: dune build failed for nanofuzz_runtime");
    }
  }

  const destOxRuntime = path.resolve(
    "./build/extension/nanofuzz_runtime_oxcaml"
  );
  fs.mkdirSync(destOxRuntime, { recursive: true });
  fs.cpSync(oxRuntimeDir, destOxRuntime, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}_build`),
  });
  console.log("copied nanofuzz_runtime_oxcaml");
}

// Build and copy Java runtime package (nanofuzz-runtime)
const javaRuntimeDir = path.resolve("./packages/runtime/java");
if (fs.existsSync(javaRuntimeDir)) {
  const javaTargetDir = path.join(javaRuntimeDir, "target");
  // Locate the versioned shaded runtime JAR
  const findJar = () => {
    if (!fs.existsSync(javaTargetDir)) return undefined;
    const files = fs.readdirSync(javaTargetDir);
    const jar = files.find(
      (f) =>
        f.startsWith("nanofuzz-runtime") &&
        f.endsWith(".jar") &&
        !f.includes("sources") &&
        !f.startsWith("original-")
    );
    return jar ? path.join(javaTargetDir, jar) : undefined;
  };

  let javaTargetJar = findJar();
  if (!javaTargetJar) {
    const mvnBin = resolveMaven();
    if (mvnBin) {
      ChildProcess.execFileSync(mvnBin, ["clean", "package", "-DskipTests"], {
        cwd: javaRuntimeDir,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      javaTargetJar = findJar();
    } else {
      throw new Error(
        "Maven (mvn) not found. Java runtime JAR cannot be built (see ./CONTRIBUTING.md)"
      );
    }
  }

  if (!javaTargetJar || !fs.existsSync(javaTargetJar)) {
    throw new Error(
      `Java runtime JAR was not found in ${javaTargetDir} after build.`
    );
  }

  const destJavaRuntime = path.resolve(
    "./build/extension/nanofuzz-runtime-java"
  );
  fs.mkdirSync(destJavaRuntime, { recursive: true });
  fs.cpSync(javaRuntimeDir, destJavaRuntime, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}target`),
  });
  fs.copyFileSync(
    javaTargetJar,
    path.join(destJavaRuntime, "nanofuzz-runtime.jar")
  );
  console.log("copied nanofuzz-runtime (java)");
}

// Copy Virgil runtime package (nanofuzz_runtime)
const virgilRuntimeDir = path.resolve("./packages/runtime/virgil");
if (fs.existsSync(virgilRuntimeDir)) {
  const destVirgilRuntime = path.resolve(
    "./build/extension/nanofuzz_runtime_virgil"
  );
  fs.mkdirSync(destVirgilRuntime, { recursive: true });
  fs.cpSync(virgilRuntimeDir, destVirgilRuntime, { recursive: true });
  console.log("copied nanofuzz_runtime_virgil");
}

// Copy Virgil tree-sitter WASM grammar
const virgilTreeSitterDir = path.resolve("./packages/tree-sitter-virgil");
if (fs.existsSync(virgilTreeSitterDir)) {
  const destTsVirgil = path.resolve(
    "./build/extension/node_modules/tree-sitter-virgil"
  );
  fs.mkdirSync(destTsVirgil, { recursive: true });
  fs.cpSync(virgilTreeSitterDir, destTsVirgil, { recursive: true });

  const destRootVirgil = path.resolve("./node_modules/tree-sitter-virgil");
  if (
    fs.existsSync(destRootVirgil) &&
    fs.lstatSync(destRootVirgil).isSymbolicLink()
  ) {
    fs.unlinkSync(destRootVirgil);
  }
  fs.mkdirSync(destRootVirgil, { recursive: true });
  fs.cpSync(virgilTreeSitterDir, destRootVirgil, { recursive: true });
  console.log("copied tree-sitter-virgil");
}

// Copy Python imports
let interpreter = "python";
if (!fs.existsSync(path.resolve(path.join(".", ".venv")))) {
  interpreter = "python";
  console.warn(
    `WARNING: Did not find Python virtual environment in ./.venv (see ./CONTRIBUTING.md)`
  );
} else {
  const venvBin = path.resolve(
    path.join(".", ".venv", process.platform === "win32" ? "Scripts" : "bin")
  );
  interpreter = path.resolve(path.join(venvBin, "python3"));
  if (!fs.existsSync(interpreter)) {
    interpreter = path.resolve(path.join(venvBin, "python"));
  }
}
[{ name: "coverage" }, { name: "msgpack" }].forEach((pkg) => {
  const libdir = resolvePythonModule(pkg.name, interpreter);
  if (libdir === undefined) {
    throw new Error(
      `Could not find Python package ${pkg.name}. Is it installed? (see ./CONTRIBUTING.md)`
    );
  }
  fs.cpSync(
    path.resolve(path.join(libdir, "..")),
    path.resolve(
      path.join(".", "build", "extension", "_nanofuzz_python", pkg.name)
    ),
    {
      recursive: true,
    }
  );
  const pycacheDir = path.resolve(
    path.join(
      ".",
      "build",
      "extension",
      "_nanofuzz_python",
      pkg.name,
      "__pycache__"
    )
  );
  if (fs.existsSync(pycacheDir)) {
    rimraf.sync(pycacheDir);
  }
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
    "tree-sitter-rust",
    "tree-sitter-ocaml",
    "tree-sitter-java",
    "tree-sitter-virgil",
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
  entryPoints: ["./src/ui/CommandLine.ts"],
  outfile: "./build/cli/cli.cjs",
  bundle: true,
  platform: "node",
  metafile: true,
  minify: false,
  format: "cjs",
  sourcemap: "both",
  banner: {
    js: "#!/usr/bin/env node",
  },
  tsconfig: "./tsconfig.json",
  external: [
    "path",
    "fs",
    "crypto",
    "typescript",
    "tree-sitter-python",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "tree-sitter-rust",
    "tree-sitter-ocaml",
    "tree-sitter-java",
    "tree-sitter-virgil",
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
fs.chmodSync("./build/cli/cli.cjs", 0o755);

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
  external: ["path", "fs", "crypto", "typescript"],
  plugins: [
    swapModulePlugin({
      vscode: "./spec/helpers/vscode.stub.js",
    }),
  ],
  define: {
    "process.env.BUILD_TARGET": JSON.stringify("vscode-exthost-worker"),
    "process.env.NANOFUZZ_VERSION": version,
  },
});

// HostWatchdogWorker
await esbuild.build({
  entryPoints: ["./src/fuzzer/runners/HostWatchdogWorker.ts"],
  outfile: "./build/workers/HostWatchdogWorker.js",
  bundle: true,
  platform: "node",
  metafile: true,
  minify: false,
  format: "cjs",
  sourcemap: "both",
  tsconfig: "./tsconfig.json",
  external: ["path", "fs", "crypto"],
  define: {
    "process.env.BUILD_TARGET": JSON.stringify("vscode-exthost-worker"),
    "process.env.NANOFUZZ_VERSION": version,
  },
});

// JavascriptRunnerHost
await esbuild.build({
  entryPoints: ["./src/fuzzer/runners/javascript/JavascriptRunnerHost.ts"],
  outfile: "./build/extension/JavascriptRunnerHost.js",
  bundle: true,
  platform: "node",
  metafile: true,
  minify: true,
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
    "tree-sitter-rust",
    "tree-sitter-ocaml",
    "tree-sitter-java",
    "tree-sitter-virgil",
    "web-tree-sitter",
  ],
  define: {
    "process.env.BUILD_TARGET": JSON.stringify("vscode-exthost-spawn"),
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

/**
 * Resolves a Python module name by calling Python.
 * If found, returns the absolute path to the module/package file.
 * Otherwise, returns `undefined`.
 *
 * @param moduleName The dotted Python module name to resolve (e.g., "json", "numpy", "my_package.utils")
 * @returns Path to the module file or undefined if not found
 */
function resolvePythonModule(moduleName, interpreter = "python3") {
  const output = ChildProcess.execFileSync(
    interpreter,
    [
      "-c",
      `
import importlib.util, json
spec = importlib.util.find_spec("${moduleName}")
if spec and spec.origin:
  print(spec.origin)
else:
  print("")
`,
    ],
    { encoding: "utf8" }
  ).trim();

  // If output is empty or "None" (namespace packages without an origin file sometimes return None)
  if (output && output !== "None") {
    return output;
  } else {
    return undefined;
  }
}

/**
 * Resolves the cargo executable location.
 *
 * @returns Path to the cargo executable or undefined if not found
 */
function resolveCargo() {
  const cargoBinName = process.platform === "win32" ? "cargo.exe" : "cargo";
  const candidates = [];
  if (process.env.CARGO_HOME) {
    candidates.push(path.join(process.env.CARGO_HOME, "bin", cargoBinName));
  }
  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, ".cargo", "bin", cargoBinName));
  }
  candidates.push(cargoBinName);

  for (const candidate of candidates) {
    try {
      const res = ChildProcess.spawnSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (res.status === 0) {
        return candidate;
      }
    } catch {
      // not found or not executable
    }
  }
  return undefined;
} // fn: resolveCargo

/**
 * Resolves the dune executable location.
 *
 * @returns Path to the dune executable or undefined if not found
 */
function resolveDune() {
  const duneBinName = process.platform === "win32" ? "dune.exe" : "dune";
  const candidates = [];
  if (process.env.OPAM_SWITCH_PREFIX) {
    candidates.push(
      path.join(process.env.OPAM_SWITCH_PREFIX, "bin", duneBinName)
    );
  }
  const home = os.homedir();
  if (home) {
    const opamDir = path.join(home, ".opam");
    if (fs.existsSync(opamDir)) {
      try {
        const switches = fs.readdirSync(opamDir);
        for (const sw of switches) {
          candidates.push(path.join(opamDir, sw, "bin", duneBinName));
        }
      } catch {
        // ignore
      }
    }
  }
  candidates.push(duneBinName);
  for (const candidate of candidates) {
    try {
      const res = ChildProcess.spawnSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (res.status === 0) {
        return candidate;
      }
    } catch {
      // not found or not executable
    }
  }
  return undefined;
} // fn: resolveDune

/**
 * Resolves the maven (mvn) executable location.
 *
 * @returns Path to the mvn executable or undefined if not found
 */
function resolveMaven() {
  const mvnBinName = process.platform === "win32" ? "mvn.cmd" : "mvn";
  const candidates = [];
  if (process.env.M2_HOME) {
    candidates.push(path.join(process.env.M2_HOME, "bin", mvnBinName));
  }
  if (process.env.MAVEN_HOME) {
    candidates.push(path.join(process.env.MAVEN_HOME, "bin", mvnBinName));
  }
  candidates.push(mvnBinName);
  for (const candidate of candidates) {
    try {
      const res = ChildProcess.spawnSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: "pipe",
        shell: process.platform === "win32",
      });
      if (res.status === 0) {
        return candidate;
      }
    } catch {
      // not found or not executable
    }
  }
  return undefined;
} // fn: resolveMaven
