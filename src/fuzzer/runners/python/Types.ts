export type PythonEnv = {
  env: { [k: string]: string | undefined };
  libs: string | undefined | null;
  interpreter: string;
  paths: readonly string[];
  venv?: {
    activateCmd: string;
    path: string;
    interpreter: string;
  };
};
