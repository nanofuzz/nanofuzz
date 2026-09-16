import { CoverageScope, CoverageScopeConfig } from "./Types";

/**
 * Type guard for CoverageScope
 */
export function isCoverageScope(val: unknown): val is CoverageScope {
  if (typeof val !== "string") return false;
  try {
    parseCoverageScope(val);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses and validates coverage scope configuration string or token set.
 */
export function parseCoverageScope(raw: unknown): CoverageScopeConfig {
  if (typeof raw !== "string") {
    throw new Error(`Invalid coverageScope configuration '${String(raw)}'`);
  }

  const tokens = raw.toLowerCase().trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === "") {
    throw new Error(`Invalid coverageScope configuration '${raw}'`);
  }

  const validTokens = new Set(["project", "directimports", "static"]);

  for (const t of tokens) {
    if (!validTokens.has(t)) {
      throw new Error(`Invalid coverageScope configuration '${raw}'`);
    }
  }

  return {
    target: tokens.includes("directimports")
      ? "project directimports"
      : "project",
    collectStaticCoverage: tokens.includes("static"),
  };
}
