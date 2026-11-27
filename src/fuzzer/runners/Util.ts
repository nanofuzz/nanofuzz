import { RunnerResultItem } from "./Types";

/**
 * Type guard for RunnerResultItem.
 */
export function isRunnerResultItem(item: unknown): item is RunnerResultItem {
  if (typeof item !== "object" || item === null) return false;
  const tag = Reflect.get(item, "tag");
  return (
    tag === "value" || tag === "error" || tag === "skip" || tag === "timeout"
  );
} // fn: isRunnerResultItem
