# NaNofuzz runtime support crate

This crate provides the runtime support and types necessary for NaNofuzz tests to be executed outside of Visual Studio Code; e.g., in CI or `cargo test`.

To install the dependency in your Rust project, add to `Cargo.toml`:

```toml
[dev-dependencies]
nanofuzz-runtime = "0.4.1"
```
