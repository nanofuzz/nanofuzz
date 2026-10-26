# NaNofuzz

NaNofuzz is a fast and easy-to-use property-based fuzzer and test generator for Typescript, Python, Rust, Java, and OCaml/OxCaml that combines human insight, heuristics, and property checking to help you quickly reach working code nirvana. NaNofuzz is intended to be used during testing and development and is available in the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=penrose.nanofuzz) (GUI) and [npm](https://www.npmjs.com/package/@nanofuzz/cli) (CLI, MCP).

![NaNofuzz Screenshot](https://github.com/user-attachments/assets/33a5fcda-19ac-459c-a50a-20cc0d8502c1)

NaNofuzz proposes an initial set of tests with a single button click. Refine these tests with correctness annotations and/or by writing property validators that evaluate correctness at scale. NaNofuzz coherently organizes test results on a single screen so that you can see at a glance what you are actually testing---and what you may be missing.

## Tutorial and Playground

Our [NaNofuzz examples](https://github.com/nanofuzz/nanofuzz-examples/) repository provides a 10-minute NaNofuzz tutorial for Typescript with example programs that you can use to get familiar with NaNofuzz. Within the `nanofuzz-examples` repo on GitHub, click `Code`->`Codespaces`->`Create` to immediately get started!

## Getting started

To use NaNofuzz in your own projects: 

- **Step 1**: Add the NaNofuzz dev dependency
    - Typescript v5-6 projects:
      - **npm**: `npm i @nanofuzz/runtime -D` or
      - **yarn**: `yarn add @nanofuzz/runtime -D`
    - Python v3.13+ projects:
      - **pip**: `pip install nanofuzz-runtime`
    - Rust projects:
      - **cargo**: `cargo add nanofuzz-runtime`
    - Java projects (Java 17+ with Maven or Gradle):
      - **Maven**:
        ```xml
        <dependency>
            <groupId>com.nanofuzz</groupId>
            <artifactId>nanofuzz-runtime</artifactId>
            <version>0.4.1</version>
            <scope>test</scope>
        </dependency>
        ```
      - **Gradle**: `testImplementation 'com.nanofuzz:nanofuzz-runtime:0.4.1'`
    - OCaml / OxCaml projects:
      - **opam**: `opam install nanofuzz_runtime` or
      - **dune**: add `nanofuzz_runtime` to your `dune` libraries
- **Step 2**: Add the NaNofuzz extension to your repo's `./.vscode/extensions.json` recommendations:
    ```json
    {
        "recommendations": [
            "penrose.nanofuzz"
        ]
    }
    ```

To export a NaNofuzz test to CI, click the pin button beside an example. NaNofuzz exports pinned tests to Jest/Jasmine, pytest, cargo test, JUnit 5, or dune runtest format, depending on the target language.

### To run NaNofuzz via CLI (outside of VS Code):

```sh
npx -y @nanofuzz/cli --help
```

### To run NaNofuzz as an MCP server:

Run:

```sh
npx -y @nanofuzz/cli mcp
```

Or provide the following configuration to your favorite MCP-enabled agent or tool:
```json
{
  "mcpServers": {
    "nanofuzz": {
      "command": "npx",
      "args": ["-y", "@nanofuzz/cli", "mcp"]
    }
  }
}
```

The MCP server exposes the following tools:
- `nanofuzz_listTargets`: Discovers functions, type signatures, and ready-to-use template hooks (`<fn>Validator`, `<fn>Transformer`, `<fn>Generator`) in source files.
- `nanofuzz_fuzzFunction`: Executes coverage-guided, structure-aware property fuzzing on a target and synthesizes unit regression tests / counter-examples.
- `nanofuzz_findBugs`: Autonomous multi-turn bug hunting workflow that guides agents through invariant extraction, harness synthesis, and coverage-gated fuzzing.
- `nanofuzz_shrinkInputs`: Minimizes failing inputs and counterexamples to find the simplest canonical reproducers.

## What's new in v0.4

- **New ways to use NaNofuzz**: Run NaNofuzz directly from your terminal or CI pipelines via `npx @nanofuzz/cli <filename>::<function>` (see [docs](docs/CLI.md)) or as an MCP server via `npx -y @nanofuzz/cli mcp`.
- Test **Python** and **Typescript** functions and export saved tests to `pytest` or `jest`/`jasmine` for use in CI.
- Experimental **bug hunting mode**. Ask your agent to find bugs using NaNofuzz, and NaNofuzz will automatically find deep, silent, semantic bugs you didn't know existed, even in well-tested code.
- Experimental support for testing **Rust**, **Java**, **OCaml**, and **OxCaml** programs with support for `cargo test`, `JUnit`, and `dune` in CI. Includes support for Rust sanitizers, like AddressSanitizer (ASan) and Borrow Sanitizer.
- **Custom input generators and transformers**: Programmatically generate, modify, or skip inputs before they are dispatched for test execution.
- **More types**: Tuples, unions, `Map`s, `Set`s, unique Arrays/`List`s, dictionaries, regex strings, `null`s, binary data like `Uint8Array`/`bytes`, and select Typescript utility types, like `Record<K,V>`, `Required<T>` and `Partial<T>`.
- Support for testing **unexported functions**
- **Composite input generation**: Random-, mutation-, human-, and an opt-in ai input generator are coordinated automatically, so you can get better testing results with a single button click.
- **Code coverage visualizations**: See in your editor which lines of code were actually executed (and missed!) by the generated test examples.
- **Stop-and-go**: Pause and resume testing runs in the GUI and add your own inputs mid-run without losing the accumulated results, pinned inputs, or input generator state.

## Scope and Limitations

NaNofuzz is an **experimental** testing platform developed by the Accelerated Testing Research Program at Carnegie Mellon University's School of Computer Science based on empirical and theoretical scientific research, including extensive user studies with professional software engineers. While NaNofuzz is **not** intended for production use, contributions are welcome to address the limitations below as well as those described in our issue list.

NaNofuzz supports functions with any mixture of the following parameter types:
 - **Numbers**: Floating-point and fixed-width integers (e.g., `u8`–`u64`, `i8`–`i64` in Rust; `byte`, `short`, `int`, `long`, `float`, `double` in Java; numbers in TypeScript/Python)
 - **BigInts**: 64-bit and arbitrary-precision integers
 - **Strings & Characters**: UTF-8 strings, regex-constrained strings, single characters (`char`), and UUIDs
 - **Booleans**: `true` and `false`
 - **Binary Data**: Byte arrays and buffers (`Uint8Array`, Python `bytes`, Java `byte[]`)
 - **Objects, Records & Structs**: Object literals, Java `record`s, and Rust `struct`s
 - **Collections & Dictionaries**: Arrays and `List`s (including n-dimensional and unique-element arrays), `Set`s, `Map`s, and dictionaries
 - **Tuples**: Fixed-length typed tuples
 - **Unions & Enums**: Sum types and unions, Rust `enum` variants, Java `enum`s, and `Result<T, E>`
 - **Option types & Nullability**: `null`, `undefined`, Rust `Option<T>`, Java `Optional<T>`
 - **Utility types**: Select TypeScript utility types (`Record<K, V>`, `Partial<T>`, `Required<T>`)
 - Optional and mandatory parameters and members

NaNofuzz automatically generates a test suite in these formats for use in CI:
 - **Typescript**: Jest/Jasmine
 - **Python**: pytest
 - **Rust**: cargo test
 - **Java**: JUnit 5
 - **OCaml / OxCaml**: dune runtest

The following are not yet supported:
 - Generating inputs of deconstructed, generic, intersection, some utility (e.g., Typescript `Omit<T1,T2>`) types, implicit `any`, `unknown`, and function types as well as `NaN` and `Infinity`
 - Testing object instance methods (write a test harness for these)
 - Compiling Typescript to module formats other than CommonJS (related to [VS Code issue 130367](https://github.com/microsoft/vscode/issues/130367))
 - Stateful, flaky, or non-deterministic tests
 - Sandboxing external side-effects of the program under test, mocks, or stubs

If the `NaNofuzz...` button does not appear above the function you want to test, that usually means one of its inputs is comprised of types that are not yet supported. For unsupported functions or class methods, write a test harness function that accepts NaNofuzz' supported inputs and calls the function you want to test.

## Contributing

We welcome outside contributions to address the limitations above and to correct open issues. 
Please see our [Contributor's Guide](https://github.com/nanofuzz/nanofuzz/blob/main/CONTRIBUTING.md) for more details about how you can get involved.

## NaNofuzz Research Paper

To reference NaNofuzz v0.1.x in your own research, please cite our ESEC/FSE'23 paper:

> Matthew C. Davis, Sangheon Choi, Sam Estep, Brad A. Myers, and Joshua Sunshine. **[NaNofuzz: A Usable Tool for Automatic Test Generation](https://dl.acm.org/doi/10.1145/3611643.3616327)**. In Proceedings of the 31st ACM Joint European Software Engineering Conference and Symposium on the Foundations of Software Engineering (November, 2023).

This paper covers the original implicit oracle version of NaNofuzz that introduced the "tab-and-grid" user interface for organizing test results that we now know as the Composite Test Results Grid.

## TerzoN Research Paper

To reference NaNofuzz v0.3.x ("TerzoN") in your own research, please cite our FSE'25 paper:

> Matthew C. Davis, Amy Wei, Brad A. Myers, and Joshua Sunshine. 2025. **[TerzoN: Human-in-the-loop Software Testing with a Composite Oracle](https://dl.acm.org/doi/abs/10.1145/3729359)**. Proceedings of the ACM on Software Engineering, 2, FSE, Article FSE089 (July 2025).

This paper covers the Composite Oracle in NaNofuzz v0.3 ("TerzoN"), which features implicit, property-based, and example-based oracles, as well as an expanded "tab-and-grid" user interface.

## TestLoop Research Paper

To reference the theoretical process model ("TestLoop") behind the NaNofuzz project in your own research, please cite our TOSEM'26 paper:

> Matthew C. Davis, Sangheon Choi, Amy Wei, Sam Estep, Brad A. Myers, and Joshua Sunshine. 2025. **[TestLoop: A Process Model Describing Human-in-the-Loop Software Test Suite Generation](https://dl.acm.org/doi/full/10.1145/3765754)**. ACM Transactions on Software Engineering and Methodology, Volume 35, Issue 8. Article No.: 250, Pages 1 - 36 (July 2026).

We have a forthcoming paper describing NaNofuzz' Composite Input Generator and bug hunting mode that we plan to announce in the near future.

## The NaNofuzz Mascot

Meet NaNcy, the Silky Anteater! Silky anteaters are wonderfully-adapted, small, fuzzy creatures known to find and consume large quantities of bugs on a daily basis. Therefore, NaNcy is NaNofuzz's beloved mascot on our journey to find and eliminate more bugs.

![image](https://avatars.githubusercontent.com/u/136026223?s=200&v=4)

## Trophy Case
Did you find a bug with NaNofuzz? We would like to add the bug you found to NaNofuzz' trophy case!
Please submit a PR for README.md with a link to the bug, issue, PR, or CVE reflecting the bug that you found.

- [RosettaCode Levenshtein distance](https://rosettacode.org/wiki/Levenshtein_distance?oldid=371462): returned `undefined` when `a===''`




