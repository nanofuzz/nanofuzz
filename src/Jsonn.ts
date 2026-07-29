import * as JSON5 from "json5";
import { isKeyedObject } from "./Util";

/**
 * JSONN: JavaScript Object Notation for NaNofuzz
 *
 * Mostly a drop-in replacement for JSON5. Adds support for serializing
 * and unserializing `undefined`, including in arrays and object members.
 *
 * While JSONN is valid JSON5 and might be parsed ok by JSON5, `undefined`
 * values will be parsed inaccurately by the standard JSON5 library.
 *
 * JSONN output includes the predicate above.
 */

/**
 * Converts a JavaScript value to a JSONN string.
 *
 * @param `value` The value to convert to a JSONN string.
 * @param `replacer` A function that alters the behavior of the
 *         stringification process. If this value is null or not
 *         provided, all properties of the object are included in
 *         the resulting JSONN string.
 * @param `space` A String or Number object that's used to insert
 *        white space into the output JSON5 string for readability
 *        purposes. If this is a Number, it indicates the number of
 *        space characters to use as white space; this number is
 *        capped at 10 (if it is greater, the value is just 10).
 *        Values less than 1 indicate that no space should be used.
 *        If this is a String, the string (or the first 10 characters
 *        of the string, if it's longer than that) is used as white
 *        space. If this parameter is not provided (or is null), no
 *        white space is used. If white space is used, trailing
 *        commas will be used in objects and arrays.
 * @returns The JSONN string converted from the JavaScript value.
 */
export function stringify(
  value: unknown,
  replacer?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | null
    | undefined,
  space?: string | number | null | undefined
): string {
  const stats: JsonnStats = { replacements: false };
  const text = JSON5.stringify(
    value,
    replacer
      ? function (this: unknown, key: string, value: unknown): unknown {
          return jsonnReplacer.call(
            this,
            key,
            replacer.call(this, key, value),
            stats
          );
        }
      : function (this: unknown, key: string, value: unknown): unknown {
          return jsonnReplacer.call(this, key, value, stats);
        },
    space
  );
  return text;
}

/**
 * Parses a JSONN string and constructing a JavaScript value or object
 * described by the string.
 *
 * @param `text` The string to parse as JSONN
 * @param `reviver` A function that prescribes how the value originally
 *        produced by parsing is transformed before being returned.
 * @returns The JavaScript value converted from the JSONN string
 */
export function parse<T>(
  text: string,
  reviver?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | null
    | undefined
): T {
  let result: unknown;
  if (text.trim() === "undefined") {
    result = undefined;
  } else {
    // Parse the data while keeping a list of any values we need to replace.
    // We do this in two steps because JSON5 strips `undefined` AFTER revive.
    const valuesToRevive: ReviveTarget[] = [];
    result = JSON5.parse<T>(
      text,
      reviver
        ? function (this: unknown, key: string, value: unknown): unknown {
            return reviver.call(
              this,
              key,
              jsonnReviver.call(this, key, value, valuesToRevive)
            );
          }
        : function (this: unknown, key: string, value: unknown): unknown {
            return jsonnReviver.call(this, key, value, valuesToRevive);
          }
    );

    // Now replace the values we kept track of
    valuesToRevive.forEach((t) => {
      if ("obj" in t) {
        t.obj[t.key] = t.value;
      } else {
        t.arr[Number(t.key)] = t.value;
      }
    });
  }

  return result as T;
}

/**
 * Returns the stringified placeholder for a particular special value.
 *
 * @param _key 'undefined'
 * @returns stringified placeholder value
 */
export function getPlaceholder(_key: "undefined"): string {
  return `{${PlaceHolderKey}:'${UndefinedKey}'}`;
  //  return Undefined;
}

/**
 * Replaces special values with a JSONN placeholder
 *
 * @param `this` current object
 * @param `key` key into object
 * @param `value` value at object key
 * @returns the replacement value
 */
function jsonnReplacer(
  this: unknown,
  key: string,
  value: unknown,
  stats: JsonnStats
): unknown {
  if (value === undefined) {
    stats.replacements = true;
    return {
      [PlaceHolderKey]: UndefinedKey,
    };
  }
  return value;
}

/**
 * Makes a list of object keys that need values rerplaced.
 * This second pass is required because JSON5 strips undefined
 * values after the revive process.
 *
 * @param `this` current object
 * @param `key` key into object
 * @param `value` value at object key
 * @param `targets` array of objects and keys to replace with values
 * @returns the replacement value (but usually the input value)
 */
function jsonnReviver(
  this: unknown,
  key: string,
  value: unknown,
  targets: ReviveTarget[]
): unknown {
  if (
    isKeyedObject(value) &&
    PlaceHolderKey in value &&
    value[PlaceHolderKey] === UndefinedKey
  ) {
    if (key === "") {
      return undefined;
    } else {
      if (Array.isArray(this)) {
        targets.push({ arr: this, key, value: undefined });
      } else if (isKeyedObject(this)) {
        targets.push({ obj: this, key, value: undefined });
      }
    }
  }
  return value;
}

type ReviveTarget = {
  key: string;
  value: unknown;
} & ({ obj: Record<string, unknown> } | { arr: unknown[] });

type JsonnStats = { replacements: boolean };

const PlaceHolderKey = "____JSONN____61581952310____VALUE____";
const UndefinedKey = "__undefined__";
