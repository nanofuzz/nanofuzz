import { ExampleOracle } from "./ExampleOracle";

describe("fuzzer.oracles.ExampleOracle", () => {
  it("Example Oracle - Expected timeout / did timeout", () => {
    expect(
      ExampleOracle.judge(
        true,
        false,
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
            isTimeout: true,
          },
        ],
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
            isTimeout: true,
          },
        ]
      ).judgment
    ).toBe("pass");
  });

  it("Example Oracle - Expected timeout / did not timeout", () => {
    expect(
      ExampleOracle.judge(
        false,
        false,
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
            isTimeout: true,
          },
        ],
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
          },
        ]
      ).judgment
    ).toBe("fail");
  });

  it("Example Oracle - Expected exception / threw exception", () => {
    expect(
      ExampleOracle.judge(
        false,
        true,
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
            isException: true,
          },
        ],
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
            isException: true,
          },
        ]
      ).judgment
    ).toBe("pass");
  });

  it("Example Oracle - Expected exception / did not throw exception", () => {
    expect(
      ExampleOracle.judge(
        false,
        false,
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
            isException: true,
          },
        ],
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
          },
        ]
      ).judgment
    ).toBe("fail");
  });

  it("Example Oracle - Expected value / got timedout", () => {
    expect(
      ExampleOracle.judge(
        true,
        false,
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: 1,
          },
        ],
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
            isTimeout: true,
          },
        ]
      ).judgment
    ).toBe("fail");
  });

  it("Example Oracle - Expected value / threw exception", () => {
    expect(
      ExampleOracle.judge(
        false,
        true,
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: 1,
          },
        ],
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: undefined,
            isException: true,
          },
        ]
      ).judgment
    ).toBe("fail");
  });

  it("Example Oracle - Expected value / got that value", () => {
    expect(
      ExampleOracle.judge(
        false,
        false,
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: 1,
          },
        ],
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: 1,
          },
        ]
      ).judgment
    ).toBe("pass");
  });

  it("Example Oracle - Expected value / got different value", () => {
    expect(
      ExampleOracle.judge(
        false,
        false,
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: 1,
          },
        ],
        [
          {
            name: "",
            offset: 0,
            origin: { type: "unknown" },
            value: 2,
          },
        ]
      ).judgment
    ).toBe("fail");
  });
});
