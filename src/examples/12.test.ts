import { levenshtein } from "./12";

/**
 * BUG REPORT
 * Test 12a passes, but test 12b fails.
 */
describe("12", () => {
  // This test passes
  test("12a", () => {
    expect(levenshtein("kitten", "sitting")).toStrictEqual(3);
  });

  // Remove ".skip" to run this failing test
  test.skip("12b", () => {
    expect(levenshtein("", "sitting")).toStrictEqual(7);
  });
});
