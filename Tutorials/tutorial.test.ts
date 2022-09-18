import { gcd } from "./tutorial";

test("gcd test a", () => {
  expect(gcd(100, 10)).toStrictEqual(10);
});

test("gcd test b", () => {
  expect(gcd(50, 27)).toStrictEqual(1);
});
