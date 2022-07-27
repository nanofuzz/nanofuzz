import * as vscode from "vscode";
import * as fuzzer from "../fuzzer/Fuzzer";
import * as util from "./Utils";
import { htmlEscape } from "escape-goat";

/**
 * Manages cat coding webview panels !!!
 */
export class FuzzPanel {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   * !!!
   */
  public static currentPanels: Record<string, FuzzPanel> = {};

  public static readonly viewType = "fuzz";

  private readonly _panel: vscode.WebviewPanel; // !!!
  private readonly _extensionUri: vscode.Uri; // !!!
  private _disposables: vscode.Disposable[] = []; // !!!
  private _fuzzEnv: fuzzer.FuzzEnv; // !!!

  // !!!
  public getFnRefKey(): string {
    return JSON.stringify(this._fuzzEnv.function.getRef());
  }

  // !!!
  public static render(extensionUri: vscode.Uri, env: fuzzer.FuzzEnv): void {
    const fnRef = JSON.stringify(env.function.getRef());

    // If we already have a panel for this fuzz env, show it.
    if (fnRef in FuzzPanel.currentPanels) {
      FuzzPanel.currentPanels[fnRef]._panel.reveal();
    } else {
      // Otherwise, create a new panel.
      const panel = vscode.window.createWebviewPanel(
        FuzzPanel.viewType,
        `Fuzz: ${env.function.getName()}`,
        vscode.ViewColumn.Two, // !!!
        FuzzPanel.getWebviewOptions(extensionUri)
      );

      // Register the panel
      FuzzPanel.currentPanels[fnRef] = new FuzzPanel(panel, extensionUri, env);
    }
  }

  // !!!
  public static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    env: fuzzer.FuzzEnv
  ): void {
    FuzzPanel.currentPanels[JSON.stringify(env.function.getRef())] =
      new FuzzPanel(panel, extensionUri, env);
  }

  public static getWebviewOptions(
    extensionUri: vscode.Uri
  ): vscode.WebviewOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,

      // And restrict the webview to only loading content from our extension's `media` directory.
      // !!! localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    };
  }

  // !!!
  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    env: fuzzer.FuzzEnv
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._fuzzEnv = env;

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(
      () => {
        this.dispose();
      },
      null,
      this._disposables
    );

    // Update the content based on view changes
    /*
    this._panel.onDidChangeViewState(
      (e) => {
        if (this._panel.visible) {
          this._update();
        }
      },
      null,
      this._disposables
    );*/

    // Handle messages from the webview
    this._setWebviewMessageListener(this._panel.webview);

    // Set the webview's initial html content
    this._panel.webview.html = this._getWebviewContent(
      this._panel.webview,
      extensionUri
    );
  }

  // !!!
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: FuzzPanelMessage) => {
        const { command, json } = message;

        switch (command) {
          case "fuzz.start": {
            vscode.window.showInformationMessage(json);

            const panelInput = JSON.parse(json);
            const argsFlat = this._fuzzEnv.function.getArgDefsFlat();
            for (const i in panelInput.args) {
              const thisOverride = panelInput.args[i];
              const thisArg: fuzzer.ArgDef<fuzzer.ArgType> = argsFlat[i];
              if (Number(i) + 1 > argsFlat.length)
                throw new Error(
                  `FuzzPanel input has ${panelInput.args.length} but the function has ${argsFlat.length}`
                );

              // Min and max values
              if (
                thisOverride.min !== undefined &&
                thisOverride.max !== undefined
              ) {
                switch (thisArg.getType()) {
                  case fuzzer.ArgTag.NUMBER:
                    thisArg.setIntervals([
                      {
                        min: Number(thisOverride.min),
                        max: Number(thisOverride.max),
                      },
                    ]);
                    break;
                  case fuzzer.ArgTag.BOOLEAN:
                    thisArg.setIntervals([
                      {
                        min: !!thisOverride.min,
                        max: !!thisOverride.max,
                      },
                    ]);
                    break;
                  case fuzzer.ArgTag.STRING:
                    thisArg.setIntervals([
                      {
                        min: thisOverride.min.toString(),
                        max: thisOverride.max.toString(),
                      },
                    ]);
                    break;
                }
              }

              // String length min and max
              if (
                thisOverride.minStrLen !== undefined &&
                thisOverride.maxStrLen !== undefined
              ) {
                thisArg.setOptions({
                  strLength: {
                    min: Number(thisOverride.min),
                    max: Number(thisOverride.max),
                  },
                });
              }
            }

            const results = await fuzzer.fuzz(this._fuzzEnv);
            const pass = results.results.reduce(
              (sum: number, e: fuzzer.FuzzTestResult) =>
                e.passed ? sum + 1 : sum,
              0
            );
            const fail = results.results.length - pass;
            const icon = fail === 0 ? "$(pass)" : "$(error)";

            // Display the results in a new editor (TODO: user report goes here)
            vscode.workspace
              .openTextDocument({
                language: "json",
                content: JSON.stringify(results, null, 2),
              })
              .then((doc) => {
                vscode.window.showTextDocument(doc);
              });
            return;
          }
        }
      },
      undefined,
      this._disposables
    );
  }

  // !!! remove
  /*
  public doRefactor(): void {
    // Send a message to the webview webview.
    // You can send any JSON serializable data.
    this._panel.webview.postMessage({ command: "refactor" });
  }*/

  // !!!
  public dispose(): void {
    // Remove this panel from the list of current panels.
    delete FuzzPanel.currentPanels[this.getFnRefKey()];

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  // !!!
  private _getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri
  ): string {
    const toolkitUri = util.getUri(webview, extensionUri, [
      "node_modules",
      "@vscode",
      "webview-ui-toolkit",
      "dist",
      "toolkit.js", // A toolkit.min.js file is also available
    ]);

    const scriptUrl = util.getUri(webview, extensionUri, [
      "assets",
      "ui",
      "FuzzPanelMain.js",
    ]);
    const env = this._fuzzEnv;
    const fnRef = env.function.getRef();
    const counter = { id: 0 };
    let argDefHtml = "";
    env.function
      .getArgDefs()
      .forEach((arg) => (argDefHtml += this.argDefToHtmlForm(arg, counter)));

    // TODO: Add timeouts and max iterations !!!
    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <script type="module" src="${toolkitUri}"></script>
          <script type="module" src="${scriptUrl}"></script>
          <title>Fuzz Panel</title>
        </head>
        <body>
          <h2 style="margin-bottom:.5em;">Fuzz ${htmlEscape(
            fnRef.name
          )}() with arguments:</h2>
          <div id="argDefs">${argDefHtml}</div>
          <div style="padding-top: .25em;">
            <vscode-button id="fuzz.start">Fuzz</vscode-button>
          </div>
        </body>
      </html>
    `;
  }

  // !!!
  private argDefToHtmlForm(
    arg: fuzzer.ArgDef<fuzzer.ArgType>,
    counter: { id: number },
    depth = 0
  ): string {
    const id = counter.id++;
    const idBase = `argDef-${id}`;
    const argType = arg.getType();

    let html = `<div class="argDef" id="${idBase}">
      <div class="argDef-name" style="font-size:1.25em;">${
        depth ? "." : "Argument: "
      }<strong>${htmlEscape(arg.getName())}</strong> ${htmlEscape(
      argType === fuzzer.ArgTag.OBJECT
        ? "= {"
        : ": " + argType.toLowerCase() + " ="
    )}</div>
      <div class="argDef-type-${htmlEscape(
        arg.getType()
      )}" id="${idBase}-${argType}" style="padding-left: .5em;">`;

    switch (arg.getType()) {
      case fuzzer.ArgTag.NUMBER: {
        // TODO: validate for ints and floats
        html += `<vscode-text-field id="${idBase}-min" name="${idBase}-min" value="${htmlEscape(
          Number(arg.getIntervals()[0].min).toString()
        )}">Minimum value</vscode-text-field>`;
        html += " ";
        html += `<vscode-text-field id="${idBase}-max" name="${idBase}-max" value="${htmlEscape(
          Number(arg.getIntervals()[0].max).toString()
        )}">Maximum value</vscode-text-field>`;
        break;
      }
      case fuzzer.ArgTag.STRING: {
        html += `<vscode-text-field id="${idBase}-minStrLen" name="${idBase}-min" value="${htmlEscape(
          arg.getOptions().strLength.min.toString()
        )}">Minimum string length</vscode-text-field>`;
        html += " ";
        html += `<vscode-text-field id="${idBase}-maxStrLen" name="${idBase}-max" value="${htmlEscape(
          arg.getOptions().strLength.max.toString()
        )}">Maximum string length</vscode-text-field>`;
        break;
      }
      case fuzzer.ArgTag.BOOLEAN: {
        // TODO: booleans !!!
        break;
      }
      case fuzzer.ArgTag.OBJECT: {
        html += `<div>`;
        arg
          .getChildren()
          .forEach(
            (child) =>
              (html += this.argDefToHtmlForm(child, counter, depth + 1))
          );
        html += `</div>`;
        break;
      }
    }
    // TODO: Handle dimensions

    html += `</div>${
      argType === fuzzer.ArgTag.OBJECT
        ? `<span style="font-size:1.25em;">}</span>`
        : ""
    }</div>`;
    return html;
  }

  // !!! remove
  /*
  private _getHtmlForWebview(webview: vscode.Webview, catGifPath: string) {
    // Local path to main script run in the webview
    const scriptPathOnDisk = vscode.Uri.joinPath(
      this._extensionUri,
      "media",
      "main.js"
    );

    // And the uri we use to load this script in the webview
    const scriptUri = webview.asWebviewUri(scriptPathOnDisk);

    // Local path to css styles
    const styleResetPath = vscode.Uri.joinPath(
      this._extensionUri,
      "media",
      "reset.css"
    );
    const stylesPathMainPath = vscode.Uri.joinPath(
      this._extensionUri,
      "media",
      "vscode.css"
    );

    // Uri to load styles into webview
    const stylesResetUri = webview.asWebviewUri(styleResetPath);
    const stylesMainUri = webview.asWebviewUri(stylesPathMainPath);

    // Use a nonce to only allow specific scripts to be run
    const nonce = FuzzPanel.getNonce();

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">

            <!--
                Use a content security policy to only allow loading images from https or from our extension directory,
                and only allow scripts that have a specific nonce.
            -->
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">

            <meta name="viewport" content="width=device-width, initial-scale=1.0">

            <link href="${stylesResetUri}" rel="stylesheet">
            <link href="${stylesMainUri}" rel="stylesheet">

            <title>Fuzz Panel</title>
        </head>
        <body>

            <img src="${catGifPath}" width="300" />
            <h1 id="lines-of-code-counter">0</h1>

            <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>`;
     } */

  // !!! remove
  private static getNonce() {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}

// !!!
type FuzzPanelMessage = {
  command: string;
  json: string;
};
