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

/// In-process coverage tracking module used by NaNofuzz runner host.
pub mod coverage {
    use serde::{Deserialize, Serialize};
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// File coverage data matching Istanbul's FileCoverageData schema.
    #[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
    pub struct FileCoverage {
        pub path: String,
        pub s: HashMap<String, u32>,
        pub f: HashMap<String, u32>,
        pub b: HashMap<String, Vec<u32>>,
    }

    thread_local! {
        static HIT_STMTS: RefCell<Vec<(u32, u32)>> = const { RefCell::new(Vec::new()) };
        static HIT_FNS: RefCell<Vec<(u32, u32)>> = const { RefCell::new(Vec::new()) };
        static HIT_BRANCHES: RefCell<Vec<(u32, u32, u32)>> = const { RefCell::new(Vec::new()) };
    }

    /// Records execution of statement with index `id` in file `file_id`.
    #[inline(always)]
    pub fn hit_stmt(file_id: u32, id: u32) {
        HIT_STMTS.with(|s| s.borrow_mut().push((file_id, id)));
    }

    /// Records execution of function with index `id` in file `file_id`.
    #[inline(always)]
    pub fn hit_fn(file_id: u32, id: u32) {
        HIT_FNS.with(|f| f.borrow_mut().push((file_id, id)));
    }

    /// Records execution of branch with index `branch_id` and arm `arm_id` in file `file_id`.
    #[inline(always)]
    pub fn hit_branch(file_id: u32, branch_id: u32, arm_id: u32) {
        HIT_BRANCHES.with(|b| b.borrow_mut().push((file_id, branch_id, arm_id)));
    }

    /// Resets all recorded coverage hits across all files.
    pub fn reset() {
        HIT_STMTS.with(|s| s.borrow_mut().clear());
        HIT_FNS.with(|f| f.borrow_mut().clear());
        HIT_BRANCHES.with(|b| b.borrow_mut().clear());
    }

    /// Branch arms metadata: (branch_id, arm_count).
    pub type BranchArmSpec = (u32, usize);

    /// File specification in coverage manifest: (file_id, file_path, branch_arms).
    pub type FileCoverageSpec<'a> = (u32, &'a str, &'a [BranchArmSpec]);

    /// Takes the recorded coverage hits for multiple files described by `manifest`.
    /// Each element in `manifest` is `(file_id, file_path, branch_arms)`.
    pub fn take_multi_hits(manifest: &[FileCoverageSpec]) -> HashMap<String, FileCoverage> {
        let stmts = HIT_STMTS.with(|s| s.take());
        let fns = HIT_FNS.with(|f| f.take());
        let branches = HIT_BRANCHES.with(|b| b.take());

        let mut stmts_by_file: HashMap<u32, HashMap<String, u32>> = HashMap::new();
        for (fid, sid) in stmts {
            *stmts_by_file
                .entry(fid)
                .or_default()
                .entry(sid.to_string())
                .or_insert(0) += 1;
        }

        let mut fns_by_file: HashMap<u32, HashMap<String, u32>> = HashMap::new();
        for (fid, fnid) in fns {
            *fns_by_file
                .entry(fid)
                .or_default()
                .entry(fnid.to_string())
                .or_insert(0) += 1;
        }

        let mut branches_by_file: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
        for (fid, bid, arm) in branches {
            branches_by_file.entry(fid).or_default().push((bid, arm));
        }

        let mut result = HashMap::new();
        for &(fid, path, branch_arms) in manifest {
            let s = stmts_by_file.remove(&fid).unwrap_or_default();
            let f = fns_by_file.remove(&fid).unwrap_or_default();

            let mut b: HashMap<String, Vec<u32>> = HashMap::new();
            for (bid, arm_count) in branch_arms {
                b.insert(bid.to_string(), vec![0; *arm_count]);
            }
            if let Some(hits) = branches_by_file.remove(&fid) {
                for (bid, arm) in hits {
                    let key = bid.to_string();
                    if let Some(arms) = b.get_mut(&key) {
                        if let Some(slot) = arms.get_mut(arm as usize) {
                            *slot += 1;
                        }
                    }
                }
            }

            result.insert(
                path.to_string(),
                FileCoverage {
                    path: path.to_string(),
                    s,
                    f,
                    b,
                },
            );
        }

        result
    }

    /// Takes the recorded coverage hits for a specific file_id.
    pub fn take_file_hits(
        file_id: u32,
        file_path: &str,
        branch_arms: &[(u32, usize)],
    ) -> FileCoverage {
        let mut map = take_multi_hits(&[(file_id, file_path, branch_arms)]);
        map.remove(file_path).unwrap_or_else(|| FileCoverage {
            path: file_path.to_string(),
            ..Default::default()
        })
    }

    /// Takes the recorded coverage hits for a single file (file_id 0) and returns an Istanbul-compatible FileCoverage.
    pub fn take_hits(file_path: &str, branch_arms: &[(u32, usize)]) -> FileCoverage {
        take_file_hits(0, file_path, branch_arms)
    }
}
