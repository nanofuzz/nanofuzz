import { FuzzValueOrigin } from "./fuzzer/Types";

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

