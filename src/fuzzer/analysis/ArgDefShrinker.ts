import seedrandom from "seedrandom";
import { ArgDef } from "./ArgDef";
import { ArgDefMutator, mutatorFn } from "./ArgDefMutator";
import { ArgValueTypeWrapped } from "./Types";

/**
 * Utilities for shrinking (minimizing) values described by an ArgDef spec.
 * Wraps ArgDefMutator and filters for mutators that strictly simplify/shrink
 * the complexity of the input.
 */
export class ArgDefShrinker {
  /**
   * Returns a list of mutator functions that simplify/shrink the provided value.
   *
   * @param specs ArgDef specifications that describe the input value
   * @param value Wrapped input value to shrink
   * @param prng Random number generator
   * @returns array of mutator functions where `simplifies` is true
   */
  public static getShrinkers(
    specs: ArgDef[],
    value: ArgValueTypeWrapped[],
    prng: seedrandom.prng
  ): mutatorFn[] {
    const mutators = ArgDefMutator.getMutators(specs, value, prng);
    return mutators.filter((m) => m.simplifies === true);
  } // getShrinkers
} // class ArgDefShrinker
