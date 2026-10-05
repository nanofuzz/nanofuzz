import { AbstractInputGenerator } from "../generators/AbstractInputGenerator";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { InputAndSource } from "../Types";
import { NextableStatus } from "../generators/Types";

/**
 * Mock input generator for scheduler unit testing
 */
export class MockInputGenerator extends AbstractInputGenerator {
  public status: NextableStatus = "now";
  protected _mockName: string;

  public constructor(mockName: string) {
    super([], "seed");
    this._mockName = mockName;
  }

  public override get name(): string {
    return this._mockName;
  }

  public override nextable(): NextableStatus {
    return this.status;
  }

  public override next(): InputAndSource {
    return {
      tick: 0,
      value: [],
      source: { type: "generator", generator: "RandomInputGenerator" },
    };
  }
}

/**
 * Mock measurement with delta value for scheduler unit testing
 */
export interface MockMeasurement extends BaseMeasurement {
  name: string;
  deltaVal: number;
}

/**
 * Mock measure for scheduler unit testing
 */
export class MockMeasure extends AbstractMeasure {
  public override get name(): string {
    return "MockMeasure";
  }

  public constructor(weight = 1) {
    super();
    this._weight = weight;
  }

  public override delta(m: BaseMeasurement): number {
    return "deltaVal" in m && typeof m.deltaVal === "number" ? m.deltaVal : 0;
  }
}
