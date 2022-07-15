import { minValue, Well } from "./1";

/**
 * BUG REPORT
 * Test 1a passes, but test 1b fails.
 */
describe("1", () => {
  // This test passes
  test("1a", () => {
    expect(minValue([["2"], ["4"], ["1"]])).toStrictEqual(1);
  });

  // Remove ".skip" to run this failing test
  test.skip("1b", () => {
    expect(minValue([["2"], ["4"], ["0"]])).toStrictEqual(0);
  });
});
