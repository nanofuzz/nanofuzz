import * as vscode from "vscode";
import * as fuzzer from "../fuzzer/Fuzzer";
import * as util from "./Utils";
import { htmlEscape } from "escape-goat";

/**
 * !!!
 */
export class FuzzPanel {
  /**
   * !!!
   */
  public static currentPanels: Record<string, FuzzPanel> = {};
  public static readonly viewType = "fuzz";
  private readonly _panel: vscode.WebviewPanel; // !!!
  private readonly _extensionUri: vscode.Uri; // !!!
  private _disposables: vscode.Disposable[] = []; // !!!
  private _fuzzEnv: fuzzer.FuzzEnv; // !!!
  private _state: FuzzPanelState = FuzzPanelState.init;
  private _results?: fuzzer.FuzzTestResults;

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
        `Fuzz: ${env.function.getName()}()`,
        vscode.ViewColumn.Beside,
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
  ): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,

      // Enable searching on this panel
      enableFindWidget: true,

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
    this._updateHtml();
  } // fn: constructor

  // !!!
  private _updateHtml(): void {
    this._panel.webview.html = this._getWebviewContent(
      this._panel.webview,
      this._extensionUri
    );
  }

  // !!!
  public getFnRefKey(): string {
    return JSON.stringify(this._fuzzEnv.function.getRef());
  }

  // !!!
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: FuzzPanelMessage) => {
        const { command, json } = message;

        switch (command) {
          case "fuzz.start":
            this._doFuzzStartCmd(json);
            break;
        }
      },
      undefined,
      this._disposables
    );
  } // fn: _setWebviewMessageListener

  // !!!
  private async _doFuzzStartCmd(json: string): Promise<void> {
    const panelInput: {
      fuzzer: Record<string, any>;
      args: Record<string, any>;
    } = JSON.parse(json);
    const argsFlat = this._fuzzEnv.function.getArgDefsFlat();

    // Apply numeric fuzzer option changes
    ["suiteTimeout", "maxTests", "fnTimeout"].forEach((e) => {
      if (
        panelInput.fuzzer[e] !== undefined &&
        typeof panelInput.fuzzer[e] === "number"
      ) {
        this._fuzzEnv.options[e] = panelInput.fuzzer[e];
      }
    });

    // Apply argument option changes
    for (const i in panelInput.args) {
      const thisOverride = panelInput.args[i];
      const thisArg: fuzzer.ArgDef<fuzzer.ArgType> = argsFlat[i];
      if (Number(i) + 1 > argsFlat.length)
        throw new Error(
          `FuzzPanel input has ${panelInput.args.length} but the function has ${argsFlat.length}`
        );

      // Min and max values
      if (thisOverride.min !== undefined && thisOverride.max !== undefined) {
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

      // Number is integer
      if (thisOverride.numInteger !== undefined) {
        thisArg.setOptions({
          numInteger: thisOverride.numInteger,
        });
      }

      // String length min and max
      if (
        thisOverride.minStrLen !== undefined &&
        thisOverride.maxStrLen !== undefined
      ) {
        thisArg.setOptions({
          strLength: {
            min: Number(thisOverride.minStrLen),
            max: Number(thisOverride.maxStrLen),
          },
        });
      }
    } // !!!

    // Update the UI
    this._state = FuzzPanelState.busy;
    this._updateHtml();

    // Fuzz the function & store the results
    this._results = await fuzzer.fuzz(this._fuzzEnv);

    // Update the UI
    this._state = FuzzPanelState.done;
    this._updateHtml();
  } // fn: _doFuzzStartCmd

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
  } // fn: dispose

  // !!!
  private _getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri
  ): string {
    // TODO: Move styles to CSS !!!
    const disabledFlag =
      this._state === FuzzPanelState.busy ? ` disabled ` : "";

    const resultSummary = {
      passed: 0,
      failed: 0,
      timeout: 0,
      exception: 0,
      badOutput: 0,
    };

    if (this._state === FuzzPanelState.done && this._results !== undefined) {
      for (const result of this._results.results) {
        if (result.passed) resultSummary.passed++;
        else {
          resultSummary.failed++;
          if (result.exception) resultSummary.exception++;
          else if (result.timeout) resultSummary.timeout++;
          else resultSummary.badOutput++;
        }
      }
    }

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
      .forEach((arg) => (argDefHtml += this._argDefToHtmlForm(arg, counter)));

    // TODO: Add timeouts and max iterations !!!
    // TODO: Add decorators and filter links for the failures and passing items

    // Prettier abhorrently butchers this HTML, so disable prettier here
    // prettier-ignore
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
          <h2 style="margin-bottom:.5em;margin-top:.1em;">Fuzz ${htmlEscape(
            fnRef.name
          )}() with inputs:</h2>

          <!-- Function Arguments -->
          <div id="argDefs">${argDefHtml}</div>

          <!-- Fuzzer Options -->
          <div id="fuzzOptions" style="display:none">
            <vscode-divider></vscode-divider>
            <p>These settings control how long the fuzzer runs.  It stops when either limit is reached.</p>
            <vscode-text-field ${disabledFlag} id="fuzz-suiteTimeout" name="fuzz-suiteTimeout" value="${this._fuzzEnv.options.suiteTimeout}">
              Max runtime (ms)
            </vscode-text-field>
            <vscode-text-field ${disabledFlag} id="fuzz-maxTests" name="fuzz-maxTests" value="${this._fuzzEnv.options.maxTests}">
              Max number of tests
            </vscode-text-field>

            <vscode-divider></vscode-divider>
            <p>To ensure the fuzzer completes, it stops long-running function calls. Define how long a function may run until marked as a timeout failure.</p>
            <vscode-text-field ${disabledFlag} id="fuzz-fnTimeout" name="fuzz-fnTimeout" value="${this._fuzzEnv.options.fnTimeout}">
              Stop function call after (ms)
            </vscode-text-field>
            <vscode-divider></vscode-divider>
          </div>

          <!-- Button Bar -->
          <div style="padding-top: .25em;">
            <vscode-button ${disabledFlag} id="fuzz.start"  appearance="primary">Fuzz</vscode-button>
            <vscode-button ${disabledFlag} id="fuzz.options" appearance="secondary">More options</vscode-button>
          </div>

          <!-- Fuzzer Output -->
          <div class="fuzzResults" ${
            this._state === FuzzPanelState.done
              ? ""
              : /*html*/ `style="display:none;"`
          }>
            <h3>Output:</h3>
            <p>
              ${resultSummary.timeout ? ` <vscode-link id="link-timeout">${resultSummary.timeout} timed out</vscode-link>.` : ""} 
              ${resultSummary.exception ? ` <vscode-link id="link-exception">${resultSummary.exception} threw exception</vscode-link>.` : ""} 
              ${resultSummary.badOutput ? ` <vscode-link id="link-badOutput">${resultSummary.badOutput} invalid outputs</vscode-link>.` : ""} 
              ${resultSummary.passed ? ` <vscode-link id="link-passed">${resultSummary.passed} passed</vscode-link>.` : ` 0 passed.`} 
            </p>
            <div id="timeout">
              <h4 style="margin-bottom: .25em;">Timeout: did not terminate within ${this._fuzzEnv.options.fnTimeout}ms</h4> <vscode-data-grid id="fuzzResultsGrid-timeout" generate-header="sticky" aria-label="Basic" />
            </div>
            <div id="exception">
              <h4 style="margin-bottom: .25em;">Exception: threw a runtime exception</h4><vscode-data-grid id="fuzzResultsGrid-exception" generate-header="sticky" aria-label="Basic" />
            </div>
            <div id="badOutput">
              <h4 style="margin-bottom: .25em;">Invalid Outputs: null, NaN, Infinity, undefined</h4> <vscode-data-grid id="fuzzResultsGrid-badOutput" generate-header="sticky" aria-label="Basic" />
            </div>
            <div id="passed">
              <h4 style="margin-bottom: .25em;">Passed: no timeout, exception, null, NaN, Infinity, undefined</h4> <vscode-data-grid id="fuzzResultsGrid-passed" generate-header="sticky" aria-label="Basic" />
            </div>
          </div>
          <div id="fuzzResultsData" style="display:none">
            ${
              this._results === undefined ? "{}" : htmlEscape(JSON.stringify(this._results))
            }
          </div>
        </body>
      </html>
    `;
  } // fn: _getWebviewContent

  // !!!
  private _argDefToHtmlForm(
    arg: fuzzer.ArgDef<fuzzer.ArgType>,
    counter: { id: number },
    depth = 0
  ): string {
    const id = counter.id++;
    const idBase = `argDef-${id}`;
    const argType = arg.getType();
    const disabledFlag =
      this._state === FuzzPanelState.busy ? ` disabled ` : "";

    let html = /*html*/ `<div class="argDef" id="${idBase}">
      <div class="argDef-name" style="font-size:1.25em;">${
        depth ? "" : "Argument: "
      }<strong>${htmlEscape(arg.getName())}</strong>`;

    // Type of the argument
    switch (argType) {
      case fuzzer.ArgTag.OBJECT:
        html += /*html*/ ` = {`;
        break;
      case fuzzer.ArgTag.NUMBER:
        html += /*html*/ ` : ${argType.toLowerCase()} =`; // !!!
        break;
      default:
        html += /*html*/ ` : ${argType.toLowerCase()} =`;
    }

    html += /*html*/ `</div>`;
    html += /*html*/ `
      <div class="argDef-type-${htmlEscape(
        arg.getType()
      )}" id="${idBase}-${argType}" style="padding-left: .5em;">`;

    // Argument options
    switch (arg.getType()) {
      case fuzzer.ArgTag.NUMBER: {
        // TODO: validate for ints and floats
        html += /*html*/ `<vscode-text-field ${disabledFlag} id="${idBase}-min" name="${idBase}-min" value="${htmlEscape(
          Number(arg.getIntervals()[0].min).toString()
        )}">Minimum value</vscode-text-field>`;
        html += " ";
        html += /*html*/ `<vscode-text-field ${disabledFlag} id="${idBase}-max" name="${idBase}-max" value="${htmlEscape(
          Number(arg.getIntervals()[0].max).toString()
        )}">Maximum value</vscode-text-field>`;
        html += " ";
        html += /*html*/ `<vscode-checkbox ${disabledFlag} id="${idBase}-numInteger" name="${idBase}-numInteger"${
          arg.getOptions().numInteger ? "checked" : ""
        }>Integers</vscode-checkbox>`;
        break;
      }

      case fuzzer.ArgTag.STRING: {
        html += /*html*/ `<vscode-text-field ${disabledFlag} id="${idBase}-minStrLen" name="${idBase}-min" value="${htmlEscape(
          arg.getOptions().strLength.min.toString()
        )}">Minimum string length</vscode-text-field>`;
        html += " ";
        html += /*html*/ `<vscode-text-field ${disabledFlag} id="${idBase}-maxStrLen" name="${idBase}-max" value="${htmlEscape(
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
              (html += this._argDefToHtmlForm(child, counter, depth + 1))
          );
        html += `</div>`;
        break;
      }
    }
    // TODO: Handle dimensions

    html += `</div>${
      argType === fuzzer.ArgTag.OBJECT
        ? /*html*/ `<span style="font-size:1.25em;">}</span>`
        : ""
    }</div>`;
    return html;
  } // fn: _argDefToHtmlForm

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
  /*
  private static getNonce() {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }*/

  // !!! remove
  /*
  public doRefactor(): void {
    // Send a message to the webview webview.
    // You can send any JSON serializable data.
    this._panel.webview.postMessage({ command: "refactor" });
  }*/
}

// !!!
export type FuzzPanelMessage = {
  command: string;
  json: string;
};

// !!!
export enum FuzzPanelState {
  init = "init", // Nothing has been fuzzed yet
  busy = "busy", // Fuzzing is in progress
  done = "done", // Fuzzing is done
}
