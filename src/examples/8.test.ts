import { minSalary, Employee } from "./8";

/**
 * BUG REPORT
 * Test 8a passes, but test 8b fails.
 */
describe("8", () => {
  // This test passes
  test("8a", () => {
    expect(
      minSalary([
        { name: "P", salary: 100 },
        { name: "S", salary: 12000 },
        { name: "Q", salary: 80000 },
        { name: "W", salary: 45000 },
        { name: "E", salary: 25000 },
        { name: "V", salary: 0 },
      ])
    ).toStrictEqual(0);
  });

  // Remove ".skip" to run this failing test
  test.skip("8b", () => {
    expect(minSalary([])).toBeUndefined();
  });
});
