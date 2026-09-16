/**
 * Supported code coverage measurement scopes and target options
 */
export type CoverageScopeConfig = {
  target: "project" | "project directimports";
  collectStaticCoverage: boolean;
};

export type CoverageScope =
  | "project"
  | "project static"
  | "project directimports"
  | "project directimports static";
