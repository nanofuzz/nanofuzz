import * as crypto from "crypto";

/**
 * Replacer function for JSON.stringify that removes the parent property
 *
 * @param key
 * @param value
 * @returns undefined if key==='parent', otherwise value
 */
export function removeParents(key: any, value: any): any {
  if (key === "parent") {
    return undefined;
  } else {
    return value;
  }
}

/**
 * Returns a hash of the given string
 *
 * @param str String to hash
 * @returns Hashed string
 */
export function sha256(str: string): string {
  return crypto.createHash("sha256").update(str, "binary").digest("base64");
}
