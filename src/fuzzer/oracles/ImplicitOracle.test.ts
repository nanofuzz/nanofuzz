import { ImplicitOracle, implicitOracle } from "./ImplicitOracle";

describe("fuzzer.oracles.ImplicitOracle", () => {
  it("Implicit Oracle - NaN", () => {
    expect(implicitOracle(NaN)).toBe(false);
  });

  it("Implicit Oracle - +Infinity", () => {
    expect(implicitOracle(Infinity)).toBe(false);
  });

  it("Implicit Oracle - -Infinity", () => {
    expect(implicitOracle(-Infinity)).toBe(false);
  });

  it("Implicit Oracle - null", () => {
    expect(implicitOracle(null)).toBe(false);
  });

  it("Implicit Oracle - undefined", () => {
    expect(implicitOracle(undefined)).toBe(false);
  });

  it("Implicit Oracle - ''", () => {
    expect(implicitOracle("")).toBe(true);
  });

  it("Implicit Oracle - 0", () => {
    expect(implicitOracle(0)).toBe(true);
  });

  it("Implicit Oracle - -1", () => {
    expect(implicitOracle(-1)).toBe(true);
  });

  it("Implicit Oracle - 1", () => {
    expect(implicitOracle(1)).toBe(true);
  });

  it("Implicit Oracle - 'xyz'", () => {
    expect(implicitOracle("xyz")).toBe(true);
  });

  it("Implicit Oracle - []", () => {
    expect(implicitOracle([])).toBe(true);
  });

  it("Implicit Oracle - [1]", () => {
    expect(implicitOracle([1])).toBe(true);
  });

  it("Implicit Oracle - [[]]", () => {
    expect(implicitOracle([[]])).toBe(true);
  });

  it("Implicit Oracle - [[1]]", () => {
    expect(implicitOracle([[]])).toBe(true);
  });

  it("Implicit Oracle - [null,1]", () => {
    expect(implicitOracle([null, 1])).toBe(false);
  });

  it("Implicit Oracle - [1,undefined]", () => {
    expect(implicitOracle([1, undefined])).toBe(false);
  });

  it("Implicit Oracle - [NaN,1]", () => {
    expect(implicitOracle([NaN, 1])).toBe(false);
  });

  it("Implicit Oracle - [1,Infinity]", () => {
    expect(implicitOracle([1, Infinity])).toBe(false);
  });

  it("Implicit Oracle - [-Infinity,1]", () => {
    expect(implicitOracle([-Infinity, 1])).toBe(false);
  });

  it("Implicit Oracle - [[null,1],1]", () => {
    expect(implicitOracle([[null, 1], 1])).toBe(false);
  });

  it("Implicit Oracle - [1,[undefined,1]]", () => {
    expect(implicitOracle([1, [undefined, 1]])).toBe(false);
  });

  it("Implicit Oracle - [[NaN,1],1]", () => {
    expect(implicitOracle([[NaN, 1], 1])).toBe(false);
  });

  it("Implicit Oracle - [1,[1,Infinity]]", () => {
    expect(implicitOracle([1, [1, Infinity]])).toBe(false);
  });

  it("Implicit Oracle - [[1,-Infinity],1]", () => {
    expect(implicitOracle([[1, -Infinity], 1])).toBe(false);
  });

  it("Implicit Oracle - {}", () => {
    expect(implicitOracle({})).toBe(true);
  });

  it("Implicit Oracle - {a: 'abc', b: 123}", () => {
    expect(implicitOracle({ a: "abc", b: 123 })).toBe(true);
  });

  it("Implicit Oracle - {a:null, b:1}", () => {
    expect(implicitOracle({ a: null, b: 1 })).toBe(false);
  });

  it("Implicit Oracle - {a:1, b:undefined}", () => {
    expect(implicitOracle({ a: 1, b: undefined })).toBe(false);
  });

  it("Implicit Oracle - {a:1, b:NaN}", () => {
    expect(implicitOracle({ a: 1, b: NaN })).toBe(false);
  });

  it("Implicit Oracle - {a:1, b:Infinity}", () => {
    expect(implicitOracle({ a: 1, b: Infinity })).toBe(false);
  });

  it("Implicit Oracle - {a:-Infinity, b:1}", () => {
    expect(implicitOracle({ a: -Infinity, b: 1 })).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:null}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: null }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:NaN}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: NaN }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:Infinity}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: Infinity }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:-Infinity}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: -Infinity }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:undefined}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: undefined }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:2}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: 2 }], b: 1 }])).toBe(true);
  });

  it("Implicit Oracle - non-void fn w/timeout", () => {
    expect(
      ImplicitOracle.judge(true, false, false, [
        { name: "", offset: 0, origin: { type: "unknown" }, value: undefined },
      ])
    ).toBe("fail");
  });

  it("Implicit Oracle - non-void fn w/exception", () => {
    expect(
      ImplicitOracle.judge(false, true, false, [
        { name: "", offset: 0, origin: { type: "unknown" }, value: undefined },
      ])
    ).toBe("fail");
  });

  it("Implicit Oracle - void fn w/undefined output", () => {
    expect(
      ImplicitOracle.judge(false, false, true, [
        { name: "", offset: 0, origin: { type: "unknown" }, value: undefined },
      ])
    ).toBe("pass");
  });

  it("Implicit Oracle - void fn w/o undefined output", () => {
    expect(
      ImplicitOracle.judge(false, false, true, [
        { name: "", offset: 0, origin: { type: "unknown" }, value: 1 },
      ])
    ).toBe("fail");
  });

  it("Implicit Oracle - void fn w/timeout", () => {
    expect(
      ImplicitOracle.judge(true, false, true, [
        { name: "", offset: 0, origin: { type: "unknown" }, value: undefined },
      ])
    ).toBe("fail");
  });

  it("Implicit Oracle - void fn w/exception", () => {
    expect(
      ImplicitOracle.judge(false, true, true, [
        { name: "", offset: 0, origin: { type: "unknown" }, value: undefined },
      ])
    ).toBe("fail");
  });
});
