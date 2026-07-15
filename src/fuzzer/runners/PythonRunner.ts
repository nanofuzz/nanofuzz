import { AbstractRunner, RunnerResult } from "./AbstractRunner";
import JSON5 from "json5";
import * as ChildProcess from "node:child_process";
import * as path from "node:path";

/**
 * Python runner
 */
export class PythonRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;

  /**
   * Create a new Python runner
   *
   * @param `filename` path and filename of Python program module
   * @param `fn` exported Python function within `module` to call
   */
  public constructor(filename: string, fn: string) {
    super(fn);
    this._filename = filename;
    this._fn = fn;
  } // fn: constructor

  /**
   * Run `fn` in `module` with `inputs`
   *
   * @param `inputs` inputs to function
   * @param `timeout` stop and fail after `timeout` ms
   * @returns [an unknown output type,environment]
   */
  public run(inputs: unknown[], timeout: number | undefined = 0): RunnerResult {
    const filenameBase = path.basename(this._filename);
    const args = [
      path.resolve(
        path.join(
          path.dirname(path.resolve(module.filename)),
          "PythonRunnerHost.py"
        )
      ),
      this._filename,
      filenameBase.substring(
        0,
        filenameBase.length - path.extname(filenameBase).length
      ),
      this._fn,
      ...inputs.map((i) => JSON5.stringify(i)),
    ];
    const result = ChildProcess.spawnSync("python3", args, {
      cwd: path.dirname(module.filename),
      timeout: timeout, // !!!!!!!!!!
      windowsHide: true,
    });
    console.debug(`-----------------------------`);
    console.debug(`args  : ${JSON5.stringify(args)}`);
    console.debug(`stdout: (raw) ${result.stdout}`);
    console.debug(`stderr: (raw) ${result.stderr}`);
    console.debug(`error : (raw) ${result.error}`);
    console.debug(`status: (raw) ${result.status}`);
    console.debug(`output: (raw) ${result.output}`);

    if (result.error) {
      if (result.error.message === "spawnSync python3 ETIMEDOUT") {
        return {
          result: {
            tag: "timeout",
          },
          env: {},
        };
      } else {
        return {
          result: {
            tag: "error",
            name: result.error.name,
            message: `(raw) ${result.error.message}`, // !!!!!!!!!!
            stack: result.error.stack,
          },
          env: {},
        };
      }
    }
    if (result.status !== 0) {
      return {
        result: {
          tag: "error",
          name: `PythonErrorReturncode`,
          message: `(raw) ${result.status}`, // !!!!!!!!!!
        },
        env: {},
      };
    }
    return {
      result: {
        tag: "value",
        value: [
          result.output.map(
            (o) => (o === null ? undefined : "somevalue") // <-- !!!!!!!!!! Buffer.from(o).toString("base64")
          ),
        ], // !!!!!!!!!! too many arrays
      },
      env: {},
    };
  } // fn: run
} // class: PythonRunner
