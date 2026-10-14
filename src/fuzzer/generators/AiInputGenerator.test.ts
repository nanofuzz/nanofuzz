import * as path from "node:path";
import * as zod from "zod/v4";
import * as AiInputGenerator from "./AiInputGenerator";
import {
  makeArgDef,
  makeTypeRef,
  getRandomArgDef,
} from "../analysis/TestUtils";
import { ArgDef } from "../analysis/ArgDef";
import { ArgTag } from "../analysis/Types";
import { LlmQueryResult } from "./Types";
import { FunctionDef } from "../analysis/FunctionDef";
import { LlmAdapter, LlmQueryOptions } from "../adapters/LlmAdapter";
import { Leaderboard } from "./Leaderboard";
import { InputAndSource } from "../Types";
import { prompt } from "./AiInputGenerator";
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

  it("dictLength schema directives", () => {
    const argOptions = ArgDef.getDefaultOptions();
    const keyRef = makeTypeRef("test.ts", "keys", ArgTag.NUMBER, 0);
    const valRef = makeTypeRef("test.ts", "values", ArgTag.NUMBER, 0);
    const dictDef = makeArgDef(
      "test.ts",
      "dictArg",
      0,
      ArgTag.DICTIONARY,
      {
        ...argOptions,
        dictLength: { min: 2, max: 10 },
      },
      0,
      false,
      [keyRef, valRef]
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
    gen.testArgDefToSchema(dictDef, "dictArg", directives);

    expect(directives).toContain(
      "dictArg: dictionary length must be >= 2 && <= 10"
    );
    expect(directives).toContain(
      'dictArg: dictionary keys must be formatted as integer strings (e.g. "0", "1")'
    );
  });

  it("strRegex schema directives", () => {
    const argOptions = ArgDef.getDefaultOptions();
    const strDef = makeArgDef(
      "test.ts",
      "uid",
      0,
      ArgTag.STRING,
      {
        ...argOptions,
        strLength: { min: 36, max: 36 },
        strCharset: "0123456789abcdef-",
        strRegex:
          "\\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\Z",
      },
      0
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
    gen.testArgDefToSchema(strDef, "uid", directives);

    expect(directives).toContain(
      "uid: string length must be >= 36 && <= 36; the string may contain only the following characters: 0123456789abcdef-; string must match regex pattern /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/"
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

  it("decode bigint placeholder", () => {
    // ArgDefTokenEstimator sizes a bigint response using this prefix length
    expect(AiInputGenerator.NANOFUZZ_BIGINT.length).toBe(37);

    expect<unknown>(
      AiInputGenerator._decode(`${AiInputGenerator.NANOFUZZ_BIGINT}42`)
    ).toEqual(BigInt(42));
    expect<unknown>(
      AiInputGenerator._decode(`${AiInputGenerator.NANOFUZZ_BIGINT}-42`)
    ).toEqual(BigInt(-42));
    expect<unknown>(
      AiInputGenerator._decode([
        `${AiInputGenerator.NANOFUZZ_BIGINT}1`,
        `${AiInputGenerator.NANOFUZZ_BIGINT}2`,
      ])
    ).toEqual([BigInt(1), BigInt(2)]);
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

  it("prompt.genInputs adds request sequence number when backfeedPriorInputs is false", () => {
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

    const allInputs = new Map<string, unknown>([
      ['[{"value":1,"tag":"ArgValueTypeWrapped"}]', true],
    ]);

    Config.override("nanofuzz.ai.backfeedPriorInputs", false);
    try {
      const prompt1 = prompt.genInputs(fnDef, [], allInputs, "", 25);
      expect(prompt1).toContain(
        "This is request number 1 for this testing session."
      );
      expect(prompt1).not.toContain(
        "The following inputs were previously generated and tested"
      );

      const prompt2 = prompt.genInputs(fnDef, [], allInputs, "", 25, 2);
      expect(prompt2).toContain(
        "This is request number 2 for this testing session."
      );
      expect(prompt2).not.toContain(
        "The following inputs were previously generated and tested"
      );
    } finally {
      Config.clearOverrides();
    }
  });

  it("prompt.genInputs omits request sequence number when backfeedPriorInputs is true", () => {
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

    const allInputs = new Map<string, unknown>([
      ['[{"value":1,"tag":"ArgValueTypeWrapped"}]', true],
    ]);

    Config.override("nanofuzz.ai.backfeedPriorInputs", true);
    try {
      // Non-empty allInputs
      const promptWithInputs = prompt.genInputs(
        fnDef,
        [],
        allInputs,
        "",
        25,
        1
      );
      expect(promptWithInputs).not.toContain("This is request number");
      expect(promptWithInputs).toContain(
        "The following inputs were previously generated and tested"
      );

      // Empty allInputs (e.g. first request in session)
      const promptEmptyInputs = prompt.genInputs(
        fnDef,
        [],
        new Map(),
        "",
        25,
        1
      );
      expect(promptEmptyInputs).not.toContain("This is request number");
      expect(promptEmptyInputs).not.toContain(
        "The following inputs were previously generated and tested"
      );
    } finally {
      Config.clearOverrides();
    }
  });

  it("prompt.genInputs formats inputs in compact array format and separates interesting from other inputs", () => {
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

    const leaderboard = new Leaderboard<InputAndSource>();
    const interestingInput: InputAndSource = {
      tick: 0,
      value: [{ tag: "ArgValueTypeWrapped", value: 99 }],
      source: { type: "user" },
    };
    leaderboard.postScore(interestingInput, 5.0);

    const allInputs = new Map<string, unknown>([
      ["[99]", true],
      ["[1]", true],
      ["[2]", true],
    ]);

    Config.override("nanofuzz.ai.backfeedPriorInputs", true);
    try {
      const promptText = prompt.genInputs(
        fnDef,
        [],
        allInputs,
        "",
        25,
        1,
        undefined,
        undefined,
        leaderboard
      );

      // Distinct interesting section in compact array format
      expect(promptText).toContain(
        "Prior inputs that covered distinct branches or triggered errors (do not repeat):\n[[99]]"
      );
      // Other section without repeating [99] in compact array format
      expect(promptText).toContain(
        "The following inputs were previously generated and tested, so don't generate these again:\n[[1], [2]]"
      );
    } finally {
      Config.clearOverrides();
    }
  });

  it("prompt.genInputs respects maxBackfeedTokens budget and prioritizes interesting inputs with rolling tail for other inputs", () => {
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

    const leaderboard = new Leaderboard<InputAndSource>();
    const leader1: InputAndSource = {
      tick: 0,
      value: [{ tag: "ArgValueTypeWrapped", value: 100 }],
      source: { type: "user" },
    };
    const leader2: InputAndSource = {
      tick: 1,
      value: [{ tag: "ArgValueTypeWrapped", value: 200 }],
      source: { type: "user" },
    };
    leaderboard.postScore(leader1, 10.0);
    leaderboard.postScore(leader2, 5.0);

    const allInputs = new Map<string, unknown>([
      ["[100]", true],
      ["[200]", true],
      ["[10]", true],
      ["[20]", true],
      ["[30]", true],
      ["[40]", true],
      ["[50]", true],
    ]);

    Config.override("nanofuzz.ai.backfeedPriorInputs", true);
    try {
      // Allocate a budget that allows roughly 2-3 inputs total (~12 tokens)
      const promptText = prompt.genInputs(
        fnDef,
        [],
        allInputs,
        "",
        25,
        1,
        undefined,
        undefined,
        leaderboard,
        12
      );

      // Interesting section receives highest-scoring leader [100]
      expect(promptText).toContain(
        "Prior inputs that covered distinct branches or triggered errors"
      );
      expect(promptText).toContain("[100]");

      // Other section takes the tail of otherInputs (most recent: [50]), omitting older ones like [10]
      expect(promptText).toContain(
        "The following inputs were previously generated and tested"
      );
      expect(promptText).toContain("[50]");
      expect(promptText).not.toContain("[10]");
    } finally {
      Config.clearOverrides();
    }
  });

  it("prompt.genInputs includes uncovered and partially covered lines when uncoveredInfo is provided", () => {
    const mathPath = path.join(process.cwd(), "src/math.ts");
    const fnDef = FunctionDef.fromFunctionRef({
      module: mathPath,
      name: "calculate",
      src: "function calculate(x: number) {}",
      lang: "typescript",
      startOffset: 0,
      endOffset: 30,
      isExported: true,
      isVoid: false,
      args: [],
    });

    const uncoveredInfo = {
      uncoveredLinesByFile: {
        [mathPath]: [10, 11, 12, 25],
      },
      partiallyCoveredLinesByFile: {
        [mathPath]: [18],
      },
    };

    const promptText = prompt.genInputs(
      fnDef,
      [],
      new Map(),
      "function calculate(x: number) {}",
      10,
      1,
      uncoveredInfo
    );

    const relMathPath = path.relative(process.cwd(), mathPath);

    expect(promptText).toContain(
      "Code coverage achieved by prior tests indicates the following lines have NOT been fully executed:"
    );
    expect(promptText).toContain(
      `Uncovered in \`${relMathPath}\`: line(s) 10-12, 25`
    );
    expect(promptText).toContain(
      `Partially covered in \`${relMathPath}\`: line(s) 18`
    );
    expect(promptText).toContain(
      "Generate inputs that specifically aim to execute these uncovered lines and branches"
    );
  });

  it("prompt.genInputs omits coverage section when uncoveredInfo is empty", () => {
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

    const promptText = prompt.genInputs(fnDef, [], new Map(), "", 10, 1, {
      uncoveredLinesByFile: {},
      partiallyCoveredLinesByFile: {},
    });

    expect(promptText).not.toContain("Code coverage achieved by prior tests");
    expect(promptText).not.toContain("Uncovered in");
  });

  it("prompt.genInputs omits coverage section when uncoveredInfo is undefined", () => {
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

    const promptText = prompt.genInputs(
      fnDef,
      [],
      new Map(),
      "",
      10,
      1,
      undefined
    );

    expect(promptText).not.toContain("Code coverage achieved by prior tests");
    expect(promptText).not.toContain("Uncovered in");
  });

  it("nanofuzz.ai.coverageGuidance config defaults to true and can be disabled", () => {
    expect(
      Config.get<boolean>("nanofuzz.ai.coverageGuidance", true)
    ).toBeTrue();

    Config.override("nanofuzz.ai.coverageGuidance", false);
    try {
      expect(
        Config.get<boolean>("nanofuzz.ai.coverageGuidance", true)
      ).toBeFalse();
    } finally {
      Config.clearOverrides();
    }
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

  it("passes request sequence number to llm.query", async () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public setLlm(llm: LlmAdapter): void {
        this._llm = llm;
      }
      public callGetMoreInputs(): void {
        this._getMoreInputs();
      }
      public clearPending(): void {
        this._callsPending = 0;
      }
    }

    class MockLlmAdapter extends LlmAdapter {
      public readonly prompts: string[] = [];
      public override get id(): string {
        return "test-model";
      }
      public override async query(
        promptText: string | string[],
        _schema?: zod.ZodType
      ): Promise<LlmQueryResult> {
        this.prompts.push(
          Array.isArray(promptText) ? promptText.join("\n") : promptText
        );
        return {
          text: JSON.stringify({ programInputs: [] }),
          stats: {
            tokensSent: 10,
            tokensSentCost: { amt: 0, unit: "USD" },
            tokensReceived: 5,
            tokensReceivedCost: { amt: 0, unit: "USD" },
          },
        };
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

    Config.override("nanofuzz.ai.provider", "gemini");
    Config.override("nanofuzz.ai.model", "gemini-flash");
    Config.override("nanofuzz.ai.apiKey", "test-key");
    Config.override("nanofuzz.ai.backfeedPriorInputs", false);

    try {
      const mockLlm = new MockLlmAdapter();
      gen.setLlm(mockLlm);
      gen.callGetMoreInputs();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockLlm.prompts.length).toBe(1);
      expect(mockLlm.prompts[0]).toContain(
        "This is request number 1 for this testing session."
      );

      gen.clearPending();
      gen["_exhausted"] = false;
      gen.callGetMoreInputs();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockLlm.prompts.length).toBe(2);
      expect(mockLlm.prompts[1]).toContain(
        "This is request number 2 for this testing session."
      );
    } finally {
      Config.clearOverrides();
    }
  });

  it("handles input parsing, discards, and LLM failures in AiInputGenerator", async () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public setLlm(llm: LlmAdapter): void {
        this._llm = llm;
      }
      public callGetMoreInputs(): void {
        this._getMoreInputs();
      }
      public clearPending(): void {
        this._callsPending = 0;
      }
      public getQueueLength(): number {
        return this._inputQueue.length;
      }
      public getCallStats() {
        return this._stats.calls;
      }
      public getInputStats() {
        return this._stats.inputs;
      }
    }

    class MockLlmAdapter extends LlmAdapter {
      public responseText: string = JSON.stringify({ programInputs: [] });
      public shouldFail: boolean = false;

      public override get id(): string {
        return "test-model";
      }
      public override async query(
        _promptText: string | string[],
        _schema?: zod.ZodType
      ): Promise<LlmQueryResult> {
        if (this.shouldFail) {
          throw new Error("simulated model timeout");
        }
        return {
          text: this.responseText,
          stats: {
            tokensSent: 12,
            tokensSentCost: { amt: 0, unit: "USD" },
            tokensReceived: 8,
            tokensReceivedCost: { amt: 0, unit: "USD" },
          },
        };
      }
    }

    const argDef = makeArgDef(
      "test.ts",
      "x",
      0,
      ArgTag.NUMBER,
      ArgDef.getDefaultOptions(),
      0
    );
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

    Config.override("nanofuzz.ai.provider", "gemini");
    Config.override("nanofuzz.ai.model", "gemini-flash");
    Config.override("nanofuzz.ai.apiKey", "test-key");
    Config.override("nanofuzz.ai.backfeedPriorInputs", false);
    Config.override("nanofuzz.ai.retryDelay", 0);

    try {
      // 1. Valid inputs parsed and queued
      const gen1 = new TestableAiInputGenerator(
        fnDef,
        "seed1",
        new Map([["x", argDef]]),
        "function testFn(x: number) {}"
      );
      const mock1 = new MockLlmAdapter();
      mock1.responseText = JSON.stringify({
        programInputs: [{ x: 42 }, { x: 100 }],
      });
      gen1.setLlm(mock1);
      gen1.callGetMoreInputs();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(gen1.getQueueLength()).toBe(2);
      expect(gen1.getCallStats().valid).toBe(1);
      expect(gen1.getInputStats().gen).toBe(2);

      // 2. Discard malformed JSON
      const gen2 = new TestableAiInputGenerator(
        fnDef,
        "seed2",
        new Map([["x", argDef]]),
        "function testFn(x: number) {}"
      );
      const mock2 = new MockLlmAdapter();
      mock2.responseText = "NOT VALID JSON";
      gen2.setLlm(mock2);
      gen2.callGetMoreInputs();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(gen2.getQueueLength()).toBe(0);
      expect(gen2.getCallStats().invalid).toBe(1);
      expect(gen2.getCallStats().history[0]).toEqual({ discard: true });

      // 3. Discard invalid schema shape
      const gen3 = new TestableAiInputGenerator(
        fnDef,
        "seed3",
        new Map([["x", argDef]]),
        "function testFn(x: number) {}"
      );
      const mock3 = new MockLlmAdapter();
      mock3.responseText = JSON.stringify({ unexpectedKey: 123 });
      gen3.setLlm(mock3);
      gen3.callGetMoreInputs();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(gen3.getQueueLength()).toBe(0);
      expect(gen3.getCallStats().invalid).toBe(1);
      expect(gen3.getCallStats().history[0]).toEqual({ discard: true });

      // 4. Handle query rejection / failure
      const gen4 = new TestableAiInputGenerator(
        fnDef,
        "seed4",
        new Map([["x", argDef]]),
        "function testFn(x: number) {}"
      );
      const mock4 = new MockLlmAdapter();
      mock4.shouldFail = true;
      gen4.setLlm(mock4);
      gen4.callGetMoreInputs();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(gen4.getQueueLength()).toBe(0);
      expect(gen4.getCallStats().failed).toBe(1);
      expect(gen4.getCallStats().history[0]).toEqual({
        failure: true,
        message: "simulated model timeout",
      });
    } finally {
      Config.clearOverrides();
    }
  });

  it("disables adapter retries via query options and refreshes query on timeout", async () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public setLlm(llm: LlmAdapter): void {
        this._llm = llm;
      }
      public callGetMoreInputs(): void {
        this._getMoreInputs();
      }
      public getQueueLength(): number {
        return this._inputQueue.length;
      }
      public getCallStats() {
        return this._stats.calls;
      }
    }

    class MockLlmAdapter extends LlmAdapter {
      public queryCount = 0;
      public readonly prompts: string[] = [];
      public readonly receivedOptions: (LlmQueryOptions | undefined)[] = [];

      public override get id(): string {
        return "test-model";
      }
      public override async query(
        promptText: string | string[],
        _schema?: zod.ZodType,
        options?: LlmQueryOptions
      ): Promise<LlmQueryResult> {
        this.queryCount++;
        this.receivedOptions.push(options);
        this.prompts.push(
          Array.isArray(promptText) ? promptText.join("\n") : promptText
        );
        if (this.queryCount === 1) {
          throw new Error("Request timeout after 60000ms");
        }
        return {
          text: JSON.stringify({ programInputs: [{ x: 42 }] }),
          stats: {
            tokensSent: 10,
            tokensSentCost: { amt: 0, unit: "USD" },
            tokensReceived: 5,
            tokensReceivedCost: { amt: 0, unit: "USD" },
          },
        };
      }
    }

    const argDef = makeArgDef(
      "test.ts",
      "x",
      0,
      ArgTag.NUMBER,
      ArgDef.getDefaultOptions(),
      0
    );
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

    Config.override("nanofuzz.ai.provider", "gemini");
    Config.override("nanofuzz.ai.model", "gemini-flash");
    Config.override("nanofuzz.ai.apiKey", "test-key");
    Config.override("nanofuzz.ai.backfeedPriorInputs", false);
    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 0);

    try {
      const gen = new TestableAiInputGenerator(
        fnDef,
        "seed_retry",
        new Map([["x", argDef]]),
        "function testFn(x: number) {}"
      );
      const mockLlm = new MockLlmAdapter();
      gen.setLlm(mockLlm);
      gen.callGetMoreInputs();
      await new Promise((resolve) => setTimeout(resolve, 15));

      // Adapter retry was disabled on both queries
      expect(mockLlm.queryCount).toBe(2);
      expect(mockLlm.receivedOptions[0]?.retryOnTimeout).toBeFalse();
      expect(mockLlm.receivedOptions[0]?.retries).toBe(0);
      expect(mockLlm.receivedOptions[1]?.retryOnTimeout).toBeFalse();

      // Second query was refreshed with sequence number 2
      expect(mockLlm.prompts[0]).toContain(
        "This is request number 1 for this testing session."
      );
      expect(mockLlm.prompts[1]).toContain(
        "This is request number 2 for this testing session."
      );

      // Inputs were successfully queued after refreshed query
      expect(gen.getQueueLength()).toBe(1);
      expect(gen.getCallStats().valid).toBe(1);
      expect(gen.getCallStats().failed).toBe(0);
    } finally {
      Config.clearOverrides();
    }
  });

  it("does not retry when non-timeout error occurs during query", async () => {
    class TestableAiInputGenerator extends AiInputGenerator.AiInputGenerator {
      public setLlm(llm: LlmAdapter): void {
        this._llm = llm;
      }
      public callGetMoreInputs(): void {
        this._getMoreInputs();
      }
      public getQueueLength(): number {
        return this._inputQueue.length;
      }
      public getCallStats() {
        return this._stats.calls;
      }
    }

    class MockLlmAdapter extends LlmAdapter {
      public queryCount = 0;

      public override get id(): string {
        return "test-model";
      }
      public override async query(
        _promptText: string | string[],
        _schema?: zod.ZodType,
        _options?: LlmQueryOptions
      ): Promise<LlmQueryResult> {
        this.queryCount++;
        throw new Error("Authentication failed: invalid API key");
      }
    }

    const argDef = makeArgDef(
      "test.ts",
      "x",
      0,
      ArgTag.NUMBER,
      ArgDef.getDefaultOptions(),
      0
    );
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

    Config.override("nanofuzz.ai.provider", "gemini");
    Config.override("nanofuzz.ai.model", "gemini-flash");
    Config.override("nanofuzz.ai.apiKey", "test-key");
    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 0);

    try {
      const gen = new TestableAiInputGenerator(
        fnDef,
        "seed_auth_fail",
        new Map([["x", argDef]]),
        "function testFn(x: number) {}"
      );
      const mockLlm = new MockLlmAdapter();
      gen.setLlm(mockLlm);
      gen.callGetMoreInputs();
      await new Promise((resolve) => setTimeout(resolve, 15));

      // No retries on non-timeout error
      expect(mockLlm.queryCount).toBe(1);
      expect(gen.getQueueLength()).toBe(0);
      expect(gen.getCallStats().failed).toBe(1);
      expect(gen.getCallStats().history[0]).toEqual({
        failure: true,
        message: "Authentication failed: invalid API key",
      });
    } finally {
      Config.clearOverrides();
    }
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
      if (typeof val === "bigint") {
        // A bigint reaches the model as a prefixed decimal string, since
        // neither JSON nor JSON Schema can represent one. Without this,
        // JSON.stringify throws on every bigint sample below and the catch
        // silently drops it, leaving the estimate unmeasured.
        return `${AiInputGenerator.NANOFUZZ_BIGINT}${val.toString()}`;
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
    expect(stdDev).toBeLessThan(0.1);
  });
});
