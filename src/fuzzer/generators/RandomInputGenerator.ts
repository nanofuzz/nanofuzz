import seedrandom from "seedrandom";
import { FuzzEnv, FuzzIoElement } from "fuzzer/Fuzzer";
import { GeneratorFactory } from "./GeneratorFactory";
import { InputGenerator } from "./InputGenerator";

export class RandomInputGenerator implements InputGenerator {
  private gens: Array<{ name: string; offset: number; fn: () => any }> = [];

  init(env: FuzzEnv): void {
    const prng = seedrandom(env.options.seed ?? "");
    this.gens = env.function.getArgDefs().map((argDef) => ({
      name: argDef.getName(),
      offset: argDef.getOffset(),
      fn: GeneratorFactory(argDef, prng),
    }));
  }

  next(): FuzzIoElement[] {
    return this.gens.map(({ name, offset, fn }) => ({
      name,
      offset,
      value: fn(),
    }));
  }
}
