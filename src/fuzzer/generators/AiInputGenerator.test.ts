import * as AiInputGenerator from "./AiInputGenerator";
import { makeArgDef } from "../analysis/TestUtils";
import { ArgDef } from "../analysis/ArgDef";
import { ArgTag } from "../analysis/Types";
import { FunctionDef } from "../analysis/FunctionDef";
import { LlmAdapter, prompt } from "../adapters/LlmAdapter";

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
    const promptText = prompt.genInputs(fnDef, [], new Map(), moduleSrc);
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
    const promptText = prompt.genInputs(fnDef, [], new Map(), moduleSrc);
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
});
