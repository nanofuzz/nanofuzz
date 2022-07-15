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

  // Remove ".skip" to run this failing test
  test.skip("2b", () => {
    expect(getSortSetting(0)).toStrictEqual(0);
  });
});
