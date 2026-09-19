import * as JSON5 from "json5";
import {
  encode as msgpackEncode,
  decode as msgpackDecode,
} from "@msgpack/msgpack";
import { isBufferOrUint8Array, isKeyedObject, makeCanonicalSet } from "./Util";

/**
 * JSONN: JavaScript Object Notation for NaNofuzz
 *
 * Mostly a drop-in replacement for JSON5. Adds support for serializing
 * and unserializing `undefined`, `bigint`, and `Uint8Array`, including
 * within arrays and object members.
 *
 * While JSONN is valid JSON5 and might be parsed without error by JSON5,
 * the special types (`undefined`, `bigint`, and `Uint8Array`) will be
 * parsed inaccurately by the standard JSON5 library.
 *
 * The `pack` and `unpack` methods serialize to/from a binary MsgPack
 * format, which is MsgPack behind the scenes.
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
  const text = JSON5.stringify(
    value,
    replacer
      ? function (this: unknown, key: string, value: unknown): unknown {
          return jsonnReplacer.call(this, key, replacer.call(this, key, value));
        }
      : function (this: unknown, key: string, value: unknown): unknown {
          return jsonnReplacer.call(this, key, value);
        },
    space
  );
  return text;
}

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast()

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
    result = JSON5.parse(
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

  return cast<T>(result);
} // fn: parse()

/**
 * Packs a value into a MsgPack Uint8Array after sanitizing custom types.
 *
 * @param value The value to pack into MsgPack binary format.
 * @returns Uint8Array containing MsgPack binary data.
 */
export function pack(value: unknown): Uint8Array {
  return msgpackEncode(jsonnReplacerMsgpack(value));
} // fn: pack()

/**
 * Unpacks a MsgPack binary buffer back into a JavaScript value.
 *
 * @param buffer The MsgPack binary buffer to decode.
 * @returns The unpacked JavaScript value.
 */
export function unpack<T>(buffer: Uint8Array | ArrayBuffer | Buffer): T {
  const decoded = msgpackDecode(buffer);
  return cast<T>(jsonnReviverMsgpack(decoded));
} // fn: unpack()

/**
 * Recursively converts Sets, Maps, BigInts, and undefined values in an object structure
 * to MsgPack-serializable placeholders or native binary formats.
 *
 * @param val The value to sanitize
 * @returns Sanitized value suitable for MsgPack encoding
 */
function jsonnReplacerMsgpack(value: unknown): unknown {
  if (isBufferOrUint8Array(value)) {
    return value;
  }
  if (value instanceof Map) {
    return {
      [PlaceHolderMapKey]: Array.from(value.entries()).map(([k, v]) => [
        jsonnReplacerMsgpack(k),
        jsonnReplacerMsgpack(v),
      ]),
    };
  }
  if (value instanceof Set) {
    const canonical = makeCanonicalSet(Array.from(value.values()));
    return {
      [PlaceHolderSetKey]: Array.from(canonical.values()).map(
        jsonnReplacerMsgpack
      ),
    };
  }
  if (typeof value === "undefined") {
    return {
      [PlaceHolderValueKey]: UndefinedValue,
    };
  }
  if (typeof value === "bigint") {
    return {
      [PlaceHolderBigIntKey]: value.toString(),
    };
  }
  if (Array.isArray(value)) {
    return value.map(jsonnReplacerMsgpack);
  }
  if (value !== null && typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = jsonnReplacerMsgpack(v);
    }
    return obj;
  }
  return value;
} // fn: jsonnReplacerMsgpack()

/**
 * Recursively revives JSONN placeholders after MsgPack decoding.
 *
 * @param value The value decoded from MsgPack
 * @returns Revived JavaScript value with original types
 */
function jsonnReviverMsgpack(value: unknown): unknown {
  if (isBufferOrUint8Array(value)) {
    return value;
  }
  if (value !== null && typeof value === "object") {
    if (isKeyedObject(value) && value[PlaceHolderValueKey] === UndefinedValue) {
      return undefined;
    }
    if (
      isKeyedObject(value) &&
      typeof value[PlaceHolderBigIntKey] === "string"
    ) {
      return BigInt(String(value[PlaceHolderBigIntKey]));
    }
    if (
      isKeyedObject(value) &&
      Array.isArray(value[PlaceHolderUint8ArrayKey])
    ) {
      const arr = value[PlaceHolderUint8ArrayKey];
      return new Uint8Array(
        arr.filter((e): e is number => typeof e === "number")
      );
    }
    if (isKeyedObject(value) && Array.isArray(value[PlaceHolderMapKey])) {
      const rawEntries = value[PlaceHolderMapKey];
      const entries: Array<[unknown, unknown]> = [];
      for (const entry of rawEntries) {
        if (Array.isArray(entry) && entry.length === 2) {
          entries.push([
            jsonnReviverMsgpack(entry[0]),
            jsonnReviverMsgpack(entry[1]),
          ]);
        }
      }
      return new Map(entries);
    }
    if (isKeyedObject(value) && Array.isArray(value[PlaceHolderSetKey])) {
      const rawValues = value[PlaceHolderSetKey].map(jsonnReviverMsgpack);
      return makeCanonicalSet(rawValues);
    }
    if (Array.isArray(value)) {
      return value.map(jsonnReviverMsgpack);
    }
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = jsonnReviverMsgpack(v);
    }
    return obj;
  }
  return value;
} // fn: jsonnReviverMsgpack()

/**
 * Returns the stringified placeholder for a particular special value.
 *
 * @param _key 'undefined'
 * @returns stringified placeholder value
 */
export function getPlaceholder(_key: "undefined"): string {
  return `{${PlaceHolderValueKey}:'${UndefinedValue}'}`;
  //  return Undefined;
} // fn: getPlaceholder()

/**
 * Replaces special values with a JSONN placeholder
 *
 * @param `this` current object
 * @param `key` key into object
 * @param `value` value at object key
 * @returns the replacement value
 */
function jsonnReplacer(this: unknown, key: string, value: unknown): unknown {
  if (isBufferOrUint8Array(value)) {
    return {
      [PlaceHolderUint8ArrayKey]: Array.from(value),
    };
  }

  if (value instanceof Map) {
    return {
      [PlaceHolderMapKey]: Array.from(value.entries()),
    };
  }

  if (value instanceof Set) {
    return {
      [PlaceHolderSetKey]: Array.from(value.values()),
    };
  }

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (typeof value) {
    case "undefined":
      return {
        [PlaceHolderValueKey]: UndefinedValue,
      };
    case "bigint":
      return {
        [PlaceHolderBigIntKey]: value.toString(),
      };
    default:
      return value;
  }
} // fn: jsonnReplacer()

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
  if (isKeyedObject(value)) {
    if (value[PlaceHolderValueKey] === UndefinedValue) {
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
    if (typeof value[PlaceHolderBigIntKey] === "string") {
      return BigInt(String(value[PlaceHolderBigIntKey]));
    }
    if (Array.isArray(value[PlaceHolderUint8ArrayKey])) {
      const arr = value[PlaceHolderUint8ArrayKey];
      return new Uint8Array(
        arr.filter((e): e is number => typeof e === "number")
      );
    }
    if (Array.isArray(value[PlaceHolderMapKey])) {
      const rawEntries = value[PlaceHolderMapKey];
      const entries: Array<[unknown, unknown]> = [];
      for (const entry of rawEntries) {
        if (Array.isArray(entry) && entry.length === 2) {
          entries.push([entry[0], entry[1]]);
        }
      }
      return new Map(entries);
    }
    if (Array.isArray(value[PlaceHolderSetKey])) {
      const rawValues = value[PlaceHolderSetKey];
      return makeCanonicalSet(rawValues);
    }
  }
  return value;
} // fn: jsonnReviver()

type ReviveTarget = {
  key: string;
  value: unknown;
} & ({ obj: Record<string, unknown> } | { arr: unknown[] });

export const PlaceHolderValueKey = "____JSONN____61581952310____VALUE____";
export const PlaceHolderBigIntKey = "____JSONN____61581952310____BIGINT____";
export const PlaceHolderUint8ArrayKey =
  "____JSONN____61581952310____UINT8ARRAY____";
export const PlaceHolderMapKey = "____JSONN____61581952310____MAP____";
export const PlaceHolderSetKey = "____JSONN____61581952310____SET____";
export const UndefinedValue = "__undefined__";
