import { ArgDef } from "../analysis/ArgDef";

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
