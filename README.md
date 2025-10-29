# NaNofuzz

NaNofuzz is a fast and easy-to-use Automatic Test sUite Generator (ATUG) for TypeScript that combines human insight, heuristics, and property checking to help you quickly reach working code nirvana. NaNofuzz is intended to be used during testing and development and is available in the [the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=penrose.nanofuzz).

![NaNofuzz Screenshot](https://github.com/user-attachments/assets/7655c0c7-96ee-4251-b383-77023c68f3da)

NaNofuzz proposes an initial set of tests with a single button click. You then improve these tests by manually annotating the correctness of specific examples and/or by adding property validator functions that evaluate correctness at scale. NaNofuzz coherently organizes and prioritizes all test results on a single screen so that you can see at a glance what your suite is testing---as well as what it may be missing. 

## Tutorial and Playground

Our [NaNofuzz examples](https://github.com/nanofuzz/nanofuzz-examples/) repository provides a 10-minute NaNofuzz tutorial and several example buggy programs that you can use to get familiar with NaNofuzz. Within the `nanofuzz-examples` repo on GitHub, click `Code`->`Codespaces`->`Create` to immediately get started!

## Getting started

To use NaNofuzz in your own projects: 

- **Step 1**: Add the NaNofuzz dev dependency
    - **npm**: `npm i @nanofuzz/runtime -D`
    - **yarn**: `yarn add @nanofuzz/runtime -D`
- **Step 2**: Add the NaNofuzz extension to your repo's `./.vscode/settings.json` recommendations:
    ```
    {
        "recommendations": [
            "penrose.nanofuzz"
        ]
    }
    ```

> **Note:** To run NaNofuzz tests in CI, click the pin button. NaNofuzz exports pinned tests to Jest format for execution in CI.

## Scope and Limitations

NaNofuzz is an **experimental** testing platform developed by the Accelerated Testing Research Program at Carnegie Mellon University's School of Computer Science. While NaNofuzz is **not** intended for production use, contributions are welcome to address the limitations below. 

NaNofuzz supports exported standard and arrow functions with any mixture of the following parameter types:
 - Numbers (integers and floats, signed and unsigned)
 - Strings
 - Booleans
 - Literal object types
 - n-dimension arrays of any of the above
 - Optional and mandatory parameters

NaNofuzz automatically generates a test suite in these formats for use in CI:
 - Jest

The following are not yet supported:
 - Deconstructed types, Tuples, Enums, Generics, Function, and built-in (e.g., Record) types
 - Non-finite numeric inputs (`NaN`, `Infinity`), `bigint`, `null`
 - Class and object methods
 - Compiling to module formats other than CommonJS (see [VS Code issue 130367](https://github.com/microsoft/vscode/issues/130367))
 - Support for stateful, flaky, or non-deterministic tests
 - Sandboxing external side-effects, mocks, or stubs
 - Custom generators and filters
 - Test case minimization

If the NaNofuzz button does not appear above your function, that usually indicates that the function is not exported or one of its inputs is comprised of types that are not yet supported (see above).

## Contributing

We welcome outside contributions to address the limitations above and to correct open issues. 
Please see our [Contributor's Guide](https://github.com/nanofuzz/nanofuzz/blob/main/CONTRIBUTING.md) for more details about how you can get involved.

## NaNofuzz Research Paper

To reference NaNofuzz v0.1.x in your own research, please cite our ESEC/FSE'23 paper:

> Matthew C. Davis, Sangheon Choi, Sam Estep, Brad A. Myers, and Joshua Sunshine. **[NaNofuzz: A Usable Tool for Automatic Test Generation](https://dl.acm.org/doi/10.1145/3611643.3616327)**. In Proceedings of the 31st ACM Joint European Software Engineering Conference and Symposium on the Foundations of Software Engineering, 2023.

This paper covers the original implicit oracle version of NaNofuzz that introduced the "tab-and-grid" user interface for organizing test results.

## TerzoN Research Paper

To reference NaNofuzz v0.3.x ("TerzoN") in your own research, please cite our FSE'25 paper:

> Matthew C. Davis, Amy Wei, Brad A. Myers, and Joshua Sunshine. 2025. **[TerzoN: Human-in-the-loop Software Testing with a Composite Oracle](https://dl.acm.org/doi/abs/10.1145/3729359)**. Proceedings of the ACM on Software Engineering, 2, FSE, Article FSE089 (July 2025),

This paper covers the version of NaNofuzz that introduced the Composite Oracle, which features implicit, property-based, and example-based oracles, as well as the expanded "tab-and-grid" user interface.


## The NaNofuzz Mascot

Meet NaNcy, the Silky Anteater! Silky anteaters are wonderfully-adapted, small, fuzzy creatures known to find and consume large quantities of bugs on a daily basis. Therefore, NaNcy is NaNofuzz's beloved mascot on our journey to find and eliminate more bugs.

![image](https://avatars.githubusercontent.com/u/136026223?s=200&v=4)

## Trophy Case
If you find bugs with NaNofuzz and feel comfortable sharing them, we would be happy to add them to our list. 
Please send a PR for README.md with a link to the bug or CVE that you found.

- [RosettaCode Levenshtein distance](https://rosettacode.org/wiki/Levenshtein_distance?oldid=371462): returned `undefined` when `a===''`




