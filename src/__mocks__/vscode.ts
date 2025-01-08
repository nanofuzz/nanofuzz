/**
 * This is a workaround to use jest to unit test NaNofuzz
 * modules that use vscode to store configuration data.
 *
 * If we eliminate jest and test inside VSCode, we can
 * remove this.
 */
export const workspace = {
  getConfiguration: (k: string) => {
    return {
      get: (k: string, dft?: string | number | boolean | undefined) => dft,
    };
  },
};
