import * as vscode from "vscode";
import * as JSON5 from "json5";
import * as fuzzer from "../fuzzer/Fuzzer";
import * as fs from "fs";
import { htmlEscape } from "escape-goat";
import * as telemetry from "../telemetry/Telemetry";
import * as jestadapter from "../fuzzer/adapters/JestAdapter";
import { ProgramDef } from "../fuzzer/analysis/typescript/ProgramDef";
import { isError } from "../fuzzer/Util";
import { AbstractProgramModel } from "../models/AbstractProgramModel";
import { ProgramModelFactory } from "../models/ProgramModelFactory";

// Consts for validator result arg name generation
const resultArgCandidateNames = ["r", "result", "_r", "_result"];
const maxResultArgSuffix = 1000;

// Consts for validator out variable name generation
const outVarCandidateNames = ["out", "output", "_out", "_output"];
const maxOutVarSuffix = 1000;

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
 * a separate FuzzPanelMain.ts.
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
  private _focusInput?: [string, number]; // Newly-added input to receive UI focus
  private _lastTab: string | undefined; // Last tab that had focus
  private _disposed = false; // Indicates whether this panel is disposed
  private _gen?: ReturnType<typeof fuzzer.TestGenerator>; // The test generator
  private _statusFn = (payload: fuzzer.FuzzBusyStatusMessage): void => {
    this._panel.webview.postMessage({
      command: "busy.message",
      json: JSON5.stringify(payload),
    });
  }; // Fn that provides test status feedback to the panel => {
  private _cancelFn: () => boolean = () => this._stopTesting; // Fn to cancel testing

  // State-dependent instance variables
  private _results?: fuzzer.FuzzTestResults; // done state: the fuzzer output
  private _errorMessage?: string; // error state: the error message
  private _sortColumns?: fuzzer.FuzzSortColumns; // column sort orders
  private _model?: AbstractProgramModel; // !!!!!!
  private _stopTesting = false; // indicates that testing should stop

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
        FuzzPanel.getWebviewOptions() // options
      );
      panel.iconPath = vscode.Uri.joinPath(
        extensionUri,
        "assets",
        "ui",
        "icon.svg"
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
      } catch (e: unknown) {
        // It's possible the source code changed between restarting;
        // just log the exception and continue. Restoring these panels
        // is best effort anyway.
        const msg = isError(e) ? e.message : JSON5.stringify(e);
        console.error(`Unable to revive FuzzPanel: ${msg}`);
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
  public static getWebviewOptions(): vscode.WebviewPanelOptions &
    vscode.WebviewOptions {
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
    this._fuzzEnv.options = testSet.options;
    this._argOverrides = testSet.argOverrides ?? [];
    this._sortColumns = testSet.sortColumns;

    // Register the new panel
    FuzzPanel.currentPanels[this.getFnRefKey()] = this;

    // Post-analysis callback function
    const onInit = (): void => {
      // Apply argument ranges, etc. over the defaults
      _applyArgOverrides(
        this._fuzzEnv.function,
        this._argOverrides,
        this._fuzzEnv.options.argDefaults
      );

      // Set the webview's initial html content
      this._state = FuzzPanelState.init;
      this._updateHtml();
    };

    // !!!!!!!
    if (ProgramModelFactory.isConfigured()) {
      // Program Model is configured and we do not have any overrides yet
      // ...which means we are encountering the function for the first time
      // and should use our program model to analyze it
      this._state = FuzzPanelState.busyAnalyzing;
      this._updateHtml();

      // Bounce off the stack and perform the model-driven analyses
      setTimeout(async () => {
        try {
          // Get the program model
          const model = this._getModel();
          if (!this._argOverrides.length) {
            await model.getSpec();
            const overrides = await model.getFuzzerArgOverrides();
            console.debug(
              `Applying overrides from analysis: ${JSON5.stringify(
                overrides,
                null,
                2
              )}`
            ); // !!!!!!
            this._argOverrides = overrides;
          }
          onInit();
        } catch (e: unknown) {
          if (!this._disposed) {
            const msg = `AI analysis of function failed. Message: ${
              e instanceof Error ? e.message : JSON5.stringify(e)
            }`;
            vscode.window.showWarningMessage(msg);
            console.debug(msg); // !!!!!!!
            // !!!!!!! telemetry

            // Fall back to normal init
            this._state = FuzzPanelState.init;
            this._updateHtml();
          }
        }
      });
    } else {
      onInit();
    }
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

  /** !!!!!! */
  private _getModel(): AbstractProgramModel {
    if (!this._model) {
      this._model = ProgramModelFactory.create(this._fuzzEnv.function);
    }
    return this._model;
  } // fn: _getModel

  /** !!!!!! */
  private _updateModel(): void {
    if (this._model) {
      this._model = ProgramModelFactory.create(this._fuzzEnv.function);
    }
  } // fn: _updateModel

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
            this._doGetValidators();
            this._testAll(json);
            break;
          case "fuzz.addTestInput":
            this._doGetValidators();
            this._testOne(json);
            break;
          case "fuzz.stop":
            this._stopTesting = true;
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
          case "validator.getList":
            this._doGetValidators();
            break;
          case "open.source": {
            this._navigateToSource(
              this._fuzzEnv.function.getModule(),
              this._fuzzEnv.function.getRef().startOffset
            );
            break;
          }
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
    let inputTests, testSet: fuzzer.FuzzTests;

    // Read the file; if it doesn't exist, load default values
    try {
      inputTests = JSON5.parse(fs.readFileSync(jsonFile).toString());
      testSet = inputTests;
    } catch (e: unknown) {
      return this._initFuzzTestsForThisFn();
    }

    // Handle any version conversions needed
    while (inputTests.version !== CURR_FILE_FMT_VER) {
      if (!("version" in inputTests)) {
        // v0.1.0 format -- convert to current format
        testSet = this._initFuzzTestsForThisFn();
        const fnName = this._fuzzEnv.function.getName();
        if (fnName in inputTests) {
          testSet.functions[fnName].tests = inputTests[fnName];
        }
        console.info(
          `Upgraded test set in file ${jsonFile} from ${testSet.version} to current version`
        );
        inputTests = testSet;
      } else {
        switch (inputTests.version) {
          case "0.2.0": {
            // v0.2.0 format -- add maxFailures and onlyFailure options
            testSet = { ...inputTests, version: "0.2.1" };
            for (const fn in testSet.functions) {
              testSet.functions[fn].options.maxFailures = 0;
              testSet.functions[fn].options.useHuman = true;
              testSet.functions[fn].options.useImplicit = true;
            }
            console.info(
              `Upgraded test set in file ${jsonFile} from ${inputTests.version} to ${testSet.version}`
            );
            inputTests = testSet;
            break;
          }
          case "0.2.1": {
            // v0.2.1 format -- infer useProperty option & turn on useHuman (the latter
            // is req'd b/c we eliminated the UI button that controls this)
            testSet = { ...inputTests, version: "0.3.0" };
            for (const fn in testSet.functions) {
              testSet.functions[fn].options.useProperty =
                "validator" in testSet.functions[fn];
              testSet.functions[fn].options.useHuman = true;
            }
            console.info(
              `Upgraded test set in file ${jsonFile} from ${inputTests.version} to ${testSet.version}`
            );
            inputTests = testSet;
            break;
          }
          case "0.3.0": {
            // v0.3.0 format -- infer arg strCharset override from function default
            testSet = { ...inputTests, version: "0.3.3" };
            for (const fn in testSet.functions) {
              const thisFn = testSet.functions[fn];
              if (thisFn.argOverrides) {
                for (const i in thisFn.argOverrides) {
                  const arg = thisFn.argOverrides[i];
                  // strings overrides only
                  if (arg.string && !arg.string.strCharset) {
                    arg.string.strCharset =
                      thisFn.options.argDefaults.strCharset;
                  }
                }
              }
              break;
            }
            console.info(
              `Upgraded test set in file ${jsonFile} from ${inputTests.version} to ${testSet.version}`
            );
            inputTests = testSet;
            break;
          }
          case "0.3.3": {
            // v0.3.3 format -- only additions such as isVoid and literal types that
            // older versions of NaNofuzz will not interpret. Also check for missing
            // maxDupeInputs value
            testSet = { ...inputTests, version: "0.3.6" };
            for (const fn in testSet.functions) {
              const thisFn = testSet.functions[fn];
              const thisOpt: Partial<fuzzer.FuzzOptions> = thisFn.options;
              if (
                !("maxDupeInputs" in thisOpt) ||
                thisOpt.maxDupeInputs === undefined ||
                isNaN(thisOpt.maxDupeInputs)
              ) {
                thisOpt.maxDupeInputs = vscode.workspace
                  .getConfiguration("nanofuzz.fuzzer")
                  .get("maxDupeInputs", 1000);
              }
            }
            console.info(
              `Upgraded test set in file ${jsonFile} from ${inputTests.version} to ${testSet.version}`
            );
            inputTests = testSet;
            break;
          }
          case "0.3.6": {
            // v0.3.9 format -- add configuration for measures and generators,
            //        re-key and add origin info to saved test inputs
            testSet = { ...inputTests, version: "0.3.9" }; // !!!!!!!!
            for (const fn in testSet.functions) {
              const thisFn = testSet.functions[fn];
              thisFn.options.measures = getDefaultFuzzOptions().measures;
              thisFn.options.generators = getDefaultFuzzOptions().generators;

              const oldTestSet = thisFn.tests;
              thisFn.tests = {};
              for (const oldKey in oldTestSet) {
                const newKey = fuzzer.getIoKey(oldTestSet[oldKey].input);
                const thisTest = (thisFn.tests[newKey] = oldTestSet[oldKey]);
                for (const input of thisTest.input) {
                  input.origin = {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  };
                }
                for (const output of thisTest.output) {
                  output.origin = { type: "put" };
                }
                if (thisTest.expectedOutput) {
                  for (const expectedOutput of thisTest.expectedOutput) {
                    expectedOutput.origin = { type: "user" };
                  }
                }
              }
            }
            console.info(
              `Upgraded test set in file ${jsonFile} from ${inputTests.version} to ${testSet.version}`
            );
            inputTests = testSet;
            break;
          }
          default: {
            // unknown format; stop to avoid losing data
            throw new Error(
              `Unknown version ${inputTests.version} in test file ${jsonFile}. Update your ${toolName} extension or delete/rename the file to continue.`
            );
          }
        }
      }
    }

    return this._pruneTestSet(testSet);
  } // fn: _getFuzzTestsForModule()

  /**
   * Removes tests from a test set that are neither pinned nor have
   * an expected value.
   *
   * @param `testSet` unpruned test set
   * @returns a copy of the `testSet` that only contains pinned tests of
   *          tests with an expected output.
   */
  private _pruneTestSet(testSet: fuzzer.FuzzTests): fuzzer.FuzzTests {
    const prunedTestSet: fuzzer.FuzzTests = JSON5.parse(
      JSON5.stringify(testSet)
    );
    for (const fn in prunedTestSet.functions) {
      for (const test in prunedTestSet.functions[fn].tests) {
        const thisTest = prunedTestSet.functions[fn].tests[test];
        if (!thisTest.pinned && thisTest.expectedOutput === undefined) {
          delete prunedTestSet.functions[fn].tests[test];
        }
      }
    }
    return prunedTestSet;
  } // fn: _pruneTestSet

  /**
   * Initializes and return a new FuzzTests structure for the current
   * function under test.
   *
   * @returns a new FuzzTests structure for the current function
   */
  private _initFuzzTestsForThisFn(): fuzzer.FuzzTests {
    return {
      version: CURR_FILE_FMT_VER,
      functions: {
        [this._fuzzEnv.function.getName()]: {
          options: this._fuzzEnv.options,
          argOverrides: this._argOverrides,
          validators: this._fuzzEnv.validators.map((ref) => ref.name),
          tests: {},
          isVoid: this._fuzzEnv.function.isVoid(),
        },
      },
    };
  } // fn: _initFuzzTestsForThisFn()

  /** !!!!!! */

  /**
   * Returns the saved tests for just the current function.
   *
   * @param `opt` optional parameters
   * @returns saved tests for the current function
   */
  private _getFuzzTestsForThisFn(
    opt: { interesting?: boolean } = {}
  ): fuzzer.FuzzTestsFunction {
    // Get the tests for the entire module
    const moduleSet = this._getFuzzTestsForModule();

    // Get the persistent tests for the function, if it exists
    const fnName = this._fuzzEnv.function.getName();
    const fnSet = // persistent tests
      fnName in moduleSet.functions
        ? moduleSet.functions[fnName]
        : this._initFuzzTestsForThisFn().functions[fnName];

    // add "interesting" inputs if not already persisted
    if (opt.interesting && this._results) {
      this._results.results
        .filter((r) => r.interestingReasons.length)
        .forEach((r) => {
          const serializedInput = JSON5.stringify(r.input);
          if (!(serializedInput in fnSet.tests)) {
            fnSet.tests[serializedInput] = {
              input: r.input,
              output: r.output,
              pinned: false,
            };
          }
        });
    }
    return fnSet;
  } // fn: _getFuzzTestsForThisFn()

  /**
   * Persists the pinned tests for the current function.
   *
   * @param testSet the pinned tests for the current function
   */
  private _putFuzzTestsForThisFn(testSet: fuzzer.FuzzTestsFunction): void {
    const jsonFile = this._getFuzzTestsFilename();
    let fullSet = this._getFuzzTestsForModule();

    // Update the function in the dataset
    fullSet.functions[this._fuzzEnv.function.getName()] = testSet;

    // Prune unused tests
    fullSet = this._pruneTestSet(fullSet);

    // Count the number of pinned tests for the module
    let pinnedCount = 0;
    Object.values(fullSet.functions).forEach((fn) => {
      pinnedCount += Object.values(fn.tests).filter((e) => e.pinned).length;
    });

    // Persist the test set
    try {
      fs.writeFileSync(jsonFile, JSON5.stringify(fullSet)); // Update the file
    } catch (e: unknown) {
      const msg = isError(e) ? e.message : JSON5.stringify(e);
      vscode.window.showErrorMessage(
        `Unable to update json file: ${jsonFile} (${msg})`
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
      } catch (e: unknown) {
        const msg = isError(e) ? e.message : JSON5.stringify(e);

        vscode.window.showErrorMessage(
          `Unable to update Jest test file: ${jestFile} (${msg})`
        );
      }
    } else if (fs.existsSync(jestFile)) {
      // Delete the test file: it would contain no tests
      try {
        fs.rmSync(jestFile);
      } catch (e: unknown) {
        const msg = isError(e) ? e.message : JSON5.stringify(e);
        vscode.window.showErrorMessage(
          `Unable to remove Jest test file: ${jestFile} (${msg})`
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
    const currInputsJson = fuzzer.getIoKey(currTest.input);

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
  } // fn: _saveColumnSortOrders

  /**
   * Shows the open text editor at the desired position. If an
   * exsting editor is not found, then one is created either to
   * the left of the FuzzPanel (in the case where it is not in
   * column 1) or to the right of the FuzzPanel.
   *
   * @param module path to TypeScript module
   * @param position? offset position to receive focus in file
   */
  private _navigateToSource(module: string, position?: number): void {
    const uri = vscode.Uri.file(module);
    let viewColumn: vscode.ViewColumn | undefined;

    // Find an open editor with this module's url & store its ViewColumn
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          if (tab.input.uri.toString() === uri.toString()) {
            viewColumn = tabGroup.viewColumn; // found the editor
          }
        }
        if (viewColumn) break;
      }
      if (viewColumn) break;
    }

    // If we didn't find an editor, open the editor to the left of the
    // FuzzPanel except in the case where FuzzPanel is in column 1, in
    // which case open the editor to the right
    if (!viewColumn) {
      if (this._panel.viewColumn) {
        const fuzzPanelPane = Number.parseInt(
          this._panel.viewColumn.toString()
        );
        if (fuzzPanelPane === 1) {
          viewColumn = 2; // already in left-most column so open to the right
        } else {
          viewColumn = fuzzPanelPane - 1; // open one column to the left
        }
      } else {
        viewColumn = -2; // FuzzPanel doesn't have a ViewColumn...?
      }
    }

    // Open the text document for the module
    vscode.workspace.openTextDocument(uri).then((doc) => {
      // Show the document in the desired column and position the
      // cursor where we want, if a position was provided.
      const opt: vscode.TextDocumentShowOptions = {
        viewColumn: viewColumn,
        selection: position
          ? new vscode.Range(doc.positionAt(position), doc.positionAt(position))
          : undefined,
      };
      vscode.window.showTextDocument(doc, opt);
    });
  }
  /**
   * Add code skeleton for a property validator to the program source code.
   */
  private async _doAddValidatorCmd() {
    const fn = this._fuzzEnv.function; // Function under test
    const module = this._fuzzEnv.function.getModule();
    const validatorPrefix = fn.getName() + "Validator";
    let fnCounter = 0;
    let program: ProgramDef;

    try {
      program = ProgramDef.fromModule(module);
    } catch (e: unknown) {
      this._errorMessage = isError(e)
        ? `${e.message}<vscode-divider></vscode-divider><small><pre>${e.stack}</pre></small>`
        : "Unknown error";
      vscode.window.showErrorMessage(
        `Unable to add the validator. TypeScript source file cannot be parsed. ${this._fuzzEnv.function.getModule()}`
      );
      return;
    }

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

    const inArgs = fn.getArgDefs();
    const validatorArgs = this._getValidatorArgs(inArgs);
    const inArgConsts = inArgs
      .map(
        (argDef, i) =>
          `  const ${argDef.getName()}: ${argDef.getTypeAnnotation()} = ${
            validatorArgs.resultArgName
          }.in[${i}];`
      )
      .join("\n");

    const outTypeAsArg = fn.getReturnArg();
    const outTypeAsString = outTypeAsArg
      ? outTypeAsArg.getTypeAnnotation()
      : undefined;

    const outArgConst = this._getOutArgConst(
      inArgs,
      validatorArgs.resultArgName,
      outTypeAsString
    );

    // Name of the validator generated
    const validatorName = `${validatorPrefix}${
      fnCounter === 0 ? "" : fnCounter
    }`;

    // prettier-ignore
    const skeleton = `

export function ${validatorName} ${validatorArgs.str}: boolean | undefined {
${inArgConsts}
  ${outArgConst}

  return true; // true=passed; false=failed
}`;

    // Save the editor if dirty
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.fileName === module && editor.document.isDirty) {
        await editor.document.save();
      }
    }

    // Append the code skeleton to the source file
    try {
      if (!hasImport) {
        // Pre-pend the import & append the validator
        const fileData = fs.readFileSync(module);
        const importStmt =
          Buffer.from(`import { FuzzTestResult } from "@nanofuzz/runtime";
`);
        const validatorFn = Buffer.from(skeleton);
        const fd = fs.openSync(module, "w+");

        fs.writeSync(fd, importStmt, 0, importStmt.length, 0);
        fs.writeSync(fd, fileData, 0, fileData.length, importStmt.length);
        fs.writeSync(
          fd,
          validatorFn,
          0,
          validatorFn.length,
          importStmt.length + fileData.length
        );
        fs.closeSync(fd);
      } else {
        // Append the validator to the end of the file
        const fd = fs.openSync(module, "as+");
        fs.writeFileSync(fd, skeleton);
        fs.closeSync(fd);
      }

      // Change focus to the generated validator
      try {
        const fn = ProgramDef.fromModule(module).getFunctions()[validatorName];
        this._navigateToSource(fn.getModule(), fn.getStartOffset());
      } catch (e: unknown) {
        this._errorMessage = isError(e)
          ? `${e.message}<vscode-divider></vscode-divider><small><pre>${e.stack}</pre></small>`
          : "Unknown error";
        vscode.window.showErrorMessage(
          `Unable to navigate to the created validator '${validatorName}' in '${fn.getModule()}'`
        );
        return;
      }
    } catch {
      vscode.window.showErrorMessage(
        `Unable to write property validator code skeleton to source file`
      );
    }
  }

  /**
   * Choose a name for an identifier that doesn't conflict with the input arguments
   *
   * @param inArgs The input arguments
   * @param candidateNames The candidate names to choose from
   * @param maxSuffix The maximum suffix to use when generating a new name
   * @returns The chosen name and whether it was generated
   */
  private _getIdentifierNameAvoidingConflicts(
    // The input arguments
    inArgs: fuzzer.ArgDef<fuzzer.ArgType>[],
    // The candidate names to choose from
    candidateNames: string[],
    // The maximum suffix to use when generating a new name
    maxSuffix: number
  ): {
    // The chosen name
    name: string;
    // Whether the name was generated (as opposed to being in possibleResultArgNames)
    generated: boolean;
  } {
    const inArgNames = inArgs.map((argDef) => argDef.getName());
    for (const name of candidateNames) {
      if (!inArgNames.includes(name)) {
        return { name, generated: false };
      }
    }

    let i = 1;
    // Generate a new name with a suffix
    for (const candidateName of candidateNames) {
      while (i <= maxSuffix) {
        const name = `${candidateName}_${i}`;
        if (!inArgNames.includes(name)) {
          return { name, generated: true };
        }
        i++;
      }
    }

    // In the extremely unlikely event that all the names generated above are
    // already in `inArgNames`, we'll just return `r_conflicted` and not worry
    // about potential conflicts.
    return { name: "r_conflicted", generated: true };
  } // fn: getIdentifierNameAvoidingConflicts()

  /**
   * Get the string representation for the validator arguments, along with the
   * name of the argument that will hold the result.
   *
   * @param inArgs The input arguments
   * @returns An object containing the above information
   */
  private _getValidatorArgs(inArgs: fuzzer.ArgDef<fuzzer.ArgType>[]): {
    str: string;
    resultArgName: string;
  } {
    const resultArgName = this._getIdentifierNameAvoidingConflicts(
      inArgs,
      resultArgCandidateNames,
      maxResultArgSuffix
    );
    const resultArgString = `${resultArgName.name}: FuzzTestResult`;
    return {
      str: `(${resultArgString})`,
      resultArgName: resultArgName.name,
    };
  } // fn: getValidatorArgs()

  /**
   * Get the string for the declaration of the out variable.
   *
   * The out variable is the variable that will hold the result of the function
   * under test.
   *
   * @param inArgs The input arguments
   * @param resultArgName The name of the argument that will hold the result
   * @param returnType The return type of the function
   * @returns The string for the declaration of the out variable
   */
  private _getOutArgConst(
    inArgs: fuzzer.ArgDef<fuzzer.ArgType>[],
    resultArgName: string,
    returnType?: string
  ): string {
    const outVarName = this._getIdentifierNameAvoidingConflicts(
      inArgs,
      outVarCandidateNames,
      maxOutVarSuffix
    );
    const outVarString = `const ${outVarName.name}${
      returnType ? ": " + returnType : ""
    } = ${resultArgName}.out;`;
    return outVarString;
  } // fn: getOutConst()

  /**
   * Message handler for the `validator.getList` command. Gets the list
   * of validators from the program source code and sends it back to the
   * front-end.
   */
  private _doGetValidators() {
    let program: ProgramDef;
    try {
      program = ProgramDef.fromModule(this._fuzzEnv.function.getModule());
    } catch (e: unknown) {
      this._errorMessage = isError(e)
        ? `${e.message}<vscode-divider></vscode-divider><small><pre>${e.stack}</pre></small>`
        : "Unknown error";
      vscode.commands.executeCommand(
        telemetry.commands.logTelemetry.name,
        new telemetry.LoggerEntry(
          "FuzzPanel.parse.error",
          "Parsing program failed. Target: %s. Message: %s",
          [this.getFnRefKey(), this._errorMessage]
        )
      );
      return;
    }
    const fn = this._fuzzEnv.function; // Function under test

    const oldValidatorNames = JSON5.stringify(
      this._fuzzEnv.validators.map((e) => e.name)
    );
    const newValidators = fuzzer.getValidators(program, fn);
    const newValidatorNames = JSON5.stringify(newValidators.map((e) => e.name));

    // Only send the message if there has been a change
    if (oldValidatorNames !== newValidatorNames) {
      // Update the Fuzzer Environment
      this._fuzzEnv.validators = fuzzer.getValidators(program, fn);

      // Notify the front-end about the change
      this._panel.webview.postMessage({
        command: "validator.list",
        json: JSON5.stringify({
          validators: newValidators.map((e) => e.name),
        }),
      });
    }
  } // fn: _doGetValidators()

  // !!!!!!
  protected test(
    env: fuzzer.FuzzEnv,
    pinnedTests: fuzzer.FuzzPinnedTest[] = [],
    callbackFn: (result: fuzzer.FuzzTestResults | Error) => void
  ): void {
    if (!this._gen) {
      this._gen = fuzzer.TestGenerator(
        env,
        pinnedTests,
        this._statusFn,
        this._cancelFn
      );
    }

    // !!!!!!!! rationalize changed env

    const nextBatch = (): void => {
      let result: fuzzer.FuzzTestResults | undefined;
      const timer = performance.now();

      while (!result && performance.now() - timer < 125 && this._gen) {
        try {
          result = this._gen.next().value;
          if (result) {
            callbackFn(result);
            return;
          }
        } catch (e) {
          callbackFn(
            isError(e)
              ? e
              : { name: "unknown error", message: JSON5.stringify(e) }
          );
          return;
        }
      }
      if (!result)
        setTimeout(() => {
          nextBatch();
        });
    };

    nextBatch();
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
  private async _testAll(json: string): Promise<void> {
    const panelInput: FuzzPanelFuzzStartMessage = JSON5.parse(json);
    this._getConfigFromUi(panelInput);

    // Gather all inputs to inject, including "interesting" inputs
    const testsToInject = this._getFuzzTestsForThisFn({
      interesting: true,
    }).tests;

    // Update the UI
    this._results = undefined;
    this._state = FuzzPanelState.busyTesting;
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

      try {
        // Test the function & store the results
        this._stopTesting = false;
        this.test(
          this._fuzzEnv,
          Object.values(testsToInject),
          (result: fuzzer.FuzzTestResults | Error) => {
            if (isError(result)) {
              /* Error */
              // Transition to error state
              this._errorMessage = `${result.message}<vscode-divider></vscode-divider><small><pre>${result.stack}</pre></small>`;
              this._state = FuzzPanelState.error;

              // Log the end of fuzzing
              vscode.commands.executeCommand(
                telemetry.commands.logTelemetry.name,
                new telemetry.LoggerEntry(
                  "FuzzPanel.fuzz.error",
                  "Fuzzing failed. Target: %s. Message: %s",
                  [this.getFnRefKey(), this._errorMessage]
                )
              );

              // Update the UI
              this._updateHtml();
            } else {
              /* Success */
              this._results = result;

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

              // Persist the fuzz test run settings (!!!!!!! validation)
              this._updateFuzzTests();

              // Update the UI
              this._updateHtml();
            }
          }
        );
      } catch (e: unknown) {
        this._state = FuzzPanelState.error;
        this._errorMessage = isError(e)
          ? `${e.message}<vscode-divider></vscode-divider><small><pre>${e.stack}</pre></small>`
          : "Unknown error";
        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "FuzzPanel.fuzz.error",
            "Fuzzing failed. Target: %s. Message: %s",
            [this.getFnRefKey(), this._errorMessage]
          )
        );
        // Update the UI
        this._updateHtml();
      }
    }); // setTimeout
  } // fn: _doFuzzStartCmd()

  /**
   * Adds and executes a test input. Requires the message's input
   * property be filled with an input to test.
   *
   * @param json serialized inputs
   */
  private async _testOne(json: string): Promise<void> {
    const panelInput: FuzzPanelFuzzStartMessage = JSON5.parse(json);

    // Make sure we have an input to add
    if (panelInput.input === undefined) {
      this._state = FuzzPanelState.error;
      this._errorMessage = `No single input was provided to add and test`;
      this._updateHtml();
      return;
    }

    this._getConfigFromUi(panelInput);
    const specs = this._fuzzEnv.function.getArgDefs();

    // Build the test to inject
    const injectedTest: fuzzer.FuzzPinnedTest = {
      input: panelInput.input.map((v, i) => {
        return {
          name: specs[i].getName(),
          offset: i,
          value: v.value,
          origin: { type: "user" },
        };
      }),
      output: [], // the fuzzer fills this
      pinned: false,
    };

    // Turn off input generation: execute just the single injected input
    // and include all results
    const noGenerators: typeof this._fuzzEnv.options.generators = JSON5.parse(
      JSON5.stringify(this._fuzzEnv.options.generators)
    );
    let k: keyof typeof noGenerators;
    for (k in noGenerators) {
      noGenerators[k].enabled = false;
    }
    const envNoGenerators: fuzzer.FuzzEnv = {
      ...this._fuzzEnv,
      options: {
        ...this._fuzzEnv.options,
        generators: noGenerators,
      },
    };

    // Make the FuzzPanel busy
    this._state = FuzzPanelState.busyTesting;
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

      // Run just the one test input w/all input generators
      this._stopTesting = false;
      this.test(
        envNoGenerators,
        [injectedTest],
        (result: fuzzer.FuzzTestResults | Error) => {
          if (isError(result)) {
            /* Error */
            this._state = FuzzPanelState.error;
            this._errorMessage = `${result.message}<vscode-divider></vscode-divider><small><pre>${result.stack}</pre></small>`;
            vscode.commands.executeCommand(
              telemetry.commands.logTelemetry.name,
              new telemetry.LoggerEntry(
                "FuzzPanel.fuzz.error",
                "Fuzzing failed. Target: %s. Message: %s",
                [this.getFnRefKey(), this._errorMessage]
              )
            );

            // Update the UI
            this._updateHtml();
          } else {
            /* Success */
            this._results = result;

            // Log the end of fuzzing
            vscode.commands.executeCommand(
              telemetry.commands.logTelemetry.name,
              new telemetry.LoggerEntry(
                "FuzzPanel.fuzz.done",
                "Fuzzing completed successfully. Target: %s. Results: %s",
                [this.getFnRefKey(), JSON5.stringify(result)]
              )
            );

            // If we have a matching result then give the new result UI focus
            if (
              result.results.length &&
              JSON5.stringify(
                result.results[result.results.length - 1].input
              ) === JSON5.stringify(injectedTest.input)
            ) {
              // Give focus to the newInput
              this._focusInput = [
                result.results[result.results.length - 1].category,
                result.results.length - 1,
              ];
            }

            // Transition to done state
            this._errorMessage = undefined;
            this._state = FuzzPanelState.done;

            // Persist the fuzz test run settings
            this._updateFuzzTests();

            // Update the UI
            this._updateHtml();
            this._focusInput = undefined;
          }
        }
      );
    }); // setTimeout
  } // fn: _addTestInputCmd

  /**
   * Updates the fuzzer configuration from the front-end UI message.
   *
   * @param panelInput a FuzzPanelFuzzStartMessage input
   */
  private _getConfigFromUi(panelInput: FuzzPanelFuzzStartMessage): void {
    const fn = this._fuzzEnv.function;

    // Remember the selected tab
    this._lastTab = panelInput.lastTab;

    // Apply numeric fuzzer option changes
    (
      [
        "suiteTimeout",
        "maxDupeInputs",
        "maxTests",
        "maxFailures",
        "fnTimeout",
      ] as const
    ).forEach((e) => {
      if (e in panelInput.fuzzer) {
        const inputOption = panelInput.fuzzer[e];
        if (typeof inputOption === "number") {
          this._fuzzEnv.options[e] = inputOption;
        }
      }
    });

    // Apply boolean fuzzer option changes
    (["useImplicit", "useHuman", "useProperty"] as const).forEach((e) => {
      if (e in panelInput.fuzzer) {
        const inputOption = panelInput.fuzzer[e];
        if (typeof inputOption === "boolean") {
          this._fuzzEnv.options[e] = inputOption;
        }
      }
    });

    // Apply generator and measure settings
    this._fuzzEnv.options.generators = panelInput.fuzzer.generators;
    this._fuzzEnv.options.measures = panelInput.fuzzer.measures;

    // Apply the argument overrides from the front-end UI
    _applyArgOverrides(fn, panelInput.args, this._fuzzEnv.options.argDefaults);
  } // fn: _getConfigFromUi

  /**
   * Persist the current fuzzer configuration to the JSON file
   */
  private _updateFuzzTests(): void {
    const testSet = this._getFuzzTestsForThisFn();
    testSet.options = this._fuzzEnv.options;
    testSet.validators = this._fuzzEnv.validators.map((ref) => ref.name);
    testSet.argOverrides = this._argOverrides;
    testSet.sortColumns = this._sortColumns;
    testSet.isVoid = this._fuzzEnv.function.isVoid();
    this._putFuzzTestsForThisFn(testSet);
  } // fn: _updateFuzzTests

  /**
   * Disposes all objects used by this instance
   */
  public dispose(): void {
    // Set the disposed flag
    this._disposed = true;

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
    let html = "";
    try {
      const webview: vscode.Webview = this._panel.webview; // Current webview
      const extensionUri: vscode.Uri = this._extensionUri; // Extension URI
      const disabledFlag =
        this._state === FuzzPanelState.busyTesting ||
        this._state === FuzzPanelState.busyAnalyzing
          ? ` disabled `
          : ""; // Disable inputs if busy
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
        "build",
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
      const argDefs = fn.getArgDefs();
      const counterArgDef = { id: 0 }; // Unique counter for argument ids
      let argDefHtml = ""; // HTML representing argument definitions
      const heuristicValidatorDescription = fn.isVoid()
        ? "Heuristic validator (for void functions). Fails: timeout, exception, values !==undefined"
        : "Heuristic validator. Fails: timeout, exception, null, undefined, Infinity, NaN";

      // If fuzzer results are available, calculate how many tests passed, failed, etc.
      if (this._state === FuzzPanelState.done && this._results !== undefined) {
        this._results.results.forEach((result) => {
          resultSummary[result.category]++;
        });
      } // if: results are available

      argDefs.forEach((arg, i) => {
        // Render the HTML for each generator argument
        argDefHtml += this._argDefToHtmlForm(
          arg,
          counterArgDef,
          "",
          i === argDefs.length - 1 ? "" : ",",
          undefined
        );
      });

      // Prettier abhorrently butchers this HTML, so disable prettier here
      // prettier-ignore
      html += /*html*/ `
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
            <title>${toolName} Panel</title>
          </head>
          <body>
            
          <!-- ${toolName} pane -->
          <div id="pane-nanofuzz"> 
            <h2 style="font-size:1.75em; padding-top:.2em; margin-bottom:.2em;">${this._state === FuzzPanelState.busyTesting ? "Testing:" : this._state === FuzzPanelState.busyAnalyzing ? "Analyzing:" : "Test: "+htmlEscape(
              fn.getName())+"()"} 
              <div title="Open soure code" id="openSourceLink" class='codicon codicon-link clickable'></div>
            </h2>

            <!-- Function Arguments -->
            <div id="argDefs">${argDefHtml}</div>

            <!-- Change Validators Options -->
            <div style="clear: both;">
            <p style="font-size:1.2em; margin-top: 0.1em; margin-bottom: 0.1em;"><strong>Categorize output using:</strong></p>
            <div style="padding-left: .76em;">
              <!-- Checkboxes -->
              <div class="fuzzInputControlGroup">
                <!-- Heuristic Validator -->
                <vscode-checkbox ${disabledFlag} id="fuzz-useImplicit" ${this._fuzzEnv.options.useImplicit ? "checked" : ""}>
                  <span class="tooltipped tooltipped-ne" aria-label="${heuristicValidatorDescription}">
                  Heuristic validator 
                  </span>
                </vscode-checkbox>

                <!-- Property Validator -->
                <span style="padding-left:1.3em;"> </span>
                <span style="display:inline-block;">
                  <vscode-checkbox ${disabledFlag} id="fuzz-useProperty" ${this._fuzzEnv.options.useProperty ? "checked" : ""}>
                    <span id="validator-functionList" class="tooltipped tooltipped-ne" aria-label=""> 
                      Property validator${this._fuzzEnv.validators.length===1 ? "" : "s"}
                    </span> (<span id="validator-functionCount">${this._fuzzEnv.validators.length}</span>)
                  </vscode-checkbox>
                  <span id="validator.add" class="tooltipped tooltipped-nw" aria-label="Add new property validator">
                    <span class="classAddRefreshValidator">
                      <span class="codicon codicon-add" style="padding-left:0.1em; padding-right:0.1em;"></span>
                    </span>
                  </span>
                  <span id="validator.getList" class="tooltipped tooltipped-nw" aria-label="Refresh list">
                    <span class="classAddRefreshValidator">
                      <span class="codicon codicon-refresh" style="padding-left:0.1em;"></span>
                    </span>
                  </span>
                </span>
              </div>
            </div>

            <vscode-divider></vscode-divider>

            <!-- Fuzzer Options -->
            <div id="fuzzOptions" class="hidden">
              <div class="panelButton">
                <span class="clickable codicon codicon-close" id="fuzzOptions-close"></span>
              </div>
              <h2>More options</h2>

              <vscode-panels aria-label="Options tabs" class="fuzzTabStrip">
                <!-- <vscode-panel-tab aria-label="Validating options tab">Validating</vscode-panel-tab> -->
                <vscode-panel-tab aria-label="Stopping options tab">Stopping</vscode-panel-tab>
                <vscode-panel-tab aria-label="Input generation options tab">Generating Inputs</vscode-panel-tab>

                <vscode-panel-view>
                  <p>
                    These settings control how long testing runs. Testing pauses and results are returned when any limit is reached.  
                    Saved or pinned tests count against the maximum runtime and number of failures but do not count against the maximum number of tests. 
                    For max runtime and number of failed tests, 0 indicates no limit.
                  </p>
                  <div class="fuzzInputControlGroup">
                    <vscode-text-field ${disabledFlag} size="3" id="fuzz-suiteTimeout" name="fuzz-suiteTimeout" value="${this._fuzzEnv.options.suiteTimeout}">
                      Max runtime (ms)
                    </vscode-text-field>
                    <vscode-text-field ${disabledFlag} size="3" id="fuzz-maxTests" name="fuzz-maxTests" value="${this._fuzzEnv.options.maxTests}">
                      Max number of tests
                    </vscode-text-field>
                    <vscode-text-field ${disabledFlag} size="3" id="fuzz-maxFailures" name="fuzz-maxFailures" value="${this._fuzzEnv.options.maxFailures}">
                      Max failed tests
                    </vscode-text-field>
                    <vscode-text-field ${disabledFlag} size="3" id="fuzz-maxDupeInputs" name="fuzz-maxDupeInputs" value="${this._fuzzEnv.options.maxDupeInputs}">
                      Max dupe inputs
                    </vscode-text-field>
                  </div>
    
                  <p>
                    To ensure testing completes, stop long-running function calls and categorize them as timeouts.
                  </p>
                  <div class="fuzzInputControlGroup">
                    <vscode-text-field ${disabledFlag} size="3" id="fuzz-fnTimeout" name="fuzz-fnTimeout" value="${this._fuzzEnv.options.fnTimeout}">
                      Test function timeout (ms)
                    </vscode-text-field>
                  </div>
                </vscode-panel-view>

                <vscode-panel-view>
                  <p>
                    What makes an input "interesting"?
                  </p>
                  <div class="fuzzInputControlGroup">
                    <vscode-checkbox ${disabledFlag} id="fuzz-measure-CoverageMeasure-enabled" ${this._fuzzEnv.options.measures.CoverageMeasure.enabled ? "checked" : ""}>
                      <span> 
                        Increases code coverage
                      </span>
                    </vscode-checkbox>
                    <vscode-text-field style="display:none" ${disabledFlag} size="3" id="fuzz-measure-CoverageMeasure-weight" name="fuzz-measures-CoverageMeasure-weight" value="${this._fuzzEnv.options.measures.FailedTestMeasure.weight}">
                      Weight of measure (&gt;=1)
                    </vscode-text-field>
                    <vscode-checkbox ${disabledFlag} id="fuzz-measure-FailedTestMeasure-enabled" ${this._fuzzEnv.options.measures.FailedTestMeasure.enabled ? "checked" : ""}>
                      <span> 
                        Causes a new test to fail
                      </span>
                    </vscode-checkbox>
                    <vscode-text-field style="display:none" ${disabledFlag} size="3" id="fuzz-measures-FailedTestMeasure-weight" name="fuzz-measures-FailedTestMeasure-weight" value="${this._fuzzEnv.options.measures.FailedTestMeasure.weight}">
                      Weight of measure (&gt;=1)
                    </vscode-text-field>
                  </div>

                  <p>
                    Generate inputs:
                  </p>
                  <div class="fuzzInputControlGroup">
                    <vscode-checkbox disabled id="fuzz-gen-RandomInputGenerator-enabled" checked>
                      <span> 
                        Randomly (always enabled)
                      </span>
                    </vscode-checkbox>                    
                    <vscode-checkbox ${disabledFlag} id="fuzz-gen-MutationInputGenerator-enabled" ${this._fuzzEnv.options.generators.MutationInputGenerator.enabled ? "checked" : ""}>
                      <span> 
                        By mutating "interesting" inputs
                      </span>
                    </vscode-checkbox>                    
                    <vscode-checkbox ${disabledFlag} id="fuzz-gen-AiInputGenerator-enabled" ${this._fuzzEnv.options.generators.AiInputGenerator.enabled ? "checked" : ""}>
                      <span> 
                        Using an LLM
                      </span>
                    </vscode-checkbox>                    
                  </div>

                </vscode-panel-view>
                </vscode-panels>

              <vscode-divider></vscode-divider>
            </div>

            <!-- Button Bar -->
            <div>
              <vscode-button ${disabledFlag} ${this._state===FuzzPanelState.busyTesting ? `class="hidden"` : ""} id="fuzz.start" appearance="primary icon" aria-label="${this._results ? "Generate more tests": "Generate tests"}">
                <span class="codicon codicon-${this._results ? "debug-continue" : "play"}"></span>
              </vscode-button>
              <vscode-button ${this._state!==FuzzPanelState.busyTesting ? `class="hidden"` : ""} id="fuzz.stop" appearance="primary icon" aria-label="Pause testing">
                <span class="codicon codicon-debug-pause"></span>
              </vscode-button>
              <span ${ 
                (this._results !== undefined)
                    ? ``
                    : `class="hidden" ` 
                }>
                <vscode-button ${disabledFlag}  id="fuzz.rerun" appearance="secondary icon" aria-label="Re-test these results">
                  <span class="codicon codicon-debug-rerun"></span>
                </vscode-button>
                <vscode-button ${disabledFlag}  id="fuzz.addTestInputOptions.open" appearance="secondary icon" aria-label="Add a test input">
                  <span class="codicon codicon-add"></span>
                </vscode-button>
                <vscode-button ${disabledFlag} class="hidden" id="fuzz.addTestInputOptions.close" appearance="secondary icon depressed" aria-label="Add a test input">
                  <span class="codicon codicon-add"></span>
                </vscode-button>
                &nbsp;
                <vscode-button ${disabledFlag}  id="fuzz.clear" appearance="secondary icon" aria-label="Clear unused tests">
                  <span class="codicon codicon-clear-all"></span>
                </vscode-button>
              </span>
              &nbsp;
              <vscode-button ${disabledFlag} ${ 
                vscode.workspace
                  .getConfiguration("nanofuzz.ui")
                  .get("hideMoreOptionsButton")
                    ? `class="hidden" ` 
                    : ``
                } id="fuzz.options.open" appearance="secondary icon" aria-label="Open settings">
                <span class="codicon codicon-settings-gear"></span>
              </vscode-button>
              <vscode-button ${disabledFlag} id="fuzz.options.close" class="hidden" appearance="secondary icon depressed" aria-label="Close settings">
                <span class="codicon codicon-settings-gear"></span>
              </vscode-button>
            </div>

            <!-- Add New Test Input -->
            <div id="fuzzAddTestInputOptions-pane" class="hidden">
              <vscode-divider></vscode-divider>
              <div class="panelButton">
                <span class="clickable codicon codicon-close" id="fuzzAddTestInputOptions-close"></span>
              </div>
              <h2 style="margin-bottom:.3em;">Add a test input</h2>
              <p class="fuzzPanelDescription">
                Enter literal Javascript input value${ argDefs.length ===1 ? "" : "s"} below in JSON format. 
                ${ argDefs.length ===1 ? "It" : "They"} won't be type-checked.
                Click <span class="codicon codicon-run-below"></span> to test.
              </p>
              <table class="fuzzGrid">
                <thead>
                  <tr>
                    ${argDefs
                      .map((a,i) => `<th><big>input: ${a.getName()}</big><span id="addInputArg-${i}-message"></span></th>`)
                      .join("\r\n")}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr style="vertical-align: top;">
                    ${argDefs
                      .map(
                        (arg,i) => /*html*/
                          `<td>
                            <vscode-text-field ${disabledFlag} id="addInputArg-${i}-value" name="addInputArg-${i}-value" placeholder="Literal value (JSON)" value=""></vscode-text-field>
                          </td>`
                      )
                      .join("\r\n")}
                      <td>
                        <vscode-button ${disabledFlag} id="fuzz.addTestInput" appearance="primary icon" ariaLabel="Test this input">
                          <span class="codicon codicon-run-below"></span>
                        </vscode-button>
                      </td>
                  </tr>
                </tbody>
              </table>
              <vscode-divider></vscode-divider>
            </div>            

            <!-- Fuzzer Errors -->
            <div class="fuzzErrors${
              this._state === FuzzPanelState.error
                ? ""
                : " hidden"
            }">
              <h3>Testing stopped with this error:</h3>
              <p>${this._errorMessage ?? "Unknown error"}</p>
            </div>

            <!-- Fuzzer Warnings -->
            <div class="fuzzWarnings${
              this._state === FuzzPanelState.done && !this._fuzzEnv.options.useHuman && !this._fuzzEnv.options.useImplicit && (!this._fuzzEnv.options.useProperty || !this._fuzzEnv.validators.length )
                ? ""
                : " hidden"
            }">
              <p>No validators were selected, so all tests below will pass. You can change this by turning on one or more validators.</p>
            </div>

            <div class="fuzzWarnings${
              this._state === FuzzPanelState.done && this._fuzzEnv.options.useProperty && !(this._fuzzEnv.validators.length)
                ? ""
                : " hidden"
            }">
              <p>No property validators were found, so the property validator column is blank.</p>
            </div>

            <!-- Fuzzer Info -->
            <div class="fuzzInfo hidden"></div>
            
            <!-- Fuzzer Output -->
            <div class="fuzzResults" ${
              this._state === FuzzPanelState.done
                ? ""
                : /*html*/ `style="display:none;"`
            }>
              <vscode-panels aria-label="Test result tabs" id="fuzzResultsTabStrip" class="fuzzTabStrip"${this._focusInput ? ` activeId="tab-${this._focusInput[0]}"` : (this._lastTab ? ` activeId="${this._lastTab}"` : ``)}>`;

      // If we have results, render the output tabs to display the results.
      const tabs: (
        | {
            id: fuzzer.FuzzResultCategory;
            name: string;
            description: string;
            hasGrid: boolean;
          }
        | {
            id: "runInfo";
            name: string;
            description: string;
            hasGrid: false;
          }
      )[] = [
        {
          id: "failure",
          name: "Validator Error",
          description: `A property validator threw an exception for these inputs. Fix the bug in the property validator and re-test.`,
          hasGrid: true,
        },
        {
          id: "disagree",
          name: "Disagree",
          description: `The property and human validators disagreed about how to categorize these outputs. Correct one of the validators and re-test.`,
          hasGrid: true,
        },
        {
          id: "timeout",
          name: "Timeouts",
          description: `These inputs did not terminate within ${this._fuzzEnv.options.fnTimeout}ms, and no validator categorized them as passed.`,
          hasGrid: true,
        },
        {
          id: "exception",
          name: "Exceptions",
          description: `These inputs resulted in a runtime exception, and no validator categorized them as passed.`,
          hasGrid: true,
        },
        {
          id: "badValue",
          name: "Failed",
          description: `${
            this._fuzzEnv.options.useProperty // if using property validator
              ? `The property or human validator categorized these outputs as failed.`
              : this._fuzzEnv.options.useImplicit // if using heuristic validator
              ? `The heuristic or human validator categorized these outputs as failed.`
              : `The human validator categorized these outputs as failed.`
          }`,
          // description: `A validator categorized these outputs as failed. The heuristic validator by default fails outputs that contain null, NaN, Infinity, or undefined if no other validator categorizes them as passed.`,
          hasGrid: true,
        },
        {
          id: "ok",
          name: "Passed",
          description: `A validator categorized these outputs as passed, or no validator categorized them as failed.`,
          // description: `Passed. No validator categorized these outputs as failed.`,
          // description: `No validator categorized these outputs as failed, or a validator categorized them as passed.`,
          hasGrid: true,
        },
      ];
      if (this._results) {
        // prettier-ignore
        const textReason = {
          [fuzzer.FuzzStopReason.CANCEL]: `because the user stopped testing.`,
          [fuzzer.FuzzStopReason.CRASH]: `because it crashed.`,
          [fuzzer.FuzzStopReason.MAXTIME]: `because it exceeded the maximum time configured (${
              this._results.env.options.suiteTimeout
            } ms) for it to run.`,
          [fuzzer.FuzzStopReason.MAXFAILURES]: `because it found ${
              this._results.env.options.maxFailures
            } failing test${
              this._results.env.options.maxFailures !== 1 ? "s" : ""
            }. This is the maximum number configured.`,
          [fuzzer.FuzzStopReason.MAXTESTS]: `because it reached the maximum number of new tests configured (${
              this._results.env.options.maxTests
            }). This is in addition to the ${this._results.stats.counters.inputsInjected} interesting input${
              this._results.stats.counters.inputsInjected !== 1 ? "s" : ""
            } ${toolName} also tested.`,
          [fuzzer.FuzzStopReason.MAXDUPES]: `because it reached the maximum number of sequentially-generated duplicate inputs configured (${
              this._results.env.options.maxDupeInputs
            }). This can mean that NaNofuzz is having difficulty generating further new inputs: the function's input space might be small or near exhaustion. You can change this setting in More Options.`,
          "": `because of an unknown reason.`,
          [fuzzer.FuzzStopReason.NOMOREINPUTS]: `because it ran out of inputs to test (e.g., it was testing a single input).`,
        };

        // Build the list of input generators
        const genTextEnabled: string[] = [];
        const genTextDisabled: string[] = [];
        let g: keyof typeof env.options.generators;
        for (g in env.options.generators) {
          const shortName = g.replace("InputGenerator", "").toLowerCase();
          if (env.options.generators[g].enabled) {
            if (`generator.${g}` in this._results.stats.generators) {
              const genStats = this._results.stats.generators[`generator.${g}`];
              genTextEnabled.push(
                `<strong><u>${shortName}</u></strong> produced ${
                  genStats.counters.inputsGenerated
                } inputs (${genStats.counters.dupesGenerated} of which ${
                  genStats.counters.dupesGenerated === 1
                    ? "was a duplicate"
                    : "were duplicates"
                }) in ${genStats.timers.gen.toFixed(2)} ms (${(
                  genStats.timers.gen /
                  (genStats.counters.inputsGenerated +
                    genStats.counters.dupesGenerated)
                ).toFixed(2)} ms/input)`
              );
            } else {
              genTextEnabled.push(
                `<strong><u>${shortName}</u></strong> was enabled but did not produce any inputs before testing stopped`
              );
            }
          } else {
            genTextDisabled.push(`<strong><u>${shortName}</u></strong>`);
          }
        }

        const generatorsText = `${toolName} generated inputs using the following strateg${
          genTextEnabled.length === 1 ? "y" : "ies"
        }: ${toPrettyList(genTextEnabled)}. ${
          genTextDisabled.length
            ? `The following strateg${
                genTextDisabled.length === 1 ? "y was" : "ies were"
              } not used because ${
                genTextDisabled.length === 1 ? "it was" : "they were"
              } disabled: `
            : ``
        }${toPrettyList(genTextDisabled)}${genTextDisabled.length ? "." : ""}`;

        // Build code coverage information
        const coverageStats = this._results.stats.measures.CodeCoverageMeasure;
        const fmtPct = (n: number, d: number) =>
          d === 0 ? "na%" : ((n * 100) / d).toFixed(0).toString() + "%";
        const coverageText =
          coverageStats === undefined
            ? ""
            : `The executed inputs exercised ${
                coverageStats.counters.functionsCovered
              } of ${coverageStats.counters.functionsTotal} function${
                coverageStats.counters.functionsTotal === 1 ? "" : "s"
              } (${fmtPct(
                coverageStats.counters.functionsCovered,
                coverageStats.counters.functionsTotal
              )}), ${coverageStats.counters.statementsCovered} of ${
                coverageStats.counters.statementsTotal
              } statement${
                coverageStats.counters.statementsTotal === 1 ? "" : "s"
              } (${fmtPct(
                coverageStats.counters.statementsCovered,
                coverageStats.counters.statementsTotal
              )}), and ${coverageStats.counters.branchesCovered} of ${
                coverageStats.counters.branchesTotal
              } branch${
                coverageStats.counters.branchesTotal === 1 ? "" : "es"
              } (${fmtPct(
                coverageStats.counters.branchesCovered,
                coverageStats.counters.branchesTotal
              )}) in the ${coverageStats.files.length} source file${
                coverageStats.files.length === 1 ? "" : "s"
              } executed.`;

        // Build the list of validators used/not used
        const validatorsUsed: string[] = [];
        const validatorsNotUsed: string[] = [];
        let validatorsUsedText: string;
        let validatorsUsedText2 = "";
        (env.options.useImplicit ? validatorsUsed : validatorsNotUsed).push(
          "<strong><u>heuristic</u></strong>"
        );
        (env.options.useHuman ? validatorsUsed : validatorsNotUsed).push(
          "<strong><u>human</u></strong>"
        );
        if (env.validators.length && env.options.useProperty) {
          env.validators.forEach((e) => {
            validatorsUsed.push(`<strong><u>property:${e.name}</u></strong>`);
          });
        } else if (!env.options.useProperty) {
          validatorsNotUsed.push(`<strong><u>property</u></strong>`);
        } else {
          validatorsUsedText2 = `The <strong><u>property</u></strong> validator was active, but no property validators were found, so ${toolName} raised an on-screen warning.`;
        }
        if (validatorsUsed.length) {
          validatorsUsedText = `
            ${toolName} categorized outputs using the ${toPrettyList(
            validatorsUsed
          )} validator${validatorsUsed.length > 1 ? "s" : ""}. `;
          if (validatorsNotUsed.length) {
            validatorsUsedText += `The ${toPrettyList(
              validatorsNotUsed
            )} validator${
              validatorsNotUsed.length > 1 ? "s were" : " was"
            } not configured.`;
          }
        } else {
          validatorsUsedText = `${toolName} did not use any validators in this test. This means that all tests were categorized as passed.`;
        }

        // Add the run info tab to the panel
        tabs.push({
          id: "runInfo",
          name: `<div class="codicon codicon-info"></div>`,
          description: /*html*/ `

          <div class="fuzzResultHeading">What did ${toolName} do?</div>
          <p>
            ${toolName} ran for ${Math.round(
            this._results.stats.timers.total
          )} ms, tested ${
            this._results.stats.counters.inputsInjected
          } interesting input${
            this._results.stats.counters.inputsInjected !== 1 ? "s" : ""
          }, generated ${
            this._results.stats.counters.inputsGenerated
          } new input${
            this._results.stats.counters.inputsGenerated !== 1 ? "s" : ""
          } (${this._results.stats.counters.dupesGenerated} of which ${
            this._results.stats.counters.dupesGenerated !== 1
              ? "were duplicates"
              : "was a duplicate"
          } ${toolName} previously tested), and reported ${
            this._results.results.length
          } test result${
            this._results.results.length !== 1 ? "s" : ""
          } before stopping.
          </p>
          <p>
            Compiling and instrumenting the program used ${Math.round(
              this._results.stats.timers.compile
            )} ms, generating inputs used ${Math.round(
            this._results.stats.timers.gen
          )} ms, executing the program used ${Math.round(
            this._results.stats.timers.run
          )} ms (${(
            this._results.stats.timers.run / this._results.results.length
          ).toFixed(2)} ms/input),
            validating outputs used ${Math.round(
              this._results.stats.timers.val
            )} ms (${(
            this._results.stats.timers.val / this._results.results.length
          ).toFixed(2)} ms/input),
            and measuring execution results used ${Math.round(
              this._results.stats.timers.measure
            )} ms (${(
            this._results.stats.timers.measure / this._results.results.length
          ).toFixed(2)} ms/input).
          </p>

          <div class="fuzzResultHeading">Why did testing stop?</div>
          <p>
            ${toolName} most recently stopped testing ${
            this._results.stopReason in textReason
              ? textReason[this._results.stopReason]
              : textReason[""]
          }
          </p>

          <div class="fuzzResultHeading">How were inputs generated?</div>
          <p>
            ${generatorsText}
          </p>
          <p class="${coverageText !== "" ? "" : "hidden"}">
            ${coverageText}
          </p>
          <p class="${this._results.interesting.inputs.length ? "" : "hidden"}">
            The selected measures classified ${
              this._results.interesting.inputs.length
            } input${
            this._results.interesting.inputs.length > 1 ? "s" : ""
          } as "interesting," and these inputs will be reused in the next test run. (<a id="fuzz.options.interesting.inputs.button" href=""><span id="fuzz.options.interesting.inputs.show">show</span><span id="fuzz.options.interesting.inputs.hide" class="hidden">hide</span> interesting inputs</a>)
            <table class="fuzzGrid hidden" id="fuzz.options.interesting.inputs">
              <thead>
                <th><big>#</big></th>
                ${this._results.env.function
                  .getArgDefs()
                  .map((a) => `<th><big>input: ${a.getName()}</big></th>`)
                  .join("\r\n")}
                <th><big>source</big></th>
                <th><big>why interesting</big></th>
              </thead>
              <tbody>
                ${this._results.interesting.inputs
                  .map(
                    (i) =>
                      `<tr class="editorFont"><td>${htmlEscape(
                        i.input.tick.toString()
                      )}</td>${i.input.value
                        .map(
                          (i) =>
                            `<td>${
                              i.value === undefined
                                ? "(no input)"
                                : JSON5.stringify(i.value)
                            }</td>`
                        )
                        .join("\r\n")}
                      <td>${htmlEscape(
                        i.input.source.type === "generator"
                          ? i.input.source.generator
                              .replace("InputGenerator", "")
                              .toLowerCase()
                          : i.input.source.type.toLowerCase()
                      )}${
                        i.input.source.tick !== undefined
                          ? ` from #${i.input.source.tick}`
                          : ""
                      }</td><td>${htmlEscape(
                        i.interestingReasons
                          .map((r) => r.replace("Measure", "").toLowerCase())
                          .join(", ")
                      )}</td></tr>`
                  )
                  .join("\r\n")}
              </tbody>
            </table>
          </p>
          <p>
            
          </p>

          <div class="fuzzResultHeading">How were outputs categorized?</div>
          <p>
            ${validatorsUsedText} ${validatorsUsedText2}
          </p>
                    
          <div class="fuzzResultHeading">What was returned?</div>
          <p>
            ${toolName} returned ${this._results.results.length} test result${
            this._results.results.length === 1 ? "" : "s"
          }. ${
            this._results.results.length
              ? "You can view these returned results in the other tabs."
              : ""
          }
          </p>
          
          <p ${
            vscode.workspace
              .getConfiguration("nanofuzz.ui")
              .get("hideMoreOptionsButton")
              ? `class="hidden" `
              : ``
          }>
            You may change the configuration using the <strong>More options</strong> button, or the options at the top of the screen.
          </p>
  `,
          hasGrid: false,
        });
      }
      tabs.forEach((e) => {
        if (!e.hasGrid || resultSummary[e.id] > 0) {
          // prettier-ignore
          html += /*html*/ `
                <vscode-panel-tab id="tab-${e.id}" style="font-size:1.15em;">
                  ${e.name}`;
          if (e.hasGrid) {
            // prettier-ignore
            html += /*html*/ `
                  <vscode-badge appearance="secondary">${
                    resultSummary[e.id]
                  }</vscode-badge>`;
          }
          // prettier-ignore
          html += /*html*/ `
                </vscode-panel-tab>`;
        }
      });

      tabs.forEach((e) => {
        if (!e.hasGrid || resultSummary[e.id] > 0) {
          html += /*html*/ `
                <vscode-panel-view class="fuzzGridPanel" id="view-${e.id}">
                  <section>
                    <div class="fuzzPanelDescription">${e.description}</div>`;
          if (e.hasGrid) {
            // prettier-ignore
            html += /*html*/ `
                    <div id="fuzzResultsGrid-${e.id}">
                      <table class="fuzzGrid">
                        <thead class="columnSortOrder" id="fuzzResultsGrid-${e.id}-thead" /> 
                        <tbody id="fuzzResultsGrid-${e.id}-tbody" />
                      </table>
                    </div>`;
          }
          // prettier-ignore
          html += /*html*/ `
                  </section>
                </vscode-panel-view>`;
        }
      });

      // prettier-ignore
      html += /*html*/ `
              </vscode-panels>
            </div>`;

      if (this._state === FuzzPanelState.busyTesting) {
        html += /*html*/ `
            <!-- Fuzzer Busy Status Message -->
            <div id="fuzzBusyStatusBarContainer">
              <div id="fuzzBusyStatusBar" style="width: 0%;"></div>
            </div>
            <div id="fuzzBusyMessage">
              <pre id="fuzzBusyMessageNonMilestone"> </pre>
            </div>
        `;
      }

      if (this._focusInput) {
        html += /*html*/ `
            <!-- Fuzzer Result to receive UI focus -->
            <div id="fuzzFocusInput" style="display:none">
              ${htmlEscape(JSON5.stringify(this._focusInput))}
            </div>
        `;
      }

      // Hidden data for the client script to process
      html += /*html*/ `
            <!-- Fuzzer Result Payload: for the client script to process -->
            <div id="fuzzResultsData" style="display:none">
              ${
                this._results === undefined ||
                this._state !== FuzzPanelState.done
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
                  validators: this._fuzzEnv.validators.map((e) => e.name),
                })
              )}
            </div>

            <!-- Fuzzer State Payload: for the client script to persist -->
            <div id="fuzzPanelState" style="display:none">
              ${htmlEscape(JSON5.stringify(this.getState()))}
            </div>
          </div>
          <div id="snackbarRoot" class="hidden" />
          </body>
        </html>
      `;
    } catch (e: unknown) {
      const msg = isError(e) ? e.message : "Unknown error";
      const stack = isError(e) ? e.stack : "<no stack>";
      html = /*html*/ `
      <head></head>
      <body>
        <h1>:-(</h1>
        <p>Unable to render this panel due to an internal error in FuzzPanel._updateHtml().</p>
        <p>Stack trace:</p>
        <pre>${stack}</pre>
      <body>`;
      console.debug(`Exception in updateHtml(): ${msg} stack: ${stack}`);
    }

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
    counter: { id: number }, // pass counter by reference
    beginSep: string,
    endSep: string,
    parentTag?: fuzzer.ArgTag
  ): string {
    const id = counter.id++; // unique id for each argument
    const idBase = `argDef-${id}`; // base HTML id for this argument
    const argType = arg.getType(); // type of argument
    const argName = arg.getName(); // name of the argument
    const disabledFlag =
      this._state === FuzzPanelState.busyTesting ||
      this._state === FuzzPanelState.busyAnalyzing
        ? ` disabled `
        : ""; // Disable inputs if busy
    const dimString = "[]".repeat(arg.getDim()); // Text indicating array dimensions
    const optionalString = arg.isOptional() ? "?" : ""; // Text indication arg optionality
    const htmlEllipsis = `<span class="hidden argDef-ellipsis">...</span>`;
    const isArgArray = arg.getDim() > 0; // Is this an array argument?

    let typeString: string; // Text indicating the type of argument
    const argTypeRef = arg.getTypeRef();
    if (argTypeRef !== undefined) {
      typeString = htmlEscape(
        argTypeRef.substring(argTypeRef.lastIndexOf(".") + 1)
      );
    } else {
      typeString = htmlEscape(argType.toLowerCase());
      switch (argType) {
        case fuzzer.ArgTag.OBJECT:
          typeString = "Object";
          break;
        case fuzzer.ArgTag.LITERAL:
          if (arg.isConstant()) {
            const constantValue = arg.getConstantValue();
            typeString =
              constantValue === undefined
                ? "undefined"
                : htmlEscape(JSON5.stringify(constantValue, undefined, 2));
          }
          break;
      }
    }

    // prettier-ignore
    let html = /*html*/ `
    <!-- Argument Definition -->
    <div class="argDef" id="${idBase}">`

    // prettier-ignore
    html += /*html*/ `
      <!-- Argument Name -->
      <div class="argDef-name" style="font-size:1.25em;">${beginSep}`;

    if (argName !== "unknown") {
      // prettier-ignore
      html += /*html*/ `
          <strong>${argName}</strong>${optionalString}: 
        `
    }

    let sep: string;
    switch (argType) {
      case fuzzer.ArgTag.LITERAL:
        sep = endSep;
        break;
      case fuzzer.ArgTag.UNION:
        sep = ":";
        break;
      case fuzzer.ArgTag.OBJECT:
        sep = ` = {` + htmlEllipsis;
        break;
      default:
        sep = " = " + htmlEllipsis;
    }

    // prettier-ignore
    html += /*html*/ `
         ${typeString}${dimString}${sep}
      </div>`;

    // Give the option of suppressing generation of optional members
    if (
      parentTag === fuzzer.ArgTag.UNION ||
      (parentTag === fuzzer.ArgTag.OBJECT && arg.isOptional())
    ) {
      // prettier-ignore
      html += /*html*/ `
        <div class="isNoInput tooltipped tooltipped-nw" aria-label="Generate inputs of this type?">
          <vscode-checkbox id="${idBase}-isNoInput" ${disabledFlag} ${arg.isNoInput() ? "" : "checked"} current-checked="${arg.isNoInput() ? "false" : "true"}"></vscode-checkbox>
        </div>`
    }

    html += /*html*/ `
      <!-- Argument isArray -->
      <div class="argDef-isArray argDef-isArray-${htmlEscape(
        isArgArray ? "true" : "false"
      )}" id="${idBase}-${
      isArgArray ? "true" : "false"
    }" style="padding-left: 1em;"></div>`;

    html += /*html*/ `
      <!-- Argument Type -->
      <div class="argDef-type argDef-type-${htmlEscape(
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
          `<vscode-radio-group style="display: inline-block;">
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
        html += " ";
        html += /*html*/ `<vscode-text-field size="10" ${disabledFlag} id="${idBase}-strCharset" name="${idBase}-strCharset" value="${htmlEscape(
          arg.getOptions().strCharset
        )}">Character set</vscode-text-field>`;
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

      // Union-specific Options
      case fuzzer.ArgTag.UNION: {
        // Output the array form prior to the child arguments.
        // This seems odd, but the screen reads better to the user this way.
        html += this._argDefArrayToHtmlForm(arg, idBase, disabledFlag);
        html += `<div>`;
        arg
          .getChildren()
          .forEach(
            (child) =>
              (html += this._argDefToHtmlForm(
                child,
                counter,
                " | ",
                "",
                arg.getType()
              ))
          );
        html += `</div>`;
        break;
      }

      // Object-specific Options
      case fuzzer.ArgTag.OBJECT: {
        // Output the array form prior to the child arguments.
        // This seems odd, but the screen reads better to the user this way.
        html += this._argDefArrayToHtmlForm(arg, idBase, disabledFlag);
        html += `<div>`;
        const children = arg.getChildren();
        children.forEach(
          (child, i) =>
            (html += this._argDefToHtmlForm(
              child,
              counter,
              "",
              i === children.length - 1 ? "" : ",",
              arg.getType()
            ))
        );
        html += `</div>`;
        break;
      }
    }

    // For objects & unions: output the array settings
    if (argType !== fuzzer.ArgTag.OBJECT && argType !== fuzzer.ArgTag.UNION) {
      html += this._argDefArrayToHtmlForm(arg, idBase, disabledFlag);
    }

    html += `</div>`;
    // For objects: output the end of object character ("}") here
    if (argType === fuzzer.ArgTag.OBJECT) {
      html += /*html*/ `<div class="argDef-preClose"></div><div class="argDef-close" style="font-size:1.25em;">}${endSep}</div>`;
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
    const argOptions = arg.getOptions();

    // Array dimensions
    for (let dim = 0; dim < arg.getDim(); dim++) {
      const arrayBase = `${idBase}-array-${dim}`;
      const arrayDimOptions = argOptions.dimLength;
      const minValue =
        arrayDimOptions.length > dim
          ? arrayDimOptions[dim].min
          : argOptions.dftDimLength.min;
      const maxValue =
        arrayDimOptions.length > dim
          ? arrayDimOptions[dim].max
          : argOptions.dftDimLength.max;

      // TODO: validate for ints > 0 !!!
      html += /*html*/ ``;
      html +=
        /*html*/
        `<div class="argDef-array">
          <vscode-text-field size="3" ${disabledFlag} id="${arrayBase}-min" name="${arrayBase}-min" value="${htmlEscape(
          minValue.toString()
        )}">Array${"[]".repeat(dim + 1)}: Min 
          </vscode-text-field>
          <vscode-text-field size="3" ${disabledFlag} id="${arrayBase}-max" name="${arrayBase}-max" value="${htmlEscape(
          maxValue.toString()
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
      "Please use the " + toolName + " button to test a function."
    );
    return;
  }

  // Save the file if dirty
  if (document.isDirty) {
    await document.save();
  }

  // Get the current active editor filename
  const srcFile = document.uri.fsPath; // full path of the file which contains the function

  // Call the fuzzer to analyze the function
  const fuzzOptions = getDefaultFuzzOptions();
  let fuzzSetup: fuzzer.FuzzEnv;
  try {
    fuzzSetup = fuzzer.setup(fuzzOptions, srcFile, fnName);
  } catch (e: unknown) {
    const msg = isError(e) ? e.message : JSON.stringify(e);
    vscode.window.showErrorMessage(
      `${toolName} could not find or does not support this function. Message: "${msg}"`
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
  document: vscode.TextDocument
): vscode.CodeLens[] {
  // Use the TypeScript analyzer to find all fn declarations in the module
  const matches: FunctionMatch[] = [];
  try {
    const program = ProgramDef.fromModuleAndSource(document.fileName, () =>
      document.getText()
    );
    // Skip analyzing files that we are configured to ignore
    const fuzzIgnore: string = vscode.workspace
      .getConfiguration("nanofuzz.ui.codeLens")
      .get("ignoreFilePattern", "");
    if (fuzzIgnore !== "" && document.fileName.match(fuzzIgnore)) {
      return [];
    }

    // Skip decorating validators if configured to skip them
    const fuzzValidators = vscode.workspace
      .getConfiguration("nanofuzz.ui.codeLens")
      .get("includeValidators");
    const functions = (fuzzValidators === undefined ? true : fuzzValidators)
      ? Object.values(program.getExportedFunctions())
      : Object.values(program.getExportedFunctions()).filter(
          (fn) => !fn.isValidator()
        );

    for (const fn of functions) {
      matches.push({
        document,
        ref: fn.getRef(),
      });
    }
  } catch (e: unknown) {
    const msg = isError(e) ? e.message : JSON.stringify(e);
    console.error(
      `Error parsing typescript file: ${document.fileName} error: ${msg}`
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
          title: `${toolName}...`,
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
  argOverrides: fuzzer.FuzzArgOverride[],
  argDefaults: fuzzer.ArgOptions
) {
  // Get the flattened list of function arguments
  const argsFlat = fn.getArgDefsFlat();

  // Make the user aware if it appears that the function arguments changed
  if (argOverrides.length && argOverrides.length !== argsFlat.length) {
    vscode.window.showInformationMessage(
      `Check the testing config: '${fn.getName()}()' may have changed`
    );
  }

  // Apply argument option changes
  for (const i in argOverrides) {
    const thisOverride = argOverrides[i];
    const thisArg: fuzzer.ArgDef<fuzzer.ArgType> = argsFlat[i];
    if (Number(i) + 1 > argsFlat.length) {
      break; // exit the for loop
    }

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
            // Character set. Note: empty sets are invalid
            strCharset:
              thisOverride.string.strCharset === ""
                ? argDefaults.strCharset
                : thisOverride.string.strCharset,
          });
        }
        break;
    }

    // isNoInput
    thisArg.setOptions({
      isNoInput: thisOverride.isNoInput ?? false,
    });

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
    maxDupeInputs: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("maxDupeInputs", 1000),
    maxFailures: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("maxFailures", 0),
    useHuman: true,
    useImplicit: true,
    useProperty: false,
    measures: {
      FailedTestMeasure: {
        // Externalize !!!!!!!
        enabled: true,
        weight: 1,
      },
      CoverageMeasure: {
        // Externalize !!!!!!!
        enabled: true,
        weight: 1,
      },
    },
    generators: {
      RandomInputGenerator: {
        // Externalize !!!!!!!
        enabled: true,
      },
      MutationInputGenerator: {
        // Externalize !!!!!!!
        enabled: true,
      },
      AiInputGenerator: {
        // Externalize !!!!!!!
        enabled: true,
      },
    },
  };
}; // fn: getDefaultFuzzOptions()

/**
 * Accepts an array of strings and returns a prettier list including
 * commas and 'and'. Adapted from https://stackoverflow.com/a/53888018
 *
 * @param inList Array of strings to turn into a list
 * @returns string The list in string form including 'and'
 */
function toPrettyList(inList: string[]): string {
  if (inList.length === 0) return "";
  return inList.length === 2
    ? inList.join(" and ")
    : inList.reduce(
        (a, b, i, array) => a + (i < array.length - 1 ? ", " : ", and ") + b
      );
} // fn: toPrettyList()

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
 * The tool's current name (used for studies)
 */
export const toolName = vscode.workspace
  .getConfiguration("nanofuzz")
  .get("name");

/**
 * Languages supported by this module
 */
export const languages = ["typescript", "typescriptreact"];

/**
 * The Fuzzer State Version we currently support.
 */
const fuzzPanelStateVer = "FuzzPanelStateSerialized-0.3.9"; // !!!!!!! Increment if fmt changes

/**
 * Current file format version for persisting test sets / pinned test cases
 */
const CURR_FILE_FMT_VER = "0.3.9"; // !!!!!!! Increment if fmt changes

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
  busyAnalyzing = "busyAnalyzing", // Busy analyzing
  busyTesting = "busyTesting", // Testing is in progress
  done = "done", // Testing is done
  error = "error", // Testing stopped due to an error
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

/**
 * Message to start Fuzzer
 */
export type FuzzPanelFuzzStartMessage = {
  fuzzer: Omit<fuzzer.FuzzOptions, "argDefaults">;
  args: fuzzer.FuzzArgOverride[];
  lastTab?: string;
  input?: fuzzer.ArgValueTypeWrapped[];
};
