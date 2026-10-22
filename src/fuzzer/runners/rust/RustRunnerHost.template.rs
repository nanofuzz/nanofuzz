use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[allow(dead_code, unused_imports, unused_variables, non_snake_case)]
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
    },
    #[serde(rename = "error")]
    Error {
        name: String,
        message: String,
        source: &'static str,
        seq: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        validators: Option<HashMap<String, ValidatorResult>>,
    },
    #[serde(rename = "skip")]
    Skip { message: String, seq: i64 },
}

fn write_msg(msg: &[u8]) -> io::Result<()> {
    let mut s = io::stdout().lock();
    s.write_all(&(msg.len() as u32).to_be_bytes())?;
    s.write_all(msg)?;
    s.flush()
}

fn main() -> io::Result<()> {
    // Suppress default panic printing to stderr so intentional fuzzer panics do not clutter output
    std::panic::set_hook(Box::new(|_| {}));

    // Send READY handshake message
    write_msg(&serde_json::to_vec("READY").unwrap())?;

    // Send initial coverage placeholder
    write_msg(&serde_json::to_vec(&serde_json::json!({})).unwrap())?;

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
                };
                write_msg(&serde_json::to_vec(&resp).unwrap())?;
                continue;
            }
        };

        /* __NANOFUZZ_ARG_CONVERSIONS__ */

        let call_res = catch_unwind(AssertUnwindSafe(|| {
            /* __NANOFUZZ_FN_CALL__ */
            json_val
        }));

        let response = match call_res {
            Ok(json_val) => {
                /* __NANOFUZZ_VALIDATORS__ */
                RunnerResultPayload::Value {
                    value: json_val,
                    seq: input.seq,
                    validators: validators_res,
                }
            }
            Err(panic_err) => {
                if let Some(assump) =
                    panic_err.downcast_ref::<nanofuzz_runtime::UnsatisfiedAssumption>()
                {
                    RunnerResultPayload::Skip {
                        message: assump.message.clone(),
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
                    RunnerResultPayload::Error {
                        name: "Panic".to_string(),
                        message: msg,
                        source: "put",
                        seq: input.seq,
                        validators: None,
                    }
                }
            }
        };

        write_msg(&serde_json::to_vec(&response).unwrap())?;
    }

    Ok(())
}
