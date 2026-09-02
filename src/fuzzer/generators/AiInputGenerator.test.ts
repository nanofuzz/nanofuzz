import * as AiInputGenerator from "./AiInputGenerator";
import { makeArgDef } from "../analysis/TestUtils";
import { ArgDef } from "../analysis/ArgDef";
import { ArgTag } from "../analysis/Types";

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const genProto = AiInputGenerator.AiInputGenerator.prototype as any;
    genProto._argDefToSchema(argDef, "items", directives);

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
});
