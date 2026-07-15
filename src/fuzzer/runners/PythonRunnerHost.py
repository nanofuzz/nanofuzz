import importlib.util
import json5
import sys
import os

filename: str
fnname: str

def loadPythonFn(filename: str, modulename: str, fn: str):
    """
    Loads a function from a Python module.
    """
    # Import module
    spec = importlib.util.spec_from_file_location(modulename, filename)
    if spec is None:
        raise ImportError(f"Could not load python module: {filename}")
    module = importlib.util.module_from_spec(spec)
    
    # Add to sys.modules and load
    sys.modules[modulename] = module
    spec.loader.exec_module(module)
    
    # return the function from the imported module
    if hasattr(module, fnname):
        return getattr(module, fnname)
    else:
        raise ImportError(f"Function '{fnname}' not found in {filename}")
    
if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python PythonRunnerHost.py <filename.py> <moduile_name> <function_name> <function_arg_1> ... <function_arg_n>")
        sys.exit(1)

    # Arguments for loading the function
    filename = sys.argv[1]
    modulename = sys.argv[2]
    fnname = sys.argv[3]
    
    # De-serialize arguments for calling the function
    args = [json5.loads(a) for a in sys.argv[4:]]
        
    fn = loadPythonFn(filename, modulename, fnname)
    
    try:
        print(f"cwd was: {os.getcwd()}")
        os.chdir(os.path.dirname(filename))
        print(f"cwd now: {os.getcwd()}")
        output = json5.dumps(fn(*args))
        print(f"Result: {output}")
    except Exception as e:
        print(f"Error: {e}")
