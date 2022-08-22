import { parentPort, workerData } from "worker_threads"; // !!!!
//import Worker from "web-worker"; // !!!!
import * as compiler from "./Compiler";
import { FuzzWorkerInput, FuzzWorkerOutput } from "./Types";

console.log("WebWorker: starting"); // !!!!
let id: number;
let isNode: boolean;

try {
  /* eslint eslint-comments/no-use: off */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-constant-condition
  isNode = Worker !== undefined ? false : true;
} catch {
  isNode = true;
}

if (isNode) {
  id = workerData.id;
  parentPort!.on("message", messageHandler);
} else {
  isNode = false;
  id = parseInt(self.name);
  addEventListener("message", messageHandler);
}

console.log(`WebWorker ${id}: started ${isNode ? "(node)" : "(browser)"}`); // !!!!

// !!!
function messageHandler(value: any): void {
  console.log(`client: message received: ${JSON.stringify(value)}`); // !!!!
  const payload: FuzzWorkerInput = "data" in value ? value.data : value;

  console.log(
    `WebWorker ${id}: executing fn: ${JSON.stringify(payload.fnRef)}`
  ); // !!!!
  const result: FuzzWorkerOutput = { timeout: false, output: undefined };

  try {
    result.output = run(payload.fnRef, payload.inputs);
    console.log(`WebWorker ${id}: done running fn`);
  } catch (e: any) {
    result.exception = e.message;
    console.log(`WebWorker ${id}: exception thrown: ${e.message}`); // !!!!
  }

  // !!!
  if (isNode) {
    parentPort!.postMessage(result);
  } else {
    postMessage(result);
  }
  console.log(`WebWorker ${id}: returned to client: ${JSON.stringify(result)}`); // !!!!
}

// !!!
function run(
  fnRef: any /*FunctionRef*/,
  inputs: any[] /*FuzzIoElement[]*/
): any | undefined {
  console.log(`WebWorker ${id}: running with input`); // !!!!

  // The module that includes the function to fuzz will
  // be a TypeScript source file, so we first must compile
  // it to JavaScript prior to execution.  This activates the
  // TypeScript compiler that hooks into the require() function.
  compiler.activate();

  // The fuzz target is likely under development, so invalidate
  // any cached copies to ensure we retrieve the latest copy.
  delete require.cache[require.resolve(fnRef.module)];

  console.log(`WebWorker ${id}: require user module`); // !!!!
  /* eslint eslint-comments/no-use: off */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(fnRef.module);
  console.log(`WebWorker ${id}: user module loaded`); // !!!!

  compiler.deactivate(); // Deactivate the TypeScript compiler

  // Ensure what we found is a function
  if (!(fnRef.name in mod))
    throw new Error(
      `Could not find exported function ${fnRef.name} in ${fnRef.module} to fuzz`
    );
  else if (typeof mod[fnRef.name] !== "function")
    throw new Error(
      `Cannot fuzz exported member '${fnRef.name} in ${fnRef.module} because it is not a function`
    );

  // Run the function with the inputs and return its value
  console.log(`WebWorker ${id}: running fn`); // !!!!
  return mod[fnRef.name](...inputs.map((e) => e.value)); // !!!!!
  /*
   })
    .catch((e: any) => {
      console.log("WebWorker: exception thrown in require: " + e.message); // !!!!
      parentPort!.postMessage(e);
    });
    */
}

export {}; // !!!!
