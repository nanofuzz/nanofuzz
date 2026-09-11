import pkg from "../package.json";
import * as Config from "./Config";

/**
 * Returns the configured tool name and current NaNofuzz version.
 *
 * Builds inject `NANOFUZZ_VERSION`; source-only callers such as tests fall
 * back to the package version.
 */
export function getToolVersion(): string {
  const name = Config.get("nanofuzz.name", "NaNofuzz");
  const version = process.env.NANOFUZZ_VERSION ?? pkg.version;
  return `${name} v${version}`;
}
