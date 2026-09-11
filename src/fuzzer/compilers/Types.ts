export type CompilerStaleness =
  | false
  | "notcompiled"
  | "sourcechanged"
  | "compilerchanged"
  | "configchanged";
