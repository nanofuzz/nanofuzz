import { minSalary } from "./8";

/**
 * BUG REPORT
 * Test 8a passes, but test 8b fails.
 */
describe("8", () => {
  // This test passes
  test("8a", () => {
    expect(minSalary([100, 12000, 80000, 45000, 25000, 0])).toStrictEqual(0);
  });

  // Remove ".skip" to run this failing test
  test.skip("8b", () => {
    expect(minSalary([])).toBeUndefined();
  });
});
