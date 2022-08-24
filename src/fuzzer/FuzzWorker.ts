import { FuzzWorkerOutput, FuzzWorkerMessage } from "./Types";
import { WorkerServer } from "./WorkerServer";

console.log("WebWorker startup..."); // !!!!

const server = new WorkerServer(); // !!!
const id = server.getId(); // !!!
const module = { exports: {} }; // !!!

console.log(
  `WebWorker ${id}: started (mode: ${
    WorkerServer.isNode() ? "node" : "browser"
  })`
); // !!!

// !!!
// !!! Important Note: we lack vscode API access in subworkers
server.addEventListener("message", (message: any): void => {
  console.log(`WebWorker ${id}: message received: ${JSON.stringify(message)}`); // !!!!
  const fuzzMessage: FuzzWorkerMessage = message;

  // !!!
  switch (fuzzMessage.tag) {
    // !!!
    case "code": {
      module.exports = {};
      new Function("exports", "module", `${fuzzMessage.code}`).call(
        global,
        module.exports,
        module
      );
      break;
    } // case: code

    // !!!
    case "input": {
      if (Object.keys(module.exports).length === 0) {
        throw new Error(
          `WebWorker ${id}: received input before receiving code`
        );
      }
      console.log(
        `WebWorker ${id}: executing fn: ${JSON.stringify(
          fuzzMessage.input.fnRef
        )}`
      ); // !!!!
      const result: FuzzWorkerOutput = { timeout: false, output: undefined };

      try {
        result.output = run(fuzzMessage.input.fnRef, fuzzMessage.input.inputs);
        console.log(`WebWorker ${id}: done running fn`);
      } catch (e: any) {
        result.exception = e.message;
        console.log(`WebWorker ${id}: exception thrown: ${e.message}`); // !!!!
      }

      /// !!!
      server.postMessage({ tag: "output", output: result });

      console.log(
        `WebWorker ${id}: returned to client: ${JSON.stringify(result)}`
      ); // !!!!          break;
    } // case: input
  } // !!!

  // !!!! const payload: FuzzWorkerInput = "data" in message ? message.data : message;
}); // switch: fuzzMessage.tag

// !!!
function run(
  fnRef: any /*FunctionRef*/,
  inputs: any[] /*FuzzIoElement[]*/
): any | undefined {
  console.log(`WebWorker ${id}: running ${fnRef.name}() with input`); // !!!!

  // The module that includes the function to fuzz will
  // be a TypeScript source file, so we first must compile
  // it to JavaScript prior to execution.  This activates the
  // TypeScript compiler that hooks into the require() function.
  // !!!!compiler.activate();

  //console.log(`WebWorker ${id}: require user module`); // !!!!
  /* eslint eslint-comments/no-use: off */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // !!!const mod = require(fnRef.module); // !!!!
  console.log(`WebWorker ${id}: user module loaded: ${fnRef.module}`); // !!!!

  // !!!!compiler.deactivate(); // Deactivate the TypeScript compiler

  // Ensure what we found is a function
  if (!(fnRef.name in module.exports))
    throw new Error(
      `Could not find exported function ${fnRef.name} in ${fnRef.module} to fuzz`
    );
  else if (typeof module.exports[fnRef.name] !== "function")
    throw new Error(
      `Cannot fuzz exported member '${fnRef.name} in ${fnRef.module} because it is not a function`
    );

  // Run the function with the inputs and return its value
  console.log(`WebWorker ${id}: running fn`); // !!!!
  return module.exports[fnRef.name](...inputs.map((e) => e.value)); // !!!!!
  /*
   })
    .catch((e: any) => {
      console.log("WebWorker: exception thrown in require: " + e.message); // !!!!
      parentPort!.postMessage(e);
    });
    */
}
