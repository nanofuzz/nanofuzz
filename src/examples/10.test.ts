import { gramSchmidt } from "./10";

/**
 * BUG REPORT
 * Test 10a passes, but test 10b fails.
 */
describe("10", () => {
  // This test passes
  test("10a", () => {
    expect(
      gramSchmidt([
        [2, 4],
        [5, 0],
      ])
    ).toStrictEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});
