import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import { FileCoverageData } from "istanbul-lib-coverage";
import { VirgilCompiler } from "../../compilers/virgil/VirgilCompiler";
import { VirgilProgram } from "../../analysis/virgil/VirgilProgram";
import { FuzzEnv } from "../../Types";
import * as Parser from "../../adapters/ParserAdapter";
import * as Config from "../../../Config";
import { parseCoverageScope } from "../../measures/Util";
import { CoverageScopeConfig } from "../../measures/Types";

const HARNESS_TEMPLATE_VER = "VirgilHarness-0.4.1";

const _instrumentCache = new Map<
  string,
  {
    instrumentedSrc: string;
    staticCov: FileCoverageData;
    branchArms: Array<[number, number]>;
  }
>();

/**
 * Builds and returns the compiled Virgil harness executable for testing a target function.
 */
export function buildVirgilHarness(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv,
  tmpDir?: string
): {
  binaryPath: string;
  harnessDir: string;
  staticCov: FileCoverageData;
  staticCovMap: Record<string, FileCoverageData>;
} {
  const normTarget = fs.existsSync(targetFile)
    ? fs.realpathSync(path.resolve(targetFile))
    : path.resolve(targetFile);
  if (!fs.existsSync(normTarget)) {
    throw new Error(`Target file does not exist: ${normTarget}`);
  }

  const baseTmp =
    tmpDir ?? path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "virgil");
  fs.mkdirSync(baseTmp, { recursive: true });

  const coverageScopeRaw = Config.get<unknown>(
    "nanofuzz.fuzzer.coverageScope",
    "project static"
  );
  let scopeConfig: CoverageScopeConfig = {
    target: "project",
    collectStaticCoverage: true,
  };
  try {
    scopeConfig = parseCoverageScope(coverageScopeRaw);
  } catch {
    // default scope
  }

  const targetSrc = fs.readFileSync(normTarget, "utf8");
  const targetCov = instrumentVirgilSource(targetSrc, normTarget, 0);

  const staticCovMap: Record<string, FileCoverageData> = {
    [normTarget.replace(/\\/g, "/")]: targetCov.staticCov,
  };

  const localModules: string[] = [];
  if (scopeConfig.target.includes("project")) {
    const discovered = VirgilProgram.findLocalModules(normTarget);
    for (const d of discovered) {
      if (d !== normTarget && !localModules.includes(d)) {
        localModules.push(d);
      }
    }
  }

  const externalImports: string[] = [];
  if (scopeConfig.target.includes("directimports")) {
    const directImports = VirgilProgram.findDirectImports(normTarget);
    for (const imp of directImports) {
      if (!externalImports.includes(imp)) {
        externalImports.push(imp);
      }
    }
  }

  const allTrackedFiles = [normTarget, ...localModules];

  const cacheKey = crypto
    .createHash("sha256")
    .update(
      `${normTarget}:${fnName}:${allTrackedFiles.sort().join(",")}:${scopeConfig.target}:${HARNESS_TEMPLATE_VER}:${targetSrc}`
    )
    .digest("hex");

  const harnessDir = path.join(baseTmp, `harness-${cacheKey.slice(0, 16)}`);
  fs.mkdirSync(harnessDir, { recursive: true });
  const binaryPath = path.join(harnessDir, "harness_bin");

  const runtimeV3Src = path.resolve(
    __dirname,
    "../../../../packages/runtime/virgil/nanofuzz_runtime.v3"
  );
  const runtimeDest = path.join(harnessDir, "nanofuzz_runtime.v3");
  if (fs.existsSync(runtimeV3Src)) {
    fs.copyFileSync(runtimeV3Src, runtimeDest);
  } else {
    // Generate minimal fallback runtime if package path not found
    fs.writeFileSync(
      runtimeDest,
      `component NanofuzzCoverage {
    var stmt_hits: Array<int> = Array<int>.new(4096);
    var fn_hits: Array<int> = Array<int>.new(1024);
    var branch_hits: Array<int> = Array<int>.new(4096);
    def hit_stmt(f: int, s: int) {}
    def hit_fn(f: int, fn: int) {}
    def hit_branch(f: int, b: int, a: int) {}
}\n`
    );
  }

  // Write instrumented target file
  const instTargetFile = path.join(harnessDir, path.basename(normTarget));
  fs.writeFileSync(instTargetFile, targetCov.instrumentedSrc);

  // Write instrumented local module files
  const instLocalFiles: string[] = [];
  for (let i = 0; i < localModules.length; i++) {
    const locFile = localModules[i];
    const locSrc = fs.readFileSync(locFile, "utf8");
    const locCov = instrumentVirgilSource(locSrc, locFile, i + 1);
    staticCovMap[locFile.replace(/\\/g, "/")] = locCov.staticCov;
    const destLoc = path.join(harnessDir, `loc_${i}_${path.basename(locFile)}`);
    fs.writeFileSync(destLoc, locCov.instrumentedSrc);
    instLocalFiles.push(destLoc);
  }

  // Generate harness host runner
  const harnessSrc = generateVirgilHarnessHost(fnName, targetCov.branchArms);
  const harnessFile = path.join(harnessDir, "harness_host.v3");
  fs.writeFileSync(harnessFile, harnessSrc);

  const v3c = VirgilCompiler.resolveV3c();
  if (v3c && !fs.existsSync(binaryPath)) {
    const filesToCompile = [
      runtimeDest,
      instTargetFile,
      ...instLocalFiles,
      harnessFile,
    ];
    const args = [`-output=${binaryPath}`, ...filesToCompile];
    ChildProcess.spawnSync(v3c, args, {
      cwd: harnessDir,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  return {
    binaryPath,
    harnessDir,
    staticCov: targetCov.staticCov,
    staticCovMap,
  };
} // fn: buildVirgilHarness

/**
 * Instruments a Virgil source code string to record statement, function, and branch coverage.
 */
export function instrumentVirgilSource(
  src: string,
  targetFile: string,
  fileId: number = 0
): {
  instrumentedSrc: string;
  staticCov: FileCoverageData;
  branchArms: Array<[number, number]>;
} {
  const cacheKey = crypto
    .createHash("sha256")
    .update(`${targetFile}:${fileId}:${src}`)
    .digest("hex");

  if (_instrumentCache.has(cacheKey)) {
    const cached = _instrumentCache.get(cacheKey)!;
    return {
      instrumentedSrc: cached.instrumentedSrc,
      staticCov: structuredClone(cached.staticCov),
      branchArms: [...cached.branchArms],
    };
  }

  const tree = Parser.parse("virgil", src);
  if (!tree) {
    throw new Error(`Failed to parse Virgil source: ${targetFile}`);
  }

  const statementMap: FileCoverageData["statementMap"] = {};
  const fnMap: FileCoverageData["fnMap"] = {};
  const branchMap: FileCoverageData["branchMap"] = {};
  const s: FileCoverageData["s"] = {};
  const f: FileCoverageData["f"] = {};
  const b: FileCoverageData["b"] = {};
  const branchArms: Array<[number, number]> = [];

  const insertions: Array<{ pos: number; text: string }> = [];

  let sIdx = 0;
  let fIdx = 0;
  let bIdx = 0;

  // 1. Function Coverage
  const fnQuery = Parser.query(
    "virgil",
    `
(method
  name: (ident_param name: (identifier) @method.name)
  body: (method_body (block_stmt) @method.block)) @method.item
`
  );
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const match of fnMatches) {
    const nameNode = match.captures.find((c) => c.name === "method.name")?.node;
    const blockNode = match.captures.find(
      (c) => c.name === "method.block"
    )?.node;
    if (!nameNode || !blockNode) continue;

    const currentFIdx = String(fIdx++);
    const fnName = nameNode.text.trim();
    fnMap[currentFIdx] = {
      name: fnName,
      decl: {
        start: {
          line: nameNode.startPosition.row + 1,
          column: nameNode.startPosition.column,
        },
        end: {
          line: nameNode.endPosition.row + 1,
          column: nameNode.endPosition.column,
        },
      },
      loc: {
        start: {
          line: blockNode.startPosition.row + 1,
          column: blockNode.startPosition.column,
        },
        end: {
          line: blockNode.endPosition.row + 1,
          column: blockNode.endPosition.column,
        },
      },
      line: nameNode.startPosition.row + 1,
    };
    f[currentFIdx] = 0;

    // Insert probe immediately after the opening '{'
    insertions.push({
      pos: blockNode.startIndex + 1,
      text: ` NanofuzzCoverage.hit_fn(${fileId}, ${currentFIdx}); `,
    });
  }

  // 2. Statement Coverage
  const stmtQuery = Parser.query(
    "virgil",
    `
[
  (return_stmt) @stmt.item
  (expr_stmt) @stmt.item
  (var_stmt) @stmt.item
]
`
  );
  const stmtMatches = stmtQuery.matches(tree.rootNode);

  for (const match of stmtMatches) {
    const itemNode = match.captures.find((c) => c.name === "stmt.item")?.node;
    if (!itemNode) continue;

    const currentSIdx = String(sIdx++);
    statementMap[currentSIdx] = {
      start: {
        line: itemNode.startPosition.row + 1,
        column: itemNode.startPosition.column,
      },
      end: {
        line: itemNode.endPosition.row + 1,
        column: itemNode.endPosition.column,
      },
    };
    s[currentSIdx] = 0;

    insertions.push({
      pos: itemNode.startIndex,
      text: `NanofuzzCoverage.hit_stmt(${fileId}, ${currentSIdx}); `,
    });
  }

  // 3. Branch Coverage (if / else)
  const ifQuery = Parser.query(
    "virgil",
    `
(if_stmt) @if.item
`
  );
  const ifMatches = ifQuery.matches(tree.rootNode);

  for (const match of ifMatches) {
    const itemNode = match.captures.find((c) => c.name === "if.item")?.node;
    if (!itemNode) continue;

    const namedChildren = itemNode.namedChildren;
    if (namedChildren.length < 2) continue;

    const thenNode = namedChildren[1];
    const elseNode = namedChildren.length > 2 ? namedChildren[2] : undefined;

    const currentBIdx = String(bIdx++);
    branchArms.push([Number(currentBIdx), 2]);

    const locations = [
      {
        start: {
          line: thenNode.startPosition.row + 1,
          column: thenNode.startPosition.column,
        },
        end: {
          line: thenNode.endPosition.row + 1,
          column: thenNode.endPosition.column,
        },
      },
      elseNode
        ? {
            start: {
              line: elseNode.startPosition.row + 1,
              column: elseNode.startPosition.column,
            },
            end: {
              line: elseNode.endPosition.row + 1,
              column: elseNode.endPosition.column,
            },
          }
        : {
            start: {
              line: itemNode.endPosition.row + 1,
              column: itemNode.endPosition.column,
            },
            end: {
              line: itemNode.endPosition.row + 1,
              column: itemNode.endPosition.column,
            },
          },
    ];

    branchMap[currentBIdx] = {
      loc: {
        start: {
          line: itemNode.startPosition.row + 1,
          column: itemNode.startPosition.column,
        },
        end: {
          line: itemNode.endPosition.row + 1,
          column: itemNode.endPosition.column,
        },
      },
      type: "if",
      locations,
      line: itemNode.startPosition.row + 1,
    };
    b[currentBIdx] = [0, 0];

    // Consequent branch probe
    if (thenNode.type === "block_stmt") {
      insertions.push({
        pos: thenNode.startIndex + 1,
        text: ` NanofuzzCoverage.hit_branch(${fileId}, ${currentBIdx}, 0); `,
      });
    } else {
      insertions.push({
        pos: thenNode.startIndex,
        text: `{ NanofuzzCoverage.hit_branch(${fileId}, ${currentBIdx}, 0); `,
      });
      insertions.push({
        pos: thenNode.endIndex,
        text: ` }`,
      });
    }

    // Alternative branch probe
    if (elseNode) {
      if (elseNode.type === "block_stmt") {
        insertions.push({
          pos: elseNode.startIndex + 1,
          text: ` NanofuzzCoverage.hit_branch(${fileId}, ${currentBIdx}, 1); `,
        });
      } else {
        insertions.push({
          pos: elseNode.startIndex,
          text: `{ NanofuzzCoverage.hit_branch(${fileId}, ${currentBIdx}, 1); `,
        });
        insertions.push({
          pos: elseNode.endIndex,
          text: ` }`,
        });
      }
    } else {
      // Synthetic else branch for bypass
      insertions.push({
        pos: thenNode.endIndex,
        text: ` else { NanofuzzCoverage.hit_branch(${fileId}, ${currentBIdx}, 1); }`,
      });
    }
  }

  // Sort insertions from end to start to preserve character offsets
  insertions.sort((a, bPos) => bPos.pos - a.pos);

  let instrumentedSrc = src;
  for (const ins of insertions) {
    instrumentedSrc =
      instrumentedSrc.slice(0, ins.pos) +
      ins.text +
      instrumentedSrc.slice(ins.pos);
  }

  const staticCov: FileCoverageData = {
    path: targetFile,
    statementMap,
    fnMap,
    branchMap,
    s,
    f,
    b,
  };

  const res = {
    instrumentedSrc,
    staticCov,
    branchArms,
  };
  _instrumentCache.set(cacheKey, res);

  return {
    instrumentedSrc,
    staticCov: structuredClone(staticCov),
    branchArms: [...branchArms],
  };
} // fn: instrumentVirgilSource

function generateVirgilHarnessHost(
  _fnName: string,
  _branchArms: Array<[number, number]>
): string {
  return `// Auto-generated NaNofuzz Virgil harness host
def main() {
    System.puts("READY\\n");
}
`;
}
