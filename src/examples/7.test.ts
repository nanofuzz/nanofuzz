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
        { playerName: "a", win: 3, lose: 1 }, // 3/1 = 3
        { playerName: "b", win: 2, lose: 1 }, // 2/1 = 2
        { playerName: "c", win: 1, lose: 2 }, // 1/2 = 0.5
      ])
    ).toStrictEqual([
      { playerName: "a", win: 3, lose: 1 }, // 3/1 = 3
      { playerName: "b", win: 2, lose: 1 }, // 2/1 = 2
      { playerName: "c", win: 1, lose: 2 }, // 1/2 = 0.5
    ]);
  });

  // Remove ".skip" to run this failing test
  test.skip("7b", () => {
    expect(
      sortByWinLoss([
        { playerName: "f", win: 0, lose: 3 }, // 0/3 = 0
        { playerName: "e", win: 2, lose: 2 }, // 2/2 = 1
        { playerName: "d", win: 3, lose: 1 }, // 3/1 = 3
      ])
    ).toStrictEqual([
      { playerName: "d", win: 3, lose: 1 }, // 3/1 = 3
      { playerName: "e", win: 2, lose: 2 }, // 2/2 = 1
      { playerName: "f", win: 0, lose: 3 }, // 0/3 = 0
    ]);
  });
});
