import * as vscode from "vscode";
import * as JSON5 from "json5";
import * as fuzzer from "../fuzzer/Fuzzer";
import * as fs from "fs";
import { htmlEscape } from "escape-goat";
import * as telemetry from "../telemetry/Telemetry";
import * as jestadapter from "../fuzzer/adapters/JestAdapter";
import { ProgramDef } from "fuzzer/analysis/typescript/ProgramDef";

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
        const msg = e instanceof Error ? e.message : JSON5.stringify(e);
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

    // Apply argument ranges, etc. over the defaults
    _applyArgOverrides(
      this._fuzzEnv.function,
      this._argOverrides,
      this._fuzzEnv.options.argDefaults
    );

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
            this._doGetValidators();
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
              testSet.functions[fn].options.onlyFailures = false;
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
          default: {
            // unknown format; stop to avoid losing data
            throw new Error(
              `Unknown version ${inputTests.version} in test file ${jsonFile}. Update your ${toolName} extension or delete/rename the file to continue.`
            );
          }
        }
      }
    }

    return testSet;
  } // fn: _getFuzzTestsForModule()

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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : JSON5.stringify(e);
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
        const msg = e instanceof Error ? e.message : JSON5.stringify(e);

        vscode.window.showErrorMessage(
          `Unable to update Jest test file: ${jestFile} (${msg})`
        );
      }
    } else if (fs.existsSync(jestFile)) {
      // Delete the test file: it would contain no tests
      try {
        fs.rmSync(jestFile);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : JSON5.stringify(e);
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
      this._errorMessage = e instanceof Error ? e.message : "Unknown error";
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
    const validatorArgs = this.getValidatorArgs(inArgs);
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

    const outArgConst = this.getOutArgConst(
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
        this._errorMessage = e instanceof Error ? e.message : "Unknown error";
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
  private getIdentifierNameAvoidingConflicts(
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
  private getValidatorArgs(inArgs: fuzzer.ArgDef<fuzzer.ArgType>[]): {
    str: string;
    resultArgName: string;
  } {
    const resultArgName = this.getIdentifierNameAvoidingConflicts(
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
  private getOutArgConst(
    inArgs: fuzzer.ArgDef<fuzzer.ArgType>[],
    resultArgName: string,
    returnType?: string
  ): string {
    const outVarName = this.getIdentifierNameAvoidingConflicts(
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
      this._errorMessage = e instanceof Error ? e.message : "Unknown error";
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
      fuzzer: Record<string, number | boolean>;
      args: fuzzer.FuzzArgOverride[];
    } = JSON5.parse(json);
    const fn = this._fuzzEnv.function;

    // Apply numeric fuzzer option changes
    const numericOptions = [
      "suiteTimeout",
      "maxDupeInputs",
      "maxTests",
      "maxFailures",
      "fnTimeout",
    ] as const;
    numericOptions.forEach((e) => {
      if (e in panelInput.fuzzer) {
        const inputOption = panelInput.fuzzer[e];
        if (typeof inputOption === "number") {
          this._fuzzEnv.options[e] = inputOption;
        }
      }
    });

    // Apply boolean fuzzer option changes
    const booleanOptions = [
      "onlyFailures",
      "useImplicit",
      "useHuman",
      "useProperty",
    ] as const;
    booleanOptions.forEach((e) => {
      if (e in panelInput.fuzzer) {
        const inputOption = panelInput.fuzzer[e];
        if (typeof inputOption === "boolean") {
          this._fuzzEnv.options[e] = inputOption;
        }
      }
    });

    // Apply the argument overrides from the front-end UI
    _applyArgOverrides(fn, panelInput.args, this._fuzzEnv.options.argDefaults);

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
        testSet.validators = this._fuzzEnv.validators.map((ref) => ref.name);
        testSet.argOverrides = this._argOverrides;
        testSet.sortColumns = this._sortColumns;
        testSet.isVoid = this._fuzzEnv.function.isVoid();
        this._putFuzzTestsForThisFn(testSet);
      } catch (e: unknown) {
        this._state = FuzzPanelState.error;
        this._errorMessage = e instanceof Error ? e.message : "Unknown error";
        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "FuzzPanel.fuzz.error",
            "Fuzzing failed. Target: %s. Message: %s",
            [this.getFnRefKey(), this._errorMessage]
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
    let html = "";
    try {
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
      const counter = { id: 0 }; // Unique counter for argument ids
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

      // Render the HTML for each argument
      fn.getArgDefs().forEach(
        (arg, i) =>
          (argDefHtml += this._argDefToHtmlForm(
            arg,
            counter,
            "",
            i === fn.getArgDefs().length - 1 ? "" : ","
          ))
      );

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
            <h2 style="font-size:1.75em; padding-top:.2em; margin-bottom:.2em;"> ${this._state === FuzzPanelState.busy ? "Testing..." : "Test: "+htmlEscape(
              fn.getName())+"()"} 
              <div title="Open soure code" id="openSourceLink" class='codicon codicon-file-text clickable'></div>
            </h2>

            <!-- Function Arguments -->
            <div id="argDefs">${argDefHtml}</div>

            <!-- Change Validators Options -->
            <div style="clear: both;">
            <p style="font-size:1.2em; margin-top: 0.1em; margin-bottom: 0.1em;"><strong>Categorize output using:</strong></p>
            <div style="padding-left: .76em;">
              <!-- Checkboxes -->
              <div class="fuzzInputControlGroup">
                <vscode-checkbox ${disabledFlag} id="fuzz-useImplicit" ${this._fuzzEnv.options.useImplicit ? "checked" : ""}>
                  <span class="tooltipped tooltipped-ne" aria-label="${heuristicValidatorDescription}">
                  Heuristic validator 
                  </span>
                </vscode-checkbox>
                <span style="padding-left:1.3em;"> </span>
                <span style="display:inline-block;">
                  <vscode-checkbox ${disabledFlag} id="fuzz-useProperty" ${this._fuzzEnv.options.useProperty ? "checked" : ""}>
                    <span id="validator-functionList" class="tooltipped tooltipped-ne" aria-label=""> 
                    Property validator(s) </span>
                  </vscode-checkbox>
                  <span id="validator.add" class="tooltipped tooltipped-nw" aria-label="Add new property validator">
                    <span class="classAddRefreshValidator">
                      <span class="codicon codicon-add" style="padding-left:.2em; padding-right:-.1em;"></span>
                    </span>
                  </span>
                  <span id="validator.getList" class="tooltipped tooltipped-nw" aria-label="Refresh list">
                    <span class="classAddRefreshValidator">
                      <span class="codicon codicon-refresh" style="padding-left:.1em;"></span>
                    </span>
                  </span>
                </span>
              </div>
            </div>

            <vscode-divider></vscode-divider>

            <!-- Fuzzer Options -->
            <div id="fuzzOptions" class="hidden">
              <div class="panelButton">
                <span class="codicon codicon-close" id="fuzzOptions-close"></span>
              </div>
              <h2>More options</h2>

              <vscode-panels aria-label="Options tabs" class="fuzzTabStrip">
                <!-- <vscode-panel-tab aria-label="Validating options tab">Validating</vscode-panel-tab> -->
                <vscode-panel-tab aria-label="Reporting options tab">Reporting</vscode-panel-tab>
                <vscode-panel-tab aria-label="Stopping options tab">Stopping</vscode-panel-tab>


                <vscode-panel-view>
                  <p>
                    Choose what test results to report.
                  </p>
                  <div class="fuzzInputControlGroup">
                    <vscode-radio-group id="fuzz-onlyFailures">
                      <vscode-radio ${disabledFlag} id="onlyFailures.false" name="onlyFailures.false" value="false" ${
                        !this._fuzzEnv.options.onlyFailures ? "checked" : ""}>Report all test results</vscode-radio>
                      <vscode-radio ${disabledFlag} id="onlyFailures.true" name="onlyFailures.true" value="true" ${
                        this._fuzzEnv.options.onlyFailures ? "checked" : ""}>Report only failed test results</vscode-radio>
                    </vscode-radio-group>
                  </div>
                </vscode-panel-view>

                <vscode-panel-view>
                  <p>
                    These settings control how long testing runs. Testing stops when any limit is reached.  
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
                </vscode-panels>

              <vscode-divider></vscode-divider>
            </div>

            <!-- Button Bar -->
            <div style="padding-top: .25em;">
              <vscode-button ${disabledFlag} id="fuzz.start" appearance="primary">
                ${this._state === FuzzPanelState.busy ? "Testing..." : "Test"}
              </vscode-button>
              <vscode-button  ${disabledFlag} class="hidden" id="fuzz.changeMode" appearance="secondary" aria-label="Change Mode">
                Change Mode
              </vscode-button>
              <vscode-button ${disabledFlag} ${ 
                vscode.workspace
                  .getConfiguration("nanofuzz.ui")
                  .get("hideMoreOptionsButton")
                    ? `class="hidden" ` 
                    : ``
                } id="fuzz.options" appearance="secondary" aria-label="Fuzzer Options">
                More options...
                </vscode-button>
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
              <p>No property validators were found, so the property validator column is blank. Click (+) to add a property validator.</p>
            </div>

            <!-- Fuzzer Info -->
            <div class="fuzzInfo${
              this._state === FuzzPanelState.done && this._fuzzEnv.options.onlyFailures && this._results?.results.length === 0 
                ? ""
                : " hidden"
            }">
              <p>All tests passed.</p>
            </div>
            
            <!-- Fuzzer Output -->
            <div class="fuzzResults" ${
              this._state === FuzzPanelState.done
                ? ""
                : /*html*/ `style="display:none;"`
            }>
              <vscode-panels aria-label="Test result tabs" class="fuzzTabStrip">`;

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
            }). This is in addition to the ${this._results.inputsSaved} saved test${
              this._results.inputsSaved !== 1 ? "s" : ""
            } ${toolName} also executed.`,
          [fuzzer.FuzzStopReason.MAXDUPES]: `because it reached the maximum number of sequentially-generated duplicate inputs configured (${
              this._results.env.options.maxDupeInputs
            }). This can mean that NaNofuzz is having difficulty generating further new inputs: the function's input space might be small or near exhaustion. You can change this setting in More Options.`,
          "": `because of an unknown reason.`,
        };

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
            ${toolName} ran for ${this._results.elapsedTime} ms, re-tested ${
            this._results.inputsSaved
          } saved input${
            this._results.inputsSaved !== 1 ? "s" : ""
          }, generated ${this._results.inputsGenerated} new input${
            this._results.inputsGenerated !== 1 ? "s" : ""
          } (${this._results.dupesGenerated} of which ${
            this._results.dupesGenerated !== 1
              ? "were duplicates"
              : "was a duplicate"
          } ${toolName} previously tested), and reported ${
            this._results.results.length
          } test result${
            this._results.results.length !== 1 ? "s" : ""
          } before stopping.
          </p>

          <div class="fuzzResultHeading">How were outputs categorized?</div>
          <p>
            ${validatorsUsedText} ${validatorsUsedText2}
          </p>
          
          <div class="fuzzResultHeading">Why did testing stop?</div>
          <p>
            ${toolName} stopped testing ${
            this._results.stopReason in textReason
              ? textReason[this._results.stopReason]
              : textReason[""]
          }
          </p>
          
          <div class="fuzzResultHeading">What was returned?</div>
          <p>
            ${toolName} is configured to return <strong>${
            this._results.env.options.onlyFailures ? "only failed" : "all"
          }</strong> test results, and it found ${
            this._results.results.length
          } of these to return. ${
            this._results.results.length
              ? "You can view these returned results in the other tabs."
              : ""
          }${
            this._results.results.length === 0 &&
            this._results.env.options.onlyFailures
              ? "In other words, all tests passed."
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

      // Hidden data for the client script to process
      html += /*html*/ `
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
                  validators: this._fuzzEnv.validators.map((e) => e.name),
                })
              )}
            </div>

            <!-- Fuzzer State Payload: for the client script to persist -->
            <div id="fuzzPanelState" style="display:none">
              ${htmlEscape(JSON5.stringify(this.getState()))}
            </div>
          </div>
          </body>
        </html>
      `;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      const stack = e instanceof Error ? e.stack : "<no stack>>";
      html = /*html*/ `
      <head></head>
      <body>
        <h1>:-(</h1>
        <p>Unable to render this panel due to an internal error in FuzzPanel.updateHtml().</p>
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
      this._state === FuzzPanelState.busy ? ` disabled ` : ""; // Disable inputs if busy
    const dimString = "[]".repeat(arg.getDim()); // Text indicating array dimensions
    const optionalString = arg.isOptional() ? "?" : ""; // Text indication arg optionality
    const htmlEllipsis = `<span class="hidden argDef-ellipsis">...</span>`;

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
          <strong>${arg.getName()}</strong>${optionalString}: 
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
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
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
    const fuzzValidators: boolean = vscode.workspace
      .getConfiguration("nanofuzz.ui.codeLens")
      .get("includeValidators", true);
    const functions = fuzzValidators
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
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
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
    onlyFailures: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("onlyFailures", false),
    useHuman: true,
    useImplicit: true,
    useProperty: false,
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
const fuzzPanelStateVer = "FuzzPanelStateSerialized-0.3.6";

/**
 * Current file format version for persisting test sets / pinned test cases
 */
const CURR_FILE_FMT_VER = "0.3.6"; // !!!! Increment if file format changes

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
