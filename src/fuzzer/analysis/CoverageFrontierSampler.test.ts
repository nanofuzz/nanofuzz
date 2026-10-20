import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import seedrandom from "seedrandom";
import {
  CoverageFrontierSampler,
  formatFrontierContext,
} from "./CoverageFrontierSampler";
import {
  CodeCoverageMeasureStats,
  CoverageMeasure,
  CoverageMeasurement,
} from "../measures/CoverageMeasure";
import { createCoverageMap } from "istanbul-lib-coverage";
import { FunctionDef } from "./FunctionDef";
import { InputAndSource } from "../Types";
import { prompt } from "../generators/AiInputGenerator";
import { Leaderboard } from "../generators/Leaderboard";

describe("CoverageFrontierSampler", () => {
  let tmpDir: string;
  let targetFile: string;
  let depFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-frontier-sampler-test-")
    );
    targetFile = path.join(tmpDir, "Parser.ts");
    depFile = path.join(tmpDir, "Tokenizer.ts");

    fs.writeFileSync(
      targetFile,
      `import { scanToken } from "./Tokenizer";
export function parseExpression(input: string): boolean {
  return scanToken(input);
}
`
    );

    fs.writeFileSync(
      depFile,
      `export function scanToken(input: string): boolean {
  if (input === "+") {
    return true;
  } else if (input === "-") {
    return false;
  }
  return false;
}

export function uncalledHelper(x: number): number {
  return x * 2;
}
`
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("identifies candidate functions and scores frontier higher than uncalled functions", () => {
    const covStats: CodeCoverageMeasureStats = {
      counters: {
        statementsTotal: 10,
        statementsCovered: 5,
        branchesTotal: 4,
        branchesCovered: 2,
        functionsTotal: 3,
        functionsCovered: 2,
      },
      files: [
        {
          path: depFile,
          counters: {
            statementsTotal: 6,
            statementsCovered: 3,
            branchesTotal: 4,
            branchesCovered: 1,
            functionsTotal: 2,
            functionsCovered: 1,
          },
          // @ts-expect-error stub for test
          fileMap: {},
        },
      ],
    };

    const uncoveredInfo = {
      uncoveredLinesByFile: {
        [depFile]: [4, 5, 10, 11],
      },
      partiallyCoveredLinesByFile: {
        [depFile]: [2], // scanToken has a partially covered branch on line 2
      },
    };

    const candidates = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts: {},
    });

    expect(candidates.length).toBeGreaterThan(0);
    const scanCandidate = candidates.find(
      (c) => c.functionName === "scanToken"
    );
    const helperCandidate = candidates.find(
      (c) => c.functionName === "uncalledHelper"
    );

    expect(scanCandidate).toBeDefined();
    expect(scanCandidate?.isFrontier).toBe(true);
    expect(scanCandidate?.baseWeight).toBe(100);

    // Option 3A: Functions with zero hits are not sampled
    expect(helperCandidate).toBeUndefined();
  });

  it("includes the target module and PUT among candidates when it has uncovered or partial lines", () => {
    const covStats: CodeCoverageMeasureStats = {
      counters: {
        statementsTotal: 10,
        statementsCovered: 5,
        branchesTotal: 4,
        branchesCovered: 2,
        functionsTotal: 3,
        functionsCovered: 2,
      },
      files: [
        {
          path: targetFile,
          counters: {
            statementsTotal: 2,
            statementsCovered: 1,
            branchesTotal: 2,
            branchesCovered: 1,
            functionsTotal: 1,
            functionsCovered: 1,
          },
          // @ts-expect-error stub for test
          fileMap: {},
        },
      ],
    };

    const uncoveredInfo = {
      uncoveredLinesByFile: {},
      partiallyCoveredLinesByFile: {
        [targetFile]: [3],
      },
    };

    const candidates = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts: {},
    });

    const targetCandidate = candidates.find(
      (c) => c.functionName === "parseExpression"
    );
    expect(targetCandidate).toBeDefined();
    expect(targetCandidate?.filePath).toBe(targetFile);
    expect(targetCandidate?.isFrontier).toBe(true);
    expect(targetCandidate?.baseWeight).toBe(100);
  });

  it("decays candidate weight exponentially based on prior attempts", () => {
    const covStats: CodeCoverageMeasureStats = {
      counters: {
        statementsTotal: 10,
        statementsCovered: 5,
        branchesTotal: 4,
        branchesCovered: 2,
        functionsTotal: 2,
        functionsCovered: 1,
      },
      files: [],
    };

    const uncoveredInfo = {
      uncoveredLinesByFile: {
        [depFile]: [4],
      },
      partiallyCoveredLinesByFile: {
        [depFile]: [2],
      },
    };

    const targetAttempts: Record<string, number> = {};
    const initialCandidates = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts,
    });

    const initialWeight = initialCandidates[0].weight;
    expect(initialWeight).toBe(100);

    // Simulate 2 failed attempts targeting this function
    targetAttempts[initialCandidates[0].targetId] = 2;

    const decayedCandidates = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts,
    });

    // 100 * (0.5)^2 = 25
    expect(decayedCandidates[0].weight).toBe(25);
  });

  it("sample performs roulette-wheel selection, increments attempts, and returns snippet", () => {
    const covStats: CodeCoverageMeasureStats = {
      counters: {
        statementsTotal: 10,
        statementsCovered: 5,
        branchesTotal: 4,
        branchesCovered: 2,
        functionsTotal: 2,
        functionsCovered: 1,
      },
      files: [
        {
          path: depFile,
          counters: {
            statementsTotal: 6,
            statementsCovered: 3,
            branchesTotal: 4,
            branchesCovered: 1,
            functionsTotal: 2,
            functionsCovered: 1,
          },
          // @ts-expect-error stub for test
          fileMap: {},
        },
      ],
    };

    const uncoveredInfo = {
      uncoveredLinesByFile: {
        [depFile]: [4],
      },
      partiallyCoveredLinesByFile: {
        [depFile]: [2],
      },
    };

    const targetAttempts: Record<string, number> = {};
    const prng = seedrandom("frontier-sample-seed");

    const sampled = CoverageFrontierSampler.sample({
      covStats,
      uncoveredInfo,
      targetAttempts,
      prng,
    });

    expect(sampled).toBeDefined();
    expect(sampled?.functionName).toBe("scanToken");
    expect(sampled?.codeSnippet).toMatch(/\d+\|function scanToken/);
    expect(sampled?.isSliced).toBe(false); // Whole function fits in default maxChars

    // Attempt count was incremented
    expect(targetAttempts[sampled!.targetId]).toBe(1);
  });

  it("formatFrontierContext formats Markdown block for prompt", () => {
    const sampled = {
      targetId: "dep:testFn",
      filePath: depFile,
      displayPath: "src/Tokenizer.ts",
      functionName: "scanToken",
      startLine: 1,
      endLine: 10,
      uncoveredLines: [4, 5],
      partialLines: [],
      reachingInputs: [],
      codeSnippet: "function scanToken() { return true; }",
      isSliced: false,
    };

    const formatted = formatFrontierContext(sampled, "typescript");
    expect(formatted).toContain(
      "Targeted code from `src/Tokenizer.ts` (function `scanToken`)"
    );
    expect(formatted).toContain("with uncovered line(s) 4-5:");
    expect(formatted).toContain("```typescript");
    expect(formatted).toContain("function scanToken() { return true; }");
  });

  it("prompt.genInputs incorporates frontier target code into coverage context", () => {
    const fnDef = FunctionDef.fromFunctionRef({
      module: targetFile,
      name: "parseExpression",
      src: "function parseExpression(input: string) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: false,
      args: [],
    });

    const uncoveredInfo = {
      uncoveredLinesByFile: {
        [depFile]: [4, 5],
      },
      partiallyCoveredLinesByFile: {},
    };

    const frontierTarget = {
      targetId: "dep:scanToken",
      filePath: depFile,
      displayPath: "src/Tokenizer.ts",
      functionName: "scanToken",
      startLine: 1,
      endLine: 10,
      uncoveredLines: [4, 5],
      partialLines: [],
      reachingInputs: [],
      codeSnippet:
        "function scanToken(input: string): boolean { return false; }",
      isSliced: false,
    };

    const promptText = prompt.genInputs(
      fnDef,
      [],
      new Map(),
      "function parseExpression(input: string) {}",
      10,
      1,
      uncoveredInfo,
      frontierTarget
    );

    expect(promptText).toContain(
      "Targeted code from `src/Tokenizer.ts` (function `scanToken`)"
    );
    expect(promptText).toContain("function scanToken(input: string): boolean");
  });

  it("filters out uncalled sibling functions in the target file while retaining called sibling helpers", () => {
    const multiFnFile = path.join(tmpDir, "Suite.ts");
    fs.writeFileSync(
      multiFnFile,
      `export function helperOne(x: string): boolean {
  return x.length > 0;
}

export function testTarget(input: string): boolean {
  return helperOne(input);
}

export function uncalledSiblingTest(val: number): boolean {
  return val > 10;
}
`
    );

    const covStats: CodeCoverageMeasureStats = {
      counters: {
        statementsTotal: 10,
        statementsCovered: 5,
        branchesTotal: 0,
        branchesCovered: 0,
        functionsTotal: 3,
        functionsCovered: 1,
      },
      files: [
        {
          path: multiFnFile,
          counters: {
            statementsTotal: 6,
            statementsCovered: 2,
            branchesTotal: 0,
            branchesCovered: 0,
            functionsTotal: 3,
            functionsCovered: 2,
          },
          // @ts-expect-error stub for test
          fileMap: {
            s: { "0": 1, "1": 0, "2": 1, "3": 0, "4": 0 },
            statementMap: {
              "0": {
                start: { line: 1, column: 0 },
                end: { line: 1, column: 20 },
              },
              "1": {
                start: { line: 2, column: 2 },
                end: { line: 2, column: 23 },
              },
              "2": {
                start: { line: 5, column: 0 },
                end: { line: 5, column: 20 },
              },
              "3": {
                start: { line: 6, column: 2 },
                end: { line: 6, column: 26 },
              },
              "4": {
                start: { line: 10, column: 2 },
                end: { line: 10, column: 18 },
              },
            },
          },
        },
      ],
    };

    const uncoveredInfo = {
      uncoveredLinesByFile: {
        [multiFnFile]: [2, 6, 10],
      },
      partiallyCoveredLinesByFile: {},
    };

    const targetFn = FunctionDef.fromFunctionRef({
      module: multiFnFile,
      name: "testTarget",
      src: `export function testTarget(input: string): boolean {\n  return helperOne(input);\n}`,
      lang: "typescript",
      startOffset: 50,
      endOffset: 120,
      isExported: true,
      isVoid: false,
      args: [],
    });

    const candidates = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts: {},
      targetFn,
    });

    const candidateNames = candidates.map((c) => c.functionName);
    expect(candidateNames).toContain("testTarget");
    expect(candidateNames).toContain("helperOne");
    expect(candidateNames).not.toContain("uncalledSiblingTest");
  });

  it("detects frontier using partial statement coverage when branch coverage is missing", () => {
    const testFile = path.join(tmpDir, "BranchlessIstanbul.ts");
    fs.writeFileSync(
      testFile,
      `export function processItem(x: number): number {
  if (x > 0) {
    return x * 2;
  }
  return 0;
}
`
    );

    const covStats: CodeCoverageMeasureStats = {
      counters: {
        statementsTotal: 4,
        statementsCovered: 2,
        branchesTotal: 0,
        branchesCovered: 0,
        functionsTotal: 1,
        functionsCovered: 1,
      },
      files: [
        {
          path: testFile,
          counters: {
            statementsTotal: 4,
            statementsCovered: 2,
            branchesTotal: 0,
            branchesCovered: 0,
            functionsTotal: 1,
            functionsCovered: 1,
          },
          // @ts-expect-error test stub with statement hits on line 2, missing line 3
          fileMap: {
            s: { "0": 1, "1": 0, "2": 0 },
            statementMap: {
              "0": {
                start: { line: 2, column: 2 },
                end: { line: 2, column: 14 },
              },
              "1": {
                start: { line: 3, column: 4 },
                end: { line: 3, column: 18 },
              },
              "2": {
                start: { line: 5, column: 2 },
                end: { line: 5, column: 11 },
              },
            },
          },
        },
      ],
    };

    // No branch coverage available (empty partial lines, as with broken Istanbul branch coverage)
    const uncoveredInfo = {
      uncoveredLinesByFile: {
        [testFile]: [3, 5],
      },
      partiallyCoveredLinesByFile: {},
    };

    const candidates = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts: {},
    });

    expect(candidates.length).toBe(1);
    expect(candidates[0].functionName).toBe("processItem");
    expect(candidates[0].isFrontier).toBe(true);
    expect(candidates[0].baseWeight).toBe(100);
    expect(candidates[0].uncoveredLines).toEqual([3, 5]);
  });

  it("invalidates cache when file timestamp changes or clearCache is called", () => {
    const dynamicFile = path.join(tmpDir, "Dynamic.ts");
    fs.writeFileSync(
      dynamicFile,
      `export function v1Function(): void {}
`
    );

    const covStats: CodeCoverageMeasureStats = {
      counters: {
        statementsTotal: 1,
        statementsCovered: 0,
        branchesTotal: 0,
        branchesCovered: 0,
        functionsTotal: 1,
        functionsCovered: 0,
      },
      files: [],
    };
    const uncoveredInfo = {
      uncoveredLinesByFile: { [dynamicFile]: [1] },
      partiallyCoveredLinesByFile: {},
    };

    const targetFnV1 = FunctionDef.fromFunctionRef({
      module: dynamicFile,
      name: "v1Function",
      src: "export function v1Function(): void {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 35,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const initial = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts: {},
      targetFn: targetFnV1,
    });
    expect(initial.map((c) => c.functionName)).toEqual(["v1Function"]);

    // Update file with new function
    fs.writeFileSync(
      dynamicFile,
      `export function v2Function(): void {}
`
    );

    const targetFnV2 = FunctionDef.fromFunctionRef({
      module: dynamicFile,
      name: "v2Function",
      src: "export function v2Function(): void {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 35,
      isExported: true,
      isVoid: true,
      args: [],
    });

    // Because mtime changed, getCandidates automatically detects change and re-parses
    const updated = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts: {},
      targetFn: targetFnV2,
    });
    expect(updated.map((c) => c.functionName)).toEqual(["v2Function"]);

    // clearCache explicitly purges cache
    CoverageFrontierSampler.clearCache();
    const afterClear = CoverageFrontierSampler.getCandidates({
      covStats,
      uncoveredInfo,
      targetAttempts: {},
      targetFn: targetFnV2,
    });
    expect(afterClear.map((c) => c.functionName)).toEqual(["v2Function"]);
  });

  it("attaches reaching inputs from the leaderboard to the sampled frontier target", () => {
    const fnDef = FunctionDef.fromFunctionRef({
      module: targetFile,
      name: "parseExpression",
      src: "export function parseExpression(input: string): boolean { return scanToken(input); }",
      lang: "typescript",
      startOffset: 0,
      endOffset: 80,
      isExported: true,
      isVoid: false,
      args: [],
    });

    const covStats: CodeCoverageMeasureStats = {
      counters: {
        statementsTotal: 10,
        statementsCovered: 5,
        branchesTotal: 4,
        branchesCovered: 2,
        functionsTotal: 2,
        functionsCovered: 1,
      },
      files: [
        {
          path: depFile,
          counters: {
            statementsTotal: 6,
            statementsCovered: 3,
            branchesTotal: 4,
            branchesCovered: 1,
            functionsTotal: 2,
            functionsCovered: 1,
          },
          // @ts-expect-error test stub
          fileMap: {
            s: { "0": 1, "1": 0 },
            statementMap: {
              "0": {
                start: { line: 2, column: 2 },
                end: { line: 2, column: 20 },
              },
              "1": {
                start: { line: 3, column: 2 },
                end: { line: 3, column: 20 },
              },
            },
          },
        },
      ],
    };

    const uncoveredInfo = {
      uncoveredLinesByFile: {
        [depFile]: [4, 5],
      },
      partiallyCoveredLinesByFile: {
        [depFile]: [2],
      },
    };

    const leaderboard = new Leaderboard<InputAndSource>();
    const leaderInput: InputAndSource = {
      tick: 42,
      value: [{ tag: "ArgValueTypeWrapped", value: "+" }],
      source: { type: "unknown" as const },
    };
    leaderboard.postScore(leaderInput, 10.0);

    const covMeasure = new MockReachingCoverageMeasure(depFile);

    const sampled = CoverageFrontierSampler.sample({
      covStats,
      uncoveredInfo,
      targetAttempts: {},
      targetFn: fnDef,
      leaderboard,
      covMeasure,
    });

    expect(sampled).toBeDefined();
    expect(sampled?.reachingInputs).toBeDefined();
    expect(sampled?.reachingInputs?.length).toBeGreaterThan(0);
    expect(sampled?.reachingInputs?.[0]).toContain("+");

    const formatted = formatFrontierContext(sampled!, "typescript");
    expect(formatted).toContain("Prior test input(s) that reached this code:");
    expect(formatted).toContain("+");
  });
});

class MockReachingCoverageMeasure extends CoverageMeasure {
  private readonly _filePath: string;

  public constructor(filePath: string) {
    super();
    this._filePath = filePath;
  }

  public override hasCoverage(tick: number): boolean {
    return tick === 42;
  } // fn: hasCoverage

  public override getCoverage(tick: number): CoverageMeasurement {
    return {
      type: "measure",
      name: "CoverageMeasure",
      coverageMeasure: {
        current: createCoverageMap({
          [this._filePath]: {
            path: this._filePath,
            statementMap: {
              "0": {
                start: { line: 2, column: 0 },
                end: { line: 2, column: 20 },
              },
            },
            s: { "0": 1 },
            fnMap: {},
            f: {},
            branchMap: {},
            b: {},
          },
        }),
        accum: createCoverageMap({}),
        accumDelta: 1,
        globalDelta: 1,
      },
    };
  } // fn: getCoverage
} // class: MockReachingCoverageMeasure
