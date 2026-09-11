import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgDef } from "../analysis/ArgDef";
import { Leaderboard } from "./Leaderboard";
import { InputAndSource } from "../Types";
import { ArgDefMutator } from "../analysis/ArgDefMutator";
import { ArgDefValidator } from "../analysis/ArgDefValidator";

/**
 * Generates new inputs by mutating prior "interesting" inputs
 */
export class MutationInputGenerator extends AbstractInputGenerator {
  private _leaderboard: Leaderboard<InputAndSource>; // List of "interesting" inputs
  private _maxMutations = 2; // Max mutations to apply to interesting inputs

  /**
   * Create a MutationInputGenerator
   *
   * @param `specs` ArgDef specification of inputs to generate
   * @param `rngSeed` Random seed for input generation
   * @param `leaderboard` Running list of "interesting" inputs
   */
  public constructor(
    specs: ArgDef[],
    rngSeed: string | undefined,
    leaderboard: Leaderboard<InputAndSource>
  ) {
    super(specs, rngSeed);
    this._leaderboard = leaderboard;
  } // fn: constructor

  /**
   * This generator requires a leaderboard with at least one
   * "interesting" input to mutate.
   *
   * @returns true if generator is available, false otherwise
   */
  public nextable(): boolean {
    return !!this._leaderboard.length;
  } // fn: isAvailable

  /**
   * Returns the next input using a mutation strategy.
   *
   * @returns mutated input
   */
  public next(): InputAndSource {
    if (!this._leaderboard.length) {
      throw new Error(`${this.name} no interesting inputs to mutate yet`);
    }

    // Get the set of interesting inputs & select one
    const leader = this._leaderboard.getRandomLeader(this._prng);
    const input = leader.value;
    const sourceTick = leader.tick;

    // Randomize the number of mutations (1.._maxMutations)
    let n = Math.floor(this._prng() * this._maxMutations) + 1;
    while (n-- > 0) {
      // Calculate possible mutations for the input
      const mutators = ArgDefMutator.getMutators(
        this._specs,
        input,
        this._prng
      );

      // !!!!!! some kind of error here? seems pointless to return a duplicate input....?
      if (!mutators.length) {
        return {
          tick: 0,
          value: input,
          source: {
            type: "generator",
            generator: "MutationInputGenerator",
            tick: sourceTick,
          },
        };
      }

      // Randomly select & execute a mutator
      const m = Math.floor(this._prng() * mutators.length);
      mutators[m].fn();
    }

    // return the mutated input
    return {
      tick: 0,
      value: input,
      source: {
        type: "generator",
        generator: "MutationInputGenerator",
        tick: sourceTick,
      },
    };
  } // fn: next

  /**
   * Clear any now-invalid items out of the leaderboard at the
   * start of each run.
   */
  public onRunStart(_active: boolean): void {
    // Input generation options may have changed, so filter the leaderboard
    const validator = new ArgDefValidator(this._specs);
    this._leaderboard.filter((leader: { leader: InputAndSource }) => {
      return validator.validate(leader.leader.value);
    });
  } // fn: onRunStart
} // class: MutationInputGenerator
