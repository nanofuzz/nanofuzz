import { ArgDef } from "../analysis/ArgDef";

/**
 * Determines the next available integer counter suffix for a generated function name
 * given a list of existing function names and a prefix.
 *
 * @param existingFnNames Array of function names in the source module
 * @param prefix Name prefix (e.g., "myFnValidator" or "myFnTransformer")
 * @returns The next available counter value
 */
export function getNextAvailableFnNumber(
  existingFnNames: string[],
  prefix: string
): number {
  let fnCounter = 0;
  existingFnNames
    .filter((e) => e.startsWith(prefix))
    .forEach((e) => {
      if (e.endsWith(prefix)) {
        fnCounter++;
      } else {
        const suffix = e.substring(prefix.length);
        if (suffix.match(/^[0-9]+$/)) {
          fnCounter = Math.max(fnCounter, Number(suffix)) + 1;
        }
      }
    });
  return fnCounter;
} // fn: getNextAvailableFnNumber

/**
 * Chooses an identifier name from candidate names that does not conflict with input argument names.
 *
 * @param inArgs Input argument definitions
 * @param candidateNames Candidate identifier names in priority order
 * @param maxSuffix Maximum suffix index to attempt when disambiguating
 * @returns Chosen name and whether a numbered suffix was generated
 */
export function getIdentifierNameAvoidingConflicts(
  inArgs: ArgDef[],
  candidateNames: string[],
  maxSuffix: number = 1000
): { name: string; generated: boolean } {
  const inArgNames = inArgs.map((argDef) => argDef.getName());
  for (const name of candidateNames) {
    if (!inArgNames.includes(name)) {
      return { name, generated: false };
    }
  }

  let i = 1;
  for (const candidateName of candidateNames) {
    while (i <= maxSuffix) {
      const name = `${candidateName}_${i}`;
      if (!inArgNames.includes(name)) {
        return { name, generated: true };
      }
      i++;
    }
  }

  return { name: "r_conflicted", generated: true };
} // fn: getIdentifierNameAvoidingConflicts
