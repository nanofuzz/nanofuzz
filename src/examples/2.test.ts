import { getSortSetting } from "./2";

describe("2", () => {
  // This test passes
  test("2a", () => {
    expect(getSortSetting(2)).toStrictEqual(2);
  });
});
