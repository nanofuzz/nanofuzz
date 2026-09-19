import * as AiInputGenerator from "./AiInputGenerator";
import { makeArgDef, getRandomArgDef } from "../analysis/TestUtils";
import { ArgDef } from "../analysis/ArgDef";
import { ArgTag } from "../analysis/Types";
import { FunctionDef } from "../analysis/FunctionDef";
import { LlmAdapter, prompt } from "../adapters/LlmAdapter";
import { ArgDefGenerator } from "../analysis/ArgDefGenerator";
import { ArgDefValidator } from "../analysis/ArgDefValidator";
import seedrandom from "seedrandom";
import * as Config from "../../Config";

describe("src/fuzzer/generators/AiInputGenerator: ", () => {
  it("dimsUnique schema directives", () => {
    const argOptions = ArgDef.getDefaultOptions();
    const argDef = makeArgDef(
      "test.ts",
      "items",
      0,
      ArgTag.NUMBER,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 3, max: 3 }],
      },
      1
    );

    const directives: string[] = [];
    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn() {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 20,
      isExported: true,
      isVoid: true,
      args: [],
    });
    class TestAiGenerator extends AiInputGenerator.AiInputGenerator {
      public testArgDefToSchema(
        arg: ArgDef,
        path: string,
        directivesList: string[]
      ) {
        return this._argDefToSchema(arg, path, directivesList);
      }
    }
    const gen = new TestAiGenerator(fnDef, "seed", new Map(), "");
    gen.testArgDefToSchema(argDef, "items", directives);

    expect(directives).toContain(
      "items: array length must be >= 3 && <= 3; all elements in the array must be unique"
    );
  });

  it("undefined decoder", () => {
    const encodedData = [
      AiInputGenerator.NANOFUZZ_UNDEFINED,
      AiInputGenerator.NANOFUZZ_TRUE,
      AiInputGenerator.NANOFUZZ_FALSE,
      {
        isUndefined: AiInputGenerator.NANOFUZZ_UNDEFINED,
        isMissing: AiInputGenerator.NANOFUZZ_MISSING_PROPERTY,
        isTrue: AiInputGenerator.NANOFUZZ_TRUE,
        isFalse: AiInputGenerator.NANOFUZZ_FALSE,
        isArray: [
          AiInputGenerator.NANOFUZZ_UNDEFINED,
          AiInputGenerator.NANOFUZZ_TRUE,
          AiInputGenerator.NANOFUZZ_FALSE,
        ],
      },
      [
        AiInputGenerator.NANOFUZZ_UNDEFINED,
        AiInputGenerator.NANOFUZZ_TRUE,
        AiInputGenerator.NANOFUZZ_FALSE,
        {
          isUndefined: AiInputGenerator.NANOFUZZ_UNDEFINED,
          isMissing: AiInputGenerator.NANOFUZZ_MISSING_PROPERTY,
          isTrue: AiInputGenerator.NANOFUZZ_TRUE,
          isFalse: AiInputGenerator.NANOFUZZ_FALSE,
          isArray: [
            AiInputGenerator.NANOFUZZ_UNDEFINED,
            AiInputGenerator.NANOFUZZ_TRUE,
            AiInputGenerator.NANOFUZZ_FALSE,
          ],
        },
      ],
    ];
    const preDecoded = [
      undefined,
      true,
      false,
      {
        isUndefined: undefined,
        isTrue: true,
        isFalse: false,
        isArray: [undefined, true, false],
      },
      [
        undefined,
        true,
        false,
        {
          isUndefined: undefined,
          isTrue: true,
          isFalse: false,
          isArray: [undefined, true, false],
        },
      ],
    ];
    encodedData.forEach((data, i) => {
      // avoid infinite type error
      expect<unknown>(AiInputGenerator._decode(data)).toEqual(preDecoded[i]);
    });
  });

  it("decode number array as Uint8Array per spec", () => {
    const bytesSpec = makeArgDef(
      "test.ts",
      "data",
      0,
      ArgTag.BYTES,
      ArgDef.getDefaultOptions(),
      0
    );

    const rawArray = [104, 101, 108, 108, 111];
    const decoded = AiInputGenerator._decode(rawArray, bytesSpec);

    expect(decoded instanceof Uint8Array).toBeTrue();
    expect<unknown>(decoded).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  it("prompt.genInputs includes module source code", () => {
    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn() {}",
      lang: "typescript",
      startOffset: 25,
      endOffset: 45,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const moduleSrc =
      "// full module content\nconst X = 1;\nfunction testFn() {}";
    const promptText = prompt.genInputs(fnDef, [], new Map(), moduleSrc, 25);
    expect(promptText).toContain(
      'The full module source code containing "testFn":'
    );
    expect(promptText).toContain(
      "// full module content\nconst X = 1;\nfunction testFn() {}"
    );
  });

  it("escape triple backticks", () => {
    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn() { /* ``` */ }",
      cmt: "spec with ``` triple backticks",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const moduleSrc = "// module code\n/* ``` */";
    const promptText = prompt.genInputs(fnDef, [], new Map(), moduleSrc, 25);
    expect(promptText).toContain("spec with \\`\\`\\` triple backticks");
    expect(promptText).toContain("function testFn() { /* \\`\\`\\` */ }");
    expect(promptText).toContain("// module code\n/* \\`\\`\\` */");
  });

  it("nextable: 'soon' when LLM call pending and queue is empty", () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public setCallsPending(val: number): void {
        this._callsPending = val;
      }
      public clearInputQueue(): void {
        this._inputQueue = [];
      }
      public populateInputQueue(): void {
        this._inputQueue = [
          {
            tick: 1,
            value: [{ value: 42, tag: "ArgValueTypeWrapped" }],
            source: {
              type: "generator",
              generator: "AiInputGenerator",
              model: "test",
            },
          },
        ];
      }
    }

    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn(x: number) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const gen = new TestableAiInputGenerator(
      fnDef,
      "seed",
      new Map(),
      "function testFn(x: number) {}"
    );

    // Simulate an in-flight call
    gen.setCallsPending(1);
    gen.clearInputQueue();

    expect(gen.nextable()).toBe("soon");
  });

  it("nextable: 'soon'-->`false` on in-flight error", () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public setCallsPending(val: number): void {
        this._callsPending = val;
      }
      public clearInputQueue(): void {
        this._inputQueue = [];
      }
    }

    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn(x: number) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const gen = new TestableAiInputGenerator(
      fnDef,
      "seed",
      new Map(),
      "function testFn(x: number) {}"
    );

    // In-flight call
    gen.setCallsPending(1);
    gen.clearInputQueue();
    expect(gen.nextable()).toBe("soon");

    // Request completes with failure: callsPending--, queue remains empty
    gen.setCallsPending(0);
    expect(gen.nextable()).toBe(false);
  });

  it("nextable: triggers _getMoreInputs when queue is empty and LLM is configured", () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public getCallsPending(): number {
        return this._callsPending;
      }
      public setCallsPending(val: number): void {
        this._callsPending = val;
      }
      public initLlm(): void {
        this._llm = Object.create(LlmAdapter.prototype);
      }
      public disableLlm(): void {
        this._llm = undefined;
      }
      protected override _getMoreInputs(): void {
        this._callsPending = 1;
      }
    }

    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn(x: number) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const gen = new TestableAiInputGenerator(
      fnDef,
      "seed",
      new Map(),
      "function testFn(x: number) {}"
    );

    // Unconfigured LLM returns false
    expect(gen.nextable()).toBe(false);

    // Configured LLM triggers _getMoreInputs and returns 'soon'
    gen.initLlm();
    expect(gen.nextable()).toBe("soon");
    expect(gen.getCallsPending()).toBe(1);

    // Disabled LLM returns false
    gen.disableLlm();
    gen.setCallsPending(0);
    expect(gen.nextable()).toBe(false);
  });

  it("getDiagnostics: all generated inputs invalid", () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public setStatsAllInvalid(): void {
        this._stats.calls.sent = 1;
        this._stats.calls.valid = 1;
        this._stats.inputs.gen = 25;
        this._stats.inputs.invalid = 25;
      }
    }

    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn(x: number) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const gen = new TestableAiInputGenerator(
      fnDef,
      "seed",
      new Map(),
      "function testFn(x: number) {}"
    );

    gen.setStatsAllInvalid();
    Config.override("nanofuzz.ai.provider", "gemini");
    Config.override("nanofuzz.ai.model", "gemini-flash");
    Config.override("nanofuzz.ai.apiKey", "test-key");

    try {
      const diagnostics = gen.getDiagnostics();
      expect(diagnostics).toContain(
        "All 25 inputs returned by the model were invalid."
      );
    } finally {
      Config.clearOverrides();
    }
  });

  it("nextable: 'now' when queue is non-empty", () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public populateInputQueue(): void {
        this._inputQueue = [
          {
            tick: 1,
            value: [{ value: 42, tag: "ArgValueTypeWrapped" }],
            source: {
              type: "generator",
              generator: "AiInputGenerator",
              model: "test",
            },
          },
        ];
      }
    }

    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn(x: number) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const gen = new TestableAiInputGenerator(
      fnDef,
      "seed",
      new Map(),
      "function testFn(x: number) {}"
    );

    gen.populateInputQueue();

    expect(gen.nextable()).toBe("now");
  });

  it("nextable: `false` when unconfigured and no inputs available", () => {
    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn(x: number) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const gen = new AiInputGenerator.AiInputGenerator(
      fnDef,
      "seed",
      new Map(),
      "function testFn(x: number) {}"
    );

    gen.onRunStart(false); // Unconfigured / inactive
    expect<unknown>(gen.nextable()).toBe(false);
  });

  it("requested input count incorporates invalid buffer and response max tokens", () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public estimateTokens(): number {
        return this._estimateTokensPerInput();
      }
      public getRequestedCount(): number {
        return this._getRequestedInputCount();
      }
      public setStats(gen: number, invalid: number): void {
        this._stats.inputs.gen = gen;
        this._stats.inputs.invalid = invalid;
      }
    }

    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn(x: number) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const gen = new TestableAiInputGenerator(
      fnDef,
      "seed",
      new Map(),
      "function testFn(x: number) {}"
    );

    expect(gen.estimateTokens()).toBeGreaterThan(0);
    // Initial call uses 10% buffer: chunkSize 20 * 1.1 = 22
    expect(gen.getRequestedCount()).toBe(22);

    // High invalid rate (50% invalid): chunkSize 20 * 1.5 = 30
    gen.setStats(10, 10);
    expect(gen.getRequestedCount()).toBe(30);
  });

  it("random input generation size estimation accuracy test", () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public estimateTokens(): number {
        return this._estimateTokensPerInput();
      }
      public setSpecs(specs: ArgDef[]): void {
        this._specs = specs;
        this._tokensPerInput = this._estimateTokensPerInput();
      }
    }

    const fnDef = FunctionDef.fromFunctionRef({
      module: "test.ts",
      name: "testFn",
      src: "function testFn() {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: true,
      args: [],
    });

    const prng = seedrandom("random_specs_estimation_seed");

    function toJsonObj(val: unknown): unknown {
      if (val === null || val === undefined) {
        return val;
      }
      if (val instanceof Set) {
        return Array.from(val.values()).map(toJsonObj);
      }
      if (val instanceof Uint8Array) {
        return Array.from(val);
      }
      if (Array.isArray(val)) {
        return val.map(toJsonObj);
      }
      if (typeof val === "object") {
        const res: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
          if (v !== undefined) {
            res[k] = toJsonObj(v);
          }
        }
        return res;
      }
      return val;
    }

    type SpecRecord = {
      index: number;
      specName: string;
      specDetails: string;
      estimatedTokens: number;
      avgActualTokens: number;
      errorRate: number;
      absErrorRate: number;
      sampleCount: number;
    };

    const specRecords: SpecRecord[] = [];
    const numSpecRuns = 300;
    const samplesPerSpec = 300;

    for (let s = 0; s < numSpecRuns; s++) {
      // Generate 1 to 3 random parameter specs (top-level function parameters)
      const paramCount = Math.floor(prng() * 3) + 1;
      const paramSpecs: ArgDef[] = [];
      for (let p = 0; p < paramCount; p++) {
        const rawSpec = getRandomArgDef(prng, Math.floor(prng() * 2));
        const rawOpts = rawSpec.getOptions();
        delete rawOpts.isNoInput;

        const spec = new ArgDef(
          `p${p}`,
          p,
          rawSpec.getType(),
          rawOpts,
          rawSpec.getDim(),
          false, // top-level parameters in JSON schema are required keys
          rawSpec.getIntervals(),
          rawSpec.getChildren()
        );
        paramSpecs.push(spec);
      }

      const gen = new TestableAiInputGenerator(
        fnDef,
        "seed",
        new Map(),
        "function testFn() {}"
      );
      gen.setSpecs(paramSpecs);
      const estimatedTokens = gen.estimateTokens();

      const argGen = new ArgDefGenerator(paramSpecs, prng);
      const validator = new ArgDefValidator(paramSpecs);

      let totalActualTokensForSpec = 0;
      let validSampleCount = 0;

      for (let j = 0; j < samplesPerSpec; j++) {
        try {
          const generatedArgs = argGen.next();
          if (!validator.validate(generatedArgs)) {
            continue;
          }

          const sampleInputObj: Record<string, unknown> = {};
          paramSpecs.forEach((spec, idx) => {
            if (generatedArgs[idx] !== undefined) {
              sampleInputObj[spec.getName()] = generatedArgs[idx].value;
            }
          });

          const minifiedJson = JSON.stringify(toJsonObj(sampleInputObj));
          const actualTokens = Math.ceil(minifiedJson.length / 4);

          if (actualTokens > 0) {
            totalActualTokensForSpec += actualTokens;
            validSampleCount++;
          }
        } catch {
          // Ignore generation errors for unresolvable random specs
        }
      }

      if (validSampleCount > 0) {
        const avgActualTokens = totalActualTokensForSpec / validSampleCount;
        const errorRate = (estimatedTokens - avgActualTokens) / avgActualTokens;

        specRecords.push({
          index: specRecords.length + 1,
          specName: paramSpecs
            .map((sp) => `${sp.getName()}:${sp.getType()}`)
            .join(", "),
          specDetails: paramSpecs
            .map(
              (sp) =>
                `${sp.getName()}:${sp.getType()}(dims=${sp.getDim()},dimLen=${JSON.stringify(
                  sp.getOptions().dimLength
                )},setLen=${JSON.stringify(
                  sp.getOptions().setLength
                )},dictLen=${JSON.stringify(
                  sp.getOptions().dictLength
                )},children=${sp
                  .getChildren()
                  .map((c) => c.getType())
                  .join(",")})`
            )
            .join("; "),
          estimatedTokens,
          avgActualTokens,
          errorRate,
          absErrorRate: Math.abs(errorRate),
          sampleCount: validSampleCount,
        });
      }
    }

    const numSpecsEvaluated = specRecords.length;
    expect(numSpecsEvaluated).toBeGreaterThan(100);

    const errorRates = specRecords.map((s) => s.errorRate);

    // Calculate distribution statistics across random specs
    const sortedErrors = [...errorRates].sort((a, b) => a - b);
    const sum = sortedErrors.reduce((a, b) => a + b, 0);
    const mean = sum / numSpecsEvaluated;

    const median =
      numSpecsEvaluated % 2 === 0
        ? (sortedErrors[numSpecsEvaluated / 2 - 1] +
            sortedErrors[numSpecsEvaluated / 2]) /
          2
        : sortedErrors[Math.floor(numSpecsEvaluated / 2)];

    const min = sortedErrors[0];
    const max = sortedErrors[numSpecsEvaluated - 1];

    const variance =
      sortedErrors.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) /
      numSpecsEvaluated;
    const stdDev = Math.sqrt(variance);

    // Calculate mode (binned/rounded to 2 decimal places)
    const freqMap: Record<string, number> = {};
    let maxFreq = 0;
    let modeVal = sortedErrors[0];
    for (const err of sortedErrors) {
      const key = err.toFixed(2);
      freqMap[key] = (freqMap[key] || 0) + 1;
      if (freqMap[key] > maxFreq) {
        maxFreq = freqMap[key];
        modeVal = Number(key);
      }
    }

    const formatPct = (val: number) => `${(val * 100).toFixed(2)}%`;

    // Find top 5 specs with greatest absolute error rate
    const top5Errors = [...specRecords]
      .sort((a, b) => b.absErrorRate - a.absErrorRate)
      .slice(0, 5);

    let top5Report = "\n=== Top 5 Specs with Greatest Error ===\n";
    top5Errors.forEach((s, rank) => {
      top5Report += `\nRank #${rank + 1} (Spec #${s.index}, [${s.specDetails}]):\n`;
      top5Report += `  Estimated Tokens: ${s.estimatedTokens}\n`;
      top5Report += `  Avg Actual Tokens:${s.avgActualTokens.toFixed(2)}\n`;
      top5Report += `  Error Rate:       ${formatPct(s.errorRate)}\n`;
      top5Report += `  Samples Tested:   ${s.sampleCount}\n`;
    });

    const summaryReport = `
=== Token Estimation Error Rate Distribution Across Random Specs ===
Spec Count: ${numSpecsEvaluated} (across ${numSpecRuns} generated specs)
Mean Error Rate: ${formatPct(mean)}
Median Error Rate: ${formatPct(median)}
Mode Error Rate (binned): ${formatPct(modeVal)}
Min Error Rate: ${formatPct(min)}
Max Error Rate: ${formatPct(max)}
Std Dev Error Rate: ${formatPct(stdDev)}
======================================================================
${top5Report}`;

    process.stdout.write(summaryReport);

    // Verify overall accuracy bounds across randomly generated specs
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(stdDev).toBeLessThan(0.15);
  });
});
