import * as path from "node:path";
import * as fs from "node:fs";
import JSON5 from "json5";

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
 *
 * !!!!!!!! move this dependency on vscode into part of the UI codebase
 */
export function normalizePathForKey(rawPath: string): string {
  let p = rawPath.trim();
  p = path.normalize(p);

  // On Windows, treat paths case-insensitively, but on POSIX, keep case,
  // since it usually matters.
  if (process.platform === "win32") {
    p = p.toLowerCase();
  }

  return p;
} // fn: normalizePathForKey

/*
 * Extracts an error message from an unknown exception value.
 *
 * If the value is an Error-like object (has message and stack),
 * returns the message. Otherwise, stringifies the value using JSON5.
 *
 * @param e the exception value to extract a message from
 *
 * @returns the error message string
 */
export function getErrorMessageOrJson(e: unknown): string {
  return isError(e) ? e.message : JSON5.stringify(e);
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
}
