use nanofuzz_runtime::{assume, UnsatisfiedAssumption};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[test]
fn test_assume_truthy() {
    assert!(assume(true, None));
    assert!(assume(true, Some("should not panic")));
    assert!(assume!(1 > 0));
    assert!(assume!(2 + 2 == 4, "math must work"));
    assert!(assume!(5 > 0, "val {} must be > 0", 5));
}

#[test]
fn test_assume_falsy_default_message() {
    let result = catch_unwind(AssertUnwindSafe(|| {
        assume(false, None);
    }));

    assert!(result.is_err());
    let err = result.unwrap_err();
    let assumption_err = err.downcast_ref::<UnsatisfiedAssumption>();
    assert!(assumption_err.is_some());
    assert_eq!(assumption_err.unwrap().message, "Unsatisfied assumption");
}

#[test]
fn test_assume_falsy_custom_message() {
    let result = catch_unwind(AssertUnwindSafe(|| {
        assume(false, Some("n cannot be negative"));
    }));

    assert!(result.is_err());
    let err = result.unwrap_err();
    let assumption_err = err.downcast_ref::<UnsatisfiedAssumption>();
    assert!(assumption_err.is_some());
    assert_eq!(assumption_err.unwrap().message, "n cannot be negative");
}

#[test]
fn test_assume_macro_formatting() {
    let x = -5;
    let result = catch_unwind(AssertUnwindSafe(|| {
        assume!(x > 0, "x was {}, expected positive", x);
    }));

    assert!(result.is_err());
    let err = result.unwrap_err();
    let assumption_err = err.downcast_ref::<UnsatisfiedAssumption>();
    assert!(assumption_err.is_some());
    assert_eq!(
        assumption_err.unwrap().message,
        "x was -5, expected positive"
    );
}
