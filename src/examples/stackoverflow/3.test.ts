import { totalDinnerExpenses, DailyFoodExpenses } from "./3";

/**
 * BUG REPORT:
 * Test 3a passes, but test 3b fails.
 */
const expenses: DailyFoodExpenses[] = [
  {
    breakfast: 0,
    lunch: 5,
    dinner: 10,
  },
  {
    breakfast: 10,
    lunch: 5,
    dinner: 0,
  },
];

describe("3", () => {
  test("3a", () => {
    expect(totalDinnerExpenses(expenses, 0)).toStrictEqual(10);
  });
  test("3b", () => {
    expect(totalDinnerExpenses(expenses)).toStrictEqual(10);
  });
});
