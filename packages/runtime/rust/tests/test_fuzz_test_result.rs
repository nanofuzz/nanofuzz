use nanofuzz_runtime::{FuzzTestResult, ValidatorResult, VERSION};
use serde_json::json;

#[test]
fn test_version_exported() {
    assert!(!VERSION.is_empty());
}

#[test]
fn test_fuzz_test_result_accessors() {
    let result = FuzzTestResult::new(
        vec![json!(42), json!("hello"), json!(vec![1, 2, 3])],
        json!(84.5),
        false,
        false,
    );

    let first_arg: i32 = result.get_in(0).expect("failed to decode arg 0");
    assert_eq!(first_arg, 42);

    let second_arg: String = result.get_in(1).expect("failed to decode arg 1");
    assert_eq!(second_arg, "hello");

    let third_arg: Vec<i32> = result.get_in(2).expect("failed to decode arg 2");
    assert_eq!(third_arg, vec![1, 2, 3]);

    let out: f64 = result.get_out().expect("failed to decode output");
    assert_eq!(out, 84.5);

    assert_eq!(result.input(0), Some(&json!(42)));
    assert_eq!(result.input(99), None);
    assert_eq!(result.output(), &json!(84.5));
    assert!(!result.exception);
    assert!(!result.timeout);
}

#[test]
fn test_fuzz_test_result_serde_roundtrip() {
    let raw_json = r#"{
        "in": [10, "test"],
        "out": true,
        "exception": false,
        "timeout": false
    }"#;

    let res: FuzzTestResult = serde_json::from_str(raw_json).expect("failed to deserialize");
    assert_eq!(res.get_in::<i32>(0).unwrap(), 10);
    assert_eq!(res.get_in::<String>(1).unwrap(), "test");
    assert!(res.get_out::<bool>().unwrap());

    let serialized = serde_json::to_string(&res).expect("failed to serialize");
    assert!(serialized.contains("\"in\":[10,\"test\"]"));
    assert!(serialized.contains("\"out\":true"));
}

#[test]
fn test_validator_result() {
    assert_eq!(ValidatorResult::Pass.as_str(), "pass");
    assert_eq!(ValidatorResult::Fail.as_str(), "fail");
    assert_eq!(ValidatorResult::Unknown.as_str(), "unknown");

    assert_eq!(ValidatorResult::from(true), ValidatorResult::Pass);
    assert_eq!(ValidatorResult::from(false), ValidatorResult::Fail);

    assert_eq!(ValidatorResult::from("pass"), ValidatorResult::Pass);
    assert_eq!(ValidatorResult::from("fail"), ValidatorResult::Fail);
    assert_eq!(ValidatorResult::from("other"), ValidatorResult::Unknown);
}

#[test]
fn test_implicit_oracle() {
    use nanofuzz_runtime::implicit_oracle;

    assert!(implicit_oracle(&42));
    assert!(implicit_oracle(&"hello"));
    assert!(implicit_oracle(&vec![1, 2, 3]));
    assert!(implicit_oracle(&Some(100)));

    assert!(!implicit_oracle(&f64::NAN));
    assert!(!implicit_oracle(&f64::INFINITY));
    assert!(!implicit_oracle(&-f64::INFINITY));
    assert!(!implicit_oracle(&Option::<i32>::None));
    assert!(!implicit_oracle(&vec![Some(1), None]));
}

#[test]
fn test_block_on() {
    use nanofuzz_runtime::block_on;

    let res = block_on(async {
        let a = 10;
        let b = 20;
        a + b
    });
    assert_eq!(res, 30);
}

