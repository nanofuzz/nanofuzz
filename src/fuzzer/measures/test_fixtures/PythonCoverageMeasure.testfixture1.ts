import { CoverageInfo } from "../../runners/PythonRunner";
import { Arc } from "../../runners/AbstractRunner";

/**
 * Coverage fixtures for `PythonCoverageMeasure.test.ts`.
 *
 * `PythonCoverageMeasure` does not instrument anything itself: it reads
 * `runner.coverageInfo`, which the Python host fills in from coverage.py.
 * The static half (`executable`, `functions`, `branches`) is sent once when
 * the host starts; the dynamic half (`lines`, `arcs`) is replaced after every
 * call. These fixtures are therefore what the *runner* would report, so the
 * tests can drive `measure()` without spawning Python.
 *
 * Each fixture pairs a static structure with the dynamic data for individual
 * calls. The Python source each one describes is given above it, with line
 * numbers, because the tests assert `statementMap`, `fnMap` and `branchMap`
 * locations verbatim and those refer to lines of that source.
 *
 * Most fixtures below are verbatim host output for the source shown above
 * them, checked against `static_coverage` in `PythonRunnerHost.py`. A few
 * describe shapes the host cannot actually emit, and exist only to pin what
 * the translation does when handed one; each of those says so in its own
 * comment. Nothing here should be read as host output unless it is silent on
 * the point.
 *
 * Two ordering rules of the host's output are load bearing, because the
 * translation turns positions into istanbul's arm indices:
 *
 * - `static_branches` sorts a branch's `exits` by `dest` ascending, so a
 *   non-positive `dest` -- coverage.py's "left the enclosing scope" -- always
 *   sorts ahead of any real destination line.
 * - `coverage_arcs` returns the executed arcs sorted, so every `arcs` fixture
 *   below is in sorted order too.
 *
 * coverage.py measures by line, so hit counts are 0 or 1 rather than true
 * counts, and every synthesized location spans a whole line.
 */

/** The dynamic half of a coverage report: what one call reached */
export type PythonRun = { lines: number[]; arcs: Arc[] };

/** The file every fixture reports coverage for */
export const pyFileName = "/tmp/abs_value.py";

/**
 * One `if` with an early return:
 *
 * ```python
 * 1  def abs_value(n):
 * 2      if n < 0:
 * 3          return -n
 * 4      return n
 * ```
 *
 * Line 1 is executable but only runs at import, so it stays uncovered for
 * every call below.
 */
export const twoPathStatic: CoverageInfo = {
  executable: [1, 2, 3, 4],
  functions: [
    {
      name: "abs_value",
      declLine: 1,
      startLine: 2,
      endLine: 4,
      lines: [2, 3, 4],
    },
  ],
  branches: [
    {
      line: 2,
      exits: [
        { dest: 3, line: 3 }, // `if` taken
        { dest: 4, line: 4 }, // `if` not taken
      ],
    },
  ],
};

/** `abs_value(-3)`: takes the `if` and returns early */
export const twoPathNegative: PythonRun = {
  lines: [2, 3],
  arcs: [[2, 3]],
};

/** `abs_value(7)`: skips the `if` and falls through */
export const twoPathPositive: PythonRun = {
  lines: [2, 4],
  arcs: [[2, 4]],
};

/**
 * Three distinct paths, so a lineage of inputs can cover genuinely different
 * things at each generation:
 *
 * ```python
 * 1  def abs_value(n):
 * 2      if n < 0:
 * 3          return -n
 * 4      if n == 0:
 * 5          return 0
 * 6      return n
 * ```
 *
 * The three calls below cover 10 distinct items between them: one function,
 * five of the six statements, and two two-armed branches.
 */
export const threePathStatic: CoverageInfo = {
  executable: [1, 2, 3, 4, 5, 6],
  functions: [
    {
      name: "abs_value",
      declLine: 1,
      startLine: 2,
      endLine: 6,
      lines: [2, 3, 4, 5, 6],
    },
  ],
  branches: [
    {
      line: 2,
      exits: [
        { dest: 3, line: 3 },
        { dest: 4, line: 4 },
      ],
    },
    {
      line: 4,
      exits: [
        { dest: 5, line: 5 },
        { dest: 6, line: 6 },
      ],
    },
  ],
};

/** `abs_value(-3)` */
export const threePathNegative: PythonRun = {
  lines: [2, 3],
  arcs: [[2, 3]],
};

/** `abs_value(0)` */
export const threePathZero: PythonRun = {
  lines: [2, 4, 5],
  arcs: [
    [2, 4],
    [4, 5],
  ],
};

/** `abs_value(7)` */
export const threePathPositive: PythonRun = {
  lines: [2, 4, 6],
  arcs: [
    [2, 4],
    [4, 6],
  ],
};

/**
 * No branches at all:
 *
 * ```python
 * 1  def abs_value(n):
 * 2      doubled = n * 2
 * 3      return doubled
 * ```
 */
export const linearStatic: CoverageInfo = {
  executable: [1, 2, 3],
  functions: [
    { name: "abs_value", declLine: 1, startLine: 2, endLine: 3, lines: [2, 3] },
  ],
  branches: [],
};

/** `abs_value(5)` */
export const linearRun: PythonRun = { lines: [2, 3], arcs: [] };

/**
 * Three functions, one of which is never called:
 *
 * ```python
 * 1  def abs_value(n):
 * 2      return helper(n)
 * 3
 * 4  def helper(n):
 * 5      return -n if n < 0 else n
 * 6
 * 7  def never_called():
 * 8      return 0
 * ```
 *
 * The conditional expression on line 5 is not a branch point for
 * coverage.py: it cannot leave the line, so there is only one arc out of it.
 */
export const multiFunctionStatic: CoverageInfo = {
  executable: [1, 2, 4, 5, 7, 8],
  functions: [
    { name: "abs_value", declLine: 1, startLine: 2, endLine: 2, lines: [2] },
    { name: "helper", declLine: 4, startLine: 5, endLine: 5, lines: [5] },
    { name: "never_called", declLine: 7, startLine: 8, endLine: 8, lines: [8] },
  ],
  branches: [],
};

/** `abs_value(-4)`: enters `abs_value` and `helper`, never `never_called` */
export const multiFunctionRun: PythonRun = {
  lines: [2, 5],
  arcs: [[2, 5]],
};

/**
 * A branch whose second exit leaves the function:
 *
 * ```python
 * 1  def report(n):
 * 2      if n < 0:
 * 3          print(n)
 * ```
 *
 * coverage.py records leaving a function as an arc to the negative of the
 * function's `def` line, so the `if`-not-taken exit here has `dest: -1`. The
 * host gives such an exit the branching line as its display `line`, since
 * there is no line of source to point at: `dest` says which arc to look for,
 * `line` says where to show it, and only for this kind of exit do the two
 * differ. See `static_branches` in `PythonRunnerHost.py`.
 *
 * The leave-the-function exit is listed *first* because the host sorts a
 * branch's exits by `dest` ascending, and -1 sorts ahead of line 3. That
 * ordering is what makes this fixture worth having: the arm the translation
 * writes to index 0 is the one whose display line is the branching line, so
 * an implementation that matched exits by `line` instead of by `dest` would
 * flip both arms rather than fail to find them.
 */
export const earlyExitStatic: CoverageInfo = {
  executable: [1, 2, 3],
  functions: [
    { name: "report", declLine: 1, startLine: 2, endLine: 3, lines: [2, 3] },
  ],
  branches: [
    {
      line: 2,
      exits: [
        { dest: -1, line: 2 }, // `if` not taken: leave `report`
        { dest: 3, line: 3 }, // `if` taken: on to `print(n)`
      ],
    },
  ],
};

/** `report(-3)`: takes the `if`, then leaves the function from line 3 */
export const earlyExitTaken: PythonRun = {
  lines: [2, 3],
  arcs: [
    [2, 3],
    [3, -1], // same destination as the first exit, from a different line
  ],
};

/** `report(7)`: skips the `if`, leaving the function from the branch line */
export const earlyExitSkipped: PythonRun = {
  lines: [2],
  arcs: [[2, -1]],
};

/**
 * `report(-3)` again, with everything else coverage.py reports for the call:
 * entering the function, and a transition that belongs to no branch at all.
 * `coverage_arcs` returns every line transition, not just branch arcs.
 */
export const earlyExitNoisyArcs: PythonRun = {
  lines: [2, 3],
  arcs: [
    [-1, 2], // entering `report`
    [2, 3],
    [3, -1], // leaving `report`
    [7, 8], // a transition in some other function entirely
  ],
};

/**
 * Branches with fewer than two arms.
 *
 * NOT host output: neither branch below is a shape the host can emit. A
 * branch reaches `static_branches` only through `report_branch_arcs`, which
 * returns coverage.py's branch arcs -- and coverage.py counts a line as a
 * branch only when it has more than one exit. So a one-arm branch cannot
 * arrive, and an armless one cannot either, since every line `static_branches`
 * knows about got there by having an arc appended to it.
 *
 * The source below is what a one-arm branch would describe if it could be
 * reported. `while True:` can only ever exit one way, so coverage.py reports
 * no branch on line 2 at all:
 *
 * ```python
 * 1  def spin(n):
 * 2      while True:
 * 3          return n
 * ```
 *
 * Both shapes are here as robustness inputs, to pin that a branch with fewer
 * than two arms is translated and summarized rather than crashing: nothing
 * downstream may divide by, or summarize, an empty set of arms.
 */
export const degenerateBranchStatic: CoverageInfo = {
  executable: [1, 2, 3],
  functions: [
    { name: "spin", declLine: 1, startLine: 2, endLine: 3, lines: [2, 3] },
  ],
  branches: [
    { line: 2, exits: [{ dest: 3, line: 3 }] },
    { line: 3, exits: [] },
  ],
};

/** `spin(5)` */
export const degenerateBranchRun: PythonRun = {
  lines: [2, 3],
  arcs: [[2, 3]],
};

/**
 * A module with nothing in it. The host reports this shape when coverage.py's
 * JSON report has no entry for the file.
 */
export const emptyStatic: CoverageInfo = {
  executable: [],
  functions: [],
  branches: [],
};

/**
 * A nested function, and one with no executable body:
 *
 * ```python
 * 1  def outer(n):
 * 2      def inner(m):
 * 3          return m * 2
 * 4      return n
 * 5
 * 6  def documented():
 * 7      """No executable body."""
 * ```
 *
 * coverage.py attributes lines to the function they are written in, so line 3
 * belongs to `inner` and not to `outer`, while line 2 -- the `def` statement
 * that creates `inner` -- is one of `outer`'s own lines. Those two functions,
 * and the `executable` list below, are verbatim host output for this source.
 *
 * The third entry is not. A docstring is not executable, so `documented` has
 * no lines of its own, and coverage.py's per-function report therefore has no
 * entry for it -- the host emits two functions here, not three. It is added
 * as a robustness input, because "covered when one of its own lines ran" has
 * to answer something rather than divide by zero when there are no such
 * lines. Line 6 is genuinely executable, though: the `def` itself runs at
 * import, which is why it appears in `executable` and in `nestedImportOnly`.
 */
export const nestedStatic: CoverageInfo = {
  executable: [1, 2, 3, 4, 6],
  functions: [
    { name: "outer", declLine: 1, startLine: 2, endLine: 4, lines: [2, 4] },
    { name: "outer.inner", declLine: 2, startLine: 3, endLine: 3, lines: [3] },
    { name: "documented", declLine: 6, startLine: 6, endLine: 6, lines: [] },
  ],
  branches: [],
};

/** `outer(5)`: defines `inner` without calling it */
export const nestedOuterOnly: PythonRun = {
  lines: [2, 4],
  arcs: [
    [-1, 2],
    [2, 4],
    [4, -1],
  ],
};

/** Importing the module: the `def` lines run, and nothing else */
export const nestedImportOnly: PythonRun = {
  lines: [1, 6],
  arcs: [
    [-1, 1],
    [1, 6],
  ],
};
