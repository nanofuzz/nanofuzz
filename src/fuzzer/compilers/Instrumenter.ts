import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { AbstractMeasure } from "../measures/AbstractMeasure";
import { FuzzStatusUpdater } from "../Types";

/**
 * Instruments source files with a given set of measures.
 */
export class Instrumenter {
  /**
   * Computes a unique deterministic hash for a given set of active measures.
   */
  public static getMeasureHash(measures: AbstractMeasure[]): string {
    if (measures.length === 0) return "uninstrumented";
    const names = measures
      .map((m) => m.name)
      .sort()
      .join("+");
    return crypto.createHash("md5").update(names).digest("hex").substring(0, 8);
  } // fn: getMeasureHash()

  /**
   * Returns the instrumented destination path for a clean JS file under a given measure set.
   */
  public static getInstrumentedPath(
    target: string,
    tmpDir: string,
    measureHash: string
  ): string {
    if (measureHash === "uninstrumented") return target;

    const relative = path.relative(tmpDir, target);
    return path.resolve(path.join(tmpDir, `inst-${measureHash}`, relative));
  } // fn: getInstrumentedPath()

  /**
   * Batch-instruments the target entry file and ALL its compiled dependencies,
   * ensuring every required module exists on disk before execution.
   */
  public static prepareInstrumentedTree(
    targetEntry: string,
    dependencyPaths: string[],
    measures: AbstractMeasure[],
    tmpDir: string,
    updateFn?: FuzzStatusUpdater
  ): string {
    const measureHash = Instrumenter.getMeasureHash(measures);
    if (measureHash === "uninstrumented" || measures.length === 0) {
      return targetEntry;
    }

    const allFiles = Array.from(new Set([targetEntry, ...dependencyPaths]));

    for (const cleanPath of allFiles) {
      if (!fs.existsSync(cleanPath)) continue;

      const instPath = Instrumenter.getInstrumentedPath(
        cleanPath,
        tmpDir,
        measureHash
      );
      const cleanMtime = fs.statSync(cleanPath).mtimeMs;

      // Check if instrumented file exists and is up to date relative to clean JS
      const isStale =
        !fs.existsSync(instPath) || fs.statSync(instPath).mtimeMs < cleanMtime;

      if (isStale) {
        // Compute clean user-facing path by stripping the temporary compilation directory prefix
        let displayPath = path.relative(tmpDir, cleanPath);
        displayPath = displayPath.replace(/^inst-[^/\\]+[/\\]?/, "");
        if (process.platform === "win32") {
          if (/^[a-zA-Z][/\\]/.test(displayPath)) {
            displayPath =
              displayPath.charAt(0) + ":" + displayPath.substring(1);
          }
        } else {
          if (!displayPath.startsWith("/")) {
            displayPath = "/" + displayPath;
          }
        }
        displayPath = path.normalize(displayPath);

        // Provide feedback that we are instrumenting
        if (updateFn) {
          updateFn({
            msg: ` - Instrument: ${displayPath}`,
            channel: "milestone",
          });
          updateFn({
            msg: `Instrumenting: ${displayPath}`,
            channel: "update",
            pct: 0.1,
          });
        }
        fs.mkdirSync(path.dirname(instPath), { recursive: true });

        // Copy source map if present
        const mapPath = cleanPath + ".map";
        if (fs.existsSync(mapPath)) {
          const instMapPath = instPath + ".map";
          fs.copyFileSync(mapPath, instMapPath);
        }

        // Apply measure transformations
        let src = fs.readFileSync(cleanPath, "utf8");
        for (const measure of measures) {
          src = measure.onAfterCompile(src, instPath);
        }

        fs.writeFileSync(instPath, src, "utf8");
      }
    }

    return Instrumenter.getInstrumentedPath(targetEntry, tmpDir, measureHash);
  } // fn: prepareInstrumentedTree()
} // class: Instrumenter
