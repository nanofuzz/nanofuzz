import { parentPort } from "worker_threads";
import {
  TypeScriptCompiler,
  TypeScriptCompilerMessageToWorker,
  TypeScriptCompilerMessageFromWorker,
} from "./Compiler";
import { isError } from "./Util";
import { TscCompilerError } from "./Types";

console.debug("CompilerWorker started");

// Processes messages from the main thread
parentPort?.on("message", (message: TypeScriptCompilerMessageToWorker) => {
  switch (message.command) {
    case "compile": {
      const compiler = new TypeScriptCompiler(message.module);
      try {
        compiler.compileSync([], (msg) => {
          if (msg.milestone) {
            console.log(msg.msg);
          }
        });
        const reply: TypeScriptCompilerMessageFromWorker = {
          command: "compile.result",
          success: true,
          id: message.id,
        };
        parentPort?.postMessage(reply);
      } catch (e: unknown) {
        let reply: TypeScriptCompilerMessageFromWorker = {
          command: "compile.result",
          success: false,
          id: message.id,
        };
        if (isError(e)) {
          if (e instanceof TscCompilerError) {
            reply = {
              ...reply,
              ...e.details,
              output: [e.message, ...(e.details.output ?? [])],
            };
          } else {
            reply.output = [
              `${e.name} during background compilation:`,
              e.message,
              e.stack ?? `<no stack>`,
            ];
          }
        } else {
          reply.output = [`Unknown error during compilation`];
        }
        parentPort?.postMessage(reply);
      }
      break;
    }
  }
});
