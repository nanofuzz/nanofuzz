import * as vscode from "vscode";
import * as JSON5 from "json5";
import * as fuzzer from "../fuzzer/Fuzzer";
import * as fs from "fs";
import { htmlEscape } from "escape-goat";
import * as telemetry from "../telemetry/Telemetry";
import * as jestadapter from "../fuzzer/adapters/JestAdapter";
import { ProgramDef } from "fuzzer/analysis/typescript/ProgramDef";

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
  private _argOverrides: fuzzer.FuzzArgOverride[]; // The current set of argument overrides

  // State-dependent instance variables
  private _results?: fuzzer.FuzzTestResults; // done state: the fuzzer output
  private _errorMessage?: string; // error state: the error message
  private _sortColumns?: fuzzer.FuzzSortColumns; // column sort orders

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
    // Differentiate panels by the module and function under test
    const fnRef = JSON5.stringify({
      module: env.function.getModule(),
      fnName: env.function.getName(),
    });

    // If we already have a panel for this fuzz env, show it.
    if (fnRef in FuzzPanel.currentPanels) {
      FuzzPanel.currentPanels[fnRef]._panel.reveal();
    } else {
      // Otherwise, create a new panel.
      const panel = vscode.window.createWebviewPanel(
        FuzzPanel.viewType, // FuzzPanel view type
        `Test: ${env.function.getName()}()`, // webview title
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
          state.fnRef.name
        );
        // Create the new FuzzPanel (use a local variable to help the linter)
        const localFuzzPanel = new FuzzPanel(panel, extensionUri, env);
        fuzzPanel = localFuzzPanel;

        // Attach a telemetry event handler to the panel
        panel.onDidChangeViewState((e) => {
          vscode.commands.executeCommand(
            telemetry.commands.logTelemetry.name,
            new telemetry.LoggerEntry(
              "FuzzPanel.onDidChangeViewState",
              "Webview with title '%s' for function '%s' state changed.  Visible: %s.  Active %s.",
              [
                e.webviewPanel.title,
                localFuzzPanel.getFnRefKey(),
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

    // Load & apply any persisted fuzz settings previously persisted
    const testSet = this._getFuzzTestsForThisFn();
    this._fuzzEnv.validator = testSet.validator;
    this._fuzzEnv.options = testSet.options;
    this._argOverrides = testSet.argOverrides ?? [];
    this._sortColumns = testSet.sortColumns;
    _applyArgOverrides(this._fuzzEnv.function, this._argOverrides);

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
    return JSON5.stringify({
      module: this._fuzzEnv.function.getModule(),
      fnName: this._fuzzEnv.function.getName(),
    });
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

        switch (command) {
          case "fuzz.start":
            this._doFuzzStartCmd(json);
            break;
          case "test.pin":
            this._doTestPinnedCmd(json, true);
            break;
          case "test.unpin":
            this._doTestPinnedCmd(json, false);
            break;
          case "columns.sorted":
            this._saveColumnSortOrders(json);
            break;
          case "validator.add":
            this._doAddValidatorCmd();
            this._doGetValidators();
            break;
          case "validator.set":
            this._doSetValidator(json);
            this._doGetValidators();
            break;
          case "validator.getList":
            this._doGetValidators();
            break;
        }
      },
      undefined,
      this._disposables
    );
  } // fn: _setWebviewMessageListener

  /**
   * Saves or unsaves a test, depending on the `pin` parameter.
   *
   * @param json test case to save or unsave
   * @param pin true=save test; false=unsave test
   */
  private _doTestPinnedCmd(json: string, pin: boolean) {
    // Log the telemetry event
    vscode.commands.executeCommand(
      telemetry.commands.logTelemetry.name,
      new telemetry.LoggerEntry(
        "FuzzPanel._doTestPinnedCmd",
        "Saving or unsaving: %s. Test case: %s.",
        [pin ? "saving" : "unsaving", json]
      )
    );

    // Get the set of saved tests
    const testSet = this._getFuzzTestsForThisFn();

    // Update set of saved tests
    const changed = this._updateFuzzTestsForThisFn(json, testSet); // Did we change anything?

    // Persist changes
    if (changed) {
      // Persist the changes to the pinned tests file
      this._putFuzzTestsForThisFn(testSet);
    }
  } // fn: _doTestPinnedCmd()

  /**
   * Returns the filename where pinned tests are persisted.
   *
   * @returns filename of pinned tests
   */
  private _getFuzzTestsFilename(): string {
    let module = this._fuzzEnv.function.getModule();
    module = module.split(".").slice(0, -1).join(".") || module;
    return module + ".nano.test.json";
  } // fn: _getPinnedTestFilename()

  /**
   * Returns pinned tests for all functions in the current module.
   *
   * @returns all pinned tests for all functions in the current module
   */
  private _getFuzzTestsForModule(): fuzzer.FuzzTests {
    const jsonFile = this._getFuzzTestsFilename();
    let inputTests: fuzzer.FuzzTests;

    // Read the file; if it doesn't exist, load default values
    try {
      inputTests = JSON5.parse(fs.readFileSync(jsonFile).toString());
    } catch (e: any) {
      return this._initFuzzTestsForThisFn();
    }

    // Handle any version conversions needed
    if ("version" in inputTests) {
      if (inputTests.version.startsWith("0.2.")) {
        // v0.2.0 format
        return inputTests;
      } else {
        // unknown format; stop to avoid losing data
        throw new Error(
          `Unknown version ${inputTests.version} in test file ${jsonFile}. Delete or rename it to continue.`
        );
      }
    } else {
      // v0.1.0 format -- convert to v0.2.0 format
      const testSet = this._initFuzzTestsForThisFn();
      const fnName = this._fuzzEnv.function.getName();
      if (fnName in inputTests) {
        testSet.functions[fnName].tests = inputTests[fnName];
      }
      console.info(
        `Upgraded test set in file ${jsonFile} to ${testSet.version} to current version`
      );
      return testSet;
    }
  } // fn: _getFuzzTestsForModule()

  /**
   * Initializes and return a new FuzzTests structure for the current
   * function under test.
   *
   * @returns a new FuzzTests structure for the current function
   */
  private _initFuzzTestsForThisFn(): fuzzer.FuzzTests {
    return {
      version: "0.2.0", // !!!!!
      functions: {
        [this._fuzzEnv.function.getName()]: {
          options: this._fuzzEnv.options,
          argOverrides: this._argOverrides,
          validator: this._fuzzEnv.validator,
          tests: {},
        },
      },
    };
  } // fn: _initFuzzTestsForThisFn()

  /**
   * Returns the pinned tests for just the current function.
   *
   * @returns pinned tests for the current function
   */
  private _getFuzzTestsForThisFn(): fuzzer.FuzzTestsFunction {
    // Get the tests for the entire module
    const moduleSet = this._getFuzzTestsForModule();

    // Return the pinned tests for the function, if it exists
    const fnName = this._fuzzEnv.function.getName();
    if (fnName in moduleSet.functions) {
      return moduleSet.functions[fnName];
    } else {
      return this._initFuzzTestsForThisFn().functions[fnName];
    }
  } // fn: _getFuzzTestsForThisFn()

  /**
   * Persists the pinned tests for the current function.
   *
   * @param testSet the pinned tests for the current function
   */
  private _putFuzzTestsForThisFn(testSet: fuzzer.FuzzTestsFunction): void {
    const jsonFile = this._getFuzzTestsFilename();
    const fullSet = this._getFuzzTestsForModule();

    // Update the function in the dataset
    fullSet.functions[this._fuzzEnv.function.getName()] = testSet;

    // Count the number of pinned tests for the module
    let pinnedCount = 0;
    Object.values(fullSet.functions).forEach((fn) => {
      pinnedCount += Object.values(fn.tests).filter((e) => e.pinned).length;
    });

    // Persist the test set
    try {
      fs.writeFileSync(jsonFile, JSON5.stringify(fullSet)); // Update the file
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Unable to update json file: ${jsonFile} (${e.message})`
      );
    }

    // Get the filename of the Jest file
    const jestFile = jestadapter.getFilename(
      this._fuzzEnv.function.getModule()
    );

    if (pinnedCount) {
      // Generate the Jest test data for CI
      // The Jest file should contain all tests that are pinned
      const jestTests = jestadapter.toString(
        this._getFuzzTestsForModule(),
        this._fuzzEnv.function.getModule()
      );

      // Persist the Jest tests for CI
      try {
        fs.writeFileSync(jestFile, jestTests);
      } catch (e: any) {
        vscode.window.showErrorMessage(
          `Unable to update Jest test file: ${jestFile} (${e.message})`
        );
      }
    } else if (fs.existsSync(jestFile)) {
      // Delete the test file: it would contain no tests
      try {
        fs.rmSync(jestFile);
      } catch (e: any) {
        vscode.window.showErrorMessage(
          `Unable to remove Jest test file: ${jestFile} (${e.message})`
        );
      }
    }

    // Return
    return;
  } // fn: _putFuzzTestsForFn

  /**
   * Add and/or delete from the set of saved tests. Returns if changed.
   *
   * @param json current test case
   * @param testSet set of saved test cases
   * @returns if changed
   */
  private _updateFuzzTestsForThisFn(
    json: string,
    testSet: fuzzer.FuzzTestsFunction
  ): boolean {
    let changed = false;
    const currTest: fuzzer.FuzzPinnedTest = JSON5.parse(json);
    const currInputsJson = JSON5.stringify(currTest.input);

    // If input is already in pinnedSet, is not pinned, and does not have
    // an expected value assigned, then delete it
    if (
      currInputsJson in testSet.tests &&
      !currTest.pinned &&
      !currTest.expectedOutput
    ) {
      delete testSet.tests[currInputsJson];
      changed = true;
    } else {
      // Else, save to pinnedSet
      testSet.tests[currInputsJson] = currTest;
      changed = true;
    }
    return changed;
  } // fn: _updateFuzzTestsForThisFn()

  /**
   * Message handler for the `columns.sort' command.
   */
  private _saveColumnSortOrders(json: string) {
    this._sortColumns = JSON5.parse(json);
  }

  /**
   * Add code skeleton for a custom validator to the program source code.
   */
  private _doAddValidatorCmd() {
    const fn = this._fuzzEnv.function; // Function under test
    const module = this._fuzzEnv.function.getModule();
    const program = ProgramDef.fromModule(module);
    const validatorPrefix = fn.getName() + "Validator";
    let fnCounter = 0;

    // Determine the next available validator name
    Object.keys(program.getFunctions())
      .filter((e) => e.startsWith(validatorPrefix))
      .forEach((e) => {
        if (e.endsWith(validatorPrefix)) {
          fnCounter++;
        } else {
          const suffix = e.substring(validatorPrefix.length);
          if (suffix.match(/^[0-9]+$/)) {
            fnCounter = Math.max(fnCounter, Number(suffix)) + 1;
          }
        }
      });

    // Determine if we need to add an import
    const hasImport = Object.keys(program.getImports().identifiers).some(
      (e) => e === "FuzzTestResult"
    );

    // Skeleton code for the function
    const npmInstruction = `
 * 
 * You will need to:
 *  1. Add the nanofuzz/runtime package to your project using npm or yarn:
 *     ${"`"}npm install nanofuzz/runtime -D${"`"}
 *     ${"`"}yarn add nanofuzz/runtime -D${"`"}
 *  1. Add an import to the top of the file:
 *     ${"`"}import { FuzzTestResult } from "nanofuzz/runtime";${"`"}`;
    // prettier-ignore
    const skeleton = `

/**
 * TODO: Implement this custom validator for function ${"`"}${fn.getName()}${"`"}
 *
 * This custom validator has visibility to all inputs, outputs, and
 * prior oracle results (e.g., NaNofuzz' implicit oracle ${"`"}passedImplicit${"`"}
 * and any human correctness annotation ${"`"}passedHuman${"`"}) via the
 * ${"`"}result${"`"} data structure of type ${"`"}FuzzTestResult${"`"} passed as input.
 *
 * Place the result of validation in ${"`"}result.passedValidator${"`"}, where:
 *  - ${"`"}true${"`"} indicates the test passed the custom validation,
 *  - ${"`"}false${"`"} indicates the test failed the custom validation, and
 *  - ${"`"}undefined${"`"} indicates the custom validator could not decide.` 
 + (hasImport ? "" : npmInstruction) + `
 */
export function ${validatorPrefix}${
        fnCounter === 0 ? "" : fnCounter
      }(result: FuzzTestResult): FuzzTestResult {
  if(result.timeout) {
    // Mark as passed any inputs where timeouts are expected
    // result.passedValidator = true;
  } else if(result.exception) {
    // Flag any inputs as passed where exceptions are expected
    // result.passedValidator = true;
  } else {
    // Evaluate the output relative to the input
    // result.passedValidator = true;  // <-- As expected; passed
    // result.passedValidator = false; // <-- Unexpected; failed
  }
  return result;
}`;

    // Append the code skeleton to the source file
    try {
      const fd = fs.openSync(module, "as+");
      fs.writeFileSync(fd, skeleton);
      fs.closeSync(fd);
    } catch {
      vscode.window.showErrorMessage(
        `Unable to write custom validator code skeleton to source file`
      );
    }
  }

  /**
   * Saves the name of the toggled validator function into this._fuzzEnv
   *
   * @param json name of validator function
   */
  private _doSetValidator(json: string) {
    const validatorName = JSON5.parse(json);
    this._fuzzEnv.validator = validatorName === "" ? undefined : validatorName;
  }

  /**
   * Message handler for the `validator.getList` command. Gets the list
   * of validators from the program source code and sends it back to the
   * front-end.
   */
  private _doGetValidators() {
    const program = ProgramDef.fromModule(this._fuzzEnv.function.getModule());

    const oldValidatorNames = JSON5.stringify(
      this._fuzzEnv.validators.map((e) => e.name)
    );
    const newValidators = fuzzer.getValidators(program);
    const newValidatorNames = JSON5.stringify(newValidators.map((e) => e.name));

    // Only send the message if there has been a change
    if (oldValidatorNames !== newValidatorNames) {
      // Update the Fuzzer Environment
      this._fuzzEnv.validators = fuzzer.getValidators(program);
      if (
        this._fuzzEnv.validator &&
        !this._fuzzEnv.validators.some(
          (e) => e.name === this._fuzzEnv.validator
        )
      ) {
        // If no validator is selected, or the selected validator is not
        // in the list of validators, clear the selected validator
        delete this._fuzzEnv.validator;
      }

      // Notify the front-end about the change
      this._panel.webview.postMessage({
        command: "validator.list",
        json: JSON5.stringify({
          validator: this._fuzzEnv.validator,
          validators: newValidators.map((e) => e.name),
        }),
      });
    }
  } // fn: _doGetValidators()

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
      fuzzer: Record<string, number>; // !!! Improve typing
      args: fuzzer.FuzzArgOverride[]; // !!! Improve typing
    } = JSON5.parse(json);
    const fn = this._fuzzEnv.function;

    // Apply numeric fuzzer option changes
    ["suiteTimeout", "maxTests", "fnTimeout"].forEach((e) => {
      if (e in panelInput.fuzzer && typeof panelInput.fuzzer[e] === "number") {
        this._fuzzEnv.options[e] = panelInput.fuzzer[e];
      }
    });

    // Apply the argument overrides from the front-end UI
    _applyArgOverrides(fn, panelInput.args);

    // Update the UI
    this._results = undefined;
    this._state = FuzzPanelState.busy;
    this._updateHtml();

    // Save the argument overrides
    this._argOverrides = panelInput.args;

    // Bounce off the stack and run the fuzzer
    setTimeout(async () => {
      // Log the start of Fuzzing
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
        // Run the fuzzer
        this._results = await fuzzer.fuzz(
          this._fuzzEnv,
          Object.values(this._getFuzzTestsForThisFn().tests)
        );

        // Transition to done state
        this._errorMessage = undefined;
        this._state = FuzzPanelState.done;

        // Log the end of fuzzing
        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "FuzzPanel.fuzz.done",
            "Fuzzing completed successfully. Target: %s. Results: %s",
            [this.getFnRefKey(), JSON5.stringify(this._results)]
          )
        );

        // Persist the fuzz test run settings (!!! validation)
        const testSet = this._getFuzzTestsForThisFn();
        testSet.options = this._fuzzEnv.options;
        testSet.validator = this._fuzzEnv.validator;
        testSet.argOverrides = this._argOverrides;
        testSet.sortColumns = this._sortColumns;
        this._putFuzzTestsForThisFn(testSet);
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
      failure: 0,
      timeout: 0,
      exception: 0,
      badValue: 0,
      ok: 0,
      disagree: 0,
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
    const fn = env.function; // Function under test
    const counter = { id: 0 }; // Unique counter for argument ids
    let argDefHtml = ""; // HTML representing argument definitions

    // If fuzzer results are available, calculate how many tests passed, failed, etc.
    if (this._state === FuzzPanelState.done && this._results !== undefined) {
      this._results.results.forEach((result) => {
        resultSummary[result.category]++;
      });
    } // if: results are available

    // Render the HTML for each argument
    fn.getArgDefs().forEach(
      (arg) => (argDefHtml += this._argDefToHtmlForm(arg, counter))
    );

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
          <title>NaNofuzz Panel</title>
        </head>
        <body>
          <h2 style="margin-bottom:.5em;margin-top:.1em;">Test ${htmlEscape(
            fn.getName()
          )}() w/inputs:</h2>

          <!-- Function Arguments -->
          <div id="argDefs">${argDefHtml}</div>`;

    // prettier-ignore
    html += /*html*/ `
          <!-- Indicator Bar for Validator -->
          <vscode-divider></vscode-divider>
          <div id="validatorFunctions-view" />
            <span>Output validation:&nbsp;</span>

            <span class="tooltip tooltip-top">
              <span class="codicon codicon-debug"></span>
              <span class="tooltiptext">
                By default, NaNofuzz categorizes timeout, exception, null, undefined, Infinity, &amp; NaN outputs as incorrect. 
                You may override this manually or automatically using a custom validator function.
              </span>
            </span>
            <span class="tooltip tooltip-top">
              <span class="codicon codicon-person"></span>
              <span class="tooltiptext">
                Manually categorize outputs as correct (✔︎) or incorrect (X) in the results pane below.
              </span>
            </span>
            <span class="tooltip tooltip-top">
              <span class="codicon codicon-hubot" id="validatorIndicator"></span>
              <span class="tooltiptext">
                You may write a custom validator function that automatically categorizes outputs as correct (✔︎) or incorrect (X). Click <strong>More options</strong> for details.
              </span>
            </span>
            
          </div>
          <vscode-divider></vscode-divider>

          <!-- Fuzzer Options -->
          <div id="fuzzOptions" class="hidden">
            <p>You may use a <strong>custom validator function</strong> to automatically categorize outputs as corect (✔︎) or incorrect (X). Click the (+) button to create a new custom validator function.</p>
            <div id="validatorFunctions-edit">
              <vscode-radio-group id="validatorFunctions-radios">
                <vscode-button ${disabledFlag} id="validator.add" appearance="icon" aria-label="Add">
                  <span class="tooltip tooltip-top">
                    <span class="codicon codicon-add"></span>
                    <span class="tooltiptext tooltiptext-small">
                      Add new function
                    </span>
                  </span>
                </vscode-button>
                <vscode-button ${disabledFlag} id="validator.getList" appearance="icon" aria-label="Refresh">
                  <span class="tooltip tooltip-top">
                    <span class="codicon codicon-refresh"></span>
                    <span class="tooltiptext tooltiptext-small">
                      Refresh list
                  </span>
                </span>
            </vscode-button>
              </vscode-radio-group>
            </div>
          
            <p>These settings control how long testing runs. Testing stops when either limit is reached.  Pinned tests count against the maximum runtime but do not count against the maximum number of tests.</p>
            <vscode-text-field ${disabledFlag} id="fuzz-suiteTimeout" name="fuzz-suiteTimeout" value="${this._fuzzEnv.options.suiteTimeout}">
              Max runtime (ms)
            </vscode-text-field>
            <vscode-text-field ${disabledFlag} id="fuzz-maxTests" name="fuzz-maxTests" value="${this._fuzzEnv.options.maxTests}">
              Max number of tests
            </vscode-text-field>

            <p>To ensure testing completes, stop long-running function calls and mark them as timeouts.</p>
            <vscode-text-field ${disabledFlag} id="fuzz-fnTimeout" name="fuzz-fnTimeout" value="${this._fuzzEnv.options.fnTimeout}">
              Stop function call after (ms)
            </vscode-text-field>
            <vscode-divider></vscode-divider>
          </div>

          <!-- Button Bar -->
          <div style="padding-top: .25em;">
            <vscode-button ${disabledFlag} id="fuzz.start">
              ${this._state === FuzzPanelState.busy ? "Testing..." : "Test"}
            </vscode-button>
            <vscode-button ${disabledFlag} id="fuzz.options" appearance="secondary">
              More options
            </vscode-button>
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
        id: "failure",
        name: "Validator Failed",
        description: `For these inputs, the custom validator function (${
          this._fuzzEnv.validator ?? ""
        }) threw an exception. You should fix the bug in the validator and start the fuzzer again.`,
      },
      {
        id: "disagree",
        name: "Disagreements",
        description: `For these inputs, the validator function (<span class="codicon codicon-hubot"></span>) and the manual validation (<span class="codicon codicon-person"></span>) disagree about correctness. Either correct the validation function or correct the manual validation.`,
      },
      {
        id: "timeout",
        name: "Timeouts",
        description: `These inputs did not terminate within ${this._fuzzEnv.options.fnTimeout}ms, and no validator categorized them as correct.`,
      },
      {
        id: "exception",
        name: "Exceptions",
        description: `These inputs resulted in a runtime exception, and no validator categorized them as correct.`,
      },
      {
        id: "badValue",
        name: "Invalid outputs",
        description: `These inputs were categorized by a validator as likely being incorrect. NaNofuzz by default categorizes outputs as invalid that contain null, NaN, Infinity, or undefined if no other validator categorizes them as correct.`,
      },
      {
        id: "ok",
        name: "Passed",
        description: `No validator categorized these outputs as incorrect, or a validator categorized them as correct.`,
      },
    ];
    tabs.forEach((e) => {
      if (resultSummary[e.id] > 0) {
        // prettier-ignore
        html += /*html*/ `
              <vscode-panel-tab id="tab-${e.id}">
                ${e.name}<vscode-badge appearance="secondary">${
                  resultSummary[e.id]
                }</vscode-badge>
              </vscode-panel-tab>`;
      }
    });

    tabs.forEach((e) => {
      if (resultSummary[e.id] > 0)
        html += /*html*/ `
              <vscode-panel-view id="view-${e.id}">
                <section>
                <div style="margin-bottom:.25em;margin-top:.25em;">${e.description}</div>
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
          
          <!-- Validator Functions: for the client script to process -->
          <div id="validators" style="display:none">
            ${htmlEscape(
              JSON5.stringify({
                disabled: !!disabledFlag,
                validator: this._fuzzEnv.validator,
                validators: this._fuzzEnv.validators.map((e) => e.name),
              })
            )}
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
    const optionalString = arg.isOptional() ? "?" : ""; // Text indication arg optionality

    let typeString: string; // Text indicating the type of argument
    const argTypeRef = arg.getTypeRef();
    if (argTypeRef !== undefined) {
      typeString = argTypeRef.substring(argTypeRef.lastIndexOf(".") + 1);
    } else {
      typeString =
        argType === fuzzer.ArgTag.OBJECT ? "Object" : argType.toLowerCase();
    }

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
        html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-min" name="${idBase}-min" value="${htmlEscape(
          Number(arg.getIntervals()[0].min).toString()
        )}">Min value</vscode-text-field>`;
        html += " ";
        html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-max" name="${idBase}-max" value="${htmlEscape(
          Number(arg.getIntervals()[0].max).toString()
        )}">Max value</vscode-text-field>`;
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
        html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-minStrLen" name="${idBase}-min" value="${htmlEscape(
          arg.getOptions().strLength.min.toString()
        )}">Min length</vscode-text-field>`;
        html += " ";
        html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-maxStrLen" name="${idBase}-max" value="${htmlEscape(
          arg.getOptions().strLength.max.toString()
        )}">Max length</vscode-text-field>`;
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
            <!--<label slot="label">Values</label>-->
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
          <vscode-text-field size="3" ${disabledFlag} id="${arrayBase}-min" name="${arrayBase}-min" value="${htmlEscape(
          arg.getOptions().dimLength[dim].min.toString()
        )}">Array${"[]".repeat(dim + 1)}: Min length
          </vscode-text-field>
          <vscode-text-field size="3" ${disabledFlag} id="${arrayBase}-max" name="${arrayBase}-max" value="${htmlEscape(
          arg.getOptions().dimLength[dim].max.toString()
        )}">Max length
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
      "Please select a function to test in the editor."
    );
    return; // If there is no active editor, return.
  }

  // Ensure we have a function name
  if (!fnName) {
    vscode.window.showErrorMessage(
      "Please use the NaNofuzz button to test a function."
    );
    return;
  }

  // Ensure the document is saved / not dirty
  if (document.isDirty) {
    vscode.window.showErrorMessage("Please save the file before testing.");
    return;
  }

  // Get the current active editor filename
  const srcFile = document.uri.path; //full path of the file which the function is in.

  // Call the fuzzer to analyze the function
  const fuzzOptions = getDefaultFuzzOptions();
  let fuzzSetup: fuzzer.FuzzEnv;
  try {
    fuzzSetup = fuzzer.setup(fuzzOptions, srcFile, fnName);
  } catch (e: any) {
    vscode.window.showErrorMessage(
      `NaNofuzz could not find or does not support this function. Messge: "${e.message}"`
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
    const program = ProgramDef.fromModuleAndSource(document.fileName, () =>
      document.getText()
    );
    const functions = Object.values(program.getExportedFunctions());

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
          title: "NaNofuzz...",
          command: commands.fuzz.name,
          arguments: [match],
        }
      )
  );
} // fn: provideCodeLenses()

/**
 * Applies a set of argument overrides (e.g., from the UI) to a
 * function's arguments. E.g., min, max, and so on.
 *
 * @param fn Function under test
 * @param argOverrides Overrides for default argument options
 */
function _applyArgOverrides(
  fn: fuzzer.FunctionDef,
  argOverrides: fuzzer.FuzzArgOverride[]
) {
  // Get the flattened list of function arguments
  const argsFlat = fn.getArgDefsFlat();

  // Apply argument option changes
  for (const i in argOverrides) {
    const thisOverride = argOverrides[i];
    const thisArg: fuzzer.ArgDef<fuzzer.ArgType> = argsFlat[i];
    if (Number(i) + 1 > argsFlat.length)
      throw new Error(
        `FuzzPanel input has ${
          Object.entries(argOverrides).length
        } but the function has ${argsFlat.length}`
      );

    // Min and max values
    switch (thisArg.getType()) {
      case fuzzer.ArgTag.NUMBER:
        if (thisOverride.number) {
          // Min / Max
          thisArg.setIntervals([
            {
              min: Number(thisOverride.number.min),
              max: Number(thisOverride.number.max),
            },
          ]);
          // Number is integer
          thisArg.setOptions({
            numInteger: !!thisOverride.number.numInteger,
          });
        }
        break;
      case fuzzer.ArgTag.BOOLEAN:
        if (thisOverride.boolean) {
          // Min / Max
          thisArg.setIntervals([
            {
              min: !!thisOverride.boolean.min,
              max: !!thisOverride.boolean.max,
            },
          ]);
        }
        break;
      case fuzzer.ArgTag.STRING:
        if (thisOverride.string) {
          // String length
          thisArg.setOptions({
            strLength: {
              min: Number(thisOverride.string.minStrLen),
              max: Number(thisOverride.string.maxStrLen),
            },
          });
        }
        break;
    }

    // Array dimensions
    if (thisOverride.array) {
      thisOverride.array.dimLength.forEach((e: fuzzer.Interval<number>) => {
        if (typeof e === "object" && "min" in e && "max" in e) {
          e = { min: Number(e.min), max: Number(e.max) };
        } else {
          throw new Error(
            `Invalid interval for array dimensions: ${JSON5.stringify(e)}`
          );
        }
      });
      thisArg.setOptions({
        dimLength: thisOverride.array.dimLength,
      });
    }
  } // for: each argument
} // fn: _applyArgOverrides()

/**
 * Returns a default set of fuzzer options.
 *
 * @returns default set of fuzzer options
 */
export const getDefaultFuzzOptions = (): fuzzer.FuzzOptions => {
  return {
    argDefaults: fuzzer.ArgDef.getDefaultOptions(),
    maxTests: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("maxTests", 1000),
    fnTimeout: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("fnTimeout", 100),
    suiteTimeout: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("suiteTimeout", 3000),
  };
}; // fn: getDefaultFuzzOptions()

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
