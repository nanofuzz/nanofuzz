import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgDef } from "../analysis/ArgDef";
import { Leaderboard } from "./Leaderboard";
import { GetFuzzerFocusFn, InputAndSource } from "../Types";
import { ArgDefMutator } from "../analysis/ArgDefMutator";
import { ArgDefShrinker } from "../analysis/ArgDefShrinker";
import { ArgDefValidator } from "../analysis/ArgDefValidator";
import { ArgDefGenerator } from "../analysis/ArgDefGenerator";
import { FuzzGeneratorStatsBase } from "../Fuzzer";
import { NextableStatus } from "./Types";

/**
 * Generates new inputs by mutating prior "interesting" inputs
 */
export class MutationInputGenerator extends AbstractInputGenerator {
  protected _leaderboard: Leaderboard<InputAndSource>; // List of "interesting" inputs
  protected _maxMutations = 2; // Max mutations to apply to interesting inputs
  protected _getFuzzerFocus?: GetFuzzerFocusFn;
  protected _seedGen?: ArgDefGenerator;
  protected _stats?: FuzzGeneratorStatsBase;
  protected _dupeHistory: number[] = [];

  /**
   * Create a MutationInputGenerator
   *
   * @param `specs` ArgDef specification of inputs to generate
   * @param `rngSeed` Random seed for input generation
   * @param `leaderboard` Running list of "interesting" inputs
   * @param `getFuzzerFocus` Optional callback to check fuzzer focus (gen vs shrink)
   * @param `stats` Optional reference to live generator statistics
   */
  public constructor(
    specs: ArgDef[],
    rngSeed: string | undefined,
    leaderboard: Leaderboard<InputAndSource>,
    getFuzzerFocus?: GetFuzzerFocusFn,
    stats?: FuzzGeneratorStatsBase
  ) {
    super(specs, rngSeed);
    this._leaderboard = leaderboard;
    this._getFuzzerFocus = getFuzzerFocus;
    this._stats = stats;
  } // fn: constructor

  /**
   * Returns the human-readable name for the Mutation input generator
   */
  public override get humanName(): string {
    return "Mutation";
  } // property: get humanName

  /**
   * Checks if inputs are available to generate.
   *
   * @returns "now" if inputs can be produced immediately; "soon" if seed
   *          input generation is needed
   */
  public override nextable(): NextableStatus {
    return "now";
  } // fn: nextable

  /**
   * Calculates the max number of mutations to apply per step.
   * Dynamically increases _maxMutations if stats indicate dupe streaks
   * or a high dupe rates which may signal local minima or low entropy).
   */
  public getEffectiveMaxMutations(): number {
    if (!this._stats) {
      return this._maxMutations;
    }

    // Record current cumulative dupesGenerated for this generation step
    const currentDupes = this._stats.counters.dupesGenerated;
    this._dupeHistory.push(currentDupes);

    // Keep history trimmed to max window size
    if (this._dupeHistory.length > 50) {
      this._dupeHistory.shift();
    }

    const totalHistory = this._dupeHistory.length;
    if (totalHistory < 5) {
      return this._maxMutations;
    }

    // Calculate current duplicate streak by checking consecutive dupe increments backwards
    let streak = 0;
    for (let i = totalHistory - 1; i > 0; i--) {
      if (this._dupeHistory[i] - this._dupeHistory[i - 1] === 1) {
        streak++;
      } else {
        break;
      }
    }

    // Calculate duplicate rate over up to the last 20 inputs
    const windowSize = Math.min(totalHistory - 1, 20);
    const pastDupes = this._dupeHistory[totalHistory - 1 - windowSize];
    const dupesInWindow = currentDupes - pastDupes;
    const dupeRate = windowSize > 0 ? dupesInWindow / windowSize : 0;

    // Step up maxMutations to escape local minima or dupe streaks
    if (streak >= 4 || dupeRate >= 0.75) {
      return this._maxMutations + 4;
    } else if (streak >= 2 || dupeRate >= 0.5) {
      return this._maxMutations + 2;
    } else if (dupeRate >= 0.3) {
      return this._maxMutations + 1;
    }

    return this._maxMutations;
  } // fn: getEffectiveMaxMutations

  /**
   * Returns the next input using a mutation strategy or shrinking strategy.
   *
   * @returns mutated or shrunk input
   */
  public next(): InputAndSource {
    const focus = this._getFuzzerFocus?.();

    // --- SHRINK MODE ---
    if (focus?.mode === "shrink" && focus.target) {
      const candidateValue = structuredClone(focus.target.value);
      const basisTick = focus.target.tick;

      const shrinkers = ArgDefShrinker.getShrinkers(
        this._specs,
        candidateValue,
        this._prng
      );

      const appliedMutators: string[] = [];
      if (shrinkers.length > 0) {
        const m = Math.floor(this._prng() * shrinkers.length);
        appliedMutators.push(shrinkers[m].name);
        shrinkers[m].fn();
      }

      return {
        tick: 0,
        value: candidateValue,
        source: {
          type: "generator",
          generator: "MutationInputGenerator",
          tick: basisTick,
          steps: {
            taken: appliedMutators.length,
            max: 1,
            mode: "shrink",
            mutators: appliedMutators,
          },
        },
      };
    }

    // --- BOOTSTRAP MODE ---
    if (this._leaderboard.length === 0) {
      if (!this._seedGen) {
        this._seedGen = new ArgDefGenerator(this._specs, this._prng);
      }
      return {
        tick: 0,
        value: this._seedGen.next(),
        source: {
          type: "generator",
          generator: "MutationInputGenerator",
          steps: {
            taken: 0,
            max: 0,
            mode: "boot",
            mutators: [],
          },
        },
      };
    }

    // --- NORMAL MUTATION MODE ---
    // Get the set of interesting inputs & select one
    const leader = this._leaderboard.getRandomLeader(this._prng);
    const input = leader.value;
    const sourceTick = leader.tick;

    // Randomize the number of mutations (1..effectiveMaxMutations)
    const maxMutations = this.getEffectiveMaxMutations();
    let n = Math.floor(this._prng() * maxMutations) + 1;
    const appliedMutators: string[] = [];

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
            steps: {
              taken: appliedMutators.length,
              max: maxMutations,
              mode: "mutate",
              mutators: appliedMutators,
            },
          },
        };
      }

      // Randomly select & execute a mutator
      const m = Math.floor(this._prng() * mutators.length);
      appliedMutators.push(mutators[m].name);
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
        steps: {
          taken: appliedMutators.length,
          max: maxMutations,
          mode: "mutate",
          mutators: appliedMutators,
        },
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
