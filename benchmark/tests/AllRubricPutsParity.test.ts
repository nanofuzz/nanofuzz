import * as path from "node:path";
import * as fs from "node:fs";
import { runFuzz } from "../../src/ui/Agent";
import {
  registerExcludedCoverageFiles,
  clearExcludedCoverageFiles,
  setTargetCoverageFiles,
} from "../../src/ui/Agent";
import * as Config from "../../src/Config";
import * as ProgramFactory from "../../src/fuzzer/analysis/ProgramFactory";

const TARGET_DIR = path.resolve(process.cwd(), "benchmark", "target");
const PYTHON_PATH = path.join(TARGET_DIR, ".venv", "bin", "python");

describe("All 5 Rubric PUTs Cross-Tool Coverage Parity Suite", () => {
  beforeAll(() => {
    if (!fs.existsSync(TARGET_DIR)) {
      return;
    }
    Config.override("python.defaultInterpreterPath", PYTHON_PATH);
    Config.override("nanofuzz.fuzzer.coverageScope", "project");
  });

  afterAll(() => {
    Config.clearOverrides();
    clearExcludedCoverageFiles();
  });

  const RUBRIC_TASKS = [
    {
      task: "_distance_norm",
      putFile: "src/fandango/constraints/comparison.py",
      putFn: "_distance_norm",
      isFunction: true,
      harnessRoot: "nanofuzz_harness__distance_norm.py",
      harnessTests: "tests/test_pbt__distance_norm.py",
      testFn: "test_distance_norm",
    },
    {
      task: "parse",
      putFile: "src/fandango/language/parse/parse.py",
      putFn: "parse_string",
      isFunction: true,
      harnessRoot: "nanofuzz_harness_parse.py",
      harnessTests: "tests/test_pbt_parse.py",
      testFn: "test_parse",
    },
    {
      task: "make_def",
      putFile: "src/fandango/language/stdlib.py",
      putFn: "make_def",
      isFunction: true,
      harnessRoot: "nanofuzz_harness_make_def.py",
      harnessTests: "tests/test_pbt_make_def.py",
      testFn: "test_make_def",
    },
    {
      task: "TreeValue",
      putFile: "src/fandango/language/tree_value.py",
      putFn: "TreeValue",
      isFunction: false,
      harnessRoot: "nanofuzz_harness_TreeValue.py",
      harnessTests: "tests/test_pbt_TreeValue.py",
      testFn: "test_treevalue",
    },
    {
      task: "DerivationTree",
      putFile: "src/fandango/language/tree.py",
      putFn: "DerivationTree",
      isFunction: false,
      harnessRoot: "nanofuzz_harness_DerivationTree.py",
      harnessTests: "tests/test_pbt_DerivationTree.py",
      testFn: "test_derivationtree",
    },
  ];

  for (const t of RUBRIC_TASKS) {
    it(`evaluates live coverage denominator parity for rubric task: ${t.task}`, async () => {
      if (!fs.existsSync(TARGET_DIR)) {
        pending(
          "Skipping benchmark parity test: benchmark/target not present in environment."
        );
        return;
      }

      console.log(`\n======================================================`);
      console.log(`[TESTING RUBRIC PUT]: ${t.task}`);
      console.log(`======================================================`);

      const mapFile = path.resolve(process.cwd(), "benchmark", "scripts", "target_coverage_files.json");
      const mapData = JSON.parse(fs.readFileSync(mapFile, "utf8"));
      const targetFiles = mapData[t.task].map((rel: string) => path.join(TARGET_DIR, rel));

      let nanoBareDenom: number | undefined;

      // NaNofuzz Bare PUT (for top-level functions in rubric)
      if (t.isFunction) {
        clearExcludedCoverageFiles();
        setTargetCoverageFiles(targetFiles);
        Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");
        const barePutPath = path.join(TARGET_DIR, t.putFile);
        const res = await runFuzz({
          filePath: barePutPath,
          functionName: t.putFn,
          maxTests: 5,
          suiteTimeout: 3000,
          coverageScope: "project",
        });
        nanoBareDenom = res.coverage?.branchesTotal;
        console.log(`  - NaNofuzz (Bare PUT)       : Denominator = ${nanoBareDenom}`);
      }

      // NaNofuzz Root Harness (nanofuzz_harness_<task>.py)
      const rootHarnessPath = path.join(TARGET_DIR, t.harnessRoot);
      const modName = t.putFile.replace(/^src\//, "").replace(/\.py$/, "").replace(/\//g, ".");
      const callExpr = t.isFunction
        ? `${t.putFn}()`
        : `(${t.putFn}.empty() if hasattr(${t.putFn}, 'empty') else ${t.putFn}())`;
      fs.writeFileSync(
        rootHarnessPath,
        `from ${modName} import ${t.putFn}\ndef fuzz_target():\n    try:\n        ${callExpr}\n    except Exception:\n        pass\n`,
        "utf8"
      );
      clearExcludedCoverageFiles();
      setTargetCoverageFiles(targetFiles);
      registerExcludedCoverageFiles([rootHarnessPath]);
      Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");
      const rootRes = await runFuzz({
        filePath: rootHarnessPath,
        functionName: "fuzz_target",
        maxTests: 5,
        suiteTimeout: 3000,
        coverageScope: "project",
      });
      const nanoRootDenom = rootRes.coverage?.branchesTotal;
      console.log(`  - NaNofuzz (Root Harness)   : Denominator = ${nanoRootDenom}`);

      // Hypothesis (tests/test_pbt_<task>.py)
      const testsHarnessPath = path.join(TARGET_DIR, t.harnessTests);
      fs.writeFileSync(
        testsHarnessPath,
        `from hypothesis import given, strategies as st\nfrom ${modName} import ${t.putFn}\n@given(x=st.integers())\ndef ${t.testFn}(x):\n    try:\n        ${callExpr}\n    except Exception:\n        pass\n`,
        "utf8"
      );
      clearExcludedCoverageFiles();
      setTargetCoverageFiles(targetFiles);
      Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");
      const hypoRes = await runFuzz({
        filePath: testsHarnessPath,
        functionName: t.testFn,
        suiteTimeout: 5000,
        maxTests: 5,
      });
      const hypoDenom = hypoRes.coverage?.branchesTotal;
      console.log(`  - Hypothesis (tests/ Harness): Denominator = ${hypoDenom}`);

      // Hypofuzz (tests/test_pbt_<task>.py)
      clearExcludedCoverageFiles();
      setTargetCoverageFiles(targetFiles);
      Config.override("nanofuzz.experimental.findBugs.tool", "hypofuzz");
      const hypofuzzRes = await runFuzz({
        filePath: testsHarnessPath,
        functionName: t.testFn,
        suiteTimeout: 5000,
        maxTests: 5,
      });
      const hypofuzzDenom = hypofuzzRes.coverage?.branchesTotal;
      console.log(`  - Hypofuzz (tests/ Harness)  : Denominator = ${hypofuzzDenom}`);

      // ASSERT EQUALITY ACROSS ALL AVAILABLE TREATMENTS FOR THIS RUBRIC PUT
      expect(nanoRootDenom).toBeDefined();
      expect(hypoDenom).toBeDefined();
      expect(hypofuzzDenom).toBeDefined();
      expect(hypoDenom).toEqual(nanoRootDenom!);
      expect(hypofuzzDenom).toEqual(nanoRootDenom!);
      if (t.isFunction && nanoBareDenom !== undefined) {
        expect(nanoBareDenom).toEqual(nanoRootDenom!);
      }
    }, 180000);
  }

  it("evaluates live coverage denominator for TreeValue in an isolated worktree lane without harness exclusion", async () => {
    const wtDir = path.resolve(process.cwd(), "benchmark", "worktrees", "w2");
    if (!fs.existsSync(wtDir)) {
      pending("Skipping worktree parity test: benchmark/worktrees/w2 not present.");
      return;
    }
    const wtHarnessPath = path.join(wtDir, "nanofuzz_harness_TreeValue.py");
    const targetFile = path.join(wtDir, "src", "fandango", "language", "tree_value.py");
    fs.writeFileSync(
      wtHarnessPath,
      `from fandango.language.tree_value import TreeValue\ndef fuzz_target():\n    try:\n        TreeValue.empty()\n    except Exception:\n        pass\n`,
      "utf8"
    );
    try {
      clearExcludedCoverageFiles(wtDir);
      setTargetCoverageFiles([targetFile], wtDir);
      process.env.NANOFUZZ_PROJECT_ROOT = wtDir;
      process.env.NANOFUZZ_COVERAGE_INCLUDE_FILES = JSON.stringify([targetFile]);
      Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");

      const res = await runFuzz({
        filePath: wtHarnessPath,
        functionName: "fuzz_target",
        maxTests: 5,
        suiteTimeout: 3000,
        coverageScope: "project",
      });

      console.log(`  - Worktree NaNofuzz (TreeValue) : Denominator = ${res.coverage?.branchesTotal}`);
      expect(res.coverage?.branchesTotal).toBe(124);
    } finally {
      if (fs.existsSync(wtHarnessPath)) {
        fs.unlinkSync(wtHarnessPath);
      }
      clearExcludedCoverageFiles(wtDir);
      delete process.env.NANOFUZZ_COVERAGE_INCLUDE_FILES;
      delete process.env.NANOFUZZ_PROJECT_ROOT;
    }
  }, 60000);

  it("extracts and resolves PUT targets across all 5 benchmark study harnesses", () => {
    const harnesses = [
      {
        file: "benchmark/harnesses/nanofuzz_harness_TreeValue.py",
        fn: "fuzz_TreeValue",
        expectedTargets: ["TreeValue"],
        expectedResolvedPathSubstr: "tree_value.py",
      },
      {
        file: "benchmark/harnesses/nanofuzz_harness_DerivationTree.py",
        fn: "fuzz_DerivationTree",
        expectedTargets: ["DerivationTree"],
        expectedResolvedPathSubstr: "tree.py",
      },
      {
        file: "benchmark/harnesses/nanofuzz_harness__distance_norm.py",
        fn: "fuzz__distance_norm",
        expectedTargets: ["target_distance_norm", "target_sigmoid"],
        expectedResolvedPathSubstr: "comparison.py",
      },
      {
        file: "benchmark/harnesses/nanofuzz_harness_make_def.py",
        fn: "fuzz_make_def",
        expectedTargets: ["make_def"],
        expectedResolvedPathSubstr: "stdlib.py",
      },
      {
        file: "benchmark/harnesses/nanofuzz_harness_parse.py",
        fn: "fuzz_parse",
        expectedTargets: ["parse_string"],
        expectedResolvedPathSubstr: "parse.py",
      },
    ];

    for (const h of harnesses) {
      const fullPath = path.resolve(h.file);
      expect(fs.existsSync(fullPath)).toBeTrue();

      const prog = ProgramFactory.fromFile(fullPath);
      const fn = prog.functionsExported[h.fn];
      expect(fn).toBeDefined();

      const putTargets = fn.getPutTargets();
      expect(putTargets).toEqual(h.expectedTargets);

      const resolved = prog.resolvePutTargets(putTargets);
      expect(resolved.length).toBeGreaterThanOrEqual(1);
      expect(resolved[0].filePath).toContain(h.expectedResolvedPathSubstr);
      expect(resolved[0].src.length).toBeGreaterThan(0);
    }
  });
});
