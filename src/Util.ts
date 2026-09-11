import { FuzzValueOrigin } from "./fuzzer/Types";
import * as JSONN from "./Jsonn";

/**
 * Type guard function that returns true if the input object
 * has properties "message" and "stack" typed as string.
 * This function is primarily for checking whether `unknown`
 * exception types have the message and stack fields.
 *
 * @param obj the object to check
 * @returns type guard if `obj` has `message`, `stack`, and `name` properties of type `string`
 */
export function isError(obj: unknown): obj is Error {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    "message" in obj &&
    "stack" in obj &&
    "name" in obj &&
    typeof obj.message === "string" &&
    typeof obj.stack === "string" &&
    typeof obj.name === "string"
  );
} // fn: isError

/*
 * Extracts an error message from an unknown exception value.
 *
 * If the value is an Error-like object (has message and stack),
 * returns the message. Otherwise, stringifies the value using JSONN.
 *
 * @param e the exception value to extract a message from
 *
 * @returns the error message string
 */
export function getErrorMessageOrJson(e: unknown): string {
  return isError(e) ? e.message : JSONN.stringify(e);
} // fn: getErrorMessageOrJson

/**
 * Recursively freeze each non-primitive property (deep freeze) while also
 * checking for cycles to avoid infinite recursion.
 *
 * Adapted from MDN articles:
 *   https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze
 *   https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakSet#detecting_circular_references
 *
 * @param o T object to deep freeze
 * @returns the same object, but now frozen
 */
export function deepFreeze<T extends object>(o: T, _refs = new WeakSet()): T {
  // Avoid infinite recursion
  if (_refs.has(o)) {
    return o;
  }

  // Retrieve the property names defined on object
  const propNames = Reflect.ownKeys(o);

  // Freeze properties before freezing self
  let name: string | symbol;
  for (name of propNames) {
    const value = Reflect.get(o, name);

    if ((value && typeof value === "object") || typeof value === "function") {
      _refs.add(o);
      deepFreeze(value);
      _refs.delete(o);
    }
  }

  return Object.freeze(o);
}

/**
 * Constructs a new JavaScript Set whose elements are sorted in canonical
 * order based on their stringified JSONN representation.
 */
export function makeCanonicalSet<T>(elements: Iterable<T>): Set<T> {
  const items = Array.from(elements);
  items.sort((a, b) => {
    const strA = JSONN.stringify(a);
    const strB = JSONN.stringify(b);
    return strA < strB ? -1 : strA > strB ? 1 : 0;
  });
  return new Set(items);
}

/**
 * Type guard function that returns true if `obj` has keys
 *
 * @param `obj` the object to check
 * @returns true if `obj` has keys, false otherwise
 */
export function isKeyedObject(obj: unknown): obj is Record<string, unknown> {
  return (
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    Object.keys(obj).length > 0
  );
} // fn: isKeyedObject

/**
 * Unwraps transformer origins to return the underlying base origin.
 *
 * @param origin the FuzzValueOrigin to unwrap
 * @returns the non-transformer base FuzzValueOrigin
 */
export function getBaseOrigin(
  origin: FuzzValueOrigin
): Exclude<FuzzValueOrigin, { type: "transformer" }> {
  if (origin.type === "transformer") {
    return getBaseOrigin(origin.basis.source);
  }
  return origin;
}

/**
 * Removes tick metadata from a MutationInputGenerator origin,
 * unwrapping transformer origins as necessary.
 *
 * @param origin the FuzzValueOrigin from which to remove tick
 */
export function removeTickFromOrigin(origin: FuzzValueOrigin): void {
  if (
    origin.type === "generator" &&
    origin.generator === "MutationInputGenerator"
  ) {
    delete origin.tick;
  } else if (origin.type === "transformer") {
    removeTickFromOrigin(origin.basis.source);
  }
}

/**
 * Encodes control characters and backslashes in a string to printable escape sequences
 * (e.g. newline -> \n, tab -> \t, backslash -> \\).
 */
export function encodeEscapeSequences(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    switch (char) {
      case "\\":
        result += "\\\\";
        break;
      case "\n":
        result += "\\n";
        break;
      case "\r":
        result += "\\r";
        break;
      case "\t":
        result += "\\t";
        break;
      case "\0":
        result += "\\0";
        break;
      default:
        result += char;
        break;
    }
  }
  return result;
}

/**
 * Decodes printable escape sequences in a string back to their raw character equivalents
 * (e.g. \n -> newline, \t -> tab, \\ -> backslash, \u{1F600} -> 😀, \x41 -> A).
 */
export function decodeEscapeSequences(str: string): string {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\\" && i + 1 < str.length) {
      const rest = str.slice(i + 1);

      // 1. Unicode code point escape \u{HEX}
      const unicodeHexMatch = rest.match(/^u\{([0-9a-fA-F]+)\}/);
      if (unicodeHexMatch) {
        const cp = parseInt(unicodeHexMatch[1], 16);
        if (!isNaN(cp)) {
          result += String.fromCodePoint(cp);
          i += 1 + unicodeHexMatch[0].length;
          continue;
        }
      }

      // 2. Unicode 4-hex escape \uXXXX or 2-hex escape \xXX
      const hexMatch = rest.match(/^(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/);
      if (hexMatch) {
        const hex = hexMatch[1] ?? hexMatch[2];
        const cp = parseInt(hex, 16);
        if (!isNaN(cp)) {
          result += String.fromCodePoint(cp);
          i += 1 + hexMatch[0].length;
          continue;
        }
      }

      // 3. Single-character escape sequences (\n, \r, \t, \0, \\)
      const next = str[i + 1];
      switch (next) {
        case "\\":
          result += "\\";
          i += 2;
          break;
        case "n":
          result += "\n";
          i += 2;
          break;
        case "r":
          result += "\r";
          i += 2;
          break;
        case "t":
          result += "\t";
          i += 2;
          break;
        case "0":
          result += "\0";
          i += 2;
          break;
        default:
          result += "\\" + next;
          i += 2;
          break;
      }
    } else {
      result += str[i++];
    }
  }
  return result;
}

/**
 * Type guard for Uint8Array or Buffer across Node and Webview environments.
 */
export function isBufferOrUint8Array(val: unknown): val is Uint8Array {
  return (
    val instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(val))
  );
}

/**
 * Converts a hex string to a Uint8Array in both Node and Webview environments.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(hex, "hex"));
  }
  const cleanHex = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes = new Uint8Array(Math.floor(cleanHex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Converts a base64 string to a Uint8Array in both Node and Webview environments.
 */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Converts a Uint8Array to a base64 string in both Node and Webview environments.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
