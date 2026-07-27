import * as path from "path";

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
