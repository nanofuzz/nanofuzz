import { NodePath } from "@babel/traverse";
import { TSEntityName, Node } from "@babel/types";
import { FunctionDef } from "./FunctionDef";
import { ArgDef } from "./ArgDef";
import { ArgType } from "./Types";

/**
 * Replacer function for JSON.stringify that removes the parent property
 *
 * @param key The key of the property being stringified
 * @param value The value of the property being stringified
 * @returns undefined if key==='parent', otherwise value
 */
export function removeParents(key: string, value: unknown): unknown {
  if (key === "parent" || key === "parentPath") {
    return undefined;
  } else {
    return value;
  }
} // fn: removeParents()

/**
 * Gets a qualified identifier name for a given entity node
 *
 * @param node The node to get the identifier name for
 * @returns Qualified name as a string
 */
export function getIdentifierName(node: TSEntityName): string {
  switch (node.type) {
    case "Identifier": {
      return node.name;
    }
    case "TSQualifiedName": {
      return getIdentifierName(node.left) + "." + node.right.name;
    }
  }
} // fn: getIdentifierName()

/**
 * Determines whether an AST node is block scoped
 * Note: Requires that nodes have the parent property set
 *
 * @param `node` The node to check
 * @returns `true` if the node is block scoped, `false` otherwise
 */
export function isBlockScoped(node: NodePath<Node>): boolean {
  let thisNode = node;
  while (thisNode.parentPath) {
    if (thisNode.parentPath.node.type === "BlockStatement") {
      return true; // block scoped
    } else {
      thisNode = thisNode.parentPath; // move up the tree
    }
  }
  return false; // at root; block not encountered
} // fn: isBlockScoped()

/**
 * Genertes a property test skeleton for a given function and name suffix
 *
 * @param `fn` FunctionDef for which to generate the property skeleton
 * @param `nameSuffix` variable part of property function name
 * @returns a property test skeleton for the `fn` and `nameSuffix`
 */
export function getPropertyTestSkeleton(
  fn: FunctionDef,
  nameSuffix: string
): string {
  const inArgs = fn.getArgDefs();
  const validatorArgs = _getValidatorArgs(inArgs);
  const inArgConsts = inArgs
    .map(
      (argDef, i) =>
        `const ${argDef.getName()}: ${argDef.getTypeAnnotation()} = ${
          validatorArgs.resultArgName
        }.in[${i}];`
    )
    .join("\n  ");

  const outTypeAsArg = fn.getReturnArg();
  const outTypeAsString = outTypeAsArg
    ? outTypeAsArg.getTypeAnnotation()
    : undefined;

  const outArgConst = _getOutArgConst(
    inArgs,
    validatorArgs.resultArgName,
    outTypeAsString
  );

  return `export function ${fn.getName()}Validator${nameSuffix}${validatorArgs.str}: "pass" | "fail" | "unknown" {
  /* inputs */
  ${inArgConsts}
  /* output */
  ${outArgConst}

  // <-- insert your property check code here. 

  return "pass"; // <-- return "pass", "fail", or "unknown"
}`;
} // fn: getPropertyTestSkeleton

/**
 * Choose a name for an identifier that doesn't conflict with the input arguments
 *
 * @param inArgs The input arguments
 * @param candidateNames The candidate names to choose from
 * @param maxSuffix The maximum suffix to use when generating a new name
 * @returns The chosen name and whether it was generated
 */
function _getIdentifierNameAvoidingConflicts(
  // The input arguments
  inArgs: ArgDef<ArgType>[],
  // The candidate names to choose from
  candidateNames: string[],
  // The maximum suffix to use when generating a new name
  maxSuffix: number
): {
  // The chosen name
  name: string;
  // Whether the name was generated (as opposed to being in possibleResultArgNames)
  generated: boolean;
} {
  const inArgNames = inArgs.map((argDef) => argDef.getName());
  for (const name of candidateNames) {
    if (!inArgNames.includes(name)) {
      return { name, generated: false };
    }
  }

  let i = 1;
  // Generate a new name with a suffix
  for (const candidateName of candidateNames) {
    while (i <= maxSuffix) {
      const name = `${candidateName}_${i}`;
      if (!inArgNames.includes(name)) {
        return { name, generated: true };
      }
      i++;
    }
  }

  // In the extremely unlikely event that all the names generated above are
  // already in `inArgNames`, we'll just return `r_conflicted` and not worry
  // about potential conflicts.
  return { name: "r_conflicted", generated: true };
} // fn: getIdentifierNameAvoidingConflicts()

/**
 * Get the string representation for the validator arguments, along with the
 * name of the argument that will hold the result.
 *
 * @param inArgs The input arguments
 * @returns An object containing the above information
 */
function _getValidatorArgs(inArgs: ArgDef<ArgType>[]): {
  str: string;
  resultArgName: string;
} {
  const resultArgCandidateNames = ["r", "result", "_r", "_result"];
  const maxResultArgSuffix = 1000;

  const resultArgName = _getIdentifierNameAvoidingConflicts(
    inArgs,
    resultArgCandidateNames,
    maxResultArgSuffix
  );
  const resultArgString = `${resultArgName.name}: FuzzTestResult`;
  return {
    str: `(${resultArgString})`,
    resultArgName: resultArgName.name,
  };
} // fn: getValidatorArgs()

/**
 * Get the string for the declaration of the out variable.
 *
 * The out variable is the variable that will hold the result of the function
 * under test.
 *
 * @param inArgs The input arguments
 * @param resultArgName The name of the argument that will hold the result
 * @param returnType The return type of the function
 * @returns The string for the declaration of the out variable
 */
function _getOutArgConst(
  inArgs: ArgDef<ArgType>[],
  resultArgName: string,
  returnType?: string
): string {
  const outVarCandidateNames = ["out", "output", "_out", "_output"];
  const maxOutVarSuffix = 1000;
  const outVarName = _getIdentifierNameAvoidingConflicts(
    inArgs,
    outVarCandidateNames,
    maxOutVarSuffix
  );
  const outVarString = `const ${outVarName.name}${
    returnType ? ": " + returnType : ""
  } = ${resultArgName}.out;`;
  return outVarString;
} // fn: getOutConst()
