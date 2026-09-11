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
    super(env, cwd, nodeCmd, args, onExit);
  } // fn: constructor

  protected _spawn(): ChildProcess.ChildProcessWithoutNullStreams {
    const proc = ChildProcess.spawn(this._cmd, this._args, {
      cwd: this._cwd,
      env: this._env,
      windowsHide: true,
    });
    proc.stderr.pipe(process.stderr);
    return proc;
  } // fn: _spawn
} // class: NodeHost
