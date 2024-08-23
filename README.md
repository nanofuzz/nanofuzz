# NaNofuzz

NaNofuzz is a fast and easy-to-use Automatic Test sUite Generator (ATUG) for TypeScript that implements a Gradual Oracle, which uses human insight, heuristics, and property checking to help you quickly reach working code nirvana. NaNofuzz is intended to be used during testing and development and is available in the [the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=penrose.nanofuzz).

![NaNofuzz Screenshot](https://github.com/user-attachments/assets/7655c0c7-96ee-4251-b383-77023c68f3da)

NaNofuzz' unique Gradual Oracle proposes an initial test suite with a single button click. You interactively improve this this initial test suite by manually annotating the correctness of specific examples and by adding property validator functions that evaluate correctness at scale. NaNofuzz coherently organizes and prioritizes all test results on a single screen so that you can see at a glance what your suite is testing---as well as what it may be missing.

### The Details

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

NaNofuzz is a experimental testing platform developed by the Accelerated Testing Research program at Carnegie Mellon University's School of Computer Science. As an experimental tool, NaNofuzz is not presently intended for production use. Contributions are welcome to address the limitations above.

### NaNofuzz Research Paper

To reference NaNofuzz in your own research, please cite our ESEC/FSE'23 paper:

> Matthew C. Davis, Sangheon Choi, Sam Estep, Brad A. Myers, and Joshua Sunshine. **[NaNofuzz: A Usable Tool for Automatic Test Generation](https://dl.acm.org/doi/10.1145/3611643.3616327)**. In Proceedings of the 31st ACM Joint European Software Engineering Conference and Symposium on the Foundations of Software Engineering, 2023.

The paper above covers the 0.1.x version of NaNofuzz. A lot has changed since then, and we plan to publish new papers soon!

### The NaNofuzz Mascot

Meet NaNcy, the Silky Anteater! Silky anteaters are wonderfully-adapted, small, fuzzy creatures known to find and consume large quantities of bugs on a daily basis. Therefore, NaNcy is NaNofuzz' beloved mascot on the journey to find and eliminate more bugs.

![image](https://avatars.githubusercontent.com/u/136026223?s=200&v=4)


