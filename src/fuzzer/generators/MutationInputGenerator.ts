import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgDef } from "../analysis/ArgDef";
import { Leaderboard } from "./Leaderboard";
import { GetFuzzerFocusFn, InputAndSource } from "../Types";
import { ArgDefMutator } from "../analysis/ArgDefMutator";
import { ArgDefShrinker } from "../analysis/ArgDefShrinker";
import { ArgDefValidator } from "../analysis/ArgDefValidator";
import { ArgDefGenerator } from "../analysis/ArgDefGenerator";
import { NextableStatus } from "./Types";

/**
 * Generates new inputs by mutating prior "interesting" inputs
 */
export class MutationInputGenerator extends AbstractInputGenerator {
  protected _leaderboard: Leaderboard<InputAndSource>; // List of "interesting" inputs
  protected _maxMutations = 2; // Max mutations to apply to interesting inputs
  protected _getFuzzerFocus?: GetFuzzerFocusFn;
  protected _seedGen?: ArgDefGenerator;

  /**
   * Create a MutationInputGenerator
   *
   * @param `specs` ArgDef specification of inputs to generate
   * @param `rngSeed` Random seed for input generation
   * @param `leaderboard` Running list of "interesting" inputs
   * @param `getFuzzerFocus` Optional callback to check fuzzer focus (gen vs shrink)
   */
  public constructor(
    specs: ArgDef[],
    rngSeed: string | undefined,
    leaderboard: Leaderboard<InputAndSource>,
    getFuzzerFocus?: GetFuzzerFocusFn
  ) {
    super(specs, rngSeed);
    this._leaderboard = leaderboard;
    this._getFuzzerFocus = getFuzzerFocus;
  } // fn: constructor

  /**
   * Returns the human-readable name for the Mutation input generator
   */
  public override get humanName(): string {
    return "Mutation";
  } // property: get humanName

  /**
   * This generator requires a leaderboard with at least one
   * "interesting" input to mutate, or an active shrink target in shrink mode.
   * If no leaderboard inputs are available, returns "soon" so that other
   * input generators get priority because we need to gen a seed input.
   *
   * @returns "now" if generator is available, "soon" if seed generation is needed
   */
  public override nextable(): NextableStatus {
    const focus = this._getFuzzerFocus?.();
    if (focus?.mode === "shrink" && focus.target) {
      return "now";
    }
    return this._leaderboard.length ? "now" : "soon";
  } // fn: nextable

  /**
   * Returns diagnostic messages when the generator is unable to produce inputs.
   */
  public override getDiagnostics(): string[] {
    return [];
  } // fn: getDiagnostics

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

      if (shrinkers.length > 0) {
        const m = Math.floor(this._prng() * shrinkers.length);
        shrinkers[m].fn();
      }

      return {
        tick: 0,
        value: candidateValue,
        source: {
          type: "generator",
          generator: "MutationInputGenerator",
          tick: basisTick,
        },
      };
    }

    // --- NORMAL MUTATION MODE ---
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
   * Asynchronously produce the next test-case inputs when `nextable()` returns "soon".
   * When no leaderboard inputs are available, generates a random seed input using ArgDefGenerator.
   */
  public override async nextSoon(): Promise<InputAndSource> {
    if (this.nextable() === "now") {
      return this.next();
    }

    if (!this._seedGen) {
      this._seedGen = new ArgDefGenerator(this._specs, this._prng);
    }

    return {
      tick: 0,
      value: this._seedGen.next(),
      source: {
        type: "generator",
        generator: "MutationInputGenerator",
      },
    };
  } // fn: nextSoon

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
