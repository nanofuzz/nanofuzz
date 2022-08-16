import { totalDinnerExpenses } from "./3";

/**
 * BUG REPORT:
 * Test 3a passes.
 */
describe("3", () => {
  // This test passes
  test("3a", () => {
    expect(totalDinnerExpenses([10, 0], 0)).toStrictEqual(10);
  });
  test.skip("3b", () => {
    expect(totalDinnerExpenses([10, 5])).toStrictEqual(15);
  });
  
  test("3c", () => {
    expect(totalDinnerExpenses([10, 5], -5)).toStrictEqual(10);
  });
  
  test.skip("3d", () => {
    expect(totalDinnerExpenses([10, NaN])).toStrictEqual(10);
  });
});
