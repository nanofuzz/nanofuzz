import * as AiInputGenerator from "./AiInputGenerator";

describe("src/fuzzer/generators/AiInputGenerator: ", () => {
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
