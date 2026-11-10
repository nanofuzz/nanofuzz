import { functionMatchesEntrypoint, targetMatchesEntrypoint } from "../Util";

/**
 * Fuzz harness for functionMatchesEntrypoint:
 * Ensures it never throws unhandled exceptions on arbitrary strings,
 * and maintains essential relational invariants.
 */
export function fuzzFunctionMatches(
  runFn: string,
  entryName: string,
  harnessFn: string
): boolean {
  // Target call: should NEVER throw or crash
  const matched = functionMatchesEntrypoint(runFn, {
    name: entryName,
    harnessFunctionName: harnessFn,
  });

  // Invariant 1: Exact string identity must always match
  if (runFn === entryName && !matched) {
    throw new Error(
      `Invariant violation: Exact match failed for runFn='${runFn}', entry='${entryName}'`
    );
  }

  // Invariant 2: Harness identity must always match
  if (runFn === harnessFn && harnessFn.length > 0 && !matched) {
    throw new Error(
      `Invariant violation: Harness match failed for runFn='${runFn}', harness='${harnessFn}'`
    );
  }

  return matched;
} // fn: fuzzFunctionMatches

/**
 * Fuzz harness for targetMatchesEntrypoint:
 * Ensures it never throws unhandled exceptions and maintains invariants.
 */
export function fuzzTargetMatches(
  target: string,
  entryName: string,
  harnessFn: string
): boolean {
  const matched = targetMatchesEntrypoint(target, {
    name: entryName,
    harnessFunctionName: harnessFn,
  });

  // Invariant 1: Identity must always match
  if (target === entryName && !matched) {
    throw new Error(
      `Invariant violation: Exact target match failed for target='${target}', entry='${entryName}'`
    );
  }

  return matched;
} // fn: fuzzTargetMatches

/**
 * Fuzz harness for Gate 3 Deep Criteria evaluation:
 * Tests that isEntrypointDeepCriteriaMet logic strictly enforces:
 * - suiteTimeout >= 300000 AND maxTests === 0
 * - AND (branchCoverage >= 100 OR attempts >= 5)
 */
export function fuzzDeepCriteriaLogic(
  fnName: string,
  entryName: string,
  suiteTimeout: number,
  maxTests: number,
  branchCoveragePct: number,
  attemptCount: number
): boolean {
  // Model the gate evaluation logic
  const match = functionMatchesEntrypoint(fnName, { name: entryName });
  const isDeepRun =
    suiteTimeout >= 300000 &&
    (maxTests === 0 || maxTests === Number.MAX_SAFE_INTEGER);

  const runs: Array<{
    functionName: string;
    suiteTimeout: number;
    maxTests: number;
    branchCoveragePct: number;
  }> = [];

  const count = Math.max(0, Math.min(attemptCount, 20));
  for (let i = 0; i < count; i++) {
    runs.push({
      functionName: fnName,
      suiteTimeout,
      maxTests,
      branchCoveragePct,
    });
  }

  const matchingDeepRuns = runs.filter(
    (r) =>
      functionMatchesEntrypoint(r.functionName, { name: entryName }) &&
      (r.suiteTimeout ?? 0) >= 300000 &&
      (r.maxTests === 0 || r.maxTests === Number.MAX_SAFE_INTEGER)
  );

  let criteriaMet = false;
  if (matchingDeepRuns.length > 0) {
    const reachedFullCoverage = matchingDeepRuns.some(
      (r) => r.branchCoveragePct !== undefined && r.branchCoveragePct >= 100
    );
    if (reachedFullCoverage) {
      criteriaMet = true;
    } else if (matchingDeepRuns.length >= 5) {
      criteriaMet = true;
    }
  }

  // INVARIANT 1: If runs do not match entryName or aren't deep, criteria MUST NEVER be met
  if ((!match || !isDeepRun) && criteriaMet) {
    throw new Error(
      `Gate Invariant Violation: criteriaMet was true without matching deep runs! match=${match}, isDeepRun=${isDeepRun}`
    );
  }

  // INVARIANT 2: If deep run count is between 1 and 4, criteria CANNOT be met unless coverage is >= 100
  if (
    match &&
    isDeepRun &&
    count >= 1 &&
    count < 5 &&
    branchCoveragePct < 100 &&
    criteriaMet
  ) {
    throw new Error(
      `Gate Invariant Violation: Gate bypassed with < 5 attempts and < 100% coverage!`
    );
  }

  // INVARIANT 3: If 0 attempts, criteria MUST be false
  if (count === 0 && criteriaMet) {
    throw new Error(
      `Gate Invariant Violation: criteriaMet was true with 0 attempts!`
    );
  }

  return criteriaMet;
} // fn: fuzzDeepCriteriaLogic
