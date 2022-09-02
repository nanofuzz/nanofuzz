import { sortByWinLoss } from "./7";

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
});
