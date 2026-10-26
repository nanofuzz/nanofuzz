# @nanofuzz/cli

Structure-aware property-based Fuzzing for **TypeScript**, **Python**, **Rust**, and **Java** directly from your terminal!

NaNofuzz tests functions (exported and unexported, synchronous and asynchronous) by combining coverage-guided mutation, grammar-based input generation, property validators, input transformers, and automated input shrinking to find edge cases, crashes, and minimal counterexamples.

---

## Quick Start

You can run NaNofuzz immediately with **zero installation** via `npx`:

```bash
# Test a TypeScript function
npx @nanofuzz/cli src/math.ts::add

# Test a Python function
npx @nanofuzz/cli app/calculator.py::divide

# Test a Rust function
npx @nanofuzz/cli src/lib.rs::parse_token

# Test a Java method
npx @nanofuzz/cli src/main/java/com/example/MathUtil.java::add
```

### Install as a Dev Dependency

Add NaNofuzz to your project for faster local runs and CI integration:

```bash
# npm
npm install -D @nanofuzz/cli

# yarn
yarn add -D @nanofuzz/cli

# pnpm
pnpm add -D @nanofuzz/cli
```

Once installed, use `npx nanofuzz` or add it to your `package.json` scripts:

```json
{
  "scripts": {
    "fuzz": "nanofuzz src/index.ts::parsePayload"
  }
}
```

### Global Installation

To install `nanofuzz` as a system-wide command:

```bash
npm install -g @nanofuzz/cli
nanofuzz src/math.ts::add
```

---

## Usage

```bash
nanofuzz [options] <filename>::<function>
```

### Examples

```bash
# Display help and all available options
nanofuzz --help

# Run up to 5,000 tests and stop on the first failing input (default)
nanofuzz src/parser.ts::parseExpr --max-tests 5000

# Continue fuzzing to collect up to 5 distinct counterexamples
nanofuzz src/parser.ts::parseExpr --max-failures 5

# Set per-test execution timeout to 500ms and total suite timeout to 10s
nanofuzz src/network.ts::fetchRecord --fn-timeout 500 --max-runtime 10000

# Run deterministic fuzzing with a fixed seed
nanofuzz src/math.ts::divide --seed my-seed-42

# Save structured counterexamples and coverage metrics to JSON5
nanofuzz src/math.ts::divide --output-file results.json5

# Test a specific unexported function
nanofuzz src/internal.ts::_helperFn

# Run Rust fuzzing with BorrowSanitizer enabled to detect aliasing violations
nanofuzz src/lib.rs::my_unsafe_fn --rust-sanitizer borrow
```

---

## Command Line Options

### General Options

| Option                  | Description                                     |
| :---------------------- | :---------------------------------------------- |
| `-h, --help`            | Display help and available command-line options |
| `-V, --version`         | Output the version number                       |
| `--clear-compile-cache` | Clear compiler cache before run                 |

### Core Fuzzing Parameters

| Option                    |   Default    | Description                                                  |
| :------------------------ | :----------: | :----------------------------------------------------------- |
| `<filename>::<function>`  | _(required)_ | Target module and function                                   |
| `--max-failures <n>`      |     `1`      | Max failing inputs to find before stopping (`0` = no limit)  |
| `--max-tests <n>`         |    `1000`    | Maximum number of tests to execute                           |
| `--max-runtime <ms>`      |    `3000`    | Maximum suite runtime in ms (`0` = no limit)                 |
| `--fn-timeout <ms>`       |    `200`     | Maximum execution time in ms allowed per single test run     |
| `--seed <string>`         |              | PRNG seed for deterministic test generation                  |
| `--no-shrink`             |              | Disable input shrinking (minimization) on failure            |
| `--max-shrink-time <ms>`  |    `2000`    | Maximum time allowed for shrinking failing inputs            |
| `--output-file <file>`    |              | Output file path for structured results (`.json5` or `.mpk`) |
| `--output-results <mode>` |  `failures`  | Results to return in output file: `all`, `failures`, `none`  |
| `--no-config-file`        |              | Ignore companion `.nano.json5` file on disk                  |

### Concurrency and Engine

| Option                        | Default | Description                                                           |
| :---------------------------- | :-----: | :-------------------------------------------------------------------- |
| `--engine <v1\|v2\|v3\|auto>` | `auto`  | Fuzzer engine (`auto`, `v1` classic, `v2` refactored, `v3` pipelined) |
| `--workers <n\|auto>`         | `auto`  | Number of concurrent worker execution processes                       |
| `--max-runner-memory <MB>`    | `8192`  | Memory limit in MB for worker runner hosts                            |

### Oracles & Coverage

| Option                     |     Default      | Description                                                                 |
| :------------------------- | :--------------: | :-------------------------------------------------------------------------- |
| `--no-heuristic-oracle`    |                  | Disable built-in heuristic assertions (NaN, null pointer, unhandled errors) |
| `--no-property-oracle`     |                  | Disable user property validators (`<fn>Validator`)                          |
| `--no-example-oracle`      |                  | Disable example oracle                                                      |
| `--no-coverage-measure`    |                  | Disable code coverage tracking                                              |
| `--coverage-scope <scope>` | `project static` | Coverage tracking scope (`project`, `directimports`, `static`)              |

### Language & Sanitizer Options

| Option                                     | Default | Description                                                                                                |
| :----------------------------------------- | :-----: | :--------------------------------------------------------------------------------------------------------- |
| `--rust-sanitizer <none\|borrow\|address>` | `none`  | Enable runtime sanitizers for Rust fuzz targets (`none`, `borrow` for BorrowSanitizer, `address` for ASan) |

### Input Generators & Schedulers

| Option                          | Default | Description                                                                                        |
| :------------------------------ | :-----: | :------------------------------------------------------------------------------------------------- |
| `--no-random-input-generator`   |         | Disable pseudo-random input generator                                                              |
| `--no-mutation-input-generator` |         | Disable coverage-guided mutation generator                                                         |
| `--no-user-input-generator`     |         | Disable custom generator function (`<fn>Generator`)                                                |
| `--no-ai-input-generator`       |         | Disable LLM-assisted input generator                                                               |
| `--cig-scheduler <algo>`        |  `mab`  | Generator scheduler algorithm (`mab`, `ucb1`, `thompson`, `ewma`, `mopt`, `random`, `round-robin`) |

---

## Exit Codes

NaNofuzz uses pytest-compatible exit codes suitable for CI/CD gates and pre-commit hooks:

- **`0`**: Fuzzing ran and all executed tests passed.
- **`1`**: Fuzzing found at least one failure, crash, exception, or oracle counterexample.
- **`2`**: User interrupted or cancelled testing (e.g. `Ctrl+C` / `SIGINT`).
- **`3`**: Internal error (or 0 tests could be executed, e.g. all inputs were skipped).
- **`4`**: Command line usage or argument parsing error.

---

## Companion Functions

NaNofuzz automatically detects companion functions defined alongside your target function:

### 1. Preconditions via Input Transformers

To filter invalid inputs or express function preconditions, define an input transformer `<fn>Transformer`. Use `assume(...)` from `@nanofuzz/runtime` (or `UnsatisfiedAssumption` in Python, `assume!` in Rust, or `Assume.that(...)` in Java):

```typescript
import { assume } from "@nanofuzz/runtime";

export function sqrt(x: number): number {
  return Math.sqrt(x);
}

// Automatically detected and paired with sqrt():
export function sqrtTransformer(x: number): number {
  assume(x >= 0, "x must be non-negative");
  return x;
}
```

```java
import com.nanofuzz.runtime.Assume;

public class MathUtil {
    public static double sqrt(double x) {
        return Math.sqrt(x);
    }

    // Automatically detected and paired with sqrt():
    public static Object[] sqrtTransformer(double x) {
        Assume.that(x >= 0, "x must be non-negative");
        return new Object[] { x };
    }
}
```

### 2. Correctness via Property Validators

To test arbitrary properties across inputs, define `<fn>Validator`:

```typescript
export function sortNumbers(nums: number[]): number[] {
  return [...nums].sort((a, b) => a - b);
}

// Automatically runs on every test output:
export function sortNumbersValidator(r: {
  in: [number[]];
  out: number[];
}): boolean {
  const [input] = r.in;
  const output = r.out;
  // Output length must match input length
  if (output.length !== input.length) return false;
  // Output must be monotonically increasing
  for (let i = 1; i < output.length; i++) {
    if (output[i] < output[i - 1]) return false;
  }
  return true;
}
```

```java
import com.nanofuzz.runtime.FuzzTestResult;
import com.nanofuzz.runtime.ValidatorResult;

public class MathUtil {
    public static int add(int a, int b) {
        return a + b;
    }

    // Automatically runs on every test output:
    public static ValidatorResult addValidator(FuzzTestResult r) {
        int a = r.getIn(0);
        int b = r.getIn(1);
        int out = r.getOut();
        return (out - a == b) ? ValidatorResult.PASS : ValidatorResult.FAIL;
    }
}
```

### 3. Custom Input Generators

To supply domain-specific distributions or structured grammars, define `<fn>Generator`:

```typescript
export function parseExpression(expr: string): number { ... }

export function parseExpressionGenerator(prng: () => number): string {
  // Return generated strings conforming to your domain grammar
}
```

```java
import java.util.function.DoubleSupplier;

public class MathUtil {
    public static int classify(int val) { ... }

    // Generates inputs using seeded pseudo-random supplier:
    public static Object[] classifyGenerator(DoubleSupplier prng) {
        int val = (int)(prng.getAsDouble() * 100);
        return new Object[] { val };
    }
}
```

---

## Configuration & Option Precedence

NaNofuzz resolves execution options in the following priority order:

1. **CLI flags** (e.g. `--max-tests 50`, `--max-failures 2`) — explicit terminal arguments always take highest precedence.
2. **Companion config file (`.nano.json5`)** — options explicitly saved in the function's companion file on disk.
3. **In-source annotations** — language-native attributes (e.g. Python `@settings(max_examples=..., deadline=...)`).
4. **CLI defaults** — standard defaults (`--max-failures 1`, `--max-tests 1000`, `--fn-timeout 200`, `--max-runtime 3000`).

---

## License

MIT
