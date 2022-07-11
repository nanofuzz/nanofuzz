import { minMaxValue, Well } from "./1";

/**
 * BUG REPORT
 * Test 1a passes, but test 1b fails.
 */
const wells: Well[] = [];

wells.push({
  posCol: 0,
  posRow: 0,
  valueText: "2",
});
wells.push({
  posCol: 1,
  posRow: 0,
  valueText: "4",
});
wells.push({
  posCol: 2,
  posRow: 0,
  valueText: "1",
});

const moreWells: Well[] = [];

moreWells.push({
  posCol: 0,
  posRow: 0,
  valueText: "2"
});
moreWells.push({
  posCol: 1,
  posRow: 0,
  valueText: "4"
});
moreWells.push({
  posCol: 2,
  posRow: 0,
  valueText: "0"
});

describe("1", () => {
  test("1a", () => {
    expect(minMaxValue(wells)).toStrictEqual({ min: 1, max: 4 });
  });
  test("1b", () => {
    expect(minMaxValue(moreWells)).toStrictEqual({ min: 1, max: 4 });
  });
});
