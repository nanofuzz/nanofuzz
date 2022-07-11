import { maxOfArray } from "./4";

/**
 * BUG REPORT
 * Test 4a passes, but test 4b fails.
 */
describe("4", () => {
  test("4a", () => {
    expect(maxOfArray([1])).toStrictEqual(1);
  });
  test("4b", () => {
    expect(maxOfArray([0,1])).toStrictEqual(1);
  });
});
