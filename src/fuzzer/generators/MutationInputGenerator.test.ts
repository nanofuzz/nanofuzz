import * as ProgramFactory from "../analysis/ProgramFactory";
import { RandomInputGenerator } from "./RandomInputGenerator";
import { MutationInputGenerator } from "./MutationInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { InputAndSource } from "../Types";
import { ArgDefValidator } from "../analysis/ArgDefValidator";
import * as JSONN from "../../Jsonn";

/**
 * Provide a seed to ensure tests are deterministic.
 */
const seed: string = "qwertyuiop";

describe("fuzzer/generator/MutationInputGenerator:", () => {
  it("dimsUnique object arrays for random and mutation generators", () => {
    const program = ProgramFactory.fromSource(
      () => `export function x(obj: { a?: 1 }[]): number { return 1; }`,
      "typescript"
    );
    const specs = program.functionsExported["x"].getArgDefs();
    specs[0].setOptions({
      dimLength: [{ min: 2, max: 2 }],
      dimsUnique: true,
    });
    const validator = new ArgDefValidator(specs);
    const initialInput = [
      {
        tag: "ArgValueTypeWrapped" as const,
        value: [{ a: 1 }, {}],
      },
    ];
    const leaderboard = new Leaderboard<InputAndSource>();
    leaderboard.postScore(
      {
        tick: 1,
        value: initialInput,
        source: { type: "user" },
      },
      1
    );

    const generators = [
      new RandomInputGenerator(specs, seed),
      new MutationInputGenerator(specs, seed, leaderboard),
    ];
    for (const generator of generators) {
      for (let index = 0; index < 100; index++) {
        const input = generator.next().value;
        expect(validator.validate(input)).toBeTrue();
        const array = input[0].value;
        expect(Array.isArray(array)).toBeTrue();
        if (Array.isArray(array)) {
          expect(
            new Set(array.map((element) => JSONN.stringify(element))).size
          ).toEqual(array.length);
        }
      }
    }
  });

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
