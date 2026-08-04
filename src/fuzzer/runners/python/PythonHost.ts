import {
  AbstractHost,
  HostExitHandler,
  HostMessageHandler,
} from "../AbstractHost";
import * as ChildProcess from "node:child_process";

/**
 * Wrapper for running and interacting with running Python programs
 */
export class PythonHost extends AbstractHost {
  protected _pythonEnv;

  constructor(
    args: string[],
    cwd: string | undefined,
    pythonEnv: PythonEnv,
    onMessage?: HostMessageHandler | undefined,
    onExit?: HostExitHandler | undefined
  ) {
    super(pythonEnv.env, cwd, pythonEnv.interpreter, args, onExit);
    this._pythonEnv = pythonEnv;
  }

  protected _spawn(): ChildProcess.ChildProcessWithoutNullStreams {
    return ChildProcess.spawn(this._cmd, this._args, {
      cwd: this._cwd,
      env: this._env,
      windowsHide: true,
    });
  }
} // class: PythonHost

export type PythonEnv = {
  env: { [k: string]: string | undefined };
  libs: string | undefined | null;
  interpreter: string;
  paths: readonly string[];
  venv?: {
    activateCmd: string;
    path: string;
    interpreter: string;
  };
};
