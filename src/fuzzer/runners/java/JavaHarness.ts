import fs from "node:fs";
import path from "node:path";
import { FileCoverageData } from "istanbul-lib-coverage";
import * as Parser from "../../adapters/ParserAdapter";
import { FuzzEnv } from "../../Types";
import { findInAncestor } from "../../Util";
import * as Config from "../../../Config";
import { parseCoverageScope } from "../../measures/Util";
import { CoverageScopeConfig } from "../../measures/Types";

/**
 * Builds and returns the static coverage maps and manifest for testing a Java target.
 *
 * @param targetFile Source file containing the target method
 * @param fnName Name of the method to test
 * @param env Optional FuzzEnv
 * @returns Object containing target static coverage and multi-file project coverage maps
 */
export function buildJavaHarness(
  targetFile: string,
  _fnName?: string,
  _env?: FuzzEnv
): {
  staticCov: FileCoverageData;
  staticCovMap: Record<string, FileCoverageData>;
  branchSpecsMap: Record<string, JavaBranchSpec[]>;
} {
  const normTarget = fs.existsSync(targetFile)
    ? fs.realpathSync(path.resolve(targetFile))
    : path.resolve(targetFile);

  if (!fs.existsSync(normTarget)) {
    throw new Error(`Target file does not exist: ${normTarget}`);
  }

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
    // fallback to project scope
  }

  // Extract static coverage for target file
  const targetSrc = fs.readFileSync(normTarget, "utf8");
  const targetExtraction = extractJavaStaticCoverage(targetSrc, normTarget);

  const staticCovMap: Record<string, FileCoverageData> = {
    [normTarget.replace(/\\/g, "/")]: targetExtraction.staticCov,
  };
  const branchSpecsMap: Record<string, JavaBranchSpec[]> = {
    [normTarget.replace(/\\/g, "/")]: targetExtraction.branchSpecs,
  };

  // Discover local project source files if project scope is active
  if (scopeConfig.target.includes("project")) {
    const pomFile = findInAncestor(path.dirname(normTarget), "pom.xml");
    const gradleFile =
      findInAncestor(path.dirname(normTarget), "build.gradle") ??
      findInAncestor(path.dirname(normTarget), "build.gradle.kts");

    let srcRoots: string[] = [];
    if (pomFile || gradleFile) {
      const projDir = path.dirname((pomFile ?? gradleFile)!);
      const standardSrc = path.join(projDir, "src", "main", "java");
      if (fs.existsSync(standardSrc)) {
        srcRoots.push(standardSrc);
      } else {
        srcRoots.push(projDir);
      }
    } else {
      srcRoots.push(path.dirname(normTarget));
    }

    for (const root of srcRoots) {
      const javaFiles = findJavaFilesRecursive(root);
      for (const jf of javaFiles) {
        const fullPath = fs.existsSync(jf)
          ? fs.realpathSync(jf)
          : path.resolve(jf);
        const normKey = fullPath.replace(/\\/g, "/");
        if (normKey === normTarget.replace(/\\/g, "/")) continue;

        try {
          const src = fs.readFileSync(fullPath, "utf8");
          const extraction = extractJavaStaticCoverage(src, fullPath);
          staticCovMap[normKey] = extraction.staticCov;
          branchSpecsMap[normKey] = extraction.branchSpecs;
        } catch {
          // Ignore individual file parse errors during project discovery
        }
      }
    }
  }

  return {
    staticCov: targetExtraction.staticCov,
    staticCovMap,
    branchSpecsMap,
  };
} // fn: buildJavaHarness

/**
 * Extracts static Istanbul coverage schema (statements, methods, and branches)
 * from Java source code using Tree-sitter.
 *
 * @param src Java source code string
 * @param targetFile Path to the source file
 * @returns Static FileCoverageData and branch specification metadata
 */
export function extractJavaStaticCoverage(
  src: string,
  targetFile: string = ""
): {
  staticCov: FileCoverageData;
  branchSpecs: JavaBranchSpec[];
} {
  const tree = Parser.parse("java", src);
  if (!tree) {
    throw new Error("Parser failed to parse Java source for static coverage");
  }

  const statementMap: FileCoverageData["statementMap"] = {};
  const fnMap: FileCoverageData["fnMap"] = {};
  const branchMap: FileCoverageData["branchMap"] = {};
  const s: FileCoverageData["s"] = {};
  const f: FileCoverageData["f"] = {};
  const b: FileCoverageData["b"] = {};
  const branchSpecs: JavaBranchSpec[] = [];

  let sIdx = 0;
  let fIdx = 0;
  let bIdx = 0;

  // Methods and Constructors
  const fnQuery = Parser.query(
    "java",
    `
(method_declaration
  name: (identifier) @fn.name
  body: (block) @fn.body) @fn.item

(constructor_declaration
  name: (identifier) @fn.name
  body: (constructor_body) @fn.body) @fn.item
`
  );
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const m of fnMatches) {
    const itemNode = m.captures.find((c) => c.name === "fn.item")?.node;
    const nameNode = m.captures.find((c) => c.name === "fn.name")?.node;
    const bodyNode = m.captures.find((c) => c.name === "fn.body")?.node;
    if (!itemNode || !nameNode || !bodyNode) continue;

    const currentFIdx = String(fIdx++);
    fnMap[currentFIdx] = {
      name: nameNode.text,
      decl: {
        start: {
          line: itemNode.startPosition.row + 1,
          column: itemNode.startPosition.column,
        },
        end: {
          line: itemNode.startPosition.row + 1,
          column: itemNode.startPosition.column + itemNode.text.length,
        },
      },
      loc: {
        start: {
          line: bodyNode.startPosition.row + 1,
          column: bodyNode.startPosition.column,
        },
        end: {
          line: bodyNode.endPosition.row + 1,
          column: bodyNode.endPosition.column,
        },
      },
      line: itemNode.startPosition.row + 1,
    };
    f[currentFIdx] = 0;

    // Collect statements within the method/constructor body
    collectStatementsFromBlock(bodyNode, (stmtNode) => {
      const currentSIdx = String(sIdx++);
      statementMap[currentSIdx] = {
        start: {
          line: stmtNode.startPosition.row + 1,
          column: stmtNode.startPosition.column,
        },
        end: {
          line: stmtNode.endPosition.row + 1,
          column: stmtNode.endPosition.column,
        },
      };
      s[currentSIdx] = 0;
    });
  }

  // If statements
  const ifQuery = Parser.query(
    "java",
    `
(if_statement
  condition: (parenthesized_expression)
  consequence: (_) @if.then
  alternative: (_)? @if.else) @if.item
`
  );
  const ifMatches = ifQuery.matches(tree.rootNode);

  for (const m of ifMatches) {
    const itemNode = m.captures.find((c) => c.name === "if.item")?.node;
    const thenNode = m.captures.find((c) => c.name === "if.then")?.node;
    const elseNode = m.captures.find((c) => c.name === "if.else")?.node;
    if (!itemNode || !thenNode) continue;

    const currentBIdx = String(bIdx++);
    const hasElse = !!elseNode;

    const loc0 = {
      start: {
        line: thenNode.startPosition.row + 1,
        column: thenNode.startPosition.column,
      },
      end: {
        line: thenNode.endPosition.row + 1,
        column: thenNode.endPosition.column,
      },
    };

    const loc1 = elseNode
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
            line: itemNode.startPosition.row + 1,
            column: itemNode.startPosition.column,
          },
          end: {
            line: itemNode.endPosition.row + 1,
            column: itemNode.endPosition.column,
          },
        };

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
      locations: [loc0, loc1],
      line: itemNode.startPosition.row + 1,
    };
    b[currentBIdx] = [0, 0];

    const thenExecLine = getExecutableLine(thenNode);
    const elseExecLine = elseNode
      ? getExecutableLine(elseNode)
      : itemNode.startPosition.row + 1;

    branchSpecs.push({
      id: currentBIdx,
      line: itemNode.startPosition.row + 1,
      type: "if",
      armCount: 2,
      armLines: [thenExecLine, elseExecLine],
      hasElse,
    });
  }

  // Ternary expressions
  const ternaryQuery = Parser.query(
    "java",
    `
(ternary_expression
  consequence: (_) @ternary.then
  alternative: (_) @ternary.else) @ternary.item
`
  );
  const ternaryMatches = ternaryQuery.matches(tree.rootNode);

  for (const m of ternaryMatches) {
    const itemNode = m.captures.find((c) => c.name === "ternary.item")?.node;
    const thenNode = m.captures.find((c) => c.name === "ternary.then")?.node;
    const elseNode = m.captures.find((c) => c.name === "ternary.else")?.node;
    if (!itemNode || !thenNode || !elseNode) continue;

    const currentBIdx = String(bIdx++);
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
      type: "cond-expr",
      locations: [
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
        {
          start: {
            line: elseNode.startPosition.row + 1,
            column: elseNode.startPosition.column,
          },
          end: {
            line: elseNode.endPosition.row + 1,
            column: elseNode.endPosition.column,
          },
        },
      ],
      line: itemNode.startPosition.row + 1,
    };
    b[currentBIdx] = [0, 0];

    branchSpecs.push({
      id: currentBIdx,
      line: itemNode.startPosition.row + 1,
      type: "cond-expr",
      armCount: 2,
      armLines: [
        thenNode.startPosition.row + 1,
        elseNode.startPosition.row + 1,
      ],
    });
  }

  // Switch statements and expressions
  const switchQuery = Parser.query(
    "java",
    `
(switch_expression (switch_block) @sw.block) @sw.item
`
  );
  const switchMatches = switchQuery.matches(tree.rootNode);

  for (const m of switchMatches) {
    const itemNode = m.captures.find((c) => c.name === "sw.item")?.node;
    const blockNode = m.captures.find((c) => c.name === "sw.block")?.node;
    if (!itemNode || !blockNode) continue;

    const armLocations: Array<{
      start: { line: number; column: number };
      end: { line: number; column: number };
    }> = [];
    const armLines: number[] = [];

    for (let i = 0; i < blockNode.childCount; i++) {
      const child = blockNode.child(i);
      if (!child) continue;
      if (
        child.type === "switch_rule" ||
        child.type === "switch_block_statement_group"
      ) {
        armLocations.push({
          start: {
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          },
          end: {
            line: child.endPosition.row + 1,
            column: child.endPosition.column,
          },
        });
        armLines.push(child.startPosition.row + 1);
      }
    }

    if (armLocations.length > 0) {
      const currentBIdx = String(bIdx++);
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
        type: "switch",
        locations: armLocations,
        line: itemNode.startPosition.row + 1,
      };
      b[currentBIdx] = new Array(armLocations.length).fill(0);

      branchSpecs.push({
        id: currentBIdx,
        line: itemNode.startPosition.row + 1,
        type: "switch",
        armCount: armLocations.length,
        armLines,
      });
    }
  }

  const staticCov: FileCoverageData = {
    path: targetFile.replace(/\\/g, "/"),
    statementMap,
    fnMap,
    branchMap,
    s,
    f,
    b,
  };

  return {
    staticCov,
    branchSpecs,
  };
} // fn: extractJavaStaticCoverage

/**
 * Maps dynamic JaCoCo line and branch execution metrics onto an Istanbul FileCoverageData schema.
 *
 * @param staticCovMap Static coverage maps for all project files
 * @param jacocoCoverage Execution coverage reported by JVM host JaCoCo agent
 * @param branchSpecsMap Optional branch specifications by file
 * @returns Updated Record of FileCoverageData populated with single-run hit counts
 */
export function mapDynamicCoverage(
  staticCovMap: Record<string, FileCoverageData>,
  jacocoCoverage: Record<string, JacocoClassCoverage>,
  branchSpecsMap?: Record<string, JavaBranchSpec[]>
): Record<string, FileCoverageData> {
  const result: Record<string, FileCoverageData> = {};

  for (const [filePath, staticCov] of Object.entries(staticCovMap)) {
    const fileCov: FileCoverageData = {
      path: staticCov.path,
      statementMap: { ...staticCov.statementMap },
      fnMap: { ...staticCov.fnMap },
      branchMap: { ...staticCov.branchMap },
      s: {},
      f: {},
      b: {},
    };

    for (const sk of Object.keys(staticCov.s)) {
      fileCov.s[sk] = 0;
    }
    for (const fk of Object.keys(staticCov.f)) {
      fileCov.f[fk] = 0;
    }
    for (const bk of Object.keys(staticCov.b)) {
      fileCov.b[bk] = staticCov.b[bk].map(() => 0);
    }

    const baseName = path.basename(filePath);
    const classNameWithoutExt = path.basename(filePath, ".java");

    // Locate matching class in JaCoCo coverage by sourceFileName or class name
    let classCov: JacocoClassCoverage | undefined;
    for (const cName of Object.keys(jacocoCoverage)) {
      const cc = jacocoCoverage[cName];
      if (
        cc.sourceFileName === baseName ||
        cc.name === classNameWithoutExt ||
        cc.name.endsWith("/" + classNameWithoutExt) ||
        cc.name.endsWith("." + classNameWithoutExt)
      ) {
        classCov = cc;
        break;
      }
    }

    if (classCov) {
      // Statements
      for (const [sKey, stmtRange] of Object.entries(fileCov.statementMap)) {
        const lineStr = String(stmtRange.start.line);
        const lInfo = classCov.lines[lineStr];
        if (lInfo && lInfo.coveredInstructions > 0) {
          fileCov.s[sKey] = 1;
        }
      }

      // Functions
      for (const [fKey, fnInfo] of Object.entries(fileCov.fnMap)) {
        const mInfo = classCov.methods[fnInfo.name];
        if (mInfo && mInfo.coveredInstructions > 0) {
          fileCov.f[fKey] = 1;
        } else {
          // Check line ranges
          let hit = false;
          for (let l = fnInfo.loc.start.line; l <= fnInfo.loc.end.line; l++) {
            if ((classCov.lines[String(l)]?.coveredInstructions ?? 0) > 0) {
              hit = true;
              break;
            }
          }
          if (hit) {
            fileCov.f[fKey] = 1;
          }
        }
      }

      // Branches
      const specs = branchSpecsMap?.[filePath] ?? [];
      for (const [bKey, branchInfo] of Object.entries(fileCov.branchMap)) {
        const spec = specs.find((sp) => sp.id === bKey);
        const lineStr = String(branchInfo.line);
        const lineInfo = classCov.lines[lineStr];

        if (branchInfo.type === "if") {
          const hasElse =
            spec?.hasElse ??
            (branchInfo.locations.length > 1 &&
              branchInfo.locations[1].start.line !== branchInfo.loc.start.line);
          const thenLine = spec
            ? spec.armLines[0]
            : branchInfo.locations[0].start.line;
          const thenHit =
            (classCov.lines[String(thenLine)]?.coveredInstructions ?? 0) > 0;

          if (thenHit) {
            fileCov.b[bKey][0] = 1;
          }

          if (hasElse) {
            const elseLine = spec
              ? spec.armLines[1]
              : branchInfo.locations[1].start.line;
            const elseHit =
              (classCov.lines[String(elseLine)]?.coveredInstructions ?? 0) > 0;
            if (elseHit) {
              fileCov.b[bKey][1] = 1;
            }
          } else {
            // Bypass logic for if without else
            if (lineInfo) {
              if (lineInfo.coveredBranches >= 2) {
                fileCov.b[bKey][0] = 1;
                fileCov.b[bKey][1] = 1;
              } else if (lineInfo.coveredBranches === 1) {
                if (thenHit) {
                  fileCov.b[bKey][0] = 1;
                  fileCov.b[bKey][1] = 0;
                } else {
                  fileCov.b[bKey][0] = 0;
                  fileCov.b[bKey][1] = 1;
                }
              } else if (lineInfo.coveredInstructions > 0 && !thenHit) {
                fileCov.b[bKey][1] = 1;
              }
            }
          }
        } else if (branchInfo.type === "switch") {
          for (let a = 0; a < branchInfo.locations.length; a++) {
            const armLine = branchInfo.locations[a].start.line;
            if (
              (classCov.lines[String(armLine)]?.coveredInstructions ?? 0) > 0
            ) {
              fileCov.b[bKey][a] = 1;
            }
          }
        } else if (branchInfo.type === "cond-expr") {
          const thenLine = branchInfo.locations[0].start.line;
          const elseLine = branchInfo.locations[1].start.line;
          const thenHit =
            (classCov.lines[String(thenLine)]?.coveredInstructions ?? 0) > 0;
          const elseHit =
            (classCov.lines[String(elseLine)]?.coveredInstructions ?? 0) > 0;

          if (thenHit) fileCov.b[bKey][0] = 1;
          if (elseHit) fileCov.b[bKey][1] = 1;

          if (
            thenLine === elseLine &&
            lineInfo &&
            lineInfo.coveredInstructions > 0
          ) {
            if (lineInfo.coveredBranches >= 2 || lineInfo.status === 2) {
              fileCov.b[bKey][0] = 1;
              fileCov.b[bKey][1] = 1;
            } else {
              fileCov.b[bKey][0] = 1;
            }
          }
        }
      }
    }

    result[filePath] = fileCov;
  }

  return result;
} // fn: mapDynamicCoverage

/**
 * Traverses a block syntax node and collects non-comment, non-punctuation statements.
 *
 * @param node Block node to traverse
 * @param callback Callback invoked for each statement node
 */
function collectStatementsFromBlock(
  node: Parser.SyntaxNode,
  callback: (stmtNode: Parser.SyntaxNode) => void
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (
      child.type === "{" ||
      child.type === "}" ||
      child.type === "line_comment" ||
      child.type === "block_comment"
    ) {
      continue;
    }

    callback(child);

    // Recursively collect from nested blocks if present (e.g. block inside if/while)
    if (child.type === "block") {
      collectStatementsFromBlock(child, callback);
    }
  }
} // fn: collectStatementsFromBlock

/**
 * Returns the line number of the first executable statement or expression within a node.
 *
 * @param node SyntaxNode to analyze
 * @returns 1-based line number of executable statement
 */
function getExecutableLine(node: Parser.SyntaxNode): number {
  if (node.type === "block" || node.type === "constructor_body") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (
        child.type !== "{" &&
        child.type !== "}" &&
        child.type !== "line_comment" &&
        child.type !== "block_comment"
      ) {
        return getExecutableLine(child);
      }
    }
    return node.endPosition.row + 1;
  }
  if (node.type === "switch_rule") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (
        child.type === "block" ||
        child.type === "expression_statement" ||
        child.type === "throw_statement"
      ) {
        return getExecutableLine(child);
      }
    }
  }
  return node.startPosition.row + 1;
} // fn: getExecutableLine

/**
 * Recursively locates all .java files within a root directory.
 *
 * @param dir Directory to search
 * @returns Array of absolute paths to .java source files
 */
function findJavaFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "target" ||
          entry.name === "build" ||
          entry.name === ".git" ||
          entry.name === "node_modules"
        ) {
          continue;
        }
        results.push(...findJavaFilesRecursive(full));
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        results.push(full);
      }
    }
  } catch {
    // Ignore permission or scandir errors on restricted subdirectories
  }
  return results;
} // fn: findJavaFilesRecursive

/**
 * Metadata for tracking branch behavior and line numbers.
 */
export interface JavaBranchSpec {
  id: string;
  line: number;
  type: "if" | "switch" | "cond-expr";
  armCount: number;
  armLines: number[];
  hasElse?: boolean;
}

/**
 * JaCoCo execution data for a single line.
 */
export interface JacocoLineData {
  status: number;
  coveredInstructions: number;
  totalInstructions: number;
  coveredBranches: number;
  totalBranches: number;
}

/**
 * JaCoCo execution data for a single method.
 */
export interface JacocoMethodData {
  name: string;
  desc?: string;
  coveredInstructions: number;
  totalInstructions: number;
}

/**
 * JaCoCo execution coverage for an analyzed class.
 */
export interface JacocoClassCoverage {
  name: string;
  sourceFileName?: string;
  lines: Record<string, JacocoLineData>;
  methods: Record<string, JacocoMethodData>;
}
