/**
 * TypeScript source fixtures for `TypescriptCoverageMeasure.test.ts`.
 *
 * The fixtures in `CoverageMeasure.testfixture1` are JavaScript, because
 * `onAfterCompile` instruments the compiled JS. These are the *TypeScript*
 * originals, for the tests that compile them to JS with a real source map
 * first: `onRunEnd` maps the run's coverage back to TypeScript locations,
 * so exercising it at all requires a source map to map through.
 *
 * As in fixture 1, the tests assert locations verbatim, and those line
 * numbers are positions *within each string* -- so every fixture is written
 * one source line per array entry, and entry `i` is line `i + 1`. What the
 * compiler emits, and therefore what the maps say, also depends on the
 * options the tests compile with; those mirror `TypescriptCompiler`.
 */

/**
 * One `if` with an early return.
 *
 * - statements: `exports.absValue`, `if (n < 0)`, `return -n`, `return n`
 * - functions: `absValue`
 * - branches: one `if` (consequent, alternate)
 */
export const twoPathSource = [
  "export function absValue(n: number): number {",
  "  if (n < 0) {",
  "    return -n;",
  "  }",
  "  return n;",
  "}",
  "",
].join("\n");

/**
 * Three distinct paths, so that a run of several inputs discovers genuinely
 * different coverage from each one.
 */
export const threePathSource = [
  "export function absValue(n: number): number {",
  "  if (n < 0) {",
  "    return -n;",
  "  }",
  "  if (n === 0) {",
  "    return 0;",
  "  }",
  "  return n;",
  "}",
  "",
].join("\n");

/**
 * Three functions, one of which is never called, so that a run always leaves
 * an uncovered function behind. The only branch is the ternary in `helper`.
 */
export const multiFunctionSource = [
  "export function absValue(n: number): number {",
  "  return helper(n);",
  "}",
  "export function helper(n: number): number {",
  "  return n < 0 ? -n : n;",
  "}",
  "export function neverCalled(): number {",
  "  return 0;",
  "}",
  "",
].join("\n");

/**
 * No branches, and a function named something other than `absValue`, so that
 * tests loading more than one module can tell the two apart.
 */
export const linearSource = [
  "export function double(n: number): number {",
  "  const doubled: number = n * 2;",
  "  return doubled;",
  "}",
  "",
].join("\n");
