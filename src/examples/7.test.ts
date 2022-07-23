import { sortByWinLoss } from "./7";

/**
 * BUG REPORT
 * Test 7a passes, but test 7b fails with an incorrect sort.
 */
describe("7", () => {
  // This test passes
  test("7a", () => {
    expect(
      sortByWinLoss([
        { win: 2, lose: 1 }, // 2/1
        { win: 3, lose: 1 }, // 3/1
        { win: 1, lose: 2 }, // 1/2
      ])
    ).toStrictEqual([
      { win: 3, lose: 1, rank: 3 }, // 3/1
      { win: 2, lose: 1, rank: 2 }, // 2/1
      { win: 1, lose: 2, rank: 0.5 }, // 1/2
    ]);
  });

  // Remove ".skip" to run this failing test
  test.skip("7b", () => {
    expect(
      sortByWinLoss([
        { win: 0, lose: 0 }, // 0/0
        { win: 2, lose: 2 }, // 2/2
        { win: 3, lose: 1 }, // 3/1
      ])
    ).toStrictEqual([
      { win: 3, lose: 1, rank: 3 }, // 3/1
      { win: 2, lose: 2, rank: 1 }, // 2/2
      { win: 0, lose: 0, rank: 0 }, // 0/0
    ]);
  });
});
