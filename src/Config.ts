import pkg from "../package.json";
import vscode from "vscode";

// Are we actually running in vscode, or is this the shim?
const notReallyVscode = "isShim" in vscode;

// Temporary config overrides (e.g., from CLI)
const overrides: Record<string, unknown> = {};

// Change listener callbacks
const changeListeners: (() => void)[] = [];

// ============================================================================
// Public Interface
// ============================================================================

// Gets the current configuratio value
export function get<T>(key: string, dft: T): T {
  if (key in overrides) {
    return cast<T>(overrides[key]);
  }

  if (notReallyVscode) {
    if (key in cfg) {
      return cast<T>(cfg[key]);
    } else {
      return dft;
    }
  } else {
    const tokens = key.split(".");
    return vscode.workspace
      .getConfiguration(tokens.slice(0, -1).join("."))
      .get<T>(tokens.at(-1)!, dft);
  }
} // fn: get

// Temporarily override a config value (e.g., if running from CLI)
export function override<T>(key: string, val: T): void {
  overrides[key] = val;
  notifyConfigChange();
} // fn: override

// Clear all temporary overrides
export function clearOverrides(): void {
  for (const key of Object.keys(overrides)) {
    delete overrides[key];
  }
  notifyConfigChange();
} // fn: clearOverrides

/**
 * Registers a listener to be called when configuration or overrides change.
 * @returns unsubscribe function
 */
export function onConfigChange(listener: () => void): () => void {
  changeListeners.push(listener);
  return () => {
    const idx = changeListeners.indexOf(listener);
    if (idx !== -1) changeListeners.splice(idx, 1);
  };
} // fn: onConfigChange

// ============================================================================
// Helpers & Initialization
// ============================================================================

// Load defaults and config ids from `package.json`
const cfg: Record<string, unknown> = {};
pkg.contributes.configuration.forEach((area) => {
  let key: keyof typeof area.properties;
  for (key in area.properties) {
    const prop = area.properties[key]!;
    if ("default" in prop) {
      cfg[key] = cfg[key] = prop.default;
    }
  }
});

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast

function notifyConfigChange(): void {
  changeListeners.forEach((l) => l());
} // fn: notifyConfigChange

if (!notReallyVscode && vscode.workspace?.onDidChangeConfiguration) {
  vscode.workspace.onDidChangeConfiguration(() => {
    notifyConfigChange();
  });
}
