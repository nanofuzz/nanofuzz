import { PythonProgram } from "../analysis/python/PythonProgram";
import { RustProgram } from "../analysis/rust/RustProgram";
import { TypescriptProgram } from "../analysis/typescript/TypescriptProgram";
import { FuzzTests } from "../Types";
import { AbstractTestAdapter } from "./AbstractTestAdapter";
import { JestAdapter } from "./jest/JestAdapter";
import { PytestAdapter } from "./pytest/PytestAdapter";
import { CargoTestAdapter } from "./cargo/CargoTestAdapter";

export function fromSourceFilename(
  filename: string,
  testSet: FuzzTests
): AbstractTestAdapter {
  if (TypescriptProgram.understands({ filename })) {
    return new JestAdapter(testSet, filename);
  } else if (PythonProgram.understands({ filename })) {
    return new PytestAdapter(testSet, filename);
  } else if (RustProgram.understands({ filename })) {
    return new CargoTestAdapter(testSet, filename);
  } else {
    throw new Error(`Unsupported program type: ${filename}`);
  }
}
