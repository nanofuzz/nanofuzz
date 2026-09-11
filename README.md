# NaNofuzz

NaNofuzz is a fast and easy-to-use Automatic Test sUite Generator (ATUG) for TypeScript and Python that combines human insight, heuristics, and property checking to help you quickly reach working code nirvana. NaNofuzz is intended to be used during testing and development and is available in the [the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=penrose.nanofuzz).

<img width="1329" height="750" alt="image" src="https://github.com/user-attachments/assets/33a5fcda-19ac-459c-a50a-20cc0d8502c1" />

NaNofuzz proposes an initial set of test examples with a single button click. You can refine these examples by manually annotating their correctness and/or by writing property validator functions that evaluate correctness at scale. NaNofuzz coherently organizes and prioritizes all test results on a single screen so that you can see at a glance what you are actually testing---as well as what may be missing. 

## Tutorial and Playground

Our [NaNofuzz examples](https://github.com/nanofuzz/nanofuzz-examples/) repository provides a 10-minute NaNofuzz tutorial and several example buggy programs that you can use to get familiar with NaNofuzz. Within the `nanofuzz-examples` repo on GitHub, click `Code`->`Codespaces`->`Create` to immediately get started!

## Getting started

To use NaNofuzz in your own projects: 

- **Step 1**: Add the NaNofuzz dev dependency
    - TypeScript v5-6 projects:
      - **npm**: `npm i @nanofuzz/runtime -D` or
      - **yarn**: `yarn add @nanofuzz/runtime -D`
    - Python v3.13+ projects:
      - **pip**: `pip install nanofuzz-runtime`
- **Step 2**: Add the NaNofuzz extension to your repo's `./.vscode/settings.json` recommendations:
    ```
    {
        "recommendations": [
            "penrose.nanofuzz"
        ]
    }
    ```

To export a NaNofuzz test to CI, click the pin button beside an example. NaNofuzz exports pinned tests to Jest/Jasmine or pytest format, depending on the target language.

## What's new in v0.4

- **Python targets**: Test Python functions and export the saved tests to `pytest` for use in CI.
- **Input transformers**: Programatically modify or skip inputs before they are dispatched for test execution.
- **More types**: Tuples, Unions, `Map`s, `Set`s, unique Arrays/`List`s, dictionaries, regex strings, `null`s, binary data like `Uint8Array`/`bytes`, and select Typescript utility types, like `Record<K,V>`, `Required<T>` and `Partial<T>`.
- **Composite input generation**: Random-, coverage-, human-, and opt-in ai-guided input generators are coordinated automatically, so you can start testing with a single button click.
- **Code coverage visualizations**: See in your editor which lines of code were actually executed (and missed) by the generated test examples.
- **Stop-and-go testing**: Pause and resume testing runs without losing the accumulated results, pinned inputs, or input generator state.
- **Project-aware compilation**: NaNofuzz uses the target project's TypeScript compiler and `tsconfig.json` when available.

## Scope and Limitations

NaNofuzz is an **experimental** testing platform developed by the Accelerated Testing Research Program at Carnegie Mellon University's School of Computer Science based on empirical and theoretical scientific research, including extensive user studies with professional software engineers. While NaNofuzz is **not** intended for production use, contributions are welcome to address the limitations below as well as those described in our issue list.

NaNofuzz supports exported functions with any mixture of the following parameter types:
 - Numbers (ints and floats)
 - Strings
 - Booleans
 - Literal object types
 - Tuples, unions, and n-dimension arrays of any of the preceeding
 - Optional and mandatory parameters and members

NaNofuzz automatically generates a test suite in these formats for use in CI:
 - **TypeScript**: Jest/Jasmine
 - **Python**: pytest

The following are not yet supported:
 - Generating inputs of deconstructed, `enum`, generic, intersection, utility (e.g., TypeScript `Record<T>`, `Omit<T1,T2>`), dynamic dictionary, `bigint`s, implicit `any`, `unknown`, and function types as well as values `NaN`, `Infinity`, and `null`
 - Testing class and object methods (write a test harness for these)
 - Compiling to module formats other than CommonJS (related to [VS Code issue 130367](https://github.com/microsoft/vscode/issues/130367))
 - Stateful, flaky, async, or non-deterministic tests
 - Sandboxing external side-effects of the program under test, mocks, or stubs 
 - Custom generators and input filters
 - Test case minimization ("shrinking")

If the `NaNofuzz...` button does not appear above the function you want to test, that usually means the function is not exported or one of its inputs is comprised of types that are not yet supported. For these cases, write a test hardness function that accepts NaNofuzz' supported inputs and calls the function you want to test.

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

We have a forthcoming paper describing NaNofuzz' Composite Input Generator that we plan to announce in the near future.

## The NaNofuzz Mascot

Meet NaNcy, the Silky Anteater! Silky anteaters are wonderfully-adapted, small, fuzzy creatures known to find and consume large quantities of bugs on a daily basis. Therefore, NaNcy is NaNofuzz's beloved mascot on our journey to find and eliminate more bugs.

![image](https://avatars.githubusercontent.com/u/136026223?s=200&v=4)

## Trophy Case
If you find bugs with NaNofuzz and feel comfortable sharing them, we would be happy to add them to our list. 
Please send a PR for README.md with a link to the bug or CVE that you found.

- [RosettaCode Levenshtein distance](https://rosettacode.org/wiki/Levenshtein_distance?oldid=371462): returned `undefined` when `a===''`




