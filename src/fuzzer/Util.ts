import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as JSONN from "../Jsonn";
import { CompositeOracle } from "./oracles/CompositeOracle";
import { FuzzIoElement, FuzzResultCategory, FuzzTestResult } from "./Types";

/**
 * Type guard function that returns true if the input object
 * has properties "message" and "stack" typed as string.
 * This function is primarily for checking whether `unknown`
 * exception types have the message and stack fields.
 *
 * @param obj the object to check
 * @returns type guard if `obj` has `message`, `stack`, and `name` properties of type `string`
 */
export function isError(obj: unknown): obj is Error {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    "message" in obj &&
    "stack" in obj &&
    "name" in obj &&
    typeof obj.message === "string" &&
    typeof obj.stack === "string" &&
    typeof obj.name === "string"
  );
} // fn: isError

/**
 * Normalizes a file path string for use as a key (in maps) to avoid cross-platform issues.
 */
export function normalizePathForKey(rawPath: string): string {
  let p = rawPath.trim();
  p = path.normalize(p);

  // On Windows, treat paths case-insensitively, but on POSIX, paths
  // are (usually) case sensitive.
  if (process.platform === "win32") {
    p = p.toLowerCase();
  }

  return p;
} // fn: normalizePathForKey

/*
 * Extracts an error message from an unknown exception value.
 *
 * If the value is an Error-like object (has message and stack),
 * returns the message. Otherwise, stringifies the value using JSONN.
 *
 * @param e the exception value to extract a message from
 *
 * @returns the error message string
 */
export function getErrorMessageOrJson(e: unknown): string {
  return isError(e) ? e.message : JSONN.stringify(e);
} // fn: getErrorMessageOrJson

/**
 * Returns `dir`'s nearest item by traversing ancestor paths or `undefined` if not found.
 *
 * Adapted from: https://github.com/joshrtay/find-mod/blob/master/lib/index.js
 *
 * @param dir path
 * @param item file to find
 * @returns path to closest item (or `undefined`` if not found)
 */
export function findInAncestor(dir: string, item: string): string | undefined {
  while (!fs.existsSync(path.resolve(path.join(dir, item)))) {
    dir = path.resolve(path.join(dir, "..")); // ascend to parent
    if (dir === path.dirname(dir)) {
      return undefined;
    }
  }
  return path.resolve(path.join(dir, item));
} // fn: findInAncestor

/**
 * Returns the nearest item by searching recursively through descendant paths.
 * Returns `undefined` if not found.
 *
 * @param dir path
 * @param item to find
 * @returns path to closest item (or `undefined`` if not found)
 */
export function findInDescendants(
  dir: string,
  item: string
): string | undefined {
  const queue: string[] = [path.resolve(dir)];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentDir = queue.shift()!;

    // Check if item exists in the current directory
    const targetPath = path.resolve(path.join(currentDir, item));
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }

    // Add subdirectories to the queue
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.resolve(path.join(currentDir, entry.name));
          // Prevent infinite loops from symlinks
          if (!visited.has(subDir)) {
            visited.add(subDir);
            queue.push(subDir);
          }
        }
      }
    } catch (_e: unknown) {
      // Ignore directories we don't have permission to read
      continue;
    }
  }

  return undefined;
} // fn: findInDescendants

/**
 * Returns true if all oracle judgments of two test results are identical without allocating arrays or stringifying.
 */
export function isSameJudgments(a: FuzzTestResult, b: FuzzTestResult): boolean {
  if (a.passedImplicit !== b.passedImplicit) {
    return false;
  }
  if (a.passedHuman !== b.passedHuman) {
    return false;
  }
  const aVals = a.passedValidators;
  const bVals = b.passedValidators;
  if (aVals.length !== bVals.length) {
    return false;
  }
  for (let i = 0; i < aVals.length; i++) {
    if (aVals[i] !== bVals[i]) {
      return false;
    }
  }
  return true;
} // fn: isSameJudgments

/**
 * Categorizes the result of a fuzz test according to the available
 * categories defined in ResultType.
 * @param result of the test
 * @returns the category of the result
 */
export function categorizeResult(result: FuzzTestResult): FuzzResultCategory {
  if (result.harnessErrors.length > 0) {
    return "failure"; // Validator or transformer failed
  }
  if (result.skipped) {
    return "skip";
  }

  // Returns the type of bad value: execption, timeout, or badvalue
  const getBadValueType = (result: FuzzTestResult): FuzzResultCategory => {
    if (result.exception) {
      return "exception"; // PUT threw exception
    } else if (result.timeout) {
      return "timeout"; // PUT timedout
    } else {
      return "badValue"; // PUT returned bad value
    }
  };

  // Use the Composite Oracle to render a single judgment from among
  // the various oracles. We describe this in the TerzoN paper:
  //
  // TerzoN: Human-in-the-Loop Software Testing with a Composite Oracle
  // https://doi.org/10.1145/3580446
  //
  // Subsequently, map the judgment to a FuzzResultCategory
  switch (
    CompositeOracle.judge([
      [result.passedValidator, result.passedHuman],
      [result.passedImplicit],
    ])
  ) {
    case "pass":
      return "ok";
    case "fail":
      return getBadValueType(result);
    case "unknown":
      return "disagree";
  }
} // fn: categorizeResult

/**
 * Resolves the number of concurrent runner worker processes.
 *
 * In 'auto' mode:
 *  - CLI mode (process.env.BUILD_TARGET === "node-cli"): favors throughput with (cores - 1).
 *  - Non-CLI / IDE mode: favors responsiveness with floor(cores / 2).
 *  - Both modes clamp to total system memory assuming ~100MB per worker with 1024MB safety reserve.
 *  - Minimum of 1 worker is always guaranteed.
 *
 * @param configured configured worker count or "auto"
 * @param isCli whether running in CLI mode
 * @returns resolved integer worker count >= 1
 */
export function resolveWorkerCount(
  configured: number | "auto" | string,
  isCli: boolean = process.env.BUILD_TARGET === "node-cli"
): number {
  if (typeof configured === "number" && configured >= 1) {
    return Math.floor(configured);
  }
  if (typeof configured === "string" && configured !== "auto") {
    const parsed = parseInt(configured, 10);
    if (!isNaN(parsed) && parsed >= 1) return parsed;
  }

  const cpus = os.availableParallelism
    ? os.availableParallelism()
    : os.cpus().length;
  const cpuTarget = isCli
    ? Math.max(1, cpus - 1)
    : Math.max(1, Math.floor(cpus / 2));

  // 100 MB memory clamp with 1024 MB OS/IDE safety buffer based on total system memory
  const totalMemMB = os.totalmem() / (1024 * 1024);
  const memClamp = Math.max(
    1,
    Math.floor(Math.max(0, totalMemMB - 1024) / 100)
  );

  return Math.max(1, Math.min(cpuTarget, memClamp));
} // fn: resolveWorkerCount

/**
 * Gets the input key as a string from an array of `FuzzIoElement`s
 *
 * @param `io` array of `FuzzIoElements`
 * @returns string representation of input key
 */
export function getIoKey(io: FuzzIoElement[]): string {
  return JSONN.stringify(
    io.map((input) => {
      return { value: input.value };
    })
  );
} // fn: getIoKey
