import * as vscode from "vscode";
import * as nodeworker from "worker_threads"; /// !!!!;
import { FuzzIoElement, FuzzWorkerInput, FuzzWorkerOutput } from "./Types";
import { FunctionRef } from "./analysis/typescript/Types";

// !!!
export class Runner {
  private timeout: number; // !!!
  private fnRef: FunctionRef; // !!!
  private extensionUri: vscode.Uri; // !!!
  private worker: InteropWorker | undefined; // !!!
  private workerCount = 0; // !!!!

  // !!!
  constructor(fnRef: FunctionRef, timeout: number, extensionUri: vscode.Uri) {
    this.timeout = timeout;
    this.fnRef = fnRef;
    this.extensionUri = extensionUri;
    this.getWorker();
  }

  // !!!
  private getWorker(): InteropWorker {
    console.log(
      vscode.Uri.joinPath(
        this.extensionUri,
        "build",
        "workers",
        "fuzzer.js"
      ).toString()
    ); // !!!!
    const workerUri = new URL(
      vscode.Uri.joinPath(
        this.extensionUri,
        "build",
        "workers",
        "fuzzer.js"
      ).toString()
    );

    if (this.worker === undefined) {
      console.log("client: starting worker: " + workerUri.toString()); // !!!!
      console.log("client: extension root: " + this.extensionUri.toString()); // !!!!")
      this.worker = new InteropWorker(workerUri, ++this.workerCount);
      console.log(`client: worker #${this.workerCount} created`); // !!!!
    }
    return this.worker;
  }

  // !!!
  private newWorker(): InteropWorker {
    const worker = this.worker;
    if (worker !== undefined) {
      console.log(`client: terminating worker #${this.workerCount}`); // !!!!
      this.worker = undefined;
      worker.terminate();
    }
    return this.getWorker();
  }

  // !!!
  public async run(inputs: FuzzIoElement[]): Promise<FuzzWorkerOutput> {
    return new Promise<FuzzWorkerOutput>((resolve) => {
      const fuzzWorker = this.getWorker();

      const fuzzWorkerInput: FuzzWorkerInput = {
        fnRef: this.fnRef,
        inputs: inputs,
      };

      // !!!
      const timerReject = setTimeout(() => {
        const id = this.workerCount;
        console.log(
          `client: worker ${id} timed out after ${this.timeout} ms. buh bye`
        ); // !!!!
        const result: FuzzWorkerOutput = { timeout: true, output: undefined };
        this.newWorker();
        resolve(result);
      }, this.timeout);
      console.log(`client: timer set`); // !!!!

      // !!!
      const messageHandler = (message: any) => {
        const id = this.workerCount;
        console.log(
          `client: worker ${id} message received: ${JSON.stringify(message)}`
        ); // !!!!
        clearTimeout(timerReject);
        const payload: FuzzWorkerOutput =
          "data" in message ? message.data : message;
        resolve(payload);
      };

      fuzzWorker.removeAllListeners("message");
      fuzzWorker.addEventListener("message", messageHandler);

      fuzzWorker.postMessage(fuzzWorkerInput);
      console.log(`client: input posted`); // !!!!
    });
  }

  // !!!
  public close(): void {
    if (this.worker !== undefined) {
      const worker = this.worker;
      this.worker = undefined;
      worker.removeAllListeners("message");
      worker.terminate();
    }
  }
}

// !!!
class InteropWorker {
  private nodeImpl?: nodeworker.Worker; // !!!
  private browserImpl?: Worker; // !!!
  private uri: URL; // !!!
  private isNode: boolean; // !!!
  private handlers: any[] = []; // !!!
  private state: "running" | "terminated"; // !!!
  private id: number; // !!!

  // !!!
  constructor(uri: URL, id?: number) {
    this.uri = uri;
    this.state = "running";
    this.id = id ? id : 0;

    try {
      /* eslint eslint-comments/no-use: off */
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-constant-condition
      this.isNode = Worker !== undefined ? false : true;
    } catch {
      this.isNode = true;
    }

    if (this.isNode) {
      this.nodeImpl = new nodeworker.Worker(uri, { workerData: { id: id } });
    } else {
      this.browserImpl = new Worker(uri, { name: this.id.toString() });
    }
  }

  // !!!
  public getId(): number {
    return this.id;
  }

  // !!!
  public terminate(): void {
    (this.isNode ? this.nodeImpl! : this.browserImpl!).terminate();
    this.state = "terminated";
  }

  // !!!
  public postMessage(payload: any): void {
    if (this.state === "terminated") {
      throw new Error(`Worker ${this.id} previously terminated`);
    }
    (this.isNode ? this.nodeImpl! : this.browserImpl!).postMessage(payload);
  }

  // !!!
  public addEventListener(type: "message", handler: any): void {
    if (this.state === "terminated") {
      throw new Error(`Worker ${this.id} previously terminated`);
    }
    this.handlers.push({ type: type, handler: handler });
    if (this.isNode) {
      this.nodeImpl!.addListener(type, handler);
    } else {
      this.browserImpl!.addEventListener(type, handler);
    }
  }

  // !!!
  public removeAllListeners(type: "message"): void {
    if (this.state === "terminated") {
      throw new Error(`Worker ${this.id} previously terminated`);
    }
    if (this.isNode) {
      this.nodeImpl!.removeAllListeners(type);
    } else {
      this.handlers.forEach((handler) => {
        this.browserImpl!.removeEventListener(type, handler);
      });
    }
  }
}
