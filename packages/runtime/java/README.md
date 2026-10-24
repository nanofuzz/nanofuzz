# nanofuzz-runtime (Java)

Runtime support and types for NaNofuzz test suites and property validators in Java.

## Installation

### Maven

```xml
<dependency>
    <groupId>com.nanofuzz</groupId>
    <artifactId>nanofuzz-runtime</artifactId>
    <version>0.4.0</version>
    <scope>test</scope>
</dependency>
```

### Gradle

```groovy
testImplementation 'com.nanofuzz:nanofuzz-runtime:0.4.0'
```

## Features

- `FuzzTestResult`: Represents the result of executing a target method during fuzzing.
- `ValidatorResult`: Outcome of evaluating a property validator (`PASS`, `FAIL`, `UNKNOWN`).
- `Assert.that(...)`: Zero-dependency assertion utility (`that(condition)`, `that(condition, message)`) that always executes without requiring `-ea`.
- `Assume.assume(...)`: Filter invalid or out-of-domain inputs in input transformers.
- `ImplicitOracle`: Heuristic verification checking for unhandled exceptions, nulls, NaNs, and infinities.
- `CoverageTracker`: In-process branch, statement, and function coverage tracking for coverage-guided fuzzing.
