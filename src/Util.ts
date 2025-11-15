import * as path from "path";
import * as vscode from "vscode";

/**
 * Type guard function that returns true if the input object
 * has properties "message" and "stack" typed as string.
 * This function is primarily for checking whether `unknown`
 * exception types have the message and stack fields.
 *
 * @param obj the object to check
 * @returns type guard if `obj` has `message` and `stack` properties of type `string`
 */
export function isError(
  obj: unknown
): obj is { message: string; stack: string } {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    "message" in obj &&
    "stack" in obj &&
    typeof obj.message === "string" &&
    typeof obj.stack === "string"
  );
} // fn: isError

/**
 * Normalizes a file path string for use as a key (in maps) to avoid cross-platform issues.
 */
export function normalizePathForKey(rawPath: string): string {
  const fsPath = vscode.Uri.file(rawPath).fsPath;
  const normalized = path.normalize(fsPath);

  // On Windows, treat paths case-insensitively, but on POSIX, keep case,
  // since it usually matters.
  if (process.platform === "win32") return normalized.toLowerCase();

  return normalized;
}
