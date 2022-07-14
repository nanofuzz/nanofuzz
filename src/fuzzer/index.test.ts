import { fuzzSetup, fuzz, FuzzOptions } from "./index";
// !!!
const options: FuzzOptions = {
  numTests: 10,
  seed: "",
};

// !!!
describe("Fuzzer", () => {
  // !!!
  test("Fuzz example 8", () => {
    expect(
      fuzz(fuzzSetup(options, "./src/examples/8.ts", "minSalary")).outputs
    ).toStrictEqual([]); // !!!
  });

  test("Fuzz example 3", () => {
    expect(
      fuzz(fuzzSetup(options, "./src/examples/3.ts", "totalDinnerExpenses"))
        .outputs
    ).toStrictEqual([]); // !!!
  });
});
