import { encodeEscapeSequences, decodeEscapeSequences } from "./Util";

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
});
