import * as ProgramFactory from "../analysis/ProgramFactory";
import { FuzzTests } from "../Types";
import { AbstractTestAdapter } from "./AbstractTestAdapter";
import { JestAdapter } from "./jest/JestAdapter";
import { PytestAdapter } from "./pytest/PytestAdapter";
import { CargoTestAdapter } from "./cargo/CargoTestAdapter";
import { DuneTestAdapter } from "./dune/DuneTestAdapter";
import { JUnitTestAdapter } from "./junit/JUnitTestAdapter";
import { VirgilTestAdapter } from "./virgil/VirgilTestAdapter";

export function fromSourceFilename(
  filename: string,
  testSet: FuzzTests,
  outputFilename?: string
): AbstractTestAdapter {
  const lang = ProgramFactory.getLanguage({ filename });
  switch (lang) {
    case "typescript":
      return new JestAdapter(testSet, filename);
    case "python":
      return new PytestAdapter(testSet, filename);
    case "rust":
      return new CargoTestAdapter(testSet, filename);
    case "oxcaml":
      return new DuneTestAdapter(testSet, filename);
    case "java":
      return new JUnitTestAdapter(testSet, filename, outputFilename);
    case "virgil":
      return new VirgilTestAdapter(testSet, filename);
    case "*":
    default:
      throw new Error(`Unsupported program type: ${filename}`);
  }
} // fn: fromSourceFilename
