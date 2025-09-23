import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { ArgType, ArgValueType } from "../analysis/typescript/Types";
import { Leaderboard } from "./Leaderboard";
import { InputAndSource } from "./Types";
import * as JSON5 from "json5";
import { ArgDefMutator } from "../analysis/typescript/ArgDefMutator";

// !!!!!!
export class MutationInputGenerator extends AbstractInputGenerator {
  private _leaderboard; // !!!!!!
  private _isAvailable = false; // !!!!!!
  private _maxMutations = 3; // !!!!!!

  // !!!!!!
  public constructor(
    specs: ArgDef<ArgType>[],
    rngSeed: string,
    leaderboard: Leaderboard<InputAndSource>
  ) {
    super(specs, rngSeed);
    this._leaderboard = leaderboard;
  } // !!!!!!

  // !!!!!!
  // Only available when "interesting" inputs are available to mutate.
  public isAvailable(): boolean {
    if (!this._isAvailable && this._leaderboard.getLeaders().length) {
      // !!!!!!!! performance: we just need the count
      this._isAvailable = true;
    }
    return this._isAvailable;
  } // !!!!!!

  // !!!!!!
  public next(): { input: ArgValueType[]; source: string } {
    // Get the set of interesting inputs & select one
    const leaders = this._leaderboard.getLeaders();
    const i = Math.floor(this._prng() * leaders.length);
    const input = leaders[i].leader.input;

    // Randomize the number of mutations (1.._maxMutations)
    let n = Math.floor(this._prng() * this._maxMutations) + 1;
    while (n-- > 0) {
      // Save the unmutated input
      const originalInput = JSON5.parse(JSON5.stringify(input));

      // Calculate possible mutations for the input
      const mutators = ArgDefMutator.getMutators(
        this._specs,
        input,
        this._prng
      );
      console.debug(
        `[${this.name}] ${mutators.length} mutators for input ${JSON5.stringify(
          input
        )}: ${mutators
          .map((e) => `${e.name}@${JSON5.stringify(e.path)}`)
          .join(", ")}`
      ); // !!!!!!!

      // !!!!!! some kind of error here? seems pointless to return a duplicate input....?
      if (!mutators.length) {
        return { input, source: this.name };
      }

      // Randomly select & execute a mutation
      const m = Math.floor(this._prng() * mutators.length);
      mutators[m].fn();
      console.debug(
        `[${this.name}] - Applied: ${mutators[m].name}@${JSON5.stringify(
          mutators[m].path
        )} to: ${JSON5.stringify(originalInput)} result: ${JSON5.stringify(
          input
        )}`
      ); // !!!!!!!
    }

    // return the mutated input
    return { input, source: this.name };
  } // !!!!!!
} // !!!!!!
