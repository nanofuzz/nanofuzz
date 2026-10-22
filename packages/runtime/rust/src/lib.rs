use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current version of the nanofuzz-runtime crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Result of a single fuzzer execution passed to property validator functions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FuzzTestResult {
    /// Ordered list of input arguments passed to the function under test.
    #[serde(rename = "in")]
    pub inputs: Vec<Value>,

    /// Return value produced by the function under test (or Null if void / exception).
    pub out: Value,

    /// True if the function under test threw an uncaught exception or panicked.
    pub exception: bool,

    /// True if the function execution exceeded the allocated timeout.
    pub timeout: bool,
}

impl FuzzTestResult {
    /// Constructs a new `FuzzTestResult`.
    pub fn new(inputs: Vec<Value>, out: Value, exception: bool, timeout: bool) -> Self {
        Self {
            inputs,
            out,
            exception,
            timeout,
        }
    }

    /// Deserializes the input argument at `index` into type `T`.
    pub fn get_in<T: for<'de> Deserialize<'de>>(
        &self,
        index: usize,
    ) -> Result<T, serde_json::Error> {
        match self.inputs.get(index) {
            Some(val) => serde_json::from_value(val.clone()),
            None => Err(serde::de::Error::custom(format!(
                "Input argument index {} out of bounds (len: {})",
                index,
                self.inputs.len()
            ))),
        }
    }

    /// Deserializes the function return value into type `T`.
    pub fn get_out<T: for<'de> Deserialize<'de>>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_value(self.out.clone())
    }

    /// Returns a reference to the raw JSON value of the input at `index`.
    pub fn input(&self, index: usize) -> Option<&Value> {
        self.inputs.get(index)
    }

    /// Returns a reference to the raw JSON value of the output.
    pub fn output(&self) -> &Value {
        &self.out
    }
}

/// Outcome of a property validator evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidatorResult {
    Pass,
    Fail,
    Unknown,
}

impl ValidatorResult {
    /// Returns the lowercase string representation ("pass", "fail", or "unknown").
    pub fn as_str(&self) -> &'static str {
        match self {
            ValidatorResult::Pass => "pass",
            ValidatorResult::Fail => "fail",
            ValidatorResult::Unknown => "unknown",
        }
    }
}

impl From<bool> for ValidatorResult {
    fn from(b: bool) -> Self {
        if b {
            ValidatorResult::Pass
        } else {
            ValidatorResult::Fail
        }
    }
}

impl From<&str> for ValidatorResult {
    fn from(s: &str) -> Self {
        match s {
            "pass" => ValidatorResult::Pass,
            "fail" => ValidatorResult::Fail,
            _ => ValidatorResult::Unknown,
        }
    }
}

/// Error / panic payload raised when an assumption in an input transformer is not satisfied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsatisfiedAssumption {
    pub message: String,
}

impl UnsatisfiedAssumption {
    /// Creates a new `UnsatisfiedAssumption` with the given message.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for UnsatisfiedAssumption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Unsatisfied assumption: {}", self.message)
    }
}

impl std::error::Error for UnsatisfiedAssumption {}

/// Evaluates condition for truthiness. If condition is true, returns true.
/// If condition is false, panics with `UnsatisfiedAssumption` to signal to NaNofuzz
/// that this input should be filtered out.
pub fn assume(condition: bool, message: Option<&str>) -> bool {
    if !condition {
        let msg = message.unwrap_or("Unsatisfied assumption");
        std::panic::panic_any(UnsatisfiedAssumption::new(msg));
    }
    true
} // fn: assume

/// Macro equivalent to `assume(condition, ...)`.
///
/// Usage:
/// ```
/// use nanofuzz_runtime::assume;
///
/// assume!(1 > 0);
/// assume!(2 + 2 == 4, "Math must work");
/// assume!(5 > 0, "Value {} must be positive", 5);
/// ```
#[macro_export]
macro_rules! assume {
    ($cond:expr $(,)?) => {
        $crate::assume($cond, None)
    };
    ($cond:expr, $($arg:tt)+) => {
        $crate::assume($cond, Some(&format!($($arg)+)))
    };
}
