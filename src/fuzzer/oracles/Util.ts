import { RunnerFactory } from "../runners/RunnerFactory";
import { PropertyOracle } from "./PropertyOracle";

/**
 * Builds and returns a new PropertyOracle object.
 *
 * @param `module` NodeJS module
 * @param `validatorNames` Names of validators
 * @returns a new `PropertyOracle` object
 */
export function propertyOracleFromNodeModule(
  module: NodeJS.Module,
  validatorNames: string[]
): PropertyOracle {
  // Build runners for the property validators
  // and use them to build the property oracle
  return new PropertyOracle(
    validatorNames.map((vFnRef) =>
      RunnerFactory({
        type: "NodeJS.Module",
        module: module,
        fnName: vFnRef,
      })
    )
  );
} // fn: propertyOracleFromNodeModule
