# NaNofuzz
NaNofuzz is a fast, easy-to-use automatic test suite generation tool for TypeScript that integrates with a developer's VS Code workflow.  We like working code, and NaNofuzz is designed to be used during testing or development to more quickly reach working code nirvana. NaNofuzz is available in the [the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=penrose.nanofuzz).

![NaNofuzz Screenshot](https://github.com/nanofuzz/nanofuzz/assets/22134678/0bb9ed51-1b07-46e4-8986-ae377055dfe7)

Unlike many automatic test suite generation tools, NaNofuzz combines multiple approaches to help you generate a test suite. You can define properties of the program similar to QuickCheck or Hypothesis, manually annotate the correctness or incorrectness of a program's output similar to Jest, or use an approach similar to fuzzing and let NaNofuzz automatically draw your attention to likely errors. 

Combining multiple approaches can help you quickly find errors and rapidly build a test suite. For example, without any guidance from you, NaNofuzz automatically draws your attention to a test if it:
 - throws a runtime exception
 - returns null, NaN, Infinity, or undefined
 - does not terminate within a configurable period of time

These design choices allow NaNofuzz to be fast, lightweight, flexible, easy to integrate into an everyday workflow, and help developers quickly find important edge cases more quickly.

NaNofuzz supports standard and arrow functions with any mixture of the following parameter types:
 - Numbers (integers and floats, signed and unsigne)
 - Strings
 - Booleans
 - Literal object types
 - n-dimension arrays of any of the above
 - Optional and mandatory parameters

NaNofuzz automatically generates a test suite in these formats for use in CI:
 - Jest

The following are not yet supported:
 - Deconstructed types, OR types, Tuples, Enums, Generics, or Function types
 - Non-finite numeric inputs (NaN, Infinity, null)
 - Class and object methods
 - Compiling to module formats other than CommonJS (see [VS Code issue 130367](https://github.com/microsoft/vscode/issues/130367))
 - Support for stateful, flaky, or non-deterministic tests
 - Sandboxing external side-effects, mocks, or stubs
 - Custom generators and filters
 - Test case minimization

 NaNofuzz is a research project not presently intended for production use. Contributions are welcome to address the limitations above.

### NaNofuzz Research Paper

To reference NaNofuzz in your research, we request you to cite our upcoming ESEC/FSE'23 paper:

> Matthew C. Davis, Sangheon Choi, Sam Estep, Brad A. Myers, and Joshua Sunshine. **NaNofuzz: A Usable Tool for Automatic Test Generation**. In Proceedings of the 31st ACM Joint European Software Engineering Conference and Symposium on the Foundations of Software Engineering, 2023. (accepted and pending publication; [pre-print](https://cmumatt.github.io/assets/NaNofuzz_2023.pdf))

### The NaNofuzz mascot

Meet Nancy, the Silky Anteater! Silky anteaters are wonderfully-adapted, small, fuzzy creatures known to find and consume large quantities of bugs on a daily basis. Therefore, Nancy (or, NaNcy, if you prefer) is NaNofuzz' beloved mascot on your journey to find bugs.

![image](https://avatars.githubusercontent.com/u/136026223?s=200&v=4)


