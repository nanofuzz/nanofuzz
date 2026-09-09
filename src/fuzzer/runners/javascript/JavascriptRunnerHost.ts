import * as JSONN from "../../../Jsonn";
import * as path from "node:path";
import * as moduleApi from "node:module";
import { RunnerInput, TypeHint } from "../AbstractRunner";
import { isError } from "../../Util";

const realStdoutWrite = process.stdout.write.bind(process.stdout);
let stdinBuffer = Buffer.alloc(0);

setup();

main().catch((err) => {
  console.error("JavascriptRunnerHost fatal error:", err);
  process.exit(1);
});

/**
 * Main entry point for the JavascriptRunnerHost process.
 * This function reads RunnerInput messages from stdin, executes
 * the target function, and writes RunnerResult messages to stdout.
 */
async function main() {
  const initialFilename = process.argv[2];
  const initialFnName = process.argv[3];

  const loadedModules: Record<string, unknown> = {};

  const getTargetFunction = (
    filenameToLoad: string,
    fnNameToLoad: string
  ): ((...args: unknown[]) => unknown) => {
    const resolvedPath = path.resolve(filenameToLoad);
    if (!(resolvedPath in loadedModules) || !require.cache[resolvedPath]) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      loadedModules[resolvedPath] = require(resolvedPath);
    }
    const mod = loadedModules[resolvedPath];
    let fnToExec: unknown;
    if (isRecord(mod)) {
      fnToExec = mod[fnNameToLoad];
    } else if (typeof mod === "function") {
      fnToExec = mod;
    }

    if (typeof fnToExec !== "function") {
      throw new Error(
        `Could not find exported function ${fnNameToLoad} in ${resolvedPath}`
      );
    }

    const fn = fnToExec;
    return (...args: unknown[]) => fn(...args);
  };

  if (initialFilename && initialFnName) {
    try {
      getTargetFunction(initialFilename, initialFnName);
    } catch {
      // Ignore if initial load fails; loop will handle per-request errors
    }
  }

  // Send READY message
  sendMsg("READY");

  // Send initial coverage info
  const initialCoverage = getGlobalCoverageData() ?? {};
  sendMsg(initialCoverage);

  // Main loop
  while (true) {
    let header: Buffer;
    try {
      header = await readBytes(4);
    } catch {
      break; // stdin closed or EOF
    }

    const length = header.readUInt32BE(0);
    const payloadBuf = await readBytes(length);
    const input: RunnerInput & { timeout?: number } = JSONN.parse(
      payloadBuf.toString("utf-8")
    );

    resetCoverageCounters(getGlobalCoverageData());

    const targetFilename = input.filename ?? initialFilename;
    const targetFnName = input.fnName ?? initialFnName;

    let resultTag: "value" | "timeout" | "skip" | "error" = "value";
    let value: unknown = undefined;
    let errName = "";
    let errMsg = "";
    let errStack = "";

    try {
      if (!targetFilename || !targetFnName) {
        throw new Error("Target filename or function name missing");
      }

      const fnToExec = getTargetFunction(targetFilename, targetFnName);
      const typeHints = input.typeHints ?? [];
      const hydratedArgs = input.args.map((arg, i) =>
        i < typeHints.length ? transformArg(arg, typeHints[i]) : arg
      );

      value = fnToExec(...hydratedArgs);
    } catch (e: unknown) {
      const isTimeout =
        isError(e) &&
        (("code" in e && e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") ||
          e.message.includes("Script execution timed out"));
      if (isTimeout) {
        resultTag = "timeout";
      } else if (isError(e) && e.name === "UnsatisfiedAssumption") {
        resultTag = "skip";
        errMsg = e.message;
      } else if (isError(e)) {
        resultTag = "error";
        errName = e.name;
        errMsg = e.message;
        errStack = e.stack ?? "";
      } else {
        resultTag = "error";
        errName = "UnknownJavascriptRunnerError";
        errMsg = "unknown";
        errStack = "<no stack>";
      }
    }

    const currentCoverage = extractDynamicCoverage(
      getGlobalCoverageData() ?? {}
    );

    let resultMsg: Record<string, unknown>;
    if (resultTag === "timeout") {
      resultMsg = { tag: "timeout", seq: input.seq };
    } else if (resultTag === "skip") {
      resultMsg = {
        tag: "skip",
        message: errMsg,
        seq: input.seq,
        coverageData: currentCoverage,
      };
    } else if (resultTag === "error") {
      resultMsg = {
        tag: "error",
        name: errName,
        message: errMsg,
        stack: errStack,
        source: "put",
        seq: input.seq,
        coverageData: currentCoverage,
      };
    } else {
      resultMsg = {
        tag: "value",
        value: sanitizeOutput(value),
        seq: input.seq,
        coverageData: currentCoverage,
      };
    }

    sendMsg(resultMsg);
  }
} // fn: main

/**
 * Sets up the environment for the JavascriptRunnerHost process, including
 * redirecting console output to stderr and enabling Node.js compile cache,
 * if available.
 */
function setup() {
  // Activate Node.js compile cache if available (Node 22+)
  if (
    "enableCompileCache" in moduleApi &&
    typeof moduleApi.enableCompileCache === "function"
  ) {
    moduleApi.enableCompileCache();
  }

  // Redirect all console output away from stdout so IPC stdout is 100% clean
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(
      args
        .map((a) => (typeof a === "string" ? a : JSONN.stringify(a)))
        .join(" ") + "\n"
    );
  };
  console.log = toStderr;
  console.debug = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.error = toStderr;

  process.stdout.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void
  ): boolean => {
    if (typeof encoding === "function") {
      return process.stderr.write(chunk, encoding);
    }
    return process.stderr.write(chunk, encoding, callback);
  };

  process.stdin.on("data", (chunk: Buffer) => {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  });
} // fn: setup

/**
 * Transforms an argument based on the provided type hint.
 *
 * @param val The value to transform.
 * @param hint The type hint guiding the transformation.
 * @returns The transformed value.
 */
function transformArg(val: unknown, hint: TypeHint | undefined): unknown {
  if (val === null || val === undefined || hint === undefined) {
    return val;
  }

  if (hint === "bytes") {
    if (val instanceof Uint8Array) return val;
    if (Array.isArray(val) && isNumberArray(val)) return new Uint8Array(val);
    if (typeof val === "string") return new TextEncoder().encode(val);
    return val;
  }

  if (typeof hint === "object") {
    if (hint.kind === "array" && Array.isArray(val)) {
      return val.map((item) => transformArg(item, hint.element));
    }

    if (hint.kind === "set" && (Array.isArray(val) || val instanceof Set)) {
      const items = Array.from(val).map((item) =>
        transformArg(item, hint.element)
      );
      return new Set(items);
    }

    if (hint.kind === "dictionary" && (val instanceof Map || isRecord(val))) {
      if (Array.isArray(val)) {
        const entries: [unknown, unknown][] = [];
        for (const item of val) {
          if (isEntryPair(item)) {
            entries.push([
              transformArg(item[0], hint.key),
              transformArg(item[1], hint.value),
            ]);
          }
        }
        return new Map(entries);
      } else if (isRecord(val)) {
        const map = new Map<unknown, unknown>();
        for (const [k, v] of Object.entries(val)) {
          map.set(transformArg(k, hint.key), transformArg(v, hint.value));
        }
        return map;
      }
    }

    if (hint.kind === "tuple" && (Array.isArray(val) || isRecord(val))) {
      if (Array.isArray(val)) {
        return val.map((item, i) =>
          i < hint.elements.length ? transformArg(item, hint.elements[i]) : item
        );
      }
    }

    if (hint.kind === "object" && isRecord(val)) {
      const res: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        res[k] = k in hint.fields ? transformArg(v, hint.fields[k]) : v;
      }
      return res;
    }

    if (hint.kind === "union") {
      for (const arm of hint.arms) {
        const transformed = transformArg(val, arm);
        if (transformed !== val) {
          return transformed;
        }
      }
      return val;
    }
  }

  return val;
} // fn: transformArg

/**
 * Sanitizes the output object by converting complex data structures into
 * plain JavaScript objects for serialization back to the fuzzer. This
 * includes converting Uint8Arrays to arrays, Sets to arrays, & Maps to objects.
 *
 * @param obj The object to sanitize.
 * @returns The sanitized object.
 */
function sanitizeOutput(obj: unknown): unknown {
  if (obj instanceof Uint8Array) {
    return Array.from(obj);
  }
  if (obj instanceof Set) {
    return Array.from(obj).map(sanitizeOutput);
  }
  if (obj instanceof Map) {
    const res: Record<string, unknown> = {};
    for (const [k, v] of obj.entries()) {
      const sKey =
        typeof k === "string" || typeof k === "number"
          ? String(k)
          : JSONN.stringify(sanitizeOutput(k));
      res[sKey] = sanitizeOutput(v);
    }
    return res;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeOutput);
  }
  if (isRecord(obj)) {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      res[k] = sanitizeOutput(v);
    }
    return res;
  }
  return obj;
} // fn: sanitizeOutput

/**
 * Reads the specified number of bytes from stdin.
 *
 * @param bytes The number of bytes to read.
 * @returns A promise that resolves to a Buffer containing the read bytes.
 */
async function readBytes(bytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (stdinBuffer.length >= bytes) {
      const res = stdinBuffer.subarray(0, bytes);
      stdinBuffer = stdinBuffer.subarray(bytes);
      resolve(res);
      return;
    }

    const onData = () => {
      if (stdinBuffer.length >= bytes) {
        cleanup();
        const res = stdinBuffer.subarray(0, bytes);
        stdinBuffer = stdinBuffer.subarray(bytes);
        resolve(res);
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("EOF on stdin"));
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
      process.stdin.removeListener("close", onClose);
    };

    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
    process.stdin.on("close", onClose);
  });
} // fn: readBytes

/**
 * Sends a message to the fuzzer.
 *
 * @param data The data to send.
 */
function sendMsg(data: unknown): void {
  try {
    const payload = Buffer.from(JSONN.stringify(data), "utf-8");
    const message = Buffer.alloc(4 + payload.length);
    message.writeUInt32BE(payload.length, 0);
    payload.copy(message, 4);
    realStdoutWrite(message);
  } catch (err: unknown) {
    process.stderr.write(
      `HOST SENDMSG ERROR: ${isError(err) ? (err.stack ?? err.message) : String(err)}\n`
    );
  }
} // fn: sendMsg

/**
 * Resets the coverage counters in the given coverage data.
 *
 * @param covData The coverage data object whose counters should be reset.
 */
function resetCoverageCounters(covData: unknown): void {
  if (isCoverageMap(covData)) {
    for (const fileKey of Object.keys(covData)) {
      const fileCoverage = covData[fileKey];
      if (fileCoverage) {
        if (fileCoverage.b) {
          for (const bKey of Object.keys(fileCoverage.b)) {
            const arr = fileCoverage.b[bKey];
            if (Array.isArray(arr)) {
              arr.fill(0);
            }
          }
        }
        if (fileCoverage.s) {
          for (const sKey of Object.keys(fileCoverage.s)) {
            fileCoverage.s[sKey] = 0;
          }
        }
        if (fileCoverage.f) {
          for (const fKey of Object.keys(fileCoverage.f)) {
            fileCoverage.f[fKey] = 0;
          }
        }
      }
    }
  }
} // fn: resetCoverageCounters

/**
 * Extracts the dynamic coverage data from the given coverage map.
 *
 * @param covData The coverage data object to extract from.
 * @returns A record mapping file paths to their coverage data.
 */
function extractDynamicCoverage(
  covData: unknown
): Record<string, FileCoverageData> {
  const result: Record<string, FileCoverageData> = {};

  if (isCoverageMap(covData)) {
    for (const fileKey of Object.keys(covData)) {
      const fileCoverage = covData[fileKey];
      if (fileCoverage) {
        result[fileKey] = {
          s: fileCoverage.s,
          f: fileCoverage.f,
          b: fileCoverage.b,
        };
      }
    }
  }

  return result;
} // fn: extractDynamicCoverage

function isNumberArray(val: unknown[]): val is number[] {
  return val.every((x) => typeof x === "number");
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

function isEntryPair(val: unknown): val is [unknown, unknown] {
  return Array.isArray(val) && val.length >= 2;
}

function isCoverageMap(
  val: unknown
): val is Record<string, FileCoverageData | undefined> {
  return typeof val === "object" && val !== null;
}

function getGlobalCoverageData(): unknown {
  return Reflect.get(globalThis, "__coverage__");
}

type FileCoverageData = {
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
};
