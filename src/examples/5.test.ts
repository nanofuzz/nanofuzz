import { getRandomNumber } from "./5";

/**
 * BUG REPORT:
 * Test 5a is flaky: sometimes getNumber() incorrectly returns a NaN.
 */
describe("5", () => {
  // Remove ".skip" to run this flaky test
  test.skip("5a", () => {
    expect(getRandomNumber()).not.toBe(NaN);
  });
});
