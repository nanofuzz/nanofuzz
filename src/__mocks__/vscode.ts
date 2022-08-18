import * as fs from "fs";

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
      get: (k: string, dft?: any) => dft,
    };
  },
  fs: {
    readFile: async (uri: any): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        fs.readFile(uri, (err, data) => {
          if (err) {
            reject(err);
          } else {
            resolve(data.toString());
          }
        });
      });
    },
  },
};
export const Uri = {
  parse: (s: any): any => s,
};
