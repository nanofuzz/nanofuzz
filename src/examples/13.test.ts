import { isSteady } from "./13";

/**
 * BUG REPORT
 * Test 13a passes, but test 13b fails.
 */
describe("13", () => {
  // This test passes
  test("13a", () => {
    expect(isSteady(1)).toStrictEqual(true);
  });

  // Remove ".skip" to run this failing test
  test.skip("13b", () => {
    expect(isSteady(-1)).toStrictEqual(true);
  });
});
