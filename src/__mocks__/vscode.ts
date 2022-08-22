import * as fs from "fs";
import { parse } from "path";

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
        let str = uri.toString();
        if (str.startsWith("file://")) {
          str = str.substring(7);
        }
        fs.readFile(str, (err, data) => {
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
export class Uri {
  private path: string;
  constructor(path: string) {
    this.path = path;
  }
  public static parse(...s: any[]): Uri {
    const str = s.map((e) => e.toString()).join("/");
    console.log("str: " + str);
    return new Uri(str.startsWith("file://") ? str : "file://" + str);
  }
  public static file(...s: any[]): Uri {
    return this.parse(...s);
  }
  public static joinPath(...s: any[]): Uri {
    return this.parse(...s);
  }
  public toString(): string {
    return this.path;
  }
}
