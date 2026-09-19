import { parentPort } from "worker_threads";
import type {
  CompilerMessageToWorker,
  CompilerMessageFromWorker,
} from "./Types";
import * as CompilerFactory from "./CompilerFactory";
import { Instrumenter } from "./Instrumenter";
import { MeasureFactory } from "../measures/MeasureFactory";
import { isError } from "../Util";
import { TypescriptCompilerError } from "../Types";

console.debug("CompilerWorker started");

// Process messages from the main thread
parentPort?.on("message", processMessage);

function processMessage(message: CompilerMessageToWorker): void {
  switch (message.command) {
    case "prepare": {
      try {
        const compiler = CompilerFactory.fromSourcefile(message.module);
        if (!compiler) {
          throw new Error(`No compiler found for module: ${message.module}`);
        }
        const mod = compiler.compileSync((msg) => {
          if (msg.channel === "milestone") {
            console.log(msg.msg);
          }
        });

        const allMeasures = MeasureFactory("typescript");
        const measures =
          message.measures && message.measures.length > 0
            ? allMeasures.filter((m) => message.measures!.includes(m.name))
            : allMeasures;

        if (measures.length > 0) {
          Instrumenter.prepareInstrumentedTree(
            mod,
            compiler.getCompiledDependencies(),
            measures,
            compiler.options.tmpDir,
            (msg) => {
              if (msg.channel === "milestone") {
                console.log(msg.msg);
              }
            }
          );
        }

        const reply: CompilerMessageFromWorker = {
          command: "prepare.result",
          success: true,
          id: message.id,
        };
        parentPort?.postMessage(reply);
      } catch (e: unknown) {
        let reply: CompilerMessageFromWorker = {
          command: "prepare.result",
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
              `${e.name} during background preparation:`,
              e.message,
              e.stack ?? `<no stack>`,
            ];
          }
        } else {
          reply.output = [`Unknown error during preparation`];
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
