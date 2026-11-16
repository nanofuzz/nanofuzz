# NaNofuzz runtime support library for OCaml / OxCaml

This library provides the runtime support and types necessary for NaNofuzz tests to be executed in OCaml and OxCaml outside of Visual Studio Code; e.g., in CI or `dune runtest`.

To install the dependency in your Dune project, add to your `dune` file:

```dune
(library
 (name my_lib)
 (libraries nanofuzz_runtime))
```
