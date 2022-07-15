import { getOffsetOrDefault } from "./9";

/**
 * BUG REPORT
 * Test 9a passes, but test 9b fails.
 */
describe("9", () => {
  // This test passes
  test("9a", () => {
    expect(getOffsetOrDefault(["A", "B", "C", "D"], 0, "X")).toStrictEqual("A");
  });

  // Remove ".skip" to run this failing test
  test.skip("9b", () => {
    expect(getOffsetOrDefault(["A", "B", "C", "D"], 4, "X")).toStrictEqual("X");
  });
});
