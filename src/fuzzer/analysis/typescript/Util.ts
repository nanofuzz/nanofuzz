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
