import * as vscode from "vscode";
import { WorkerClient } from "./WorkerClient";
import {
  FuzzIoElement,
  FuzzWorkerInputMessage,
  FuzzWorkerMessage,
  FuzzWorkerOutput,
} from "./Types";
import { FunctionRef } from "./analysis/typescript/Types";

// !!!
export class Runner {
  private _timeout: number; // !!!
  private _fnRef: FunctionRef; // !!!
  private _extensionUri: vscode.Uri; // !!!
  private _worker: WorkerClient | undefined; // !!!
  private _workerCount = 0; // !!!!
  private _compiledCode: string; // !!!

  // !!!
  constructor(
    fnRef: FunctionRef,
    timeout: number,
    extensionUri: vscode.Uri,
    compiledCode: string
  ) {
    this._timeout = timeout;
    this._fnRef = fnRef;
    this._extensionUri = extensionUri;
    this._compiledCode = compiledCode;

    this._getWorker();
  }

  // !!!
  private _getWorker(): WorkerClient {
    const workerUri = new URL(
      vscode.Uri.joinPath(
        this._extensionUri,
        "build",
        "workers",
        "FuzzWorker.js"
      ).toString()
    );

    // !!!
    if (this._worker === undefined) {
      console.log("client: starting worker: " + workerUri.toString()); // !!!!
      console.log("client: extension root: " + this._extensionUri.toString()); // !!!!")
      this._worker = new WorkerClient(workerUri, ++this._workerCount);
      this._worker.postMessage({ tag: "code", code: this._compiledCode });
      console.log(`client: worker #${this._workerCount} created`); // !!!!
    }

    return this._worker;
  }

  // !!!
  private _newWorker(): WorkerClient {
    const worker = this._worker;
    if (worker !== undefined) {
      console.log(`client: terminating worker #${this._workerCount}`); // !!!!
      this._worker = undefined;
      worker.terminate();
    }
    return this._getWorker();
  }

  // !!!
  public async run(inputs: FuzzIoElement[]): Promise<FuzzWorkerOutput> {
    return new Promise<FuzzWorkerOutput>((resolve) => {
      const fuzzWorker = this._getWorker();

      const fuzzWorkerInput: FuzzWorkerInputMessage = {
        tag: "input",
        input: {
          fnRef: this._fnRef,
          inputs: inputs,
        },
      };

      // !!!
      const timerReject = setTimeout(() => {
        const id = this._workerCount;
        console.log(
          `client: worker ${id} timed out after ${this._timeout} ms. buh bye`
        ); // !!!!
        const result: FuzzWorkerOutput = { timeout: true, output: undefined };
        this._newWorker();
        resolve(result);
      }, this._timeout);
      console.log(`client: timer set`); // !!!!

      // !!!
      const messageHandler = (message: any) => {
        const id = this._workerCount;
        const payload: FuzzWorkerMessage = message;
        console.log(
          `client: worker ${id} message received: ${JSON.stringify(message)}`
        ); // !!!!
        if (payload.tag === "output") {
          clearTimeout(timerReject);
          resolve(payload.output);
        }
      };

      // !!!
      fuzzWorker.removeAllListeners("message");
      fuzzWorker.addEventListener("message", messageHandler);

      // !!!
      fuzzWorker.postMessage(fuzzWorkerInput);
      console.log(`client: input posted`); // !!!!
    });
  }

  // !!!
  public close(): void {
    if (this._worker !== undefined) {
      const worker = this._worker;
      this._worker = undefined;
      worker.removeAllListeners("message");
      worker.terminate();
    }
  }
}
