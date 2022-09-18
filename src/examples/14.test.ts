import { modInv } from "./14";

describe("14", () => {
  // This test passes
  test("14a", () => {
    expect(modInv(42, 2017)).toStrictEqual(1969);
  });
});
