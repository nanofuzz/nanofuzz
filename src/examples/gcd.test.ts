import { gcd } from "./gcd";

describe("gcdTest", () => {
    test("gcd a", () => {
      expect(gcd(100, 10)).toStrictEqual(10);
    });
    test("gcd b", () => {
      expect(gcd(50, 27)).toStrictEqual(1);
    });
  });