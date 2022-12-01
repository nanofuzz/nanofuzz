# NaNofuzz
NaNofuzz is a fast, easy-to-use automatic test suite generation tool for Typescript that integrates with a developer's VS Code workflow.  We like working code, and NaNofuzz is designed to be used during initial development to more quickly reach working code nirvana while avoiding regressions.  NaNofuzz is available in the [the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=penrose.nanofuzz).

![image](https://user-images.githubusercontent.com/22134678/198139136-20a7105b-29e1-435e-8ba6-2e1b92ff3bed.png)

Unlike some past automatic test suite generation tools, NaNofuzz takes an approach similar to fuzzing and uses a simple implicit oracle to determine whether or not a given test passes. Surprisingly, this approach quickly finds many errors! NaNofuzz marks a test as failed if it:
 - throws a runtime exception
 - returns null, NaN, Infinity, or undefined
 - does not terminate within a configurable period of time

These design choices allow NaNofuzz to be fast, lightweight, easy to integrate into an everyday workflow, and helps programmers quickly find important edge cases they may have missed.

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
 - Type references, deconstructed types, OR types, Tuples, Enums, Generics, or Function types
 - Non-finite numeric inputs (NaN, Infinity, null)
 - Object methods
 - Compiling to module formats other than CommonJS
 - Support for stateful tests
 - Sandboxing external side-effects
 - Custom generators, filters, and oracles

> **Note:**
>
> This is a research project not presently intended for production use. Contributions are welcome to address the limitations above.
