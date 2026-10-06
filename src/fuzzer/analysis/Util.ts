import { ArgDef } from "./ArgDef";
import { AbstractProgram } from "./AbstractProgram";
import { FunctionDef } from "./FunctionDef";
import { ArgType, ArgValueType, FunctionRef } from "./Types";
import { FuzzOptions } from "../Types";

/**
 * Replacer function for JSON.stringify that removes the parent property
 *
 * @param key The key of the property being stringified
 * @param value The value of the property being stringified
 * @returns undefined if key==='parent', otherwise value
 */
export function removeParents(key: string, value: unknown): unknown {
  if (key === "parent" || key === "parentPath") {
    return undefined;
  } else {
    return value;
  }
} // fn: removeParents()

/**
 * Type guard function that returns true if `obj` is an ArgType
 *
 * @param `obj` the object to check
 * @returns true if `obj` is an ArgType, false otherwise
 */
export function isArgType(obj: unknown): obj is ArgType {
  return (
    typeof obj === "bigint" ||
    typeof obj === "string" ||
    typeof obj === "number" ||
    typeof obj === "boolean" ||
    (obj !== null &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      Object.keys(obj).length > 0 &&
      Object.values(obj).every((i) => isArgType(i)))
  );
} // fn: isArgType

/**
 * Type guard function that returns true if `obj` is an ArgValueType
 *
 * @param `obj` the object to check
 * @returns true if `obj` is an ArgValueType, false otherwise
 */
export function isArgValueType(obj: unknown): obj is ArgValueType {
  if (
    obj === undefined ||
    obj === null ||
    typeof obj === "bigint" ||
    typeof obj === "string" ||
    typeof obj === "number" ||
    typeof obj === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(obj)) {
    return obj.every(isArgValueType);
  }
  if (typeof obj === "object") {
    return Object.values(obj).every(isArgValueType);
  }
  return false;
} // fn: isArgValueType

/**
 * Checks whether the given option set is valid.
 *
 * @param options fuzzer option set
 * @returns true if the options are valid, false otherwise
 */
export function isOptionValid(options: FuzzOptions): boolean {
  return (
    options.maxTests >= 0 &&
    options.maxDupeInputs >= 0 &&
    options.maxFailures >= 0 &&
    (options.outputResults === undefined ||
      ["all", "failures", "none"].includes(options.outputResults)) &&
    ArgDef.isOptionValid(options.argDefaults) &&
    typeof options.generators === "object" &&
    "RandomInputGenerator" in options.generators &&
    "enabled" in options.generators.RandomInputGenerator &&
    typeof options.measures === "object"
  );
} // fn: isOptionValid()

/**
 * Returns the given interval bound as a bigint.
 *
 * @param value interval bound of a bigint ArgDef
 * @returns the bound as a bigint
 *
 * Throws an exception if the bound is not a bigint
 */
export function bigIntOrThrow(value: ArgType): bigint {
  if (typeof value !== "bigint") {
    throw new Error(
      `Invalid interval bound for bigint type: ${JSON.stringify(String(value))}`
    );
  }
  return value;
} // fn: bigIntOrThrow()

/**
 * Returns a list of validator FunctionRefs found within the ProgramDef
 * associated with a FunctionDef
 *
 * @param program the ProgramDef to search
 * @returns an array of validator FunctionRefs
 */
export function getValidators(
  program: AbstractProgram,
  fnUnderTest: FunctionDef
): FunctionRef[] {
  const fnUnderTestName = fnUnderTest.getName();
  return Object.values(program.functionsExported)
    .filter(
      (fn) =>
        fn.isValidator() && fn.getValidatorTargetName() === fnUnderTestName
    )
    .map((fn) => fn.getRef());
} // fn: getValidators()

/**
 * Returns a list of input transformer functions for the function under test.
 *
 * @param program the program to search
 * @param fnUnderTest the function under test
 * @returns an array of transformer FunctionRefs
 */
export function getTransformers(
  program: AbstractProgram,
  fnUnderTest: FunctionDef
): FunctionRef[] {
  return Object.values(program.functionsExported)
    .filter(
      (fn) =>
        fn.isTransformer() && fn.getName().startsWith(fnUnderTest.getName())
    )
    .map((fn) => fn.getRef());
} // fn: getTransformers()

/**
 * Returns a list of user-provided input generator functions for the function under test.
 *
 * @param program the program to search
 * @param fnUnderTest the function under test
 * @returns an array of user generator FunctionRefs
 */
export function getUserGenerators(
  program: AbstractProgram,
  fnUnderTest: FunctionDef
): FunctionRef[] {
  const fnUnderTestName = fnUnderTest.getName();

  const isUserGen = (name: string, isExported: boolean) =>
    isExported &&
    name.endsWith("Generator") &&
    !name.endsWith("InputGenerator") &&
    name !== fnUnderTestName &&
    name.startsWith(fnUnderTestName);

  const fromExported = Object.values(program.functionsExported)
    .filter((fn) => isUserGen(fn.getName(), fn.isExported()))
    .map((fn) => fn.getRef());

  const fromUnsupported = Object.values(program.functionsNotSupported)
    .filter(
      (entry): entry is { reason: string; function: FunctionRef } =>
        "function" in entry && entry.function !== undefined
    )
    .map((entry) => entry.function)
    .filter((fnRef) => isUserGen(fnRef.name, fnRef.isExported));

  return [...fromExported, ...fromUnsupported];
} // fn: getUserGenerators()
