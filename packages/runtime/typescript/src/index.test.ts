import { assume, UnsatisfiedAssumption, version } from "./index";

describe("@nanofuzz/runtime: assume and UnsatisfiedAssumption", () => {
  it("exports valid version", () => {
    expect(typeof version).toEqual("string");
  });

  it("assume returns true when condition is truthy", () => {
    expect(assume(true)).toBeTrue();
    expect(assume(1, "should pass")).toBeTrue();
    expect(assume("non-empty string")).toBeTrue();
  });

  it("assume throws UnsatisfiedAssumption with default message when condition is falsy", () => {
    expect(() => assume(false)).toThrowError(
      UnsatisfiedAssumption,
      "Unsatisfied assumption"
    );
  });

  it("assume throws UnsatisfiedAssumption with custom message when condition is falsy", () => {
    expect(() => assume(false, "n cannot be negative")).toThrowError(
      UnsatisfiedAssumption,
      "n cannot be negative"
    );
  });
});
