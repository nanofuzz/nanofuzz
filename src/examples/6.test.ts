import { getZero } from "./6";

/**
 * BUG REPORT
 * Test 6a passes, but test 6b fails with a TypeError.
 */
describe("6", () => {
  // This test passes
  test("6a", () => {
    expect(getZero([0])).toStrictEqual("0");
  });

  // Remove ".skip" to run this failing test
  test.skip("6b", () => {
    expect(getZero([1])).toStrictEqual("");
  });
});
