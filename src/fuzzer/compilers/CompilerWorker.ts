import { parentPort } from "worker_threads";
import {
  TypescriptCompiler,
  TypeScriptCompilerMessageToWorker,
  TypescriptCompilerMessageFromWorker,
} from "./TypescriptCompiler";
import { isError } from "../../Util";
import { TypescriptCompilerError } from "../Types";

console.debug("CompilerWorker started");

// Process messages from the main thread
parentPort?.on("message", processMessage);

function processMessage(message: TypeScriptCompilerMessageToWorker): void {
  switch (message.command) {
    case "compile": {
      try {
        new TypescriptCompiler(message.module).compileSync([], (msg) => {
          if (msg.milestone) {
            console.log(msg.msg);
          }
        });
        const reply: TypescriptCompilerMessageFromWorker = {
          command: "compile.result",
          success: true,
          id: message.id,
        };
        parentPort?.postMessage(reply);
      } catch (e: unknown) {
        let reply: TypescriptCompilerMessageFromWorker = {
          command: "compile.result",
          success: false,
          id: message.id,
        };
        if (isError(e)) {
          if (e instanceof TypescriptCompilerError) {
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
    case "exit": {
      console.debug("CompilerWorker exiting");
      parentPort?.close();
    }
  }
} // fn: processMessage
