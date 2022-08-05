import { getSortSetting } from "./2";

/**
 * BUG REPORT
 * Test 2a passes, but test 2b fails.
 */
describe("2", () => {
  // This test passes
  test("2a", () => {
    expect(getSortSetting(2)).toStrictEqual(2);
  });
});
