import { sortByWinLoss, PlayerRecord } from "./7";

/**
 * BUG REPORT
 * Test 7a passes, but test 7b fails with an incorrect sort.
 */
describe("7", () => {
  // This test passes
  test("7a", () => {
    expect(
      sortByWinLoss([
        [2, 1], // 2/1
        [3, 1], // 3/1
        [1, 2], // 1/2
      ])
    ).toStrictEqual([
      [3, 1], // 3/1
      [2, 1], // 2/1
      [1, 2], // 1/2
    ]);
  });

  // Remove ".skip" to run this failing test
  test.skip("7b", () => {
    expect(
      sortByWinLoss([
        [0, 0], // 0/0
        [2, 2], // 2/2
        [3, 1], // 3/1
      ])
    ).toStrictEqual([
      [3, 1], // 3/1
      [2, 2], // 2/2
      [0, 0], // 1/0
    ]);
  });
});
