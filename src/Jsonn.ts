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

// -----------------------------------------------------------------------------
// Core Binary Packing and Unpacking
// -----------------------------------------------------------------------------

/**
 * Packs a value into a MsgPack Uint8Array after sanitizing custom types.
 *
 * @param value The value to pack into MsgPack binary format.
 * @param replacer An optional replacer function to filter or transform
 *        properties in the same pass prior to serialization.
 * @returns Uint8Array containing MsgPack binary data.
 */
export function pack(
  value: unknown,
  replacer?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | null
    | undefined
): Uint8Array {
  const sanitized = jsonnReplacerMsgpack({ "": value }, "", value, replacer);
  return msgpackEncode(sanitized);
} // fn: pack()

/**
 * Packs a value into a binary string for fast ephemeral equality and Set
 * uniqueness checks.
 *
 * @param value The value to pack into binary string format.
 * @param replacer Optional replacer function to filter or transform
 *        properties prior to packing.
 * @returns Binary string representation of the packed value.
 */
export function packString(
  value: unknown,
  replacer?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | null
    | undefined
): string {
  const packed = pack(value, replacer);
  return Buffer.from(
    packed.buffer,
    packed.byteOffset,
    packed.byteLength
  ).toString("binary");
} // fn: packString()

/**
 * Unpacks a MsgPack binary buffer back into a JavaScript value.
 *
 * @param buffer The MsgPack binary buffer to decode.
 * @param reviver Optional reviver function to transform parsed values in the
 *        same pass after decoding.
 * @returns The unpacked JavaScript value.
 */
export function unpack<T>(
  buffer: Uint8Array | ArrayBuffer | Buffer,
  reviver?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | null
    | undefined
): T {
  const decoded = msgpackDecode(buffer);
  return cast<T>(jsonnReviverMsgpack({ "": decoded }, "", decoded, reviver));
} // fn: unpack()

// -----------------------------------------------------------------------------
// File I/O
// -----------------------------------------------------------------------------

function getFs(): typeof import("node:fs") {
  const req = typeof require !== "undefined" ? require : undefined;
  if (!req) {
    throw new Error("File I/O is not supported in this environment");
  }
  const mod = "fs";
  return req(mod);
}

function getPath(): typeof import("node:path") {
  const req = typeof require !== "undefined" ? require : undefined;
  if (!req) {
    throw new Error("File I/O is not supported in this environment");
  }
  const mod = "path";
  return req(mod);
}

/**
 * Serializes and writes a JavaScript value to disk, automatically selecting
 * human-readable text (JSONN formatted with indentation) or binary MsgPack
 * based on the file extension. Creates parent directories if needed.
 *
 * @param filePath Path to the file to write.
 * @param value The JavaScript value to serialize and write.
 * @param replacer Optional replacer function for serialization.
 * @param space Indentation spaces for text format (default: 2).
 */
export function toFile(
  filePath: string,
  value: unknown,
  replacer?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | null
    | undefined,
  space: string | number = 0
): void {
  const nodeFs = getFs();
  const nodePath = getPath();
  const dir = nodePath.dirname(filePath);
  if (!nodeFs.existsSync(dir)) {
    nodeFs.mkdirSync(dir, { recursive: true });
  }

  if (isTextFilename(filePath)) {
    nodeFs.writeFileSync(filePath, stringify(value, replacer, space), "utf-8");
  } else {
    nodeFs.writeFileSync(filePath, pack(value, replacer));
  }
} // fn: toFile()

/**
 * Reads and deserializes a file from disk into a JavaScript value,
 * automatically detecting whether to parse as text (JSONN/JSON/JSON5/TXT)
 * or decode as binary (MsgPack) based on the file extension.
 *
 * @param filePath Path to the file to read.
 * @param reviver Optional custom reviver function for text parsing.
 * @returns Deserialized JavaScript value.
 */
export function fromFile<T = unknown>(
  filePath: string,
  reviver?: (this: unknown, key: string, value: unknown) => unknown
): T {
  const nodeFs = getFs();
  if (isTextFilename(filePath)) {
    const raw = nodeFs.readFileSync(filePath, "utf-8");
    return parse<T>(raw, reviver);
  } else {
    const raw = nodeFs.readFileSync(filePath);
    return unpack<T>(raw, reviver);
  }
} // fn: fromFile()

// -----------------------------------------------------------------------------
// Helper and Utility Functions
// -----------------------------------------------------------------------------

/**
 * Returns true if the file path has a human-readable text-based extension
 * (.json, .json5, .jsonn, .txt, .text), indicating it should be formatted
 * as text rather than MessagePack binary.
 *
 * @param filePath The file path or filename to check.
 * @returns true if text format; false for binary (e.g. .msgpack, .mpk, .jsonnb).
 */
export function isTextFilename(filePath: string): boolean {
  return /\.(json|json5|jsonn|txt|text)$/i.test(filePath);
}

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast()

/**
 * Recursively converts Sets, Maps, BigInts, and undefined values in an object structure
 * to MsgPack-serializable placeholders, applying any user-provided replacer in the
 * same single pass.
 *
 * @param holder The container object holding the property.
 * @param key The key or index in the container.
 * @param value The value to sanitize.
 * @param replacer Optional replacer function to filter or transform values.
 * @returns Sanitized value suitable for MsgPack encoding.
 */
function jsonnReplacerMsgpack(
  holder: unknown,
  key: string,
  value: unknown,
  replacer?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | null
    | undefined
): unknown {
  const current = replacer ? replacer.call(holder, key, value) : value;

  if (isBufferOrUint8Array(current)) {
    return current;
  }
  if (current instanceof Map) {
    return {
      [PlaceHolderMapKey]: Array.from(current.entries()).map(([k, v]) => [
        jsonnReplacerMsgpack(current, String(k), k, replacer),
        jsonnReplacerMsgpack(current, String(k), v, replacer),
      ]),
    };
  }
  if (current instanceof Set) {
    const canonical = makeCanonicalSet(Array.from(current.values()));
    return {
      [PlaceHolderSetKey]: Array.from(canonical.values()).map((v) =>
        jsonnReplacerMsgpack(current, "", v, replacer)
      ),
    };
  }
  if (typeof current === "undefined") {
    return {
      [PlaceHolderValueKey]: UndefinedValue,
    };
  }
  if (typeof current === "bigint") {
    return {
      [PlaceHolderBigIntKey]: current.toString(),
    };
  }
  if (Array.isArray(current)) {
    return current.map((item, index) =>
      jsonnReplacerMsgpack(current, String(index), item, replacer)
    );
  }
  if (current !== null && typeof current === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(current)) {
      obj[k] = jsonnReplacerMsgpack(current, k, v, replacer);
    }
    return obj;
  }
  return current;
} // fn: jsonnReplacerMsgpack()

/**
 * Recursively revives JSONN placeholders after MsgPack decoding, applying any
 * user-provided reviver function in the same single bottom-up pass.
 *
 * @param holder The container object holding the property.
 * @param key The key or index in the container.
 * @param value The value decoded from MsgPack.
 * @param reviver Optional reviver function to transform revived values.
 * @returns Revived JavaScript value with original types.
 */
function jsonnReviverMsgpack(
  holder: unknown,
  key: string,
  value: unknown,
  reviver?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | null
    | undefined
): unknown {
  let revived: unknown = value;

  if (isBufferOrUint8Array(value)) {
    revived = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (value !== null && typeof value === "object") {
    if (isKeyedObject(value) && value[PlaceHolderValueKey] === UndefinedValue) {
      revived = undefined;
    } else if (
      isKeyedObject(value) &&
      typeof value[PlaceHolderBigIntKey] === "string"
    ) {
      revived = BigInt(String(value[PlaceHolderBigIntKey]));
    } else if (
      isKeyedObject(value) &&
      Array.isArray(value[PlaceHolderUint8ArrayKey])
    ) {
      const arr = value[PlaceHolderUint8ArrayKey];
      revived = new Uint8Array(
        arr.filter((e): e is number => typeof e === "number")
      );
    } else if (
      isKeyedObject(value) &&
      Array.isArray(value[PlaceHolderMapKey])
    ) {
      const rawEntries = value[PlaceHolderMapKey];
      const entries: Array<[unknown, unknown]> = [];
      for (const entry of rawEntries) {
        if (Array.isArray(entry) && entry.length === 2) {
          entries.push([
            jsonnReviverMsgpack(rawEntries, "", entry[0], reviver),
            jsonnReviverMsgpack(rawEntries, "", entry[1], reviver),
          ]);
        }
      }
      revived = new Map(entries);
    } else if (
      isKeyedObject(value) &&
      Array.isArray(value[PlaceHolderSetKey])
    ) {
      const rawValues = value[PlaceHolderSetKey].map((v) =>
        jsonnReviverMsgpack(value, "", v, reviver)
      );
      revived = makeCanonicalSet(rawValues);
    } else if (Array.isArray(value)) {
      revived = value.map((item, index) =>
        jsonnReviverMsgpack(value, String(index), item, reviver)
      );
    } else {
      const obj = isKeyedObject(value) ? value : {};
      for (const [k, v] of Object.entries(value)) {
        obj[k] = jsonnReviverMsgpack(value, k, v, reviver);
      }
      revived = obj;
    }
  }

  if (typeof reviver === "function") {
    return reviver.call(holder, key, revived);
  }
  return revived;
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
