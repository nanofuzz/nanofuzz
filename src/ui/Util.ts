export function getElementByIdOrThrow(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Element with id "${id}" not found`);
  }
  return element;
}

export function getElementByIdWithTypeOrThrow<T extends HTMLElement>(
  id: string,
  type: {
    new (): T;
  }
): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Element with id "${id}" not found`);
  }
  if (!(element instanceof type)) {
    throw new Error(`Element with id "${id}" is not of type ${type.name}`);
  }
  return element;
}

export function htmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Accepts an array of strings and returns a prettier list including
 * commas and 'and'. Adapted from https://stackoverflow.com/a/53888018
 *
 * @param inList Array of strings to turn into a list
 * @returns string The list in string form including 'and'
 */
export function toPrettyList(inList: string[]): string {
  if (inList.length === 0) return "";
  return inList.length === 2
    ? inList.join(" and ")
    : inList.reduce(
        (a, b, i, array) => a + (i < array.length - 1 ? ", " : ", and ") + b
      );
}

/**
 * Helper function that counts the number of most-recent sequential failures in the LLM call history.
 *
 * @param history from InputGeneratorStatsAi.calls.history
 * @returns number of most-recent sequential failures and latest message
 */
export function getSequentialFailures(
  history: Array<Record<string, unknown>>
): { count: number; message?: string } {
  const callHistory = [...history].reverse();
  const first = callHistory[0];
  const message =
    first &&
    typeof first === "object" &&
    "failure" in first &&
    typeof first.message === "string"
      ? first.message
      : undefined;
  let count = 0;
  for (const e of callHistory) {
    if (
      !(
        typeof e === "object" &&
        e !== null &&
        "failure" in e &&
        "message" in e &&
        e.message === message
      )
    ) {
      continue;
    }
    count++;
  }
  return {
    count,
    message,
  };
}
