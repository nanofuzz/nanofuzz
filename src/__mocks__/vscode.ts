import * as fs from "fs";

/**
 * This is a mock that allows jest to unit test NaNofuzz
 * modules that use the vscode API (i.e., for configuration data).
 *
 * If we eliminate jest and test inside VSCode, it may be possible
 * to remove this.
 */
export const workspace = {
  getConfiguration: (k: string) => {
    return {
      get: (k: string, dft: any) => dft, // Always return the default value
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
  private _uriString: string;
  constructor(uriString: string) {
    this._uriString = uriString;
    console.log("Constructe new Uri: " + uriString); // !!!!
  }
  public static parse(...s: any[]): Uri {
    const str = s.map((e) => e.toString()).join("/");
    console.log("parse str: " + str);
    return new this(str.startsWith("file://") ? str : "file://" + str);
  }
  public static file(...s: any[]): Uri {
    return this.parse(...s);
  }
  public static joinPath(...s: any[]): Uri {
    return this.parse(...s);
  }
  public toString(): string {
    return this._uriString;
  }
}
