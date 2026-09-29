import { AbstractInputScheduler } from "./AbstractInputScheduler";
import { MabScheduler } from "./MabScheduler";
import { RandomScheduler } from "./RandomScheduler";
import { RoundRobinScheduler } from "./RoundRobinScheduler";
import { Ucb1Scheduler } from "./Ucb1Scheduler";
import { ThompsonScheduler } from "./ThompsonScheduler";
import { EwmaScheduler } from "./EwmaScheduler";
import { InputSchedulerType } from "./Types";

/**
 * Factory for creating input generator schedulers
 */
export class SchedulerFactory {
  /**
   * Creates an instance of the requested scheduler type
   *
   * @param `type` scheduler type ("mab", "random", "round-robin", "ucb1", "thompson", "ewma")
   * @param `rngSeed` optional pseudo-random seed
   */
  public static create(
    type: InputSchedulerType | string,
    rngSeed?: string
  ): AbstractInputScheduler {
    switch (type) {
      case "random":
        return new RandomScheduler(rngSeed);
      case "round-robin":
        return new RoundRobinScheduler(rngSeed);
      case "ucb1":
        return new Ucb1Scheduler(rngSeed);
      case "thompson":
        return new ThompsonScheduler(rngSeed);
      case "ewma":
        return new EwmaScheduler(rngSeed);
      case "mab":
      default:
        return new MabScheduler(rngSeed);
    }
  } // fn: create
} // class: SchedulerFactory
