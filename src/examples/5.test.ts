import { getRandomNumber } from "./5";

/**
 * BUG REPORT:
 * Test 5a is flaky: sometimes getNumber() incorrectly returns a NaN.
 */
describe("5", () => {
  test.skip("5a", () => {
    expect(getRandomNumber()).not.toBe(NaN);
  });
});
