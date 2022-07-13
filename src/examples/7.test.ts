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
        { playerName: "b", win: 2, lose: 1 }, // 2/1
        { playerName: "a", win: 3, lose: 1 }, // 3/1
        { playerName: "c", win: 1, lose: 2 }, // 1/2
      ])
    ).toStrictEqual([
      { playerName: "a", win: 3, lose: 1 }, // 3/1
      { playerName: "b", win: 2, lose: 1 }, // 2/1
      { playerName: "c", win: 1, lose: 2 }, // 1/2
    ]);
  });

  // Remove ".skip" to run this failing test
  test.skip("7b", () => {
    expect(
      sortByWinLoss([
        { playerName: "f", win: 0, lose: 0 }, // 0/0
        { playerName: "e", win: 2, lose: 2 }, // 2/2
        { playerName: "d", win: 3, lose: 1 }, // 3/1
      ])
    ).toStrictEqual([
      { playerName: "d", win: 3, lose: 1 }, // 3/1
      { playerName: "e", win: 2, lose: 2 }, // 2/2
      { playerName: "f", win: 0, lose: 0 }, // 1/0
    ]);
  });
});
