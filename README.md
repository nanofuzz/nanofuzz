# NaNofuzz
NaNofuzz is a fast, easy-to-use automatic test suite generation tool for TypeScript that integrates with a developer's VS Code workflow.  We like working code, and NaNofuzz is designed to be used during testing or development to more quickly reach working code nirvana. NaNofuzz is available in the [the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=penrose.nanofuzz).

![image](https://user-images.githubusercontent.com/22134678/198139136-20a7105b-29e1-435e-8ba6-2e1b92ff3bed.png)

Unlike some past automatic test suite generation tools, NaNofuzz takes an approach similar to fuzzing and uses an implicit oracle to detect likely errors. Surprisingly, this approach can quickly find many errors and rapidly build a test suite. NaNofuzz draws your attention to a test if it:
 - throws a runtime exception
 - returns null, NaN, Infinity, or undefined
 - does not terminate within a configurable period of time

These design choices allow NaNofuzz to be fast, lightweight, easy to integrate into an everyday workflow, and help developers quickly find important edge cases more quickly.

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

### Who is the NaNofuzz mascot?

A very important question! Silky anteaters are wonderfully-adapted, small, fuzzy creatures known to find and consume large quantities of bugs. Therefore, the NaNofuzz mascot is Nancy the Silky Anteater (or, NaNcy, if you prefer).

![image](https://avatars.githubusercontent.com/u/136026223?s=200&v=4)


