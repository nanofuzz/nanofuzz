import { AbstractProgram } from "./AbstractProgram";
import { ArgOptions } from "./Types";
import * as fs from "fs";
import { TypescriptProgram } from "./typescript/TypescriptProgram";
import { PythonProgram } from "./python/PythonProgram";

/**
 * Returns an AbstractProgram object for the given filename.
 * Note: Uses a caching strategy
 *
 * @param filename Path of the source file to load
 * @param options Argument options
 * @param parent Parent AbstractProgram parent object
 * @returns An AbstractProgram object
 */
export function fromFile(
  filename: string,
  lang?: ProgramLanguage,
  options?: ArgOptions,
  parent?: AbstractProgram
): AbstractProgram {
  if (filename !== "") {
    filename = require.resolve(filename);
  }
  const getSource = () => fs.readFileSync(filename).toString();
  return factory(filename, getSource, lang, options, parent);
} // fn: fromFile

/**
 * Returns an AbstractProgram object for the given source file.
 * Note: Uses a caching strategy
 *
 * @param getSource Function that returns program source code
 * @param lang Language of source code
 * @param filename Path of the source file to load
 * @param options Argument options
 * @param parent Parent AbstractProgram parent object
 * @returns An AbstractProgram object
 */
export function fromSource(
  getSource: () => string,
  lang: ProgramLanguage,
  filename?: string,
  options?: ArgOptions,
  parent?: AbstractProgram
): AbstractProgram {
  return factory(filename ?? "", getSource, lang, options, parent);
} // fn: fromSource

/**
 *
 * @param filename Path of the source file to load
 * @param getSource Function that returns program source code
 * @param lang Language of source code
 * @param options Argument options
 * @param parent Parent AbstractProgram parent object
 * @returns An AbstractProgram object
 */
export function fromFileAndSource(
  filename: string,
  getSource: () => string,
  lang?: ProgramLanguage,
  options?: ArgOptions,
  parent?: AbstractProgram
): AbstractProgram {
  if (filename !== "") {
    filename = require.resolve(filename);
  }
  return factory(filename, getSource, lang, options, parent);
} // fn: fromFileAndSource

/**
 * Uses an existing program with the same filename within the parent.
 * If not found then a new program is created.
 *
 * @param filename Path of the source file to load
 * @param getSource getSource Function that returns program source code
 * @param lang Language of source code
 * @param options Argument options
 * @param parent Parent AbstractProgram parent object
 * @returns an AbstractProgram represnting the profram
 */
function factory(
  filename: string,
  getSource: () => string,
  lang?: ProgramLanguage,
  options?: ArgOptions,
  parent?: AbstractProgram
): AbstractProgram {
  if (parent !== undefined && filename !== "") {
    const pgm = parent.find(filename);
    if (pgm) {
      return pgm;
    }
  }

  if (PythonProgram.understands({ filename, lang })) {
    return new PythonProgram(getSource, filename, options, parent);
  } else {
    return new TypescriptProgram(getSource, filename, options, parent);
  }
} // fn: factory

export type ProgramLanguage = "typescript" | "python" | "*";
