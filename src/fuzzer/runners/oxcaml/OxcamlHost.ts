import { AbstractHost, HostExitHandler } from "../AbstractHost";
import * as ChildProcess from "node:child_process";

/**
 * Wrapper for spawning and supervising running OCaml / OxCaml harness daemon processes.
 */
export class OxcamlHost extends AbstractHost {
  constructor(
    binPath: string,
    args: string[] = [],
    cwd: string | undefined = undefined,
    env: { [k: string]: string | undefined } = process.env,
    onExit?: HostExitHandler | undefined
  ) {
    super(env, cwd, binPath, args, onExit);
  } // constructor

  protected _spawn(): ChildProcess.ChildProcessWithoutNullStreams {
    return ChildProcess.spawn(this._cmd, this._args, {
      cwd: this._cwd,
      env: this._env,
      windowsHide: true,
    });
  } // fn: _spawn
} // class: OxcamlHost
