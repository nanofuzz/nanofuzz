import {
  encodeEscapeSequences,
  decodeEscapeSequences,
  removeTickFromOrigin,
  deepFreeze,
  getDisplayPath,
} from "./Util";
import { FuzzValueOrigin } from "./fuzzer/Types";

describe("src/Util escape sequence encoder/decoder", () => {
  it("encodes control characters and backslashes to printable escape sequences", () => {
    expect(encodeEscapeSequences("abc\n\r\t\0\\def")).toEqual(
      "abc\\n\\r\\t\\0\\\\def"
    );
  });

  it("decodes printable escape sequences back to control characters and backslashes", () => {
    expect(decodeEscapeSequences("abc\\n\\r\\t\\0\\\\def")).toEqual(
      "abc\n\r\t\0\\def"
    );
  });

  it("decodes hex and unicode escape sequences like \\u{1F600}, \\u0041, \\x41", () => {
    expect(decodeEscapeSequences("\\u{1F600}\\u0041\\x42")).toEqual("😀AB");
  });

  it("handles round-trip encoding and decoding", () => {
    const original = "abcdefghijklmnop \n\t\r\0\\";
    const encoded = encodeEscapeSequences(original);
    expect(encoded).toEqual("abcdefghijklmnop \\n\\t\\r\\0\\\\");
    const decoded = decodeEscapeSequences(encoded);
    expect(decoded).toEqual(original);
  });

  it("removes tick from MutationInputGenerator origin (unfrozen and frozen)", () => {
    const mutableOrigin: FuzzValueOrigin = {
      type: "generator",
      generator: "MutationInputGenerator",
      tick: 42,
      steps: { taken: 1, max: 5, mode: "mutate", mutators: ["foo"] },
    };
    const res1 = removeTickFromOrigin(mutableOrigin);
    expect("tick" in res1).toBeFalse();

    const frozenOrigin: FuzzValueOrigin = deepFreeze({
      type: "generator",
      generator: "MutationInputGenerator",
      tick: 42,
      steps: { taken: 1, max: 5, mode: "mutate", mutators: ["foo"] },
    });
    const res2 = removeTickFromOrigin(frozenOrigin);
    expect("tick" in res2).toBeFalse();
  });
});

describe("src/Util getDisplayPath", () => {
  it("normalizes absolute paths under process.cwd() to relative paths with forward slashes", () => {
    const cwd = process.cwd();
    const filePath = `${cwd}/src/math.ts`;
    expect(getDisplayPath(filePath)).toBe("src/math.ts");
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    const cwd = process.cwd().replace(/\\/g, "/");
    const winPath = `${cwd}\\src\\utils\\helper.ts`;
    expect(getDisplayPath(winPath)).toBe("src/utils/helper.ts");
  });

  it("preserves already relative paths", () => {
    expect(getDisplayPath("src/index.ts")).toBe("src/index.ts");
  });
});
