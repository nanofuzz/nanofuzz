import { RunnerFactory } from "../runners/RunnerFactory";
import { PropertyOracle } from "./PropertyOracle";
import { FuzzEnv } from "../Fuzzer";

/**
 * Builds and returns a new PropertyOracle object.
 *
 * @param `env` FuzzEnv
 * @param `module` module filename
 * @param `validatorNames` Names of validators
 * @returns a new `PropertyOracle` object
 */
export function propertyOracleFromNodeModule(
  env: FuzzEnv,
  module: string,
  validatorNames: string[]
): PropertyOracle {
  // Build runners for the property validators
  // and use them to build the property oracle
  return new PropertyOracle(
    validatorNames.map((vFnRef) =>
      RunnerFactory(env, module, vFnRef)
    )
  );
} // fn: propertyOracleFromNodeModule
