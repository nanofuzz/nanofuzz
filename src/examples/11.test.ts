import { idMatrix } from "./11";

/**
 * BUG REPORT
 * Test 11a passes, but test 11b fails.
 */
describe("11", () => {
  // This test passes
  test("11a", () => {
    expect(idMatrix(1)).toStrictEqual(1);
  });

  // Remove ".skip" to run this failing test
  test.skip("11b", () => {
    expect(idMatrix(2)).toStrictEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});
