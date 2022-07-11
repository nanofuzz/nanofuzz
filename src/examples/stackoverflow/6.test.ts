import {getZeroMyId, MyId} from "./6";

/** 
 * BUG REPORT
 * Test 6a passes, but test 6b fails with a TypeError.
 */
describe("6", () => {
    test("6a", () => {
      expect(getZeroMyId([{myId: 0,name: "zero"}])).toStrictEqual("zero");
    });
    test("6b", () => {
      expect(getZeroMyId([{myId: 1, name: "one"}])).toStrictEqual("");
    });
  });