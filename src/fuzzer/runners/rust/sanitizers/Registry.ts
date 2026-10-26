import { RustSanitizerAdapter, SanitizerId } from "./Types";
import { NoneSanitizer } from "./NoneSanitizer";
import { BorrowSanitizer } from "./BorrowSanitizer";

const registry: Map<SanitizerId, RustSanitizerAdapter> = new Map();

/**
 * Initializes the sanitizer registry with known adapters.
 */
function initRegistry(): void {
  if (registry.size === 0) {
    registry.set("none", new NoneSanitizer());
    registry.set("borrow", new BorrowSanitizer());
  }
} // fn: initRegistry

function isSanitizerId(value: string): value is SanitizerId {
  return (
    value === "none" ||
    value === "borrow" ||
    value === "address" ||
    value === "thread" ||
    value === "memory"
  );
} // fn: isSanitizerId

/**
 * Resolves a sanitizer adapter by name. Throws an error if the name is unknown.
 *
 * @param name Sanitizer identifier (defaults to "none")
 * @returns The matching RustSanitizerAdapter instance
 */
export function getSanitizerAdapter(
  name: string = "none"
): RustSanitizerAdapter {
  initRegistry();
  const normalized = (name || "none").toLowerCase().trim();
  if (!isSanitizerId(normalized)) {
    const known = Array.from(registry.keys())
      .map((k) => `'${k}'`)
      .join(", ");
    throw new Error(
      `Unknown Rust sanitizer '${name}'. Supported sanitizers are: ${known}.`
    );
  }
  const adapter = registry.get(normalized);
  if (!adapter) {
    const known = Array.from(registry.keys())
      .map((k) => `'${k}'`)
      .join(", ");
    throw new Error(
      `Unknown Rust sanitizer '${name}'. Supported sanitizers are: ${known}.`
    );
  }
  return adapter;
} // fn: getSanitizerAdapter
