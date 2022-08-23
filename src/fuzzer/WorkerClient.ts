import * as nodeworker from "worker_threads"; /// !!!!;
import { WorkerServer } from "./WorkerServer";

// !!!
export class WorkerClient {
  private _nodeImpl?: nodeworker.Worker; // !!!
  private _browserImpl?: Worker; // !!!
  private _uri: URL; // !!!
  private _isNode = WorkerServer.isNode();
  private _handlers: any[] = []; // !!!
  private _state: "running" | "terminated"; // !!!
  private _id: number; // !!!

  // !!!
  constructor(uri: URL, id?: number) {
    this._uri = uri;
    this._state = "running";
    this._id = id ? id : 0;

    if (this._isNode) {
      this._nodeImpl = new nodeworker.Worker(uri, { workerData: { id: id } });
    } else {
      this._browserImpl = new Worker(uri, { name: this._id.toString() });
    }
  }

  // !!!
  public getId(): number {
    return this._id;
  }

  // !!!
  public getUri(): URL {
    return this._uri;
  }

  // !!!
  public terminate(): void {
    (this._isNode ? this._getNodeImpl() : this._getBrowserImpl()).terminate();
    this._state = "terminated";
  }

  // !!!
  public postMessage(payload: any): void {
    if (this._state === "terminated") {
      throw new Error(`Worker ${this._id} previously terminated`);
    }
    (this._isNode ? this._getNodeImpl() : this._getBrowserImpl()).postMessage(
      payload
    );
  }

  // !!!
  public addEventListener(type: "message", handler: any): void {
    if (this._state === "terminated") {
      throw new Error(`Worker ${this._id} previously terminated`);
    }
    this._handlers.push({ type: type, handler: handler });
    if (this._isNode) {
      this._getNodeImpl().addListener(type, handler);
    } else {
      this._getBrowserImpl().addEventListener(type, handler);
    }
  }

  // !!!
  public removeAllListeners(type: "message"): void {
    if (this._state === "terminated") {
      throw new Error(`Worker ${this._id} previously terminated`);
    }
    if (this._nodeImpl) {
      this._nodeImpl.removeAllListeners(type);
    } else {
      const browserImpl = this._getBrowserImpl();
      this._handlers.forEach((handler) => {
        browserImpl.removeEventListener(type, handler);
      });
    }
  }

  // !!!
  private _getBrowserImpl(): Worker {
    if (this._browserImpl) {
      return this._browserImpl;
    } else {
      throw new Error("browserImpl not initialized");
    }
  }

  // !!!
  private _getNodeImpl(): nodeworker.Worker {
    if (this._nodeImpl) {
      return this._nodeImpl;
    } else {
      throw new Error("nodeImpl not initialized");
    }
  }
}
