import { josephus } from "./11";

/**
 * BUG REPORT
 * Test 11a passes, but test 11b fails.
 */
describe("11", () => {
  // This test passes
  test("11a", () => {
    expect(josephus(41, 3)).toStrictEqual(31);
  });

  // Remove ".skip" to run this failing test
  test("11b", () => {
    expect(josephus(2, 4)).toStrictEqual(1);
  });
});
