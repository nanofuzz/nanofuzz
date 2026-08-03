import * as ProgramFactory from "../analysis/ProgramFactory";
import { MutationInputGenerator } from "./MutationInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { InputAndSource } from "../Types";

/**
 * Provide a seed to ensure tests are deterministic.
 */
const seed: string = "qwertyuiop";

describe("fuzzer/generator/MutationInputGenerator:", () => {
  /**
   * Regression tests for https://github.com/nanofuzz/nanofuzz/issues/351.
   */
  describe("onRunStart() validates the leaderboard", () => {
    const tsFnWithNumberArrayInput = `function test(nums: number[]):void {0;}`;
    const intervals = [{ min: 0, max: 1 }];
    const dimLength = [{ min: 1, max: 2 }];
    const nonCompliantValue = {
      tag: "ArgValueTypeWrapped" as const,
      value: [6],
    };
    const compliantValue = {
      tag: "ArgValueTypeWrapped" as const,
      value: [1, 1],
    };
    const program = ProgramFactory.fromSource(
      () => tsFnWithNumberArrayInput,
      "typescript"
    );
    const arg = program.functions["test"].getArgDefs();
    const nums = arg[0];
    nums.setIntervals(intervals);
    nums.setOptions({ dimLength });

    it(`Filters out specs noncompliant values after onRunStart()`, () => {
      const leaderboard = new Leaderboard<InputAndSource>();
      leaderboard.postScore(
        {
          tick: 1,
          value: [nonCompliantValue],
          source: {
            type: "user",
          },
        },
        1
      );
      const gen = new MutationInputGenerator(arg, seed, leaderboard);
      gen.onRunStart(true);
      expect(gen.nextable()).toBeFalse();
    });

    it(`Generate specs compliant values after onRunStart()`, () => {
      const leaderboard = new Leaderboard<InputAndSource>();
      leaderboard.postScore(
        {
          tick: 1,
          value: [compliantValue],
          source: {
            type: "user",
          },
        },
        1
      );
      leaderboard.postScore(
        {
          tick: 1,
          value: [nonCompliantValue],
          source: {
            type: "user",
          },
        },
        1
      );
      const gen = new MutationInputGenerator(arg, seed, leaderboard);
      gen.onRunStart(true);
      expect(gen.nextable()).toBeTrue();

      for (let i = 0; i < 1000; i++) {
        const { value: inputs } = gen.next();
        const input = inputs[0].value;
        expect(typeof input === "object" && Array.isArray(input)).toBeTruthy();
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        const inputArray = input as number[];
        expect([1, 2].includes(inputArray.length)).toBeTrue();
        expect(inputArray.every((n) => [0, 1].includes(n))).toBeTrue();
      }
    });
  });
});
