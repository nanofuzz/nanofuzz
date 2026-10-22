use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[allow(
    dead_code,
    unused_imports,
    unused_variables,
    unused_assignments,
    non_snake_case
)]
mod target {
    include!("/* __NANOFUZZ_TARGET_PATH__ */");
}

#[derive(Deserialize, Debug)]
struct RunnerInput {
    seq: i64,
    #[serde(default)]
    args: Vec<serde_json::Value>,
    #[serde(default)]
    validators: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(tag = "tag")]
enum ValidatorResult {
    #[serde(rename = "value")]
    Value { value: serde_json::Value },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "skip")]
    Skip { message: String },
}

#[derive(Serialize, Debug)]
#[serde(tag = "tag")]
enum RunnerResultPayload {
    #[serde(rename = "value")]
    Value {
        value: serde_json::Value,
        seq: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        validators: Option<HashMap<String, ValidatorResult>>,
        #[serde(rename = "coverageData", skip_serializing_if = "Option::is_none")]
        coverage_data: Option<HashMap<String, nanofuzz_runtime::coverage::FileCoverage>>,
    },
    #[serde(rename = "error")]
    Error {
        name: String,
        message: String,
        source: &'static str,
        seq: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        validators: Option<HashMap<String, ValidatorResult>>,
        #[serde(rename = "coverageData", skip_serializing_if = "Option::is_none")]
        coverage_data: Option<HashMap<String, nanofuzz_runtime::coverage::FileCoverage>>,
    },
    #[serde(rename = "skip")]
    Skip {
        message: String,
        seq: i64,
        #[serde(rename = "coverageData", skip_serializing_if = "Option::is_none")]
        coverage_data: Option<HashMap<String, nanofuzz_runtime::coverage::FileCoverage>>,
    },
}

fn write_msg(msg: &[u8]) -> io::Result<()> {
    let mut s = io::stdout().lock();
    s.write_all(&(msg.len() as u32).to_be_bytes())?;
    s.write_all(msg)?;
    s.flush()
}

const TARGET_PATH: &str = r#"/* __NANOFUZZ_REAL_PATH__ */"#;
const BRANCH_ARMS: &[(u32, usize)] = &[/* __NANOFUZZ_BRANCH_ARMS__ */];

fn main() -> io::Result<()> {
    // Suppress default panic printing to stderr so intentional fuzzer panics do not clutter output
    std::panic::set_hook(Box::new(|_| {}));

    // Send READY handshake message
    write_msg(&serde_json::to_vec("READY").unwrap())?;

    // Send initial static coverage metadata
    const STATIC_COV_JSON: &str = r#"/* __NANOFUZZ_STATIC_COV_JSON__ */"#;
    write_msg(STATIC_COV_JSON.as_bytes())?;

    let mut stdin = io::stdin().lock();
    loop {
        let mut len_buf = [0u8; 4];
        if stdin.read_exact(&mut len_buf).is_err() {
            break;
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut payload = vec![0u8; len];
        stdin.read_exact(&mut payload)?;

        let input: RunnerInput = match serde_json::from_slice(&payload) {
            Ok(v) => v,
            Err(e) => {
                let resp = RunnerResultPayload::Error {
                    name: "PayloadDeserializationError".to_string(),
                    message: format!("Failed to deserialize runner payload: {}", e),
                    source: "put",
                    seq: -1,
                    validators: None,
                    coverage_data: None,
                };
                write_msg(&serde_json::to_vec(&resp).unwrap())?;
                continue;
            }
        };

        nanofuzz_runtime::coverage::reset();

        /* __NANOFUZZ_ARG_CONVERSIONS__ */

        let call_res = catch_unwind(AssertUnwindSafe(|| {
            /* __NANOFUZZ_FN_CALL__ */
            json_val
        }));

        let cov = nanofuzz_runtime::coverage::take_hits(TARGET_PATH, BRANCH_ARMS);
        let cov_data = Some(HashMap::from([(TARGET_PATH.to_string(), cov)]));

        let response = match call_res {
            Ok(json_val) => {
                /* __NANOFUZZ_VALIDATORS__ */
                RunnerResultPayload::Value {
                    value: json_val,
                    seq: input.seq,
                    validators: validators_res,
                    coverage_data: cov_data,
                }
            }
            Err(panic_err) => {
                if let Some(assump) =
                    panic_err.downcast_ref::<nanofuzz_runtime::UnsatisfiedAssumption>()
                {
                    RunnerResultPayload::Skip {
                        message: assump.message.clone(),
                        seq: input.seq,
                        coverage_data: cov_data,
                    }
                } else {
                    let msg = panic_err
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| {
                            panic_err
                                .downcast_ref::<&'static str>()
                                .map(|s| s.to_string())
                        })
                        .unwrap_or_else(|| "panic".to_string());
                    RunnerResultPayload::Error {
                        name: "Panic".to_string(),
                        message: msg,
                        source: "put",
                        seq: input.seq,
                        validators: None,
                        coverage_data: cov_data,
                    }
                }
            }
        };

        write_msg(&serde_json::to_vec(&response).unwrap())?;
    }

    Ok(())
}
