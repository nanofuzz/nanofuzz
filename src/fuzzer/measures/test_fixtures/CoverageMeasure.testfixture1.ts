/**
 * Source fixtures for `TypescriptCoverageMeasure.test.ts`.
 *
 * The measure instruments *JavaScript text* -- `onAfterCompile(jsSrc, ...)`
 * runs after `tsc` and before the module is loaded -- so these fixtures are
 * source strings that the tests hand to the measure directly, rather than
 * modules the tests import.
 *
 * The tests assert `statementMap`, `fnMap` and `branchMap` locations
 * verbatim, and those line numbers are positions *within each string*. Every
 * fixture is therefore written one source line per array entry, so entry `i`
 * of the array is line `i + 1` of the fixture. Instrumentation is pinned
 * (`istanbul-lib-instrument` 6.0.3), which is what makes the maps stable
 * enough to assert exactly.
 *
 * Each fixture exports a function named `absValue`, which is what the test
 * harness looks for after loading the instrumented source.
 */

/**
 * One `if` with an early return.
 *
 * - statements: `if (n < 0)`, `return -n`, `return n`, `module.exports`
 * - functions: `absValue`
 * - branches: one `if` (consequent, alternate)
 */
export const twoPathSource = [
  "function absValue(n) {",
  "  if (n < 0) {",
  "    return -n;",
  "  }",
  "  return n;",
  "}",
  "module.exports = { absValue };",
  "",
].join("\n");

/**
 * Three distinct paths, so that a lineage of inputs can cover genuinely
 * different things at each generation. The three paths cover 10 distinct
 * items between them: one function, five statements, and two two-armed
 * branches.
 */
export const threePathSource = [
  "function absValue(n) {",
  "  if (n < 0) {",
  "    return -n;",
  "  }",
  "  if (n === 0) {",
  "    return 0;",
  "  }",
  "  return n;",
  "}",
  "module.exports = { absValue };",
  "",
].join("\n");

/**
 * No branches at all: statements and a single function.
 *
 * Note that istanbul records the *initializer* of `const doubled` as the
 * statement, not the whole declaration.
 */
export const linearSource = [
  "function absValue(n) {",
  "  const doubled = n * 2;",
  "  return doubled;",
  "}",
  "module.exports = { absValue };",
  "",
].join("\n");

/**
 * An arrow function and a conditional expression, which istanbul records as
 * a `cond-expr` branch. The arrow is anonymous despite the `const` name.
 */
export const ternarySource = [
  "const absValue = (n) => (n < 0 ? -n : n);",
  "module.exports = { absValue };",
  "",
].join("\n");

/**
 * A short-circuiting logical operator, recorded as a `binary-expr` branch
 * with one arm per operand.
 */
export const logicalSource = [
  "function absValue(n) {",
  "  return n || 0;",
  "}",
  "module.exports = { absValue };",
  "",
].join("\n");

/**
 * A three-arm switch, recorded as a single `switch` branch whose locations
 * are the `case`/`default` clauses.
 */
export const switchSource = [
  "function absValue(n) {",
  "  switch (n) {",
  "    case 0:",
  "      return 0;",
  "    case 1:",
  "      return 1;",
  "    default:",
  "      return -1;",
  "  }",
  "}",
  "module.exports = { absValue };",
  "",
].join("\n");

/**
 * Three functions, one of which is never called, so that `f` can be checked
 * for an uncovered function. The only branch is the ternary in `helper`.
 */
export const multiFunctionSource = [
  "function absValue(n) {",
  "  return helper(n);",
  "}",
  "function helper(n) {",
  "  return n < 0 ? -n : n;",
  "}",
  "function neverCalled() {",
  "  return 0;",
  "}",
  "module.exports = { absValue, helper, neverCalled };",
  "",
].join("\n");
