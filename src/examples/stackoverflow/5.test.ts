import { getNumber } from "./5";

/**
 * BUG REPORT: 
 * Test 5a is flaky: sometimes getNumber() returns a NaN.
 */
describe("5", () => {
  test("5a", () => {
    expect(getNumber()).not.toBe(NaN);
  });
});
