/* Top-level header block comment
 * NaNofuzz test fixtures for Rust
 */

// Module-level import comment
use nanofuzz_runtime::{/* inline in import */ assume, FuzzTestResult};

// Line comment before greeting function
pub /* inline between pub and fn */ fn greeting(
    // Parameter comment
    name: /* parameter type */ String,
) -> /* return type prefix */ String {
    // Single line comment inside body
    /* Block comment inside body */
    format!(/* inline format string comment */ "Hello {}", name) // trailing comment
}

/*
 * Validator function with doc and block comments
 */
pub fn greetingValidator(/* argument comment */ r: &FuzzTestResult) -> &'static str {
    // Extract output
    let out: String = r.get_out().unwrap(); /* inline end of let */
    // Extract first input argument
    let name: String = r.get_in(0).unwrap();

    /* Comment before if condition */
    if out.ends_with(&name) {
        // Comment in then block
        "pass"
    } else {
        // Comment in else block
        "fail"
    }
}

// Function with panic
pub fn throws(n: /* arg int */ i32) -> i32 {
    /* check if greater than 10 */
    if n > 10 {
        // Panic branch
        panic!("input greater than 10 not allowed");
    }
    // Return expression
    n
}

/* Function with timeout loop */
pub fn timeouts(n: i32) -> i32 {
    // Condition check
    if n > 0 {
        /* Infinite loop block */
        loop {}
    }
    n
}

// Function with assume macro
pub fn with_assume(n: i32) -> i32 {
    /* Filter assumption */
    assume!(n != 5, /* message */ "n cannot be 5");
    n
}

/*
 * Input transformer test targets
 */
pub fn rs_transformed(n: i32) -> i32 {
    // Simple add
    n + 1
}

pub fn rs_transformedTransformer(n: i32) -> (i32,) {
    // Transformer assumption filter
    assume!(n != 5, "Transformer skipped n=5");
    /* Return tuple */
    (n * 10,)
}

// Custom user input generator target
pub fn rs_user_gen(n: i32, s: String) -> String {
    // Format combination
    format!("{}:{}", s, n)
}

pub fn rs_user_genGenerator(mut prng: impl FnMut() -> f64) -> Option<(i32, String)> {
    /* Random number generator invocation */
    let n = (prng() * 100.0) as i32;
    // Return generated pair
    Some((n, "custom".to_string()))
}

/* Asynchronous function target */
pub async fn async_greeting(name: String) -> String {
    // Async greeting message
    format!("Hello {}", name)
}

pub fn async_greetingValidator(_r: &FuzzTestResult) -> &'static str {
    /* Constant pass validator */
    "pass"
}

// Unexported helper function
fn unexported_helper(x: i32) -> i32 {
    /* Double value */
    x * 2
}

