import importlib.util, json5, sys, os, io, struct
from contextlib import redirect_stdout

filename: str
fnname: str

def loadPythonFn(filename: str, modulename: str, fn: str):
    # Import module
    spec = importlib.util.spec_from_file_location(modulename, filename)
    if spec is None:
        raise ImportError(f"Could not load python module: {filename}")
    module = importlib.util.module_from_spec(spec)

    # Add to sys.modules and load
    sys.modules[modulename] = module
    spec.loader.exec_module(module)
    
    # Return the imported module function
    if hasattr(module, fnname):
        return getattr(module, fnname)
    else:
        raise ImportError(f"Function '{fnname}' not found in {filename}")

def send_msg(data):
    msg = json5.dumps(data).encode('utf-8')
    # 4-byte length prefix followed by the data
    sys.stdout.buffer.write(struct.pack('>I', len(msg)))
    sys.stdout.buffer.write(msg)
    sys.stdout.buffer.flush()

def run_loop():
    while True:
        # Read the 4-byte length header
        header = sys.stdin.buffer.read(4)
        if not header: break
        length = struct.unpack('>I', header)[0]

        # Read exactly that many bytes
        payload = sys.stdin.buffer.read(length).decode('utf-8')
        
        # De-serialize arguments for calling the function
        args = json5.loads(payload)
        stdout_buf = io.StringIO()
        try:
            with redirect_stdout(stdout_buf):
                output = fn(*args)
            send_msg({"stdout": stdout_buf.getvalue(), "output": output})
        except Exception as e:
            send_msg({"error": str(e), "source": "put"})

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python PythonRunnerHost.py <filename.py> <moduile_name> <function_name> <function_arg_1> ... <function_arg_n>")
        sys.exit(1)

    # Arguments for loading the function
    filename = sys.argv[1]
    modulename = sys.argv[2]
    fnname = sys.argv[3]

    stdoutLoad = io.StringIO()
    with redirect_stdout(stdoutLoad):
        fn = loadPythonFn(filename, modulename, fnname)
    
    # Change cwd from the extension to that of the Python script
    os.chdir(os.path.dirname(filename))

    # Wait for inputs
    run_loop()
