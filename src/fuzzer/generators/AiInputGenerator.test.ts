import * as AiInputGenerator from "./AiInputGenerator";
import { makeArgDef } from "../analysis/TestUtils";
import { ArgDef } from "../analysis/ArgDef";
import { ArgTag } from "../analysis/Types";
import { FunctionDef } from "../analysis/FunctionDef";

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
    const gen = new TestAiGenerator(fnDef, "seed", new Map());
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
});
