import importlib.util
import json5
import sys
import os
import io
import struct
import logging
import traceback
from contextlib import redirect_stdout
from typing import Any, Literal, List, Union, TypedDict, NotRequired


class RunnerInput(TypedDict):
    args: List[any]
    seq: int


class RunnerValueResult(TypedDict):
    tag: Literal["value"]
    value: Any
    seq: int


class RunnerErrorResult(TypedDict):
    tag: Literal["error"]
    name: str
    message: str
    stack: NotRequired[str]
    source: Literal["put", "host"]
    seq: int


type RunnerResult = Union[RunnerValueResult, RunnerErrorResult]


def loadPythonFn(filename: str, modulename: str, fn: str) -> Union[RunnerErrorResult, None]:
    spec = importlib.util.spec_from_file_location(modulename, filename)
    if spec is None:
        return [RunnerErrorResult(
            tag="error",
            name="PythonRunnerHostError",
            message=f"Could not import python module: {filename}",
            source="host",
            seq=-1
        ), None]
    module = importlib.util.module_from_spec(spec)

    try:
        sys.modules[modulename] = module
        with redirect_stdout(io.StringIO()) as f:
            spec.loader.exec_module(module)
        return [None, getattr(module, fnname)]
    except Exception as e:
        return [RunnerErrorResult(
            tag="error",
            name="PythonPutLoadError",
            message=str(e),
            source="put",
            stack=traceback.format_exc(),
            seq=-1
        ), None]


def get_inputs() -> RunnerInput:
    logging.debug("Waiting for input")
    while True:
        # Read the 4-byte length header
        header = sys.stdin.buffer.read(4)
        if not header:
            break
        length = struct.unpack('>I', header)[0]
        logging.debug(f" - Incoming input of length {length}")

        # Read exactly that many bytes
        payload = sys.stdin.buffer.read(length).decode('utf-8')
        logging.debug(f" - With value {payload}")

        # De-serialize arguments for calling the function
        input: RunnerInput = json5.loads(payload)
        logging.debug(f" - Parsed ok")

        return input


def run_put(input: RunnerInput) -> RunnerResult:
    logging.debug(f"Running function '{fnname}' for {input}")
    try:
        with redirect_stdout(io.StringIO()) as f:
            return RunnerValueResult(tag="value", value=fn(*input["args"]), seq=input["seq"])
    except Exception as e:
        return RunnerErrorResult(
            tag="error",
            name="PythonPutError",
            message=str(e),
            source="put",
            stack=traceback.format_exc(),
            seq=input["seq"]
        )


def put_result(result: RunnerResult) -> None:
    logging.debug(f"Returning result")
    send_msg(result)
    logging.debug(f" - Result returned")


def send_msg(data: RunnerResult):
    msg = json5.dumps(data).encode('utf-8')
    logging.debug(f" - Writing {len(msg)} bytes: {msg}")
    sys.stdout.buffer.write(struct.pack(
        '>I', len(msg)))  # payload size
    sys.stdout.buffer.write(msg)  # payload
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    logging.basicConfig(filename='debug.log',
                        level=logging.DEBUG)  # !!!!!!!!!!

    if len(sys.argv) != 4:
        print(
            "Usage: python PythonRunnerHost.py <filename.py> <module_name> <function_name>")
        sys.exit(2)

    # Arguments for loading the function
    filename = sys.argv[1]
    modulename = sys.argv[2]
    fnname = sys.argv[3]

    # Try to load the function: either results in a RunnerErrorResult
    # or a callable function
    logging.debug(f"Loading function '{fnname}' in {filename}")
    [loadError, fn] = loadPythonFn(filename, modulename, fnname)
    if (loadError):
        logging.debug(" - Unable to load")
    else:
        logging.debug(" - Loaded function")

    # Change cwd from the extension to that of the Python script
    os.chdir(os.path.dirname(filename))

    # Ready for inputs
    msg = "READY".encode('utf-8')
    sys.stdout.buffer.write(msg)
    sys.stdout.buffer.flush()
    logging.debug(f"Sent READY message (length {len(msg)})")

    # Start the run loop
    while True:
        logging.debug("Top of main loop")
        if (loadError == None):
            put_result(run_put(get_inputs()))  # Call the put
        else:
            get_inputs()
            put_result(loadError)  # Return the load error
