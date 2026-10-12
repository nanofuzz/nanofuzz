import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import seedrandom from "seedrandom";
import {
  CoverageFrontierSampler,
  formatFrontierContext,
} from "./CoverageFrontierSampler";
import { CodeCoverageMeasureStats } from "../measures/CoverageMeasure";
import { FunctionDef } from "./FunctionDef";
import { prompt } from "../generators/AiInputGenerator";

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

    expect(helperCandidate).toBeDefined();
    expect(helperCandidate?.isFrontier).toBe(false);
    expect(helperCandidate?.baseWeight).toBe(30); // 1-hop uncalled in reached module
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
      uncoveredLines: [4, 5],
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
      uncoveredLines: [4, 5],
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
});
