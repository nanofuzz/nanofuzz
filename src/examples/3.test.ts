import { totalDinnerExpenses } from "./3";

/**
 * BUG REPORT:
 * Test 3a passes, but test 3b fails.
 */
describe("3", () => {
  // This test passes
  test("3a", () => {
    expect(totalDinnerExpenses([10, 0], 0)).toStrictEqual(10);
  });

  // Remove ".skip" to run this failing test
  test.skip("3b", () => {
    expect(totalDinnerExpenses([10, 0])).toStrictEqual(10);
  });
});
