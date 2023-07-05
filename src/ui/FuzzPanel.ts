import * as vscode from "vscode";
import * as JSON5 from "json5";
import * as fuzzer from "../fuzzer/Fuzzer";
import * as fs from "fs";
import { htmlEscape } from "escape-goat";
import * as telemetry from "../telemetry/Telemetry";
import * as jestadapter from "../fuzzer/adapters/JestAdapter";

/**
 * FuzzPanel displays fuzzer options, actions, and the last results for a
 * given FuzzEnvironment within a VS Code Webview.
 *
 * This class follows the Singleton pattern in that it keeps track of all
 * FuzzPanels created so that no more than onw panel exists at a time for
 * each FuzzEnvironment.
 *
 * For its user interface, this extension relies on the VS Code Webview
 * API and WebView controls.  Client-side Javascript is contained in
 * a separate FuzzPanelMain.js.
 */
export class FuzzPanel {
  // Static variables
  public static currentPanels: Record<string, FuzzPanel> = {}; // Map of panels indeved by the result of getFnRefKey()
  public static readonly viewType = "FuzzPanel"; // The name of this panel type
  public static context: vscode.ExtensionContext;

  // Instance variables
  private readonly _panel: vscode.WebviewPanel; // The WebView panel for this FuzzPanel instance
  private readonly _extensionUri: vscode.Uri; // Current Uri of the extension
  private _disposables: vscode.Disposable[] = []; // List of disposables
  private _fuzzEnv: fuzzer.FuzzEnv; // The Fuzz environment this panel represents
  private _state: FuzzPanelState = FuzzPanelState.init; // The current state of the fuzzer.

  // State-dependent instance variables
  private _results?: fuzzer.FuzzTestResults; // done state: the fuzzer output
  private _errorMessage?: string; // error state: the error message
  private _sortColumns?: FuzzSortColumns; // ..... the message containing column sort orders .....
  // private _sortColumns?: string; // ..... the message containing column sort orders .....

  // ------------------------ Static Methods ------------------------ //

  /**
   * This method either (a) creates a new FuzzPanel if one does not yet
   * exist for the given FuzzEnv, or (b) displays the existing FuzzPanel
   * for the given FuzzEnv, if it exists.
   *
   * @param extensionUri Extension Uri
   * @param env FuzzEnv for which to display or create the FuzzPanel
   */
  public static render(extensionUri: vscode.Uri, env: fuzzer.FuzzEnv): void {
    const fnRef = JSON5.stringify(env.function.getRef());

    // If we already have a panel for this fuzz env, show it.
    if (fnRef in FuzzPanel.currentPanels) {
      FuzzPanel.currentPanels[fnRef]._panel.reveal();
    } else {
      // Otherwise, create a new panel.
      const panel = vscode.window.createWebviewPanel(
        FuzzPanel.viewType, // FuzzPanel view type
        `AutoTest: ${env.function.getName()}()`, // webview title
        vscode.ViewColumn.Beside, // open beside the editor
        FuzzPanel.getWebviewOptions(extensionUri) // options
      );

      // Create the new FuzzPanel
      new FuzzPanel(panel, extensionUri, env);
    }
  } // fn: render()

  /**
   * Creates a new FuzzPanel with the given state.  This is used to
   * restore a FuzzPanel across VS Code restarts.
   *
   * @param panel The WebView panel for this FuzzPanel instance
   * @param extensionUri Uri of extension
   * @param state State of the FuzzPanel
   * @returns FuzzPanel instance for the given state
   */
  public static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    state: FuzzPanelStateSerialized
  ): void {
    let fuzzPanel: FuzzPanel | undefined;

    // Revive the FuzzPanel using the previous state
    if (
      typeof state === "object" &&
      "tag" in state &&
      state.tag === fuzzPanelStateVer
    ) {
      // Create a new fuzzer environment
      try {
        const env = fuzzer.setup(
          state.options,
          state.fnRef.module,
          state.fnRef.name,
          state.fnRef.startOffset
        );
        // Create the new FuzzPanel
        fuzzPanel = new FuzzPanel(panel, extensionUri, env);

        // Attach a telemetry event handler to the panel
        panel.onDidChangeViewState((e) => {
          vscode.commands.executeCommand(
            telemetry.commands.logTelemetry.name,
            new telemetry.LoggerEntry(
              "FuzzPanel.onDidChangeViewState",
              "Webview with title '%s' for function '%s' state changed.  Visible: %s.  Active %s.",
              [
                e.webviewPanel.title,
                fuzzPanel!.getFnRefKey(),
                e.webviewPanel.visible ? "true" : "false",
                e.webviewPanel.active ? "true" : "false",
              ]
            )
          );
        });
      } catch (e: any) {
        // It's possible the source code changed between restarting;
        // just log the exception and continue. Restoring these panels
        // is best effort anyway.
        console.error(`Unable to revive FuzzPanel: ${e.message}`);
      }
    }
    // Dispose of any panels we can't revive
    if (fuzzPanel === undefined) {
      panel.dispose();
    } else {
      vscode.commands.executeCommand(
        telemetry.commands.logTelemetry.name,
        new telemetry.LoggerEntry(
          "FuzzPanel.fuzz.open",
          "Fuzzing panel opened. Target: %s.",
          [fuzzPanel.getFnRefKey()]
        )
      );
    }
  } // fn: revive()

  /**
   * Determine the options to use when creating the FuzzPanel WebView
   *
   * @param extensionUri The Uri of the extension
   * @returns The options to use when creating the FuzzPanel WebView
   */
  public static getWebviewOptions(
    extensionUri: vscode.Uri
  ): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,

      // Enable searching on this panel
      enableFindWidget: true,

      // Retain the webview contents when hidden
      retainContextWhenHidden: true,

      // And restrict the webview to only loading content from our extension's `media` directory.
      // !!! localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    };
  }

  // ------------------------ Instance Methods ------------------------ //

  /**
   * Creates a new instance of FuzzPanel.
   *
   * @param panel The WebView panel for this FuzzPanel instance
   * @param extensionUri Extension Uri
   * @param env FuzzEnv for which to create the FuzzPanel
   */
  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    env: fuzzer.FuzzEnv
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._fuzzEnv = env;

    // Listen for when the panel is disposed.  This happens when the
    // user closes the panel or when it is closed programmatically
    this._panel.onDidDispose(
      () => {
        this.dispose();
      },
      null,
      this._disposables
    );

    // Handle messages from the webview
    this._setWebviewMessageListener(this._panel.webview);

    // Set the webview's initial html content
    this._updateHtml();

    // Register the new panel
    FuzzPanel.currentPanels[this.getFnRefKey()] = this;
  } // fn: constructor

  /**
   * Returns the state of the FuzzPanel for serialization.
   *
   * @returns the state of the FuzzPanel
   */
  private getState(): FuzzPanelStateSerialized {
    return {
      tag: fuzzPanelStateVer,
      fnRef: this._fuzzEnv.function.getRef(),
      options: this._fuzzEnv.options,
    };
  } // fn: getState()

  /**
   * Provides a key string that represents the fuzz environment
   * and is suitable for looking up a FuzzPanel in the
   * currentPanels map.
   *
   * @returns A key string that represents the fuzz environment
   */
  public getFnRefKey(): string {
    return JSON5.stringify(this._fuzzEnv.function.getRef());
  }

  // ----------------------- Message Handling ----------------------- //

  /**
   * Registers the message handler that allows the client side of
   * the WebView to communicate back with this extension.
   *
   * @param webview WebView instance
   */
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: FuzzPanelMessage) => {
        const { command, json } = message;
        console.log("RECEIVED A MESSAGE:", command);

        switch (command) {
          case "fuzz.start":
            this._doFuzzStartCmd(json);
            break;
          case "test.pin":
            // this._doTestPinnedCmd(json, true, JSON5.parse(json).correctness);
            this._doTestPinnedCmd(json, true);
            break;
          case "test.unpin":
            this._doTestPinnedCmd(json, false);
            break;
          case "columnSortOrders":
            this._storeColumnSortOrders(json);
            break;
        }
      },
      undefined,
      this._disposables
    );
  } // fn: _setWebviewMessageListener

  /**
   * Performs a test pin or unpin, depending on the `pin` parameter.
   *
   * @param json inputs to pin or unpins
   * @param pin true=pin test; false=unpin test
   */
  // private _doTestPinnedCmd(json: string, pin: boolean, correctness: string) {
  //   console.log("CURRENT JSON:", json);
  //   // console.log("correctness, pin:", correctness, pin);
  //   const pinnedSet: Record<string, fuzzer.FuzzPinnedTest> =
  //     this._getPinnedTests();
  //   let changed = false; // Did we change anything?

  //   console.log("PINNEDSET:", pinnedSet);
  //   console.log("json in pinnedSet?", json in pinnedSet);
  //   // Add or delete the test, as needed
  //   if (json in pinnedSet && !pin && correctness === "none") {
  //     // If we are unsaving and the test is in the file, remove it
  //     delete pinnedSet[json];
  //     changed = true;
  //   } else {
  //     // if we are saving a test but it is not in the file, add the test
  //     pinnedSet[json] = JSON5.parse(json);
  //     changed = true;
  //   }

  //   if (json in pinnedSet) {
  //     if (!pin) {
  //       delete pinnedSet[json];
  //       changed = true;
  //     }
  //   } else {
  //     pinnedSet[json] = JSON5.parse(json);
  //     changed = true;
  //   }

  //   // Persist changes
  //   if (changed) {
  //     // Update the pinned tests file
  //     const testCount = this._putPinnedTests(pinnedSet);

  //     // Get the filename of the Jest file
  //     const jestFile = jestadapter.getFilename(
  //       this._fuzzEnv.function.getModule()
  //     );

  //     if (testCount) {
  //       // Generate the Jest test data for CI
  //       const jestTests = jestadapter.toString(
  //         this._getAllPinnedTests(),
  //         this._fuzzEnv.function.getModule(),
  //         this._fuzzEnv.options.fnTimeout
  //       );

  //       // Persist the Jest tests for CI
  //       try {
  //         fs.writeFileSync(jestFile, jestTests);
  //       } catch (e: any) {
  //         vscode.window.showErrorMessage(
  //           `Unable to update test file: ${jestFile} (${e.message})`
  //         );
  //       }
  //     } else {
  //       // Delete the test file: it will contain no tests
  //       try {
  //         fs.rmSync(jestFile);
  //       } catch (e: any) {
  //         vscode.window.showErrorMessage(
  //           `Unable to remove test file: ${jestFile} (${e.message})`
  //         );
  //       }
  //     }
  //   }
  // } // fn: _doTestPinnedCmd()
  private _doTestPinnedCmd(json: string, pin: boolean) {
    const pinnedSet: Record<string, fuzzer.FuzzPinnedTest> =
      this._getPinnedTests();
    let changed = false; // Did we change anything?

    // Add or delete the test, as needed
    if (json in pinnedSet) {
      // If we are unsaving and the test is in the file, remove it
      if (!pin) {
        delete pinnedSet[json];
        changed = true;
      }
    } else {
      // if we are saving a test but it is not in the file, add the test
      if (pin) {
        pinnedSet[json] = JSON5.parse(json);
        changed = true;
      }
    }

    // Persist changes
    if (changed) {
      // Update the pinned tests file
      const testCount = this._putPinnedTests(pinnedSet);

      // Get the filename of the Jest file
      const jestFile = jestadapter.getFilename(
        this._fuzzEnv.function.getModule()
      );

      if (testCount) {
        // Generate the Jest test data for CI
        const jestTests = jestadapter.toString(
          this._getAllPinnedTests(),
          this._fuzzEnv.function.getModule(),
          this._fuzzEnv.options.fnTimeout
        );

        // Persist the Jest tests for CI
        try {
          fs.writeFileSync(jestFile, jestTests);
        } catch (e: any) {
          vscode.window.showErrorMessage(
            `Unable to update test file: ${jestFile} (${e.message})`
          );
        }
      } else {
        // Delete the test file: it will contain no tests
        try {
          fs.rmSync(jestFile);
        } catch (e: any) {
          vscode.window.showErrorMessage(
            `Unable to remove test file: ${jestFile} (${e.message})`
          );
        }
      }
    }
  } // fn: _doTestPinnedCmd()

  /**
   * Returns the filename where pinned tests are persisted.
   *
   * @returns filename of pinned tests
   */
  private _getPinnedTestFilename(): string {
    let module = this._fuzzEnv.function.getModule();
    module = module.split(".").slice(0, -1).join(".") || module;
    return module + ".nano.test.json";
  } // fn: _getPinnedTestFilename()

  /**
   * Returns pinned tests for all functions in the current module.
   *
   * @returns all pinned tests for all functions in the current module
   */
  private _getAllPinnedTests(): Record<
    string,
    Record<string, fuzzer.FuzzPinnedTest>
  > {
    const jsonFile = this._getPinnedTestFilename();

    try {
      return JSON5.parse(fs.readFileSync(jsonFile).toString());
    } catch (e: any) {
      return {};
    }
  } // fn: _getAllPinnedTests()

  /**
   * Returns the pinned tests for just the current function.
   *
   * @returns pinned tests for the current function
   */
  private _getPinnedTests(): Record<string, fuzzer.FuzzPinnedTest> {
    const pinnedSet = this._getAllPinnedTests();
    const fnName = this._fuzzEnv.function.getName(); // Name of the function being tested

    // Return the pinned tests for the function, if any
    return fnName in pinnedSet ? pinnedSet[fnName] : {};
  } // fn: _getPinnedTests()

  /**
   * Persists the pinned tests for the current function.
   *
   * @param pinnedSet the pinned tests for the current function
   * @returns the number of pinned tests
   */
  private _putPinnedTests(
    pinnedSet: Record<string, fuzzer.FuzzPinnedTest>
  ): number {
    const jsonFile = this._getPinnedTestFilename();
    const fullSet = this._getAllPinnedTests();

    // Update the function in the dataset
    fullSet[this._fuzzEnv.function.getName()] = pinnedSet;

    // Count the number of tests
    let testCount = 0;
    Object.values(fullSet).forEach((fnTests) => {
      testCount += Object.keys(fnTests).length;
    });

    // Persist the pinned tests
    try {
      if (testCount) {
        fs.writeFileSync(jsonFile, JSON5.stringify(fullSet)); // Update the file
      } else {
        fs.rmSync(jsonFile); // Delete the file (no data)
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Unable to update json file: ${jsonFile} (${e.message})`
      );
    }

    // Return the number of tests persisted
    return testCount;
  } // fn: _putPinnedTests()

  /**
   * Message handler for the `columnSortOrders' command.
   */
  private _storeColumnSortOrders(json: string) {
    this._sortColumns = JSON5.parse(json);
  }

  /**
   * Message handler for the `fuzz.start` command.
   *
   * This handler:
   *  1. Accepts a JSON object containing an updated set
   *     of fuzzer and argument options as input
   *  2. Updates the fuzzer environment accordingly (note:
   *     logical validation of these options takes place
   *     within the Fuzzer and ArgDef classes)
   *  3. Runs the fuzzer
   *  4. Updates the WebView with the results
   *
   * @param json JSON input
   */
  private async _doFuzzStartCmd(json: string): Promise<void> {
    const panelInput: {
      fuzzer: Record<string, any>; // !!! Improve typing
      args: Record<string, any>; // !!! Improve typing
    } = JSON5.parse(json);
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
          numInteger: !!thisOverride.numInteger,
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
      } // !!! validation

      // Array dimensions
      if (
        thisOverride.dimLength !== undefined &&
        thisOverride.dimLength.length
      ) {
        thisOverride.dimLength.forEach((e: fuzzer.Interval<number>) => {
          if (typeof e === "object" && "min" in e && "max" in e) {
            e = { min: Number(e.min), max: Number(e.max) };
          } else {
            throw new Error(
              `Invalid interval for array dimensions: ${JSON5.stringify(e)}`
            );
          }
        });
        thisArg.setOptions({
          dimLength: thisOverride.dimLength,
        });
      }
    } // for: each argument

    // Update the UI
    this._results = undefined;
    this._state = FuzzPanelState.busy;
    this._updateHtml();

    // Log start of Fuzzing
    setTimeout(async () => {
      vscode.commands.executeCommand(
        telemetry.commands.logTelemetry.name,
        new telemetry.LoggerEntry(
          "FuzzPanel.fuzz.start",
          "Fuzzing started. Target: %s.",
          [this.getFnRefKey()]
        )
      );

      // Fuzz the function & store the results
      try {
        this._results = await fuzzer.fuzz(
          this._fuzzEnv,
          Object.values(this._getPinnedTests())
        );

        this._errorMessage = undefined;
        this._state = FuzzPanelState.done;
        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "FuzzPanel.fuzz.done",
            "Fuzzing completed successfully. Target: %s. Results: %s",
            [this.getFnRefKey(), JSON5.stringify(this._results)]
          )
        );
      } catch (e: any) {
        this._state = FuzzPanelState.error;
        this._errorMessage = e.message ?? "Unknown error";
        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "FuzzPanel.fuzz.error",
            "Fuzzing failed. Target: %s. Message: %s",
            [this.getFnRefKey(), this._errorMessage ?? "Unknown error"]
          )
        );
      }

      // Update the UI
      this._updateHtml();
    });
  } // fn: _doFuzzStartCmd()

  /**
   * Disposes all objects used by this instance
   */
  public dispose(): void {
    // Remove this panel from the list of current panels.
    delete FuzzPanel.currentPanels[this.getFnRefKey()];

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  } // fn: dispose()

  // ------------------------- Webview HTML ------------------------- //

  /**
   * Updates the WebView HTML with the current state of the FuzzPanel
   *
   * TODO: Move styles to CSS !!!
   */
  _updateHtml(): void {
    const webview: vscode.Webview = this._panel.webview; // Current webview
    const extensionUri: vscode.Uri = this._extensionUri; // Extension URI
    const disabledFlag =
      this._state === FuzzPanelState.busy ? ` disabled ` : ""; // Disable inputs if busy
    const resultSummary = {
      passed: 0,
      failed: 0,
      timeout: 0,
      exception: 0,
      badOutput: 0,
    }; // Summary of fuzzing results
    const toolkitUri = getUri(webview, extensionUri, [
      "node_modules",
      "@vscode",
      "webview-ui-toolkit",
      "dist",
      "toolkit.js",
    ]); // URI to the VS Code webview ui toolkit
    const codiconsUri = getUri(webview, extensionUri, [
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
      "codicon.css",
    ]);
    const json5Uri = getUri(webview, extensionUri, [
      "node_modules",
      "json5",
      "dist",
      "index.js",
    ]); // URI to the json5 library
    const scriptUrl = getUri(webview, extensionUri, [
      "assets",
      "ui",
      "FuzzPanelMain.js",
    ]); // URI to client-side panel script
    const cssUrl = getUri(webview, extensionUri, [
      "assets",
      "ui",
      "FuzzPanelMain.css",
    ]); // URI to client-side panel script
    const env = this._fuzzEnv; // Fuzzer environment
    const fnRef = env.function.getRef(); // Reference to function under test
    const counter = { id: 0 }; // Unique counter for argument ids
    let argDefHtml = ""; // HTML representing argument definitions

    // If fuzzer results are available, calculate how many tests passed, failed, etc.
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
    } // if: results are available

    // Render the HTML for each argument
    env.function
      .getArgDefs()
      .forEach((arg) => (argDefHtml += this._argDefToHtmlForm(arg, counter)));

    // Prettier abhorrently butchers this HTML, so disable prettier here
    // prettier-ignore
    let html = /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <script type="module" src="${toolkitUri}"></script>
          <script src="${json5Uri}"></script>
          <script type="module" src="${scriptUrl}"></script>
          <link rel="stylesheet" type="text/css" href="${cssUrl}">
          <link rel="stylesheet" type="text/css" href="${codiconsUri}">
          <title>AutoTest Panel</title>
        </head>
        <body>
          <h2 style="margin-bottom:.5em;margin-top:.1em;">AutoTest ${htmlEscape(
            fnRef.name
          )}() w/inputs:</h2>

          <!-- Function Arguments -->
          <div id="argDefs">${argDefHtml}</div>

          <!-- Fuzzer Options -->
          <div id="fuzzOptions" style="display:none">
            <vscode-divider></vscode-divider>
            <p>These settings control how long testing runs. Testing stops when either limit is reached.  Pinned tests count against the maximum runtime but do not count against the maximum number of tests.</p>
            <vscode-text-field ${disabledFlag} id="fuzz-suiteTimeout" name="fuzz-suiteTimeout" value="${this._fuzzEnv.options.suiteTimeout}">
              Max runtime (ms)
            </vscode-text-field>
            <vscode-text-field ${disabledFlag} id="fuzz-maxTests" name="fuzz-maxTests" value="${this._fuzzEnv.options.maxTests}">
              Max number of tests
            </vscode-text-field>

            <vscode-divider></vscode-divider>
            <p>To ensure testing completes, stop long-running function calls and mark them as timeouts.</p>
            <vscode-text-field ${disabledFlag} id="fuzz-fnTimeout" name="fuzz-fnTimeout" value="${this._fuzzEnv.options.fnTimeout}">
              Stop function call after (ms)
            </vscode-text-field>
            <vscode-divider></vscode-divider>
          </div>

          <!-- Button Bar -->
          <div style="padding-top: .25em;">
            <vscode-button ${disabledFlag} id="fuzz.start"  appearance="primary">${this._state === FuzzPanelState.busy ? "Testing..." : "Test"}</vscode-button>
            <vscode-button ${disabledFlag} id="fuzz.options" appearance="secondary">More options</vscode-button>
          </div>

          <!-- Fuzzer Errors -->
          <div class="fuzzErrors" ${
            this._state === FuzzPanelState.error
              ? ""
              : /*html*/ `style="display:none;"`
          }>
            <h3>The fuzzer stopped with this error:</h3>
            <p>${this._errorMessage ?? "Unknown error"}</p>
          </div>

          <!-- Fuzzer Output -->
          <div class="fuzzResults" ${
            this._state === FuzzPanelState.done
              ? ""
              : /*html*/ `style="display:none;"`
          }>
            <vscode-panels>`;

    // If we have results, render the output tabs to display the results.
    const tabs = [
      {
        id: "timeout",
        name: "Timeouts",
        description: `These inputs did not terminate within ${this._fuzzEnv.options.fnTimeout}ms:`,
      },
      {
        id: "exception",
        name: "Exceptions",
        description: `These inputs resulted in a runtime exception:`,
      },
      {
        id: "badOutput",
        name: "Invalid Outputs",
        description: `These outputs contain: null, NaN, Infinity, or undefined:`,
      },
      {
        id: "passed",
        name: "Passed",
        description: `Passed: no timeout, exception, null, NaN, Infinity, or undefined`,
      },
    ];
    tabs.forEach((e) => {
      if (resultSummary[e.id] > 0)
        // prettier-ignore
        html += /*html*/ `
              <vscode-panel-tab id="tab-${e.id}">
                ${e.name}<vscode-badge appearance="secondary">${
                  resultSummary[e.id]
                }</vscode-badge>
              </vscode-panel-tab>`;
    });
    tabs.forEach((e) => {
      if (resultSummary[e.id] > 0)
        html += /*html*/ `
              <vscode-panel-view id="view-${e.id}">
                <section>
                  <h4 style="margin-bottom:.25em;margin-top:.25em;">${e.description}</h4>
                  <div id="fuzzResultsGrid-${e.id}">
                    <table class="fuzzGrid">
                      <thead class="columnSortOrder" id="fuzzResultsGrid-${e.id}-thead" /> 
                      <tbody id="fuzzResultsGrid-${e.id}-tbody" />
                    </table>
                  </div>
                </section>
              </vscode-panel-view>`;
    });
    html += /*html*/ `
            </vscode-panels>
          </div>

          <!-- Fuzzer Result Payload: for the client script to process -->
          <div id="fuzzResultsData" style="display:none">
            ${
              this._results === undefined
                ? "{}"
                : htmlEscape(JSON5.stringify(this._results))
            }
          </div>

          <!-- Fuzzer Sort Columns: for the client script to process -->
          <div id="fuzzSortColumns" style="display:none">
            ${
              this._sortColumns === undefined
                ? "{}"
                : htmlEscape(JSON5.stringify(this._sortColumns))
            }
          </div>

          <!-- Fuzzer State Payload: for the client script to persist -->
          <div id="fuzzPanelState" style="display:none">
            ${htmlEscape(JSON5.stringify(this.getState()))}
          </div>
                    
        </body>
      </html>
    `;

    // Update the webview with the new HTML
    this._panel.webview.html = html;
  } // fn: _updateHtml()

  /**
   * Returns an HTML form representing an argument definition.  The counter
   * is passed by reference so it can be unique across the entire tree of
   * arguments: objects can be nested arbitrarily.
   *
   * @param arg Argument definition to render
   * @param counter Counter internally incremented for each argument
   * @returns html string of the argument definition form
   */
  private _argDefToHtmlForm(
    arg: fuzzer.ArgDef<fuzzer.ArgType>,
    counter: { id: number } // pass counter by reference
  ): string {
    const id = counter.id++; // unique id for each argument
    const idBase = `argDef-${id}`; // base HTML id for this argument
    const argType = arg.getType(); // type of argument
    const disabledFlag =
      this._state === FuzzPanelState.busy ? ` disabled ` : ""; // Disable inputs if busy
    const dimString = "[]".repeat(arg.getDim()); // Text indicating array dimensions
    const typeString =
      argType === fuzzer.ArgTag.OBJECT ? "Object" : argType.toLowerCase(); // Text indicating arg type
    const optionalString = arg.isOptional() ? "?" : ""; // Text indication arg optionality

    // prettier-ignore
    let html = /*html*/ `
    <!-- Argument Definition -->
    <div class="argDef" id="${idBase}">
      <!-- Argument Name -->
      <div class="argDef-name" style="font-size:1.25em;">
        <strong>${htmlEscape(
          arg.getName()
        )}</strong>${optionalString}: ${typeString}${dimString} =
        ${argType === fuzzer.ArgTag.OBJECT
          ? ' {'
          : ''
        }
      </div>`;

    html += /*html*/ `
      <!-- Argument Type -->
      <div class="argDef-type-${htmlEscape(
        arg.getType()
      )}" id="${idBase}-${argType}" style="padding-left: 1em;">
      <!-- Argument Options -->`;

    // Argument options
    switch (arg.getType()) {
      // Number-specific Options
      case fuzzer.ArgTag.NUMBER: {
        // TODO: validate for ints and floats !!!
        html += /*html*/ `<vscode-text-field ${disabledFlag} id="${idBase}-min" name="${idBase}-min" value="${htmlEscape(
          Number(arg.getIntervals()[0].min).toString()
        )}">Minimum value</vscode-text-field>`;
        html += " ";
        html += /*html*/ `<vscode-text-field ${disabledFlag} id="${idBase}-max" name="${idBase}-max" value="${htmlEscape(
          Number(arg.getIntervals()[0].max).toString()
        )}">Maximum value</vscode-text-field>`;
        html += " ";
        html +=
          /*html*/
          `<vscode-radio-group>
            <vscode-radio ${disabledFlag} id="${idBase}-numInteger" name="${idBase}-numInteger" ${
            arg.getOptions().numInteger ? " checked " : ""
          }>Integer</vscode-radio>
            <vscode-radio ${disabledFlag} id="${idBase}-numInteger" name="${idBase}-numInteger" ${
            !arg.getOptions().numInteger ? " checked " : ""
          }>Float</vscode-radio>
          </vscode-radio-group>`;
        break;
      }

      // String-specific Options
      case fuzzer.ArgTag.STRING: {
        // TODO: validate for ints > 0 !!!
        html += /*html*/ `<vscode-text-field ${disabledFlag} id="${idBase}-minStrLen" name="${idBase}-min" value="${htmlEscape(
          arg.getOptions().strLength.min.toString()
        )}">Minimum string length</vscode-text-field>`;
        html += " ";
        html += /*html*/ `<vscode-text-field ${disabledFlag} id="${idBase}-maxStrLen" name="${idBase}-max" value="${htmlEscape(
          arg.getOptions().strLength.max.toString()
        )}">Maximum string length</vscode-text-field>`;
        break;
      }

      // Boolean-specific Options
      case fuzzer.ArgTag.BOOLEAN: {
        let intervals = arg.getIntervals();
        if (intervals.length === 0) {
          intervals = [{ min: false, max: true }];
        }
        html +=
          /*html*/
          `<vscode-radio-group>
            <label slot="label">Values</label>
            <vscode-radio ${disabledFlag} id="${idBase}-trueFalse" name="${idBase}-trueFalse" ${
            intervals[0].min !== intervals[0].max ? " checked " : ""
          }>True and false</vscode-radio>
            <vscode-radio ${disabledFlag} id="${idBase}-trueOnly" name="${idBase}-trueOnly" ${
            intervals[0].min && intervals[0].max ? " checked " : ""
          }>True</vscode-radio>
            <vscode-radio ${disabledFlag} id="${idBase}-falseOnly" name="${idBase}-falseOnly" ${
            !intervals[0].min && !intervals[0].max ? " checked " : ""
          }>False</vscode-radio>
          </vscode-radio-group>`;
        break;
      }

      // Object-specific Options
      case fuzzer.ArgTag.OBJECT: {
        // Only for objects: output the array form prior to the child arguments.
        // This seems odd, but the screen reads better to the user this way.
        html += this._argDefArrayToHtmlForm(arg, idBase, disabledFlag);
        html += `<div>`;
        arg
          .getChildren()
          .forEach((child) => (html += this._argDefToHtmlForm(child, counter)));
        html += `</div>`;
        break;
      }
    }

    // For objects: output any sub-arguments.
    if (argType !== fuzzer.ArgTag.OBJECT) {
      html += this._argDefArrayToHtmlForm(arg, idBase, disabledFlag);
    }

    html += `</div>`;
    // For objects: output the end of object character ("}") here
    if (argType === fuzzer.ArgTag.OBJECT) {
      html += /*html*/ `<span style="font-size:1.25em;">}</span>`;
    }
    html += `</div>`;

    // Return the argument's HTML
    return html;
  } // fn: _argDefToHtmlForm()

  /**
   * Returns an HTML form representing an array argument definition.
   *
   * @param arg Argument definition to render as an array
   * @param idBase The arg id base of the parent argument form
   * @param disabledFlag Indicates whether controls are disabled
   * @returns html string representing an argument's array form
   */
  private _argDefArrayToHtmlForm(
    arg: fuzzer.ArgDef<fuzzer.ArgType>,
    idBase: string,
    disabledFlag: string
  ): string {
    let html = "";

    // Array dimensions
    for (let dim = 0; dim < arg.getDim(); dim++) {
      const arrayBase = `${idBase}-array-${dim}`;

      // TODO: validate for ints > 0 !!!
      html += /*html*/ ``;
      html +=
        /*html*/
        `<div>
          <vscode-text-field ${disabledFlag} id="${arrayBase}-min" name="${arrayBase}-min" value="${htmlEscape(
          arg.getOptions().dimLength[dim].min.toString()
        )}">Array${"[]".repeat(dim + 1)}: min length
          </vscode-text-field>
          <vscode-text-field ${disabledFlag} id="${arrayBase}-max" name="${arrayBase}-max" value="${htmlEscape(
          arg.getOptions().dimLength[dim].max.toString()
        )}">Array${"[]".repeat(dim + 1)}: max length
          </vscode-text-field>
        </div>`;
    }

    return html;
  } // fn: _arraySizeHtmlForm()
} // class: FuzzPanel

// ------------------------ Helper Functions ----------------------- //

/**
 * Convenience function to build a uri to a project file at runtime.
 *
 * @param webview webview object
 * @param extensionUri uri of extension
 * @param pathList list of paths to concatenate
 * @returns A vscode uri to the requested path
 */
export function getUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  pathList: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathList));
} // fn: getUri()

/**
 * Handles the nanofuzz.Fuzz command by creating a fuzz environment for
 * the function specified as input -- or the current cursor position if
 * no function is specified.
 *
 * @param match optional: a reference to the function to fuzz
 * @returns void
 */
export async function handleFuzzCommand(match?: FunctionMatch): Promise<void> {
  // Get the function name (only present on a CodeLens match)
  const fnName: string | undefined = match ? match.ref.name : undefined;

  // Get the current active document
  const editor = vscode.window.activeTextEditor;
  const document = match
    ? match.document
    : vscode.window.activeTextEditor?.document;
  if (!document || !editor) {
    vscode.window.showErrorMessage(
      "Please select a function to autotest in the editor."
    );
    return; // If there is no active editor, return.
  }

  // Ensure the document is saved / not dirty
  if (document.isDirty) {
    vscode.window.showErrorMessage("Please save the file before autotesting.");
    return;
  }

  // Get the current active editor filename
  const srcFile = document.uri.path; //full path of the file which the function is in.

  // Get the current cursor offset
  const pos = match
    ? match.ref.startOffset
    : document.offsetAt(editor.selection.active);

  // Call the fuzzer to analyze the function
  const fuzzOptions = fuzzer.getDefaultFuzzOptions();
  let fuzzSetup: fuzzer.FuzzEnv;
  try {
    fuzzSetup = fuzzer.setup(fuzzOptions, srcFile, fnName, pos);
  } catch (e: any) {
    vscode.window.showErrorMessage(
      `Could not find or does not support this function. Messge: "${e.message}"`
    );
    return;
  }

  // Load the fuzz panel
  FuzzPanel.render(FuzzPanel.context.extensionUri, fuzzSetup);

  return;
} // fn: handleFuzzCommand()

/**
 * Returns an array of FuzzPanel CodeLens objects for the given document.
 *
 * Note: Only exported functions are returned.
 *
 * @param document text document to analyze
 * @param token cancellation token (unused)
 * @returns array of CodeLens objects
 */
export function provideCodeLenses(
  document: vscode.TextDocument,
  token: vscode.CancellationToken
): vscode.CodeLens[] {
  // Use the TypeScript analyzer to find all fn declarations in the module
  const matches: FunctionMatch[] = [];
  try {
    const functions = fuzzer.FunctionDef.find(
      document.getText(),
      document.fileName
    ).filter((e) => e.isExported()); // only exported functions

    for (const fn of functions) {
      matches.push({
        document,
        ref: fn.getRef(),
      });
    }
  } catch (e: any) {
    console.error(
      `Error parsing typescript file: ${document.fileName} error: ${e.message}`
    );
  }

  // Build the map of CodeLens objects at each function location
  return matches.map(
    (match) =>
      new vscode.CodeLens(
        new vscode.Range(
          document.positionAt(match.ref.startOffset),
          document.positionAt(match.ref.endOffset)
        ),
        {
          title: "AutoTest...",
          command: commands.fuzz.name,
          arguments: [match],
        }
      )
  );
} // fn: provideCodeLenses()

/**
 * Initializes the module
 *
 * @param context extension context
 */
export function init(context: vscode.ExtensionContext): void {
  FuzzPanel.context = context; // Set the context
}

/**
 * De-initializes the module
 */
export function deinit(): void {
  // noop
}

// --------------------------- Constants --------------------------- //

/**
 * Commands supported by this module
 *
 * Note: Manually update package.json.
 */
export const commands = {
  fuzz: { name: "nanofuzz.Fuzz", fn: handleFuzzCommand },
};

/**
 * Languages supported by this module
 */
export const languages = ["typescript", "typescriptreact"];

/**
 * The Fuzzer State Version we currently support.
 */
const fuzzPanelStateVer = "FuzzPanelStateSerialized-1.0.0";

// ----------------------------- Types ----------------------------- //

/**
 * Represents a message from the WebView client to its FuzzPanel.
 */
export type FuzzPanelMessage = {
  command: string;
  json: string; // !!! Better typing here
};

/**
 * Represents the possible states of the FuzzPanel
 */
export enum FuzzPanelState {
  init = "init", // Nothing has been fuzzed yet
  busy = "busy", // Fuzzing is in progress
  done = "done", // Fuzzing is done
  error = "error", // Fuzzing stopped due to an error
}

/**
 * The serialized state of a FuzzPanel
 */
export type FuzzPanelStateSerialized = {
  tag: string;
  fnRef: fuzzer.FunctionRef;
  options: fuzzer.FuzzOptions;
};

/**
 * Represents a link between a vscode document and a function definition
 */
export type FunctionMatch = {
  document: vscode.TextDocument;
  ref: fuzzer.FunctionRef;
};

export type FuzzSortColumns = Record<string, string>;
