import { InputGenerator } from "./InputGenerator";
import { FuzzEnv } from "fuzzer/Fuzzer";
import { FuzzIoElement, FuzzTestResult } from "fuzzer/Fuzzer";
import { RandomInputGenerator } from "./RandomInputGenerator";

export const InputGeneratorStrategies = ["random"] as const;

export class CompositeInputGenerator implements InputGenerator {
  // Mapping of input generator strategies to their respective factories.
  static readonly inputGenerators = new Map<
    (typeof InputGeneratorStrategies)[number],
    () => InputGenerator
  >([["random", () => new RandomInputGenerator()]]);

  // Default weights for each input generator strategy.
  static defaultWeights: Record<
    (typeof InputGeneratorStrategies)[number],
    number
  > = {
    random: 1,
  };

  // private _env?: FuzzEnv; // Initialized in init().
  private _subgens = new Map<string, InputGenerator>();
  private _weights: Record<string, number> = {};
  private _lastInputGeneratorStrategy?: string;

  init(env: FuzzEnv): void {
    this._weights = {
      ...CompositeInputGenerator.defaultWeights,
      // Potentially override with user-provided config.
    };

    for (const inputGeneratorStrategy of InputGeneratorStrategies) {
      const factory = CompositeInputGenerator.inputGenerators.get(
        inputGeneratorStrategy
      );
      if (!factory)
        throw new Error(
          `Unknown input-generator strategy "${inputGeneratorStrategy}"`
        );
      const gen = factory();
      gen.init(env);
      this._subgens.set(inputGeneratorStrategy, gen);
    }
  }

  next(): FuzzIoElement[] {
    const strat = this.sampleStrategy();
    this._lastInputGeneratorStrategy = strat;
    const generator = this._subgens.get(strat);
    if (!generator) {
      throw new Error(`Input generator for strategy "${strat}" not found.`);
    }
    return generator.next();
  }

  onResult(result: FuzzTestResult, coverageSummary?: any): void {
    // adjust this.weights[this.lastStrategy!]
  }

  private sampleStrategy(): string {
    const total = Object.values(this._weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const strat of InputGeneratorStrategies) {
      r -= this._weights[strat];
      if (r <= 0) return strat;
    }
    return InputGeneratorStrategies[0];
  }
}
