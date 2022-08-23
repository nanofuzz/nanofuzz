import * as nodeworker from "worker_threads"; /// !!!!;

// !!!
export class WorkerServer {
  private _id = WorkerServer.isNode()
    ? nodeworker.workerData.id
    : parseInt(self.name); // !!!
  private _isNode = WorkerServer.isNode(); // !!!

  // !!!
  public getId(): number {
    return this._id;
  }

  // !!!
  public addEventListener(
    type: "message",
    listener: (ev: MessageEvent<any>) => any,
    options?: boolean | AddEventListenerOptions | undefined
  ): void {
    if (this._isNode) {
      if (!nodeworker.parentPort)
        throw new Error("nodeworker.parentPort not defined");
      nodeworker.parentPort.addListener(type, listener);
    } else {
      self.addEventListener(
        type,
        (message: any): void => {
          listener("data" in message ? message.data : message); // interop: only provide the payload
        },
        options
      );
    }
  }

  // !!!
  public postMessage(
    message: any,
    options?: StructuredSerializeOptions | undefined
  ): void {
    if (this._isNode) {
      if (!nodeworker.parentPort)
        throw new Error("nodeworker.parentPort not defined");
      nodeworker.parentPort.postMessage(message);
    } else {
      self.postMessage(message);
    }
  }

  // !!!
  public static isNode(): boolean {
    try {
      /* eslint eslint-comments/no-use: off */
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-constant-condition
      return Worker !== undefined ? false : true;
    } catch {
      return true;
    }
  }
}
