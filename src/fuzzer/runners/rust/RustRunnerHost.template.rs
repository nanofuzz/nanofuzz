use rmp_serde;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[allow(
    dead_code,
    unused_imports,
    unused_variables,
    unused_assignments,
    unused_mut,
    non_snake_case
)]
mod target {
    include!("/* __NANOFUZZ_TARGET_PATH__ */");
    /* __NANOFUZZ_SHIM__ */
}
#[allow(unused_imports)]
use target::*;

#[derive(Deserialize, Debug)]
struct RunnerInput {
    seq: i64,
    args: Vec<serde_json::Value>,
    repetitions: usize,
    timeout: u64,
    validators: Vec<String>,
    env: HashMap<String, String>,
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
enum RunnerResultItemPayload {
    #[serde(rename = "value")]
    Value {
        value: serde_json::Value,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        validators: Option<HashMap<String, ValidatorResult>>,
        #[serde(rename = "coverageData", skip_serializing_if = "Option::is_none")]
        coverage_data: Option<HashMap<String, nanofuzz_runtime::coverage::FileCoverage>>,
    },
    #[serde(rename = "skip")]
    Skip {
        message: String,
        #[serde(rename = "coverageData", skip_serializing_if = "Option::is_none")]
        coverage_data: Option<HashMap<String, nanofuzz_runtime::coverage::FileCoverage>>,
    },
    #[serde(rename = "timeout")]
    Timeout {
        #[serde(rename = "coverageData", skip_serializing_if = "Option::is_none")]
        coverage_data: Option<HashMap<String, nanofuzz_runtime::coverage::FileCoverage>>,
    },
}

#[derive(Serialize, Debug)]
struct RunnerResultPayload {
    results: Vec<RunnerResultItemPayload>,
    seq: i64,
}

fn write_msg(msg: &[u8]) -> io::Result<()> {
    let mut s = io::stdout().lock();
    s.write_all(&(msg.len() as u32).to_be_bytes())?;
    s.write_all(msg)?;
    s.flush()
}

use nanofuzz_runtime::block_on;

const MANIFEST: &[nanofuzz_runtime::coverage::FileCoverageSpec] = &[
    /* __NANOFUZZ_COVERAGE_MANIFEST__ */
];

#[no_mangle]
pub extern "C" fn __nanofuzz_hit_stmt(file_id: u32, id: u32) {
    nanofuzz_runtime::coverage::hit_stmt(file_id, id);
}

#[no_mangle]
pub extern "C" fn __nanofuzz_hit_fn(file_id: u32, id: u32) {
    nanofuzz_runtime::coverage::hit_fn(file_id, id);
}

#[no_mangle]
pub extern "C" fn __nanofuzz_hit_branch(file_id: u32, branch_id: u32, arm_id: u32) {
    nanofuzz_runtime::coverage::hit_branch(file_id, branch_id, arm_id);
}

fn main() -> io::Result<()> {
    // Suppress default panic printing to stderr so intentional fuzzer panics do not clutter output
    std::panic::set_hook(Box::new(|_| {}));

    // Send READY handshake message
    write_msg(&rmp_serde::to_vec("READY").unwrap())?;

    // Send initial static coverage metadata
    const STATIC_COV_JSON: &str = r#"/* __NANOFUZZ_STATIC_COV_JSON__ */"#;
    let static_cov: serde_json::Value =
        serde_json::from_str(STATIC_COV_JSON).unwrap_or(serde_json::Value::Null);
    write_msg(&rmp_serde::to_vec_named(&static_cov).unwrap())?;

    let mut stdin = io::stdin().lock();
    loop {
        let mut len_buf = [0u8; 4];
        if stdin.read_exact(&mut len_buf).is_err() {
            break;
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut payload = vec![0u8; len];
        stdin.read_exact(&mut payload)?;

        let input: RunnerInput = match rmp_serde::from_slice::<serde_json::Value>(&payload)
            .map_err(|e| format!("{}", e))
            .and_then(|v| serde_json::from_value(v).map_err(|e| format!("{}", e)))
        {
            Ok(v) => v,
            Err(e) => {
                let resp = RunnerResultPayload {
                    results: vec![RunnerResultItemPayload::Error {
                        name: "PayloadDeserializationError".to_string(),
                        message: format!("Failed to deserialize runner payload: {}", e),
                        source: "put",
                        validators: None,
                        coverage_data: None,
                    }],
                    seq: -1,
                };
                write_msg(&rmp_serde::to_vec_named(&resp).unwrap())?;
                continue;
            }
        };

        // Propagate dynamic environment variables (e.g. NANOFUZZ_PROVENANCE)
        for (k, v) in &input.env {
            unsafe {
                std::env::set_var(k, v);
            }
        }

        nanofuzz_runtime::coverage::reset();

        let call_res = catch_unwind(AssertUnwindSafe(|| -> Result<Vec<serde_json::Value>, String> {
            let mut values = Vec::with_capacity(input.repetitions);
            for _ in 0..input.repetitions {
                /* __NANOFUZZ_ARG_CONVERSIONS__ */
                let json_val = {
                    /* __NANOFUZZ_FN_CALL__ */
                };
                values.push(json_val);
            }
            Ok(values)
        }));

        let response = match call_res {
            Ok(Ok(values)) => {
                let mut results = Vec::new();
                if input.repetitions > 1 {
                    for v in values {
                        results.push(RunnerResultItemPayload::Value {
                            value: v,
                            validators: None,
                            coverage_data: None,
                        });
                    }
                } else {
                    /* __NANOFUZZ_VALIDATORS__ */
                    let val = values.into_iter().next().unwrap_or(serde_json::Value::Null);
                    results.push(RunnerResultItemPayload::Value {
                        value: val,
                        validators: validators_res,
                        coverage_data: None,
                    });
                }
                let cov_data = Some(nanofuzz_runtime::coverage::take_multi_hits(MANIFEST));
                if !results.is_empty() {
                    match &mut results[0] {
                        RunnerResultItemPayload::Value { coverage_data, .. }
                        | RunnerResultItemPayload::Error { coverage_data, .. }
                        | RunnerResultItemPayload::Skip { coverage_data, .. }
                        | RunnerResultItemPayload::Timeout { coverage_data } => {
                            *coverage_data = cov_data;
                        }
                    }
                }
                RunnerResultPayload {
                    results,
                    seq: input.seq,
                }
            }
            Ok(Err(_deser_err)) => {
                continue;
            }
            Err(panic_err) => {
                let cov_data = Some(nanofuzz_runtime::coverage::take_multi_hits(MANIFEST));
                if let Some(assump) =
                    panic_err.downcast_ref::<nanofuzz_runtime::UnsatisfiedAssumption>()
                {
                    RunnerResultPayload {
                        results: vec![RunnerResultItemPayload::Skip {
                            message: assump.message.clone(),
                            coverage_data: cov_data,
                        }],
                        seq: input.seq,
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
                    RunnerResultPayload {
                        results: vec![RunnerResultItemPayload::Error {
                            name: "Panic".to_string(),
                            message: msg,
                            source: "put",
                            validators: None,
                            coverage_data: cov_data,
                        }],
                        seq: input.seq,
                    }
                }
            }
        };

        let msg_bytes = match rmp_serde::to_vec_named(&response) {
            Ok(bytes) => bytes,
            Err(e) => {
                let err_resp = RunnerResultPayload {
                    results: vec![RunnerResultItemPayload::Error {
                        name: "SerializationError".to_string(),
                        message: format!("Serialization failure: {}", e),
                        source: "host",
                        validators: None,
                        coverage_data: None,
                    }],
                    seq: input.seq,
                };
                rmp_serde::to_vec_named(&err_resp).unwrap_or_default()
            }
        };
        write_msg(&msg_bytes)?;
    }

    Ok(())
}
