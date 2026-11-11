import {
  AbstractHost,
  HostExitHandler,
  HostMessageHandler,
} from "../AbstractHost";
import * as ChildProcess from "node:child_process";

/**
 * Wrapper for running and interacting with running JavaScript/Node programs
 */
export class NodeHost extends AbstractHost {
  constructor(
    args: string[],
    cwd: string | undefined,
    env: { [k: string]: string | undefined } = process.env,
    onMessage?: HostMessageHandler | undefined,
    onExit?: HostExitHandler | undefined
  ) {
    const nodeCmd = process.execPath || "node";
    const hostEnv: { [k: string]: string | undefined } = {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    };
    super(hostEnv, cwd, nodeCmd, args, onExit);
  } // fn: constructor

  protected _spawn(): ChildProcess.ChildProcessWithoutNullStreams {
    return ChildProcess.spawn(this._cmd, this._args, {
      cwd: this._cwd,
      env: this._env,
      windowsHide: true,
    });
  } // fn: _spawn
} // class: NodeHost
