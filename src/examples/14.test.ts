import { modInv } from "./14";

/**
 * BUG REPORT
 * Test 14a passes, but test 14b fails.
 */
describe("14", () => {
  // This test passes
  test("14a", () => {
    expect(modInv(42, 2017)).toStrictEqual(1969);
  });

  // Remove ".skip" to run this failing test
  test.skip("14b", () => {
    expect(modInv(42, 2018)).toStrictEqual("Not defined");
  });
});
