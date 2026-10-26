import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as Config from "../Config";
import * as JSONN from "../Jsonn";
import { listTargets, runFuzz, shrinkInputs } from "./Agent";
import { findBugs } from "./FindBugs";
import { LlmAdapter } from "../fuzzer/adapters/LlmAdapter";
import * as CompilerFactory from "../fuzzer/compilers/CompilerFactory";
import pkg from "../../package.json";

/**
 * Recursive Zod schema for JSON-compatible values (string, number, boolean, null, array, or object)
 * to avoid unconstrained `additionalProperties: {}` in generated MCP tool JSON schemas.
 */
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

/**
 * Creates and initializes an MCP server exposing NaNofuzz tools.
 *
 * @param options Server configuration options
 * @returns Configured McpServer instance
 */
export async function createMcpServer(
  options?: McpServerOptions
): Promise<McpServer> {
  if (options) {
    applyServerOptions(options);
  }

  const version = process.env.NANOFUZZ_VERSION ?? pkg.version;
  const server = new McpServer({
    name: "nanofuzz",
    version,
  });

  server.tool(
    "nanofuzz_listTargets",
    "Discovers and lists functions (exported and unexported, synchronous and asynchronous), type signatures, parameter structures, and ready-to-use property validator, input transformer, and custom input generator code templates (validatorTemplate, transformerTemplate, and generatorTemplate) in a TypeScript, Python, Rust, Java, or OCaml/OxCaml source file that can be targeted for structure-aware fuzzing and property testing. Functions under test with preconditions can be paired with an input transformer using assume(condition) (or assume!(...) in Rust) or raise/throw UnsatisfiedAssumption(msg) to filter out invalid or out-of-domain inputs from the fuzzing loop. Functions with domain-specific input distributions or sequences can be paired with a custom generator (<fn>Generator) taking a pseudo-random number generator (e.g. prng: () => number in TypeScript, prng: Callable[[], float] in Python, impl FnMut() -> f64 in Rust, DoubleSupplier prng in Java, or prng: unit -> float in OCaml) and returning an argument tuple (or None/undefined when exhausted). If a target function is a class method or uses unsupported signature types, you can write a wrapper function with type annotations in its signature that calls the target function, and list or test that wrapper function instead.",
    {
      filePath: z
        .string()
        .describe(
          "Absolute or workspace-relative path to the source file (e.g. src/math.ts, test.py, src/lib.rs, src/Math.java, or src/app.ml)."
        ),
    },
    async ({ filePath }) => {
      const targets = await listTargets(filePath);
      return {
        content: [
          {
            type: "text",
            text: JSONN.stringify(targets, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "nanofuzz_fuzzFunction",
    "Runs coverage-guided, structure-aware property fuzzing on a target function (synchronous or asynchronous, exported or unexported) in TypeScript, Python, Rust, Java, or OCaml/OxCaml. Uses dynamic branch-coverage feedback loops, type-aware/grammar generation, coverage-directed mutation, AI input generation, and automated input shrinking (minimization) to find minimal counterexamples, crashes, and edge cases. Returns synthesized executable regression tests (Jest for TypeScript/JavaScript, Pytest for Python, cargo test for Rust, JUnit 5 for Java, or dune runtest for OCaml) and branch coverage metrics. To filter invalid inputs or express preconditions, write an input transformer function (<fn>Transformer) using assume(condition), assume!(condition), Assume.that(condition) in Java, or UnsatisfiedAssumption. To supply custom domain-specific inputs or sequences, write a generator function (<fn>Generator). If a target function is a class method or uses unsupported signature types, you can write a wrapper function with type annotations in its signature that calls the target, and fuzz that wrapper function instead.",
    {
      filePath: z
        .string()
        .describe(
          "Absolute or workspace-relative path to the source file containing the target function."
        ),
      functionName: z
        .string()
        .describe("The exact name of the function to test."),
      model: z
        .string()
        .optional()
        .describe(
          "The language model name or family currently used by the calling agent (e.g. 'gemini-2.0-flash', 'gemini-3.7-flash', 'claude-3.5-sonnet', 'gpt-4o'). Always pass your own model name or family here so NaNofuzz uses the same AI model for input generation."
        ),
      vendor: z
        .string()
        .optional()
        .describe(
          "The language model vendor/provider identifier currently used by the calling agent (e.g. 'google', 'copilot', 'gemini', 'openai'). Always pass your active vendor/provider so NaNofuzz routes queries to the exact same provider account and billing."
        ),
      maxTests: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Maximum number of test cases to generate and execute (default: 1000, 0 for no limit / run until timeoutMs)."
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum suite execution timeout in milliseconds (default: 3000)."
        ),
      maxFailures: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Maximum number of failures to find before stopping (default: 0 for no limit)."
        ),
      seed: z
        .string()
        .optional()
        .describe(
          "Optional pseudo-random generator seed for deterministic fuzzing runs."
        ),
      inputs: z
        .array(z.record(z.string(), jsonValueSchema))
        .optional()
        .describe(
          'Optional list of concrete seed inputs to test, expressed as objects mapping parameter names to argument values (e.g. [{"name": "Alice", "age": 30}]). Useful for targeting specific uncovered branches or edge cases.'
        ),
      tests: z
        .array(
          z.object({
            input: z
              .union([
                z.record(z.string(), jsonValueSchema),
                z.array(jsonValueSchema),
              ])
              .describe("Object mapping parameter names to argument values."),
            expectedOutput: jsonValueSchema
              .optional()
              .describe(
                "The expected return value of the function for these inputs."
              ),
            expectedException: z
              .boolean()
              .optional()
              .describe(
                "True if an exception or error is expected to be thrown for these inputs."
              ),
            expectedTimeout: z
              .boolean()
              .optional()
              .describe("True if a timeout is expected for these inputs."),
          })
        )
        .optional()
        .describe(
          "Optional list of unit test specifications with inputs and expected outcomes. Each test specifies 'input' (parameter object or argument array), plus optional 'expectedOutput' (expected return value), 'expectedException' (boolean), or 'expectedTimeout' (boolean)."
        ),
      exportSuite: z
        .boolean()
        .optional()
        .describe(
          "If true, synthesizes a complete, minimal branch-covering regression test suite (using shrunken inputs and counterexamples) formatted for the native test framework (Jest for TypeScript/JavaScript, Pytest for Python, cargo test for Rust, JUnit 5 for Java, or dune runtest for OCaml) and includes it in the response."
        ),
      exportFilePath: z
        .string()
        .optional()
        .describe(
          "Optional destination file path (e.g. 'tests/test_math.py', 'src/math.test.ts', 'tests/test_math.rs', or 'src/test/java/MathNanoTest.java') where the synthesized test suite will be written directly to disk."
        ),
      coverageScope: z
        .enum([
          "project",
          "project static",
          "project directimports",
          "project directimports static",
        ])
        .optional()
        .describe("Code coverage scope (e.g. 'project directimports')."),
      fnTimeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Per-test function execution timeout in milliseconds (default: 500)."
        ),
      useTransformer: z
        .boolean()
        .optional()
        .describe(
          "Whether to apply the <fn>Transformer function if present (true for semantic mode, false for adversarial robustness mode)."
        ),
    },
    async (args, extra) => {
      const isAiConfigured =
        LlmAdapter.isConfigured() ||
        (Boolean(args.model) &&
          Config.get("nanofuzz.ai.provider", "disabled") !== "disabled");

      const result = await runFuzz(
        {
          filePath: args.filePath,
          functionName: args.functionName,
          maxTests: args.maxTests,
          fnTimeout: args.fnTimeout,
          suiteTimeout: args.timeoutMs,
          maxFailures: args.maxFailures,
          seed: args.seed,
          model: args.model,
          vendor: args.vendor,
          inputs: args.inputs,
          tests: args.tests,
          exportSuite: args.exportSuite,
          exportFilePath: args.exportFilePath,
          coverageScope: args.coverageScope,
          useTransformer: args.useTransformer,
          enableCopilotAi: false,
          noConfigFile: options?.noConfigFile,
          generators: {
            AiInputGenerator: { enabled: isAiConfigured },
          },
        },
        () => Boolean(extra.signal?.aborted)
      );

      return {
        content: [
          {
            type: "text",
            text: result.summaryText,
          },
        ],
        ...(result.status === "error" ? { isError: true } : {}),
      };
    }
  );

  server.tool(
    "nanofuzz_findBugs",
    "Guides an autonomous agent through multi-turn invariant extraction, constructive harness synthesis, and coverage-gated fuzzing to discover unknown bugs in a repository using NaNofuzz.",
    {
      phase: z
        .enum(["init", "invariants_extracted", "fuzz_entrypoint", "complete"])
        .optional()
        .describe(
          "Workflow phase: 'init' to start discovery and black-box invariant extraction; 'invariants_extracted' to submit invariants and receive harness/validator instructions; 'fuzz_entrypoint' to get execution and triage guidance for a specific entrypoint; 'complete' to finalize findings and choose artifact disposition."
        ),
      model: z
        .string()
        .describe(
          "The calling agent's language model family/name (e.g. 'gemini-2.0-flash', 'claude-3.5-sonnet', 'gpt-4o'). Required."
        ),
      vendor: z
        .string()
        .describe(
          "The calling agent's language model vendor/provider identifier (e.g. 'google', 'copilot', 'gemini', 'openai'). Required."
        ),
      targetPath: z
        .string()
        .optional()
        .describe(
          "Workspace-relative or absolute path to the project or file to test. Defaults to workspace root."
        ),
      repoUrl: z
        .string()
        .optional()
        .describe("Optional Git repository URL to clone and test."),
      statePayload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Structured JSON state payload when transitioning phases (e.g. extracted invariants, entrypoint name, or final findings)."
        ),
    },
    async (args) => {
      const result = await findBugs({
        phase: args.phase,
        model: args.model,
        vendor: args.vendor,
        targetPath: args.targetPath,
        repoUrl: args.repoUrl,
        statePayload: args.statePayload,
      });

      return {
        content: [
          {
            type: "text",
            text: result.summaryText,
          },
        ],
      };
    }
  );

  server.tool(
    "nanofuzz_shrinkInputs",
    "Minimizes and shrinks one or more test inputs or counterexamples for a target function to find the simplest, canonical inputs that reproduce the same failure or execution outcome. Accepts a file path, target function name, and an array of input objects.",
    {
      filePath: z
        .string()
        .describe(
          "Absolute or workspace-relative path to the source file containing the target function."
        ),
      functionName: z
        .string()
        .describe("The exact name of the function under test."),
      inputs: z
        .array(
          z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
        )
        .describe(
          "Array of input objects mapping parameter names to argument values to shrink."
        ),
      fnTimeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Per-test function execution timeout in milliseconds (default: 500)."
        ),
      maxShrinkTime: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Maximum time in milliseconds allowed for shrinking per input (default: 2000, 0=no limit)."
        ),
      maxSteps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum number of shrink steps to attempt per input (default: 100)."
        ),
      seed: z
        .string()
        .optional()
        .describe(
          "Optional pseudo-random generator seed for deterministic shrinking."
        ),
    },
    async (args) => {
      const result = await shrinkInputs({
        filePath: args.filePath,
        functionName: args.functionName,
        inputs: args.inputs,
        fnTimeout: args.fnTimeout,
        maxShrinkTime: args.maxShrinkTime,
        maxSteps: args.maxSteps,
        seed: args.seed,
      });

      return {
        content: [
          {
            type: "text",
            text: result.summaryText,
          },
        ],
      };
    }
  );

  return server;
} // fn: createMcpServer

/**
 * Runs the MCP server listening on stdio or SSE transport.
 *
 * @param options Server configuration options
 */
export async function runMcpServer(options?: McpServerOptions): Promise<void> {
  const server = await createMcpServer(options);
  const transportType = options?.transport ?? "stdio";

  if (transportType === "sse") {
    const port = options?.port ?? 3000;
    const transports = new Map<string, SSEServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      const host = req.headers.host ?? `localhost:${port}`;
      const url = new URL(req.url ?? "", `http://${host}`);

      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        res.on("close", () => {
          transports.delete(transport.sessionId);
        });
        await server.connect(transport);
      } else if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId
          ? transports.get(sessionId)
          : transports.values().next().value;

        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Session not found or invalid");
        }
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(port, () => {
        process.stderr.write(
          `NaNofuzz MCP server listening on SSE port ${port}\n`
        );
        resolve();
      });
      httpServer.on("error", reject);
    });
  } else {
    // Redirect console methods to stderr to maintain pristine JSON-RPC on stdout
    console.log = (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(" ") + "\n");
    };
    console.info = (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(" ") + "\n");
    };
    console.warn = (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(" ") + "\n");
    };

    const transport = new StdioServerTransport();
    await server.connect(transport);

    await new Promise<void>((resolve) => {
      transport.onclose = () => {
        resolve();
      };
    });
  }
} // fn: runMcpServer

// -------------------------------------------------------------------------- //
// Helper Functions
// -------------------------------------------------------------------------- //

/**
 * Applies MCP server command line options to configuration and process state.
 *
 * @param options MCP server options
 */
function applyServerOptions(options: McpServerOptions): void {
  if (options.workspace) {
    const resolved = path.resolve(options.workspace);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Workspace path does not exist: ${options.workspace}`);
    }
    process.chdir(resolved);
  }

  if (options.clearCompileCache) {
    CompilerFactory.clean();
  }

  if (options.workers !== undefined) {
    Config.override("nanofuzz.fuzzer.workers", options.workers);
  }

  if (options.modelProvider !== undefined) {
    Config.override("nanofuzz.ai.provider", options.modelProvider);
  }
  if (options.modelName !== undefined) {
    Config.override("nanofuzz.ai.model", options.modelName);
  }
  if (options.modelKey !== undefined) {
    Config.override("nanofuzz.ai.apiKey", options.modelKey);
  }
  if (options.modelEndpoint !== undefined) {
    Config.override("nanofuzz.ai.endpoint", options.modelEndpoint);
  }
  if (options.modelTimeout !== undefined) {
    Config.override("nanofuzz.ai.requestTimeout", options.modelTimeout);
  }

  if (options.debug !== false && options.debug !== undefined) {
    const scope =
      typeof options.debug === "string"
        ? options.debug.toLowerCase().trim()
        : "*";
    const scopes = scope.split(",").map((s) => s.trim());
    Config.override(
      "nanofuzz.debug.runners",
      scopes.includes("*") || scopes.includes("runners")
    );
    Config.override(
      "nanofuzz.ai.debug",
      scopes.includes("*") || scopes.includes("ai")
    );
  }

  if (options.logFile) {
    const logPath = path.resolve(options.logFile);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void
    ): boolean => {
      logStream.write(chunk);
      if (typeof encodingOrCallback === "function") {
        return origStderrWrite(chunk, encodingOrCallback);
      }
      if (typeof encodingOrCallback === "string") {
        return origStderrWrite(chunk, encodingOrCallback, callback);
      }
      return origStderrWrite(chunk);
    };
  }
} // fn: applyServerOptions

// -------------------------------------------------------------------------- //
// Type Definitions
// -------------------------------------------------------------------------- //

/**
 * Options for starting the NaNofuzz MCP server
 */
export type McpServerOptions = {
  workspace?: string;
  transport?: "stdio" | "sse";
  port?: number;
  modelProvider?: string;
  modelName?: string;
  modelKey?: string;
  modelEndpoint?: string;
  modelTimeout?: number;
  workers?: number | "auto";
  noConfigFile?: boolean;
  debug?: string | boolean;
  logFile?: string;
  clearCompileCache?: boolean;
};
