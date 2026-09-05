import pkg from "../package.json";
import vscode from "vscode";

// Are we actually running in vscode, or is this the shim?
const notReallyVscode = "isShim" in vscode;

// Temporary config overrides (e.g., from CLI)
const overrides: Record<string, unknown> = {};

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

// Gets the current configuratio value
export function get<T>(key: string, dft: T): T {
  if (key in overrides) {
    return overrides[key] as T;
  }

  if (notReallyVscode) {
    if (key in cfg) {
      return cfg[key] as T;
    } else {
      return dft;
    }
  } else {
    const tokens = key.split(".");
    return vscode.workspace
      .getConfiguration(tokens.slice(0, -1).join("."))
      .get<T>(tokens.at(-1)!, dft);
  }
}

// Temporarily override a config value (e.g., if running from CLI)
export function override<T>(key: string, val: T): void {
  overrides[key] = val;
}
