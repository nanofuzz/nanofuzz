import * as vscode from "vscode";
import * as JSONN from "../Jsonn";
import * as Config from "../Config";
import * as fuzzer from "../fuzzer/Types";
import { FunctionDef } from "../fuzzer/analysis/FunctionDef";
import {
  ArgOptions,
  ArgValueTypeWrapped,
  FunctionRef,
  ProgramLanguage,
} from "../fuzzer/analysis/Types";
import {
  getTransformers,
  getUserGenerators,
  getValidators,
} from "../fuzzer/analysis/Util";
import { getIoKey } from "../fuzzer/Util";
import * as fs from "fs";
import { htmlEscape } from "escape-goat";
import * as telemetry from "../telemetry/Telemetry";
import {
  isError,
  getErrorMessageOrJson,
  normalizePathForKey,
} from "../fuzzer/Util";
import { removeTickFromOrigin } from "../Util";
import { FuzzerFactory, IFuzzer } from "../fuzzer/FuzzerFactory";
import {
  applyCoverageHeatmapToEditor,
  clearCoverageHeatmapFromEditor,
} from "./CoverageHeatmap";
import { CodeCoverageMeasureStats } from "../fuzzer/measures/CoverageMeasure";
import * as ProgramFactory from "../fuzzer/analysis/ProgramFactory";
import { AbstractProgram } from "../fuzzer/analysis/AbstractProgram";
import * as CompilerFactory from "../fuzzer/compilers/CompilerFactory";
import { synthesizeValidator } from "../fuzzer/synthesis/ValidatorSynthesizer";
import { synthesizeTransformer } from "../fuzzer/synthesis/TransformerSynthesizer";
import { synthesizeUserGenerator } from "../fuzzer/synthesis/UserGeneratorSynthesizer";
import { FuzzConfigStore, CURR_FILE_FMT_VER } from "../fuzzer/FuzzConfigStore";
import { ArgDefLike } from "./FuzzPanelArgForm";
import { getStaticHtmlShell, formatRunInfoHtml } from "./FuzzPanelHtml";

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
 * a separate FuzzPanelView.ts.
 */
export class FuzzPanel {
  // Static variables
  public static currentPanels: Record<string, FuzzPanel> = {}; // Map of panels indeved by the result of getFnRefKey()
  public static readonly viewType = "FuzzPanel"; // The name of this panel type
  public static context: vscode.ExtensionContext;
  private static panelShowingCoverage: FuzzPanel | undefined = undefined;
  private static staleMonitor = setInterval(() => {
    if (
      FuzzPanel.panelShowingCoverage &&
      FuzzPanel.panelShowingCoverage._panel.visible &&
      FuzzPanel.panelShowingCoverage._showingCoverage &&
      FuzzPanel.panelShowingCoverage.resultsAreStale(
        FuzzPanel.panelShowingCoverage._fuzzEnv.options
      )
    ) {
      FuzzPanel.panelShowingCoverage._doStaleNotify();
    }
  }, 5000).unref();

  // Instance variables
  private readonly _panel: vscode.WebviewPanel; // The WebView panel for this FuzzPanel instance
  private readonly _extensionUri: vscode.Uri; // Current Uri of the extension
  private _disposables: vscode.Disposable[] = []; // List of disposables
  private _fuzzEnv: fuzzer.FuzzEnv; // The Fuzz environment this panel represents
  private _state: FuzzPanelState = FuzzPanelState.init; // The current state of the fuzzer.
  private _argOverrides: fuzzer.FuzzArgOverride[]; // The current set of argument overrides
  private _focusInput?: [fuzzer.FuzzResultCategory, number]; // Newly-added input to receive UI focus
  private _lastTab: fuzzer.FuzzResultTab | undefined; // Last tab id that had focus
  private _tester: IFuzzer; // The test generator
  private _showingCoverage = false; // Currently showing code coverage?
  private _wasShowingCoverage = false; // Was showing coverage on the prior run?
  private _coverageStats: CodeCoverageMeasureStats | undefined; // Code coverage stats
  private _isDisposed = false; // is panel disposed?

  // State-dependent instance variables
  private _results?: fuzzer.FuzzTestResults; // done state: the fuzzer output
  private _errorMessage?: string; // error state: the error message
  private _errorStack?: string; // error state: the error stack trace
  private _sortColumns?: fuzzer.FuzzSortColumns; // column sort orders
  private _retestingReason: ReturnType<typeof this.resultsAreStale> | "user" =
    false; // retesting reason
  private _pauseTesting = false; // indicates that testing should stop

  // ------------------------ Static Methods ------------------------ //

  /**
   * This method either (a) creates a new FuzzPanel if one does not yet
   * exist for the given FuzzEnv, or (b) displays the existing FuzzPanel
   * for the given FuzzEnv, if it exists.
   *
   * @param extensionUri Extension Uri
   * @param env FuzzEnv for which to display or create the FuzzPanel
   */
  public static render(
    extensionUri: vscode.Uri,
    moduleFile: string,
    fnName: string,
    options: fuzzer.FuzzOptions
  ): FuzzPanel {
    // Differentiate panels by the module and function under test
    const fnRef = JSONN.stringify({
      module: moduleFile,
      fnName: fnName,
    });

    // If we already have a panel for this ref, show it.
    if (fnRef in FuzzPanel.currentPanels) {
      FuzzPanel.currentPanels[fnRef]._panel.reveal();
      return FuzzPanel.currentPanels[fnRef];
    } else {
      // Otherwise, create a new panel.
      const panel = vscode.window.createWebviewPanel(
        FuzzPanel.viewType, // FuzzPanel view type
        `Test: ${fnName}`, // webview title
        vscode.ViewColumn.Beside, // open beside the editor
        FuzzPanel.getWebviewOptions(extensionUri) // options
      );
      panel.iconPath = vscode.Uri.joinPath(
        extensionUri,
        "build",
        "ui",
        "icon.svg"
      );

      // Create the new FuzzPanel
      return new FuzzPanel(
        panel,
        extensionUri,
        FuzzerFactory(moduleFile, fnName, normalizeFuzzOptions(options), {
          engine: "auto",
          workers: Config.get("nanofuzz.fuzzer.workers", "auto"),
          outputResults: "all",
          precompile: true,
        })
      );
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

    // Apply webview options to the panel (probably unnecessary)
    panel.webview.options = FuzzPanel.getWebviewOptions(extensionUri);

    // Update the icon on the panel
    panel.iconPath = vscode.Uri.joinPath(
      extensionUri,
      "build",
      "ui",
      "icon.svg"
    );

    // Revive the FuzzPanel using the previous state
    if (
      typeof state === "object" &&
      "tag" in state &&
      state.tag === fuzzPanelStateVer
    ) {
      const fnRefKey = JSONN.stringify({
        module: state.fnRef.module,
        fnName: state.fnRef.name,
      });

      // If an active panel for this function already exists in currentPanels
      // (e.g. created by render() before this background tab was revived),
      // dispose of this redundant revived panel and reveal the active one.
      if (fnRefKey in FuzzPanel.currentPanels) {
        panel.dispose();
        FuzzPanel.currentPanels[fnRefKey]._panel.reveal();
        return;
      }

      // Create a new fuzzer environment
      try {
        // Create the new FuzzPanel
        const localFuzzPanel = new FuzzPanel(
          panel,
          extensionUri,
          FuzzerFactory(
            state.fnRef.module,
            state.fnRef.name,
            normalizeFuzzOptions(state.options),
            {
              engine: "auto",
              workers: Config.get("nanofuzz.fuzzer.workers", "auto"),
              outputResults: "all",
              precompile: true,
            }
          )
        );
        fuzzPanel = localFuzzPanel;

        // Redraw the HTML content when the tab is revived to hopefully
        // workaround problems where vscode revives the tab but does not
        // successfully load the CSS and JS components.
        localFuzzPanel._updateHtml();

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
        const msg = isError(e) ? e.message : JSONN.stringify(e);
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
  public static getWebviewOptions(
    _extensionUri: vscode.Uri
  ): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,

      // Enable searching on this panel
      enableFindWidget: true,

      // Retain the webview contents when hidden
      retainContextWhenHidden: true,

      // Restrict the webview to only loading extension content.
      // !!! localResourceRoots: [vscode.Uri.joinPath(extensionUri, "build", "ui")],
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
    tester: IFuzzer
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._fuzzEnv = tester.env;
    this._tester = tester;

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

    // Load & apply any fuzz settings previously persisted
    const testSet = this._getFuzzTestsForThisFn();
    this._fuzzEnv.options = normalizeFuzzOptions(testSet.options);
    this._argOverrides = testSet.argOverrides ?? [];
    this._sortColumns = testSet.sortColumns;

    // Register the new panel
    FuzzPanel.currentPanels[this.getFnRefKey()] = this;

    // Apply argument ranges, etc. over the defaults
    _applyArgOverrides(
      this._fuzzEnv.function,
      this._argOverrides,
      this._fuzzEnv.options.argDefaults
    );

    // Set the webview's initial html content
    this._state = FuzzPanelState.init;
    this._initHtml();
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
    return JSONN.stringify({
      module: this._fuzzEnv.function.getModule(),
      fnName: this._fuzzEnv.function.getName(),
    });
  } // fn: getFnRefKey

  /**
   * Determines if the current results are stale.
   *
   * @returns a reason if the results are stale and `false` otherwise.
   */
  private resultsAreStale(
    options: fuzzer.FuzzOptions
  ): ReturnType<IFuzzer["isStale"]> {
    return this._tester.isStale(options);
  } // fn: resultsAreStale

  /**
   * Extracts error information from an unknown error object and sets
   * the _errorMessage and _errorStack fields.
   *
   * @param error the error object to extract information from
   *
   * @returns a tuple containing the error message and stack trace
   */
  private _setErrorFromException(error: unknown): [string, string] {
    if (isError(error)) {
      this._errorMessage = htmlEscape(error.message);
      this._errorStack = error.stack ? htmlEscape(error.stack) : undefined;

      // Compiler-specific detailed messages
      if (error instanceof fuzzer.TypescriptCompilerError) {
        this._errorMessage += `<p style="margin-bottom:0.25em;"><strong>Source file</strong></p><small><pre style="margin-top:0;">${htmlEscape(error.details.inputFile)}</pre></small>`;
        if (error.details.output && error.details.output.length) {
          this._errorMessage += `<p style="margin-bottom:0.25em;"><strong>Compiler output</strong></p><small><pre style="margin-top:0;">${error.details.output.map((e) => htmlEscape(e)).join("")}</pre></small>`;
        }
        if (error.details.tscConfigFilename) {
          this._errorMessage += `<p style="margin-bottom:0.25em;"><strong>tscconfig.json</strong></p><small><pre style="margin-top:0;">${error.details.tscConfigFilename}</pre></small>`;
        }
        this._errorMessage += `<p style="margin-bottom:0.25em;"><strong>Command line</strong></p><small><pre style="margin-top:0;">${htmlEscape(error.details.tscCli)}</pre></small>`;
      }
    } else {
      this._errorMessage = "Unknown error";
      this._errorStack = "<no stack>";
    }
    return [this._errorMessage, this._errorStack ?? "<no stack>"];
  }

  // ----------------------- Message Handling ----------------------- //

  /**
   * Posts a message to the webview serialized using JSONN to safely
   * transport BigInt, Uint8Array, Set, Map, and undefined across the VS Code boundary.
   *
   * @param message The message to send to the webview.
   */
  private _postToView(message: FuzzPanelMessageToWebView): void {
    if (!this._isDisposed) {
      this._panel.webview.postMessage({ jsonn: JSONN.stringify(message) });
    }
  } // fn: _postToView()

  /**
   * Registers the message handler that allows the client side of
   * the WebView to communicate back with this extension.
   *
   * @param webview WebView instance
   */
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (rawMessage: FuzzPanelMessageFromWebView | { jsonn: string }) => {
        const message: FuzzPanelMessageFromWebView = isJsonnEnvelope(rawMessage)
          ? JSONN.parse(rawMessage.jsonn)
          : rawMessage;
        this._wasShowingCoverage = this._showingCoverage;
        switch (message.command) {
          case "fuzz.run":
            this._hideCoverageHeatmap();
            this._doGetValidatorsAndTransformers();
            if (this._results) {
              this._testClear(message.json);
            }
            this._testRun(message.json, { gen: true });
            break;
          case "fuzz.continue":
            this._hideCoverageHeatmap();
            this._doGetValidatorsAndTransformers();
            this._testRun(message.json, { gen: true });
            break;
          case "fuzz.retest":
            this._hideCoverageHeatmap();
            this._doGetValidatorsAndTransformers();
            this._testRun(message.json, { retest: true });
            break;
          case "fuzz.addTestInput":
            this._hideCoverageHeatmap();
            this._doGetValidatorsAndTransformers();
            this._testRun(message.json, { add: true });
            break;
          case "fuzz.clear":
            this._hideCoverageHeatmap();
            this._doGetValidatorsAndTransformers();
            this._testClear(message.json);
            break;
          case "fuzz.pause":
            this._pauseTesting = true;
            break;
          case "fuzz.coverage.show":
            this._navigateToSource(
              this._fuzzEnv.function.getModule(),
              this._fuzzEnv.function.getRef().startOffset
            ).then(() => {
              this._showCoverageHeatmap();
            });
            break;
          case "fuzz.coverage.hide":
            this._hideCoverageHeatmap();
            break;
          case "test.pin":
            this._doTestPinnedCmd(message.json, true);
            break;
          case "test.unpin":
            this._doTestPinnedCmd(message.json, false);
            break;
          case "columns.sorted":
            this._saveColumnSortOrders(message.json);
            break;
          case "validator.add":
            await this._doAddValidatorCmd();
            this._doGetValidatorsAndTransformers();
            break;
          case "transformer.add":
            await this._doAddTransformerCmd();
            this._doGetValidatorsAndTransformers();
            break;
          case "userGenerator.add":
            await this._doAddUserGeneratorCmd();
            this._doGetValidatorsAndTransformers();
            break;
          case "userGenerator.show":
            await this._doShowUserGeneratorCmd();
            break;
          case "userGenerator.getList":
          case "validator.getList":
          case "transformer.getList":
            this._doGetValidatorsAndTransformers();
            break;
          case "open.source": {
            this._navigateToSource(
              this._fuzzEnv.function.getModule(),
              this._fuzzEnv.function.getRef().startOffset
            );
            break;
          }
          case "open.settings.ai": {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "nanofuzz.ai"
            );
            break;
          }
          case "fuzz.ready": {
            this._sendStateUpdate();
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
    const msg: FuzzPanelPinMessage = JSONN.parse(json); // !!! validation

    // Log the telemetry event
    vscode.commands.executeCommand(
      telemetry.commands.logTelemetry.name,
      new telemetry.LoggerEntry(
        "FuzzPanel._doTestPinnedCmd",
        "Saving or unsaving: %s. Test case: %s.",
        [pin ? "saving" : "unsaving", json]
      )
    );

    if (this._results && msg.id >= 0 && msg.id < this._results.results.length) {
      // Update the back-end results data
      this._results.results[msg.id].pinned = msg.test.pinned;
      this._results.results[msg.id].expectedOutput = msg.test.expectedOutput;

      // Update set of saved tests
      this._updateFuzzTestsForThisFn({
        ...msg.test,
        input: this._results.results[msg.id].input, // avoid argument changes jank
      });
    } else {
      throw new Error("Invalid pin/unpin message");
    }
  } // fn: _doTestPinnedCmd()

  /**
   * Returns the filename where pinned tests are persisted.
   *
   * @returns filename of pinned tests
   */
  private _getFuzzTestsFilename(): string {
    return FuzzConfigStore.getNanoFilename(this._fuzzEnv.function.getModule());
  } // fn: _getFuzzTestsFilename()

  /**
   * Returns the filename where pinned tests were persisted
   * for NaNofuzz v0.1-0.3
   *
   * @returns filename of pinned tests
   */
  private _getFuzzTestsFilenameOld(): string {
    return FuzzConfigStore.getLegacyNanoFilename(
      this._fuzzEnv.function.getModule()
    );
  } // fn: _getFuzzTestsFilenameOld()

  /**
   * Returns pinned tests for all functions in the current module.
   *
   * @returns all pinned tests for all functions in the current module
   */
  private _getFuzzTestsForModule(): fuzzer.FuzzTests {
    return FuzzConfigStore.loadForModule(this._fuzzEnv.function.getModule());
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
    return FuzzConfigStore.prune(testSet);
  } // fn: _pruneTestSet

  /**
   * Initializes and return a new FuzzTests structure for the current
   * function under test.
   *
   * @returns a new FuzzTests structure for the current function
   */
  private _initFuzzTestsForThisFn(): fuzzer.FuzzTests {
    const fnRef = this._fuzzEnv.function.getRef();
    const fnConfig = FuzzConfigStore.createDefaultFunctionConfig(
      this._fuzzEnv.function.getName(),
      {
        options: {
          ...this._fuzzEnv.options,
          ...(fnRef.fuzzOptions ?? {}),
        },
        argOverrides: this._argOverrides,
        validators: this._fuzzEnv.validators.map((ref) => ref.name),
        userGenerators: this._fuzzEnv.userGenerators.map((ref) => ref.name),
        tests: {},
        isVoid: this._fuzzEnv.function.isVoid(),
        ...(this._fuzzEnv.function.isAsync() ? { isAsync: true as const } : {}),
      }
    );

    return {
      version: CURR_FILE_FMT_VER,
      functions: {
        [this._fuzzEnv.function.getName()]: fnConfig,
      },
    };
  } // fn: _initFuzzTestsForThisFn()

  /**
   * Returns the saved tests for just the current function.
   *
   * @returns saved tests for the current function
   */
  private _getFuzzTestsForThisFn(): fuzzer.FuzzTestsFunction {
    const fnRef = this._fuzzEnv.function.getRef();
    const fnName = this._fuzzEnv.function.getName();
    const defaultOptions = {
      ...this._fuzzEnv.options,
      ...(fnRef.fuzzOptions ?? {}),
    };

    const fnSet = FuzzConfigStore.loadForFunction(
      this._fuzzEnv.function.getModule(),
      fnName,
      defaultOptions
    );

    if (fnSet.argOverrides === undefined) {
      fnSet.argOverrides = this._argOverrides;
    }
    if (fnSet.validators === undefined) {
      fnSet.validators = this._fuzzEnv.validators.map((ref) => ref.name);
    }
    if (fnSet.userGenerators === undefined) {
      fnSet.userGenerators = this._fuzzEnv.userGenerators.map(
        (ref) => ref.name
      );
    }

    return fnSet;
  } // fn: _getFuzzTestsForThisFn()

  /**
   * Persists the pinned tests for the current function.
   *
   * @param testSet the pinned tests for the current function
   */
  private _putFuzzTestsForThisFn(testSet: fuzzer.FuzzTestsFunction): void {
    FuzzConfigStore.saveForFunction(
      this._fuzzEnv.function.getModule(),
      this._fuzzEnv.function.getName(),
      testSet,
      {
        syncTestAdapter: true,
        onError: (e: unknown) => {
          const msg = isError(e) ? e.message : JSONN.stringify(e);
          vscode.window.showErrorMessage(
            `Unable to update test configuration / files (${msg})`
          );
        },
      }
    );
  } // fn: _putFuzzTestsForThisFn()

  /**
   * Add and/or delete from the persisted set of tests.
   *
   * @param `test` test case to update
   */
  private _updateFuzzTestsForThisFn(test: fuzzer.FuzzPinnedTest): void {
    FuzzConfigStore.updatePinnedTest(
      this._fuzzEnv.function.getModule(),
      this._fuzzEnv.function.getName(),
      test,
      {
        syncTestAdapter: true,
        onError: (e: unknown) => {
          const msg = isError(e) ? e.message : JSONN.stringify(e);
          vscode.window.showErrorMessage(
            `Unable to update test configuration / files (${msg})`
          );
        },
      }
    );
  } // fn: _updateFuzzTestsForThisFn()

  /**
   * Message handler for the `columns.sort' command.
   */
  private _saveColumnSortOrders(json: string) {
    this._sortColumns = JSONN.parse(json); // !!! validation
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
  private async _navigateToSource(
    module: string,
    position?: number
  ): Promise<void> {
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
    const doc = await vscode.workspace.openTextDocument(uri);

    // Show the document in the desired column and position the
    // cursor where we want, if a position was provided.
    const opt: vscode.TextDocumentShowOptions = {
      viewColumn: viewColumn,
      selection: position
        ? new vscode.Range(doc.positionAt(position), doc.positionAt(position))
        : undefined,
    };
    await vscode.window.showTextDocument(doc, opt);
  }

  /**
   * Notify the panel about stale results
   */
  private _doStaleNotify() {
    const message: FuzzPanelMessageToWebView = {
      command: "coverage.stale",
    };
    this._postToView(message);
  } // fn: _doStaleNotify

  /**
   * Add code skeleton for a property validator to the program source code.
   */
  private async _doAddValidatorCmd() {
    const fn = this._fuzzEnv.function; // Function under test
    const module = this._fuzzEnv.function.getModule();
    let program: AbstractProgram;

    try {
      program = ProgramFactory.fromFile(module);
    } catch (_e: unknown) {
      vscode.window.showErrorMessage(
        `Unable to add the property validator: source file cannot be parsed. ${this._fuzzEnv.function.getModule()}`
      );
      return;
    }

    const {
      name: validatorName,
      skeleton,
      imports,
    } = synthesizeValidator(fn, program.lang, Object.keys(program.functions));

    // Save the editor if dirty
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.fileName === module && editor.document.isDirty) {
        await editor.document.save();
      }
    }

    // Append the code skeleton to the source file
    try {
      let importData = "";
      imports.forEach((i) => {
        // If there is no import, then add it
        if (!Object.keys(program.imports).some((e) => e === i.name)) {
          importData += i.stmt;
        }
      });

      if (importData.length) {
        // Pre-pend the import & append the validator
        const fileData = fs.readFileSync(module);
        const importStmt = Buffer.from(importData);
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

      // Change focus and scroll to the generated validator
      try {
        const fn = ProgramFactory.fromFile(module).functions[validatorName];
        this._navigateToSource(fn.getModule(), fn.getStartOffset());
      } catch (_e: unknown) {
        vscode.window.showErrorMessage(
          `Unable to navigate to the created property validator '${validatorName}' in '${fn.getModule()}'`
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
   * Add an input transformer code skeleton to the source code
   */
  private async _doAddTransformerCmd() {
    const fn = this._fuzzEnv.function; // Function under test
    const module = this._fuzzEnv.function.getModule();
    let program: AbstractProgram;

    try {
      program = ProgramFactory.fromFile(module);
    } catch (e: unknown) {
      this._setErrorFromException(e);
      vscode.window.showErrorMessage(
        `Unable to add the transformer. Source file cannot be parsed. ${this._fuzzEnv.function.getModule()}`
      );
      return;
    }

    // If a transformer already exists, navigate to it rather than creating a new one
    const existingTransformers = getTransformers(program, fn);
    if (existingTransformers.length > 0) {
      this._fuzzEnv.transformers = existingTransformers;
      const fnDef = program.functions[existingTransformers[0].name];
      if (fnDef) {
        this._navigateToSource(fnDef.getModule(), fnDef.getStartOffset());
        return;
      }
    } else if (this._fuzzEnv.transformers.length > 0) {
      const transformer = this._fuzzEnv.transformers[0];
      this._navigateToSource(transformer.module, transformer.startOffset);
      return;
    }

    const {
      name: transformerName,
      skeleton,
      imports,
    } = synthesizeTransformer(fn, program.lang, Object.keys(program.functions));

    // Save the editor
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.fileName === module && editor.document.isDirty) {
        await editor.document.save();
      }
    }

    // Append the code skeleton to the source file
    try {
      let importData = "";
      imports.forEach((i) => {
        // If there is no import, then add it
        if (!Object.keys(program.imports).some((e) => e === i.name)) {
          importData += i.stmt;
        }
      });

      if (importData.length) {
        // Pre-pend the import & append the transformer
        const fileData = fs.readFileSync(module);
        const importStmt = Buffer.from(importData);
        const transformerFn = Buffer.from(skeleton);
        const fd = fs.openSync(module, "w+");

        fs.writeSync(fd, importStmt, 0, importStmt.length, 0);
        fs.writeSync(fd, fileData, 0, fileData.length, importStmt.length);
        fs.writeSync(
          fd,
          transformerFn,
          0,
          transformerFn.length,
          importStmt.length + fileData.length
        );
        fs.closeSync(fd);
      } else {
        const fd = fs.openSync(module, "as+");
        fs.writeFileSync(fd, skeleton);
        fs.closeSync(fd);
      }

      // Change focus to the generated transformer
      try {
        const pgm = ProgramFactory.fromFile(module);
        const fn = pgm.functions[transformerName];
        this._navigateToSource(fn.getModule(), fn.getStartOffset());
      } catch (e: unknown) {
        this._setErrorFromException(e);
        vscode.window.showErrorMessage(
          `Unable to navigate to the created transformer '${transformerName}' in '${fn.getModule()}'`
        );
        return;
      }
    } catch {
      vscode.window.showErrorMessage(
        `Unable to write input transformer code skeleton to source file`
      );
    }
  } // fn: _doAddTransformerCmd()

  /**
   * Add a user-provided input generator code skeleton to the source code
   */
  private async _doAddUserGeneratorCmd() {
    const fn = this._fuzzEnv.function; // Function under test
    const module = this._fuzzEnv.function.getModule();
    let program: AbstractProgram;

    try {
      program = ProgramFactory.fromFile(module);
    } catch (e: unknown) {
      this._setErrorFromException(e);
      vscode.window.showErrorMessage(
        `Unable to add the user input generator. Source file cannot be parsed. ${this._fuzzEnv.function.getModule()}`
      );
      return;
    }

    const {
      name: userGenName,
      skeleton,
      imports,
    } = synthesizeUserGenerator(
      fn,
      program.lang,
      Object.keys(program.functions)
    );

    // Save the editor
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.fileName === module && editor.document.isDirty) {
        await editor.document.save();
      }
    }

    // Append the code skeleton to the source file
    try {
      let importData = "";
      imports.forEach((i) => {
        // If there is no import, then add it
        if (!Object.keys(program.imports).some((e) => e === i.name)) {
          importData += i.stmt;
        }
      });

      if (importData.length) {
        const fileData = fs.readFileSync(module);
        const importStmt = Buffer.from(importData);
        const userGenFn = Buffer.from(skeleton);
        const fd = fs.openSync(module, "w+");

        fs.writeSync(fd, importStmt, 0, importStmt.length, 0);
        fs.writeSync(fd, fileData, 0, fileData.length, importStmt.length);
        fs.writeSync(
          fd,
          userGenFn,
          0,
          userGenFn.length,
          importStmt.length + fileData.length
        );
        fs.closeSync(fd);
      } else {
        const fd = fs.openSync(module, "as+");
        fs.writeFileSync(fd, skeleton);
        fs.closeSync(fd);
      }

      // Change focus to the generated user generator
      try {
        const pgm = ProgramFactory.fromFile(module);
        const userGens = getUserGenerators(pgm, fn);
        const targetGen =
          userGens.find((g) => g.name === userGenName) ?? userGens[0];
        if (targetGen && targetGen.startOffset !== undefined) {
          this._navigateToSource(targetGen.module, targetGen.startOffset);
        } else {
          const fnDef = pgm.functions[userGenName];
          if (fnDef) {
            this._navigateToSource(fnDef.getModule(), fnDef.getStartOffset());
          } else {
            throw new Error(
              `Unable to locate function '${userGenName}' in '${module}'`
            );
          }
        }
      } catch (e: unknown) {
        this._setErrorFromException(e);
        vscode.window.showErrorMessage(
          `Unable to navigate to the created user input generator '${userGenName}' in '${fn.getModule()}'`
        );
        return;
      }
    } catch {
      vscode.window.showErrorMessage(
        `Unable to write user input generator code skeleton to source file`
      );
    }
  } // fn: _doAddUserGeneratorCmd()

  /**
   * Navigate to the custom input generator in the source code
   */
  private async _doShowUserGeneratorCmd() {
    const fn = this._fuzzEnv.function;
    const module = this._fuzzEnv.function.getModule();
    let program: AbstractProgram;

    try {
      program = ProgramFactory.fromFile(module);
    } catch (e: unknown) {
      this._setErrorFromException(e);
      vscode.window.showErrorMessage(
        `Unable to show the custom input generator. Source file cannot be parsed. ${this._fuzzEnv.function.getModule()}`
      );
      return;
    }

    const existingUserGenerators = getUserGenerators(program, fn);
    if (existingUserGenerators.length > 0) {
      this._fuzzEnv.userGenerators = existingUserGenerators;
      const targetGen = existingUserGenerators[0];
      const fnDef = program.functions[targetGen.name];
      if (fnDef) {
        this._navigateToSource(fnDef.getModule(), fnDef.getStartOffset());
        return;
      } else if (targetGen.startOffset !== undefined) {
        this._navigateToSource(targetGen.module, targetGen.startOffset);
        return;
      }
    } else if (this._fuzzEnv.userGenerators.length > 0) {
      const userGen = this._fuzzEnv.userGenerators[0];
      this._navigateToSource(userGen.module, userGen.startOffset);
      return;
    }

    vscode.window.showInformationMessage(
      `No custom input generator found for '${fn.getName()}'. Click + to create one.`
    );
  } // fn: _doShowUserGeneratorCmd()

  /**
   * Message handler for the `validator.getList` command. Gets the list
   * of validators and transformers from the program source code and sends
   * it back to the front-end.
   */
  private _doGetValidatorsAndTransformers() {
    let program: AbstractProgram;
    try {
      program = ProgramFactory.fromFile(this._fuzzEnv.function.getModule());
    } catch (e: unknown) {
      const errorMessage = getErrorMessageOrJson(e);
      vscode.commands.executeCommand(
        telemetry.commands.logTelemetry.name,
        new telemetry.LoggerEntry(
          "FuzzPanel.parse.error",
          "Parsing program failed. Target: %s. Message: %s",
          [this.getFnRefKey(), errorMessage]
        )
      );
      return;
    }
    const fn = this._fuzzEnv.function; // Function under test

    // Validators
    const oldValidatorNames = JSONN.stringify(
      this._fuzzEnv.validators.map((e) => e.name)
    );
    const newValidators = getValidators(program, fn);
    const newValidatorNames = JSONN.stringify(newValidators.map((e) => e.name));

    // Only send the validators message if there has been a change
    if (oldValidatorNames !== newValidatorNames) {
      // Update the Fuzzer Environment
      this._fuzzEnv.validators = getValidators(program, fn);

      // Notify webview about the change
      const message: FuzzPanelMessageToWebView = {
        command: "validator.list",
        validators: newValidators.map((e) => e.name),
      };
      this._postToView(message);
    }

    // Transformers
    const oldTransformerNames = JSONN.stringify(
      this._fuzzEnv.transformers.map((e) => e.name)
    );
    const newTransformers = getTransformers(program, fn);
    const newTransformerNames = JSONN.stringify(
      newTransformers.map((e) => e.name)
    );

    // Only send the message if there has been a change
    if (oldTransformerNames !== newTransformerNames) {
      // Update the Fuzzer Environment
      this._fuzzEnv.transformers = newTransformers;

      // Notify webview about the change
      const message: FuzzPanelMessageToWebView = {
        command: "transformer.list",
        transformers: newTransformers.map((e) => e.name),
      };
      this._postToView(message);
    }

    // User Generators
    const oldUserGeneratorNames = JSONN.stringify(
      this._fuzzEnv.userGenerators.map((e) => e.name)
    );
    const newUserGenerators = getUserGenerators(program, fn);
    const newUserGeneratorNames = JSONN.stringify(
      newUserGenerators.map((e) => e.name)
    );

    // Only send the message if there has been a change
    if (oldUserGeneratorNames !== newUserGeneratorNames) {
      // Update the Fuzzer Environment
      this._fuzzEnv.userGenerators = newUserGenerators;

      // Notify webview about the change
      const message: FuzzPanelMessageToWebView = {
        command: "userGenerator.list",
        userGenerators: newUserGenerators.map((e) => e.name),
      };
      this._panel.webview.postMessage(message);
    }
  } // fn: _doGetValidatorsAndTransformers()

  /**
   * Message handler for testing commands.
   *
   * This handler:
   *  1. Accepts a JSON object containing an updated set
   *     of fuzzer and argument options as input
   *  2. Updates the fuzzer environment accordingly (note:
   *     logical validation of these options takes place
   *     within the Fuzzer and ArgDef classes)
   *  3. Runs the fuzzer
   *     - If results are present and are stale, retests the results
   *     - If requested, generates new tests
   *     - If requested, manually add a test
   *  4. Updates the WebView with the results
   *
   * @param json JSON input
   */
  private async _testRun(
    json: string,
    mode: { retest?: true; gen?: true; add?: true }
  ): Promise<void> {
    this._coverageStats = undefined;

    // Get the panel input & use it to update options
    const panelInput: FuzzPanelFuzzRunMessage = JSONN.parse(json);
    this._getConfigFromUi(panelInput); // needed for accuate stale check

    // We need to build a new tester if the current tester is
    // stale or the user opted to retest the prior results.
    const resultsAreStale = this.resultsAreStale(this._fuzzEnv.options);
    const needNewTester = mode.retest || !!resultsAreStale;

    // Create a new tester if the current one is stale
    if (needNewTester) {
      try {
        this._tester = FuzzerFactory(
          this._fuzzEnv.function.getModule(),
          this._fuzzEnv.function.getName(),
          this._fuzzEnv.options,
          {
            engine: "auto",
            workers: Config.get("nanofuzz.fuzzer.workers", "auto"),
            outputResults: "all",
            precompile: false,
          }
        );
      } catch (e: unknown) {
        this._state = FuzzPanelState.error;
        this._setErrorFromException(e);
        this._updateHtml();
        return;
      }
      this._fuzzEnv = this._tester.env;

      // Apply panel inputs to the new tester
      this._getConfigFromUi(panelInput);
    }

    // Determine what inputs, if any, we need to inject
    const savedTests = this._getFuzzTestsForThisFn().tests;
    const testsToInject: fuzzer.FuzzPinnedTest[] =
      this._results === undefined
        ? Object.values(savedTests) // First run: inject saved tests
        : needNewTester
          ? this._results.results.map((i) => {
              // Inject any prior inputs into the new tester, including persisted test details
              const inputKey = getIoKey(i.input);
              if (inputKey in savedTests) {
                return savedTests[inputKey];
              } else {
                return {
                  input: i.input.map((e) => {
                    return {
                      ...e,
                      // ticks are tester-specific
                      origin: removeTickFromOrigin(e.origin),
                    };
                  }),
                  output: [],
                  pinned: false,
                };
              }
            })
          : []; // Subsequent run with existing tester; no injection needed

    // If adding a test manually, inject that test
    let testToAdd: fuzzer.FuzzPinnedTest | undefined;
    if (mode.add && panelInput.input) {
      const specs = this._fuzzEnv.function.getArgDefs();
      testToAdd = {
        input: panelInput.input.map((v, i) => {
          return {
            name: specs[i].getName(),
            offset: i,
            value: v.value,
            origin: { type: "user" },
          };
        }),
        output: [], // the fuzzer fills this
        pinned: true,
      };
      testsToInject.push(testToAdd); // for this call to the fuzzer
      this._updateFuzzTestsForThisFn(testToAdd); // persist the new test
    }

    // Update the UI to the busy state
    this._state = FuzzPanelState.busyTesting;
    this._errorMessage = undefined;
    this._errorStack = undefined;
    this._coverageStats = undefined;
    this._retestingReason = mode.retest
      ? "user" // user trigged retest
      : this._results && resultsAreStale
        ? resultsAreStale // back-end retest reason
        : false; // not retesting
    this._updateHtml();

    // Save the argument overrides
    this._argOverrides = panelInput.args;

    // Bounce off the stack and run the fuzzer
    setTimeout(async () => {
      // Log the start of Fuzzing
      vscode.commands.executeCommand(
        telemetry.commands.logTelemetry.name,
        new telemetry.LoggerEntry(
          "FuzzPanel.fuzz.run",
          "Fuzzing started. Target: %s.",
          [this.getFnRefKey()]
        )
      );

      try {
        this._tester.options = this._fuzzEnv.options;
        this._pauseTesting = false;

        // Test the function & store the results
        const result = await this._tester.test(
          testsToInject,
          { gen: mode.gen },
          // Observer that provides test status feedback to the panel => {
          {
            update: (payload: fuzzer.FuzzBusyStatusMessage): void => {
              const message: FuzzPanelMessageToWebView = {
                command: "busy.message",
                message: payload,
              };
              this._postToView(message);
            },
            granularity: "result",
          },
          // Fn to cancel testing
          () => this._pauseTesting
        );

        /* Success */
        this._results = result;

        // If we added a test, give the new result UI focus
        if (
          testToAdd &&
          result.results.length &&
          JSONN.stringify(result.results[result.results.length - 1].input) ===
            JSONN.stringify(testToAdd.input)
        ) {
          // Give focus to the newInput
          this._focusInput = [
            result.results[result.results.length - 1].category,
            result.results.length - 1,
          ];
        }

        // Transition to done state
        this._errorMessage = undefined;
        this._errorStack = undefined;
        this._state = FuzzPanelState.done;
        this._retestingReason = false;

        // Log the end of fuzzing
        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "FuzzPanel.fuzz.done",
            "Fuzzing completed successfully. Target: %s. Results: %s",
            [this.getFnRefKey(), JSONN.stringify(this._results)]
          )
        );

        // Persist the fuzz test run settings (!!!!!!! validation)
        this._updateFuzzTests();

        // Get coverage data
        this._coverageStats = this._results.stats.measures.CodeCoverageMeasure
          ? await this._results.stats.measures.CodeCoverageMeasure()
          : undefined;

        // Update the UI
        const message: FuzzPanelMessageToWebView = {
          command: "busy.ending",
        };
        this._postToView(message);
        this._updateHtml();
        this._focusInput = undefined;
      } catch (e: unknown) {
        this._state = FuzzPanelState.error;
        this._retestingReason = false;
        const [errorMessage, errorStack] = this._setErrorFromException(e);
        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "FuzzPanel.fuzz.error",
            "Fuzzing failed. Target: %s. Message: %s. Stack: %s.",
            [this.getFnRefKey(), errorMessage, errorStack]
          )
        );
        // Update the UI
        this._updateHtml();
      }
    }); // setTimeout
  } // fn: _testRun

  /**
   * Message handler for the `fuzz.clear` command.
   *
   * This handler:
   *  1. Accepts a JSON object containing an updated set
   *     of fuzzer and argument options as input
   *  2. Creates a new back-end tester
   *  4. Resets the webview to init status
   *
   * @param json JSON input
   */
  private _testClear(json: string): void {
    // Start over with a new tester
    try {
      this._tester = FuzzerFactory(
        this._fuzzEnv.function.getModule(),
        this._fuzzEnv.function.getName(),
        this._fuzzEnv.options,
        {
          engine: "auto",
          workers: Config.get("nanofuzz.fuzzer.workers", "auto"),
          outputResults: "all",
          precompile: true,
        }
      );
    } catch (e: unknown) {
      this._state = FuzzPanelState.error;
      this._setErrorFromException(e);
      this._coverageStats = undefined;
      this._updateHtml();
      return;
    }
    this._fuzzEnv = this._tester.env;

    // Get the panel input
    const panelInput: FuzzPanelFuzzRunMessage = JSONN.parse(json);
    this._getConfigFromUi(panelInput);

    // Update the UI
    this._results = undefined;
    this._state = FuzzPanelState.init;
    this._errorMessage = undefined;
    this._errorStack = undefined;
    this._focusInput = undefined;
    this._coverageStats = undefined;
    this._updateHtml();

    // Save the argument overrides
    this._argOverrides = panelInput.args;
  } // fn: _testClear

  /**
   * Hides the heat map for the set of open editors
   */
  private _hideCoverageHeatmap(): void {
    if (!this._showingCoverage) {
      return;
    }

    // Clear the editor decorations
    for (const editor of vscode.window.visibleTextEditors) {
      clearCoverageHeatmapFromEditor(editor);
    }

    // Clear indicators
    this._showingCoverage = false;
    FuzzPanel.panelShowingCoverage = undefined;

    // Inform the panel so it can update the button state, if needed
    if (!this._isDisposed) {
      const message: FuzzPanelMessageToWebView = {
        command: "coverage.hidden",
      };
      this._postToView(message);
    }

    // Telemetry
    vscode.commands.executeCommand(
      telemetry.commands.logTelemetry.name,
      new telemetry.LoggerEntry(
        "FuzzPanel.coverage.hide",
        "Hiding coverage heatmap for module: %s, function: %s.",
        [this._fuzzEnv.function.getModule(), this._fuzzEnv.function.getName()]
      )
    );
  } // fn: _hideCoverageHeatmap

  /**
   * Shows the heat map for the set of open editors
   */
  private _showCoverageHeatmap(): void {
    if (this._showingCoverage || !this._coverageStats) {
      return;
    }

    // Only show coverage for 0-1 panels to avoid user confusion
    FuzzPanel.panelShowingCoverage?._hideCoverageHeatmap();

    // Refresh this panel's heatmap
    this._showingCoverage = true;
    FuzzPanel.panelShowingCoverage = this;
    FuzzPanel.refreshCoverageHeatmap();

    // Telemetry
    vscode.commands.executeCommand(
      telemetry.commands.logTelemetry.name,
      new telemetry.LoggerEntry(
        "FuzzPanel.coverage.show",
        "Showing coverage heatmap for module: %s, function: %s.",
        [this._fuzzEnv.function.getModule(), this._fuzzEnv.function.getName()]
      )
    );
  } // fn: _showCoverageHeatmap

  /**
   * Refresh the active FuzzPanel's coverage heatmap
   */
  public static refreshCoverageHeatmap(): void {
    const panel = FuzzPanel.panelShowingCoverage;
    if (!panel || !panel._showingCoverage || !panel._coverageStats) {
      return;
    }

    const files = panel._coverageStats.files;
    for (const editor of vscode.window.visibleTextEditors) {
      const fsPath = normalizePathForKey(editor.document.uri.fsPath);
      let fileMap = files.find((f) => f.path === fsPath)?.fileMap;

      // Fall back to canonical realpath matching if direct path equality fails.
      // On macOS, system symlinks (e.g. /var -> /private/var or /tmp -> /private/tmp)
      // can cause source maps to resolve paths like /private/Users/... while VS Code
      // editor document URIs report /Users/...
      // On Windows, drive letter casing or NTFS junction points / short 8.3 paths
      // can cause identical path string mismatches. Comparing realpaths ensures
      // editor documents correctly match coverage stats on macOS, Windows, and Linux.
      if (!fileMap) {
        try {
          const realFsPath = fs.existsSync(fsPath)
            ? normalizePathForKey(fs.realpathSync(fsPath))
            : fsPath;
          fileMap = files.find((f) => {
            try {
              return (
                fs.existsSync(f.path) &&
                normalizePathForKey(fs.realpathSync(f.path)) === realFsPath
              );
            } catch {
              return false;
            }
          })?.fileMap;
        } catch {
          // ignore
        }
      }

      if (fileMap) {
        applyCoverageHeatmapToEditor(editor, fileMap);
      } else {
        clearCoverageHeatmapFromEditor(editor);
      }
    }
  } // fn: _refreshCoverageHeatmap

  /**
   * Updates the fuzzer configuration from the front-end UI message.
   *
   * @param panelInput a FuzzPanelFuzzRunMessage input
   */
  private _getConfigFromUi(panelInput: FuzzPanelFuzzRunMessage): void {
    const fn = this._fuzzEnv.function;

    // Remember the selected tab
    this._lastTab = fuzzer.isFuzzResultTab(panelInput.lastTab)
      ? (this._lastTab = panelInput.lastTab)
      : undefined;

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
    (
      ["useImplicit", "useHuman", "useProperty", "useTransformer"] as const
    ).forEach((e) => {
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
    testSet.userGenerators = this._fuzzEnv.userGenerators.map(
      (ref) => ref.name
    );
    testSet.argOverrides = this._argOverrides;
    testSet.sortColumns = this._sortColumns;
    testSet.isVoid = this._fuzzEnv.function.isVoid();
    if (this._fuzzEnv.function.isAsync()) {
      testSet.isAsync = true;
    } else {
      delete testSet.isAsync;
    }
    this._putFuzzTestsForThisFn(testSet);
  } // fn: _updateFuzzTests

  /**
   * Updates the webview when the extension configuration changes
   */
  public onDidChangeConfiguration(): void {
    const message: FuzzPanelMessageToWebView = {
      command: "config.updated",
      config: {
        ai: {
          provider: Config.get("nanofuzz.ai.provider", "disabled"),
          model: Config.get("nanofuzz.ai.model", ""),
        },
      },
    };
    this._postToView(message);
  } //fn: onDidChangeConfiguration

  /**
   * Disposes all objects used by this instance
   */
  public dispose(): void {
    this._isDisposed = true;

    // Hide code coverage decorations
    this._hideCoverageHeatmap();

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
   * Initializes the one-time static HTML shell in the webview.
   */
  private _initHtml(): void {
    this._panel.webview.html = getStaticHtmlShell({
      webview: this._panel.webview,
      extensionUri: this._extensionUri,
      fuzzEnv: this._fuzzEnv,
      state: this._state,
      results: this._results,
      activeButtons: this._getActiveButtons(),
      viewState: this._getViewState(),
      fuzzTestsFilename: this._getFuzzTestsFilename(),
    });
    this.onDidChangeConfiguration();
  } // fn: _initHtml()

  /**
   * Pushes a live state update message to the webview client without destroying the DOM.
   */
  _updateHtml(): void {
    this._sendStateUpdate();
  } // fn: _updateHtml()

  /**
   * Pushes the latest FuzzPanelViewState to the webview over IPC.
   */
  private _sendStateUpdate(): void {
    const viewState = this._getViewState();
    this._postToView({
      command: "state.update",
      viewState,
    });
  } // fn: _sendStateUpdate()

  /**
   * Constructs the complete view state payload for the webview client.
   */
  private _getViewState(): FuzzPanelViewState {
    const resultSummary: Record<fuzzer.FuzzResultCategory, number> = {
      failure: 0,
      timeout: 0,
      exception: 0,
      badValue: 0,
      ok: 0,
      disagree: 0,
      skip: 0,
    };
    if (this._results !== undefined) {
      if (this._results.stats.outcomes.categories) {
        for (const cat of fuzzer.FuzzResultCategoryValues) {
          resultSummary[cat] =
            this._results.stats.outcomes.categories[cat] ?? 0;
        }
      } else {
        this._results.results.forEach((result) => {
          resultSummary[result.category]++;
        });
      }
    }

    const hiddenColumns = Config.get<boolean>(
      "nanofuzz.ui.showSourceColumn",
      false
    )
      ? ["id", "expectedOutput", "allValidators"]
      : ["id", "src", "expectedOutput", "allValidators"];

    if (!this._fuzzEnv.function.getArgDefs().length) {
      hiddenColumns.push("pinned", "correct output?");
    }

    const lang = this._fuzzEnv.function.getLang();

    return {
      results:
        this._results !== undefined && this._state === FuzzPanelState.done
          ? this._results
          : undefined,
      focusInput: this._focusInput,
      inputCols:
        this._results !== undefined && this._state === FuzzPanelState.done
          ? this._fuzzEnv.function.getArgDefs().map((a) => a.getName())
          : [],
      sortColumns: this._sortColumns,
      showCoverageHeatmap: Boolean(
        this._coverageStats && this._wasShowingCoverage
      ),
      hiddenColumns,
      validators: this._fuzzEnv.validators.map((e) => e.name),
      transformers: this._fuzzEnv.transformers.map((e) => e.name),
      userGenerators: this._fuzzEnv.userGenerators.map((e) => e.name),
      lang,
      panelState: this.getState(),
      argDefs: this._fuzzEnv.function.getArgDefs(),
      argOverrides: this._argOverrides,
      disabled: this._state === FuzzPanelState.busyTesting,
      fuzzState: this._state,
      activeButtons: this._getActiveButtons(),
      errorMessage: this._errorMessage,
      errorStack: this._errorStack,
      retestingReason: this._retestingReason,
      generatorDiagnostics:
        this._state === FuzzPanelState.done && this._tester
          ? this._tester.getInputGeneratorDiagnostics()
          : [],
      runInfoHtml:
        this._state === FuzzPanelState.done && this._results
          ? this._formatRunInfoHtml()
          : undefined,
      resultSummary,
    };
  } // fn: _getViewState()

  /**
   * Computes which UI buttons should be active and visible.
   */
  private _getActiveButtons(): FuzzPanelActiveButtons {
    const activeButtons: FuzzPanelActiveButtons = {};
    if (this._state === FuzzPanelState.busyTesting) {
      activeButtons.pause = true;
    } else {
      switch (this._tester.state) {
        case "init":
        case "ready": {
          activeButtons.run = true;
          activeButtons.options = true;
          if (this._results) {
            activeButtons.continue = true;
            activeButtons.retest = true;
            activeButtons.clear = true;
          }
          break;
        }
        case "paused": {
          activeButtons.run = true;
          activeButtons.continue = true;
          activeButtons.retest = true;
          activeButtons.clear = true;
          activeButtons.add = true;
          activeButtons.coverage = this._fuzzEnv.options.measures
            .CoverageMeasure.enabled
            ? this._coverageStats
              ? true
              : undefined
            : "disabled";
          activeButtons.options = true;
          break;
        }
        case "running": {
          activeButtons.pause = true;
          break;
        }
        case "crashed": {
          activeButtons.run = true;
          if (this._results) {
            activeButtons.continue = true;
            activeButtons.retest = true;
            activeButtons.clear = true;
          }
          activeButtons.options = true;
          break;
        }
      }
    }
    if (
      activeButtons.options &&
      Config.get<boolean>("nanofuzz.ui.hideMoreOptionsButton", false)
    ) {
      delete activeButtons.options;
    }
    if (activeButtons.add && !this._fuzzEnv.function.getArgDefs().length) {
      delete activeButtons.add;
    }
    return activeButtons;
  } // fn: _getActiveButtons()

  /**
   * Formats the HTML content for the Run Info tab.
   *
   * @returns formatted HTML string for Run Info
   */
  private _formatRunInfoHtml(): string {
    if (!this._results) {
      return "";
    }
    return formatRunInfoHtml({
      results: this._results,
      fuzzEnv: this._fuzzEnv,
      workerCount: this._tester.workerCount,
      engine: this._tester.engine,
      coverageStats: this._coverageStats,
    });
  } // fn: _formatRunInfoHtml()
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

  // Create the panel
  try {
    FuzzPanel.render(
      FuzzPanel.context.extensionUri,
      srcFile,
      fnName,
      getDefaultFuzzOptions()
    );
  } catch (e: unknown) {
    const msg = isError(e) ? e.message : JSON.stringify(e);
    vscode.window.showErrorMessage(
      `${toolName} could not find or does not support this function. Message: "${msg}"`
    );
  }
} // fn: handleFuzzCommand()

/**
 * Handles the "nanofuzz.FuzzWithValidator" command by testing the associated
 * function with property validators enabled.
 *
 * @param match a reference to the validator and its associated FUT
 * @returns void
 */
export async function handleFuzzWithValidatorCommand(
  match?: ValidatorMatch
): Promise<void> {
  if (!match) {
    vscode.window.showErrorMessage(
      "No function matching the given validator provided."
    );
    return;
  }

  const document = match.document;
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showErrorMessage(
      "Please select a function to test in the editor."
    );
    return;
  }

  // Save the file if dirty
  if (document.isDirty) {
    await document.save();
  }

  // Get the current active editor filename
  const srcFile = document.uri.fsPath; // full path of the file which contains the function
  const fnName = match.fut.name;

  // Call the fuzzer to analyze the FUT
  const fuzzOptions = getDefaultFuzzOptions();
  fuzzOptions.useProperty = true; // Enable property oracle by default

  let tester: IFuzzer;
  try {
    tester = FuzzerFactory(srcFile, fnName, fuzzOptions, {
      engine: "auto",
      workers: Config.get("nanofuzz.fuzzer.workers", "auto"),
      outputResults: "all",
      precompile: false,
    });
  } catch (e: unknown) {
    const msg = getErrorMessageOrJson(e);
    vscode.window.showErrorMessage(
      `${toolName} could not find or does not support this function. Message: "${msg}"`
    );
    return;
  }

  // Verify the validator is actually associated with this FUT
  const validatorName = match.validator.name;
  const hasValidator = tester.env.validators.some(
    (v) => v.name === validatorName
  );

  if (!hasValidator) {
    vscode.window.showWarningMessage(
      `Validator ${validatorName} not found for ${fnName}.`
    );
  }

  // Load the fuzz panel (brings it to foreground)
  FuzzPanel.render(
    FuzzPanel.context.extensionUri,
    srcFile,
    fnName,
    fuzzOptions
  );

  return;
} // fn: handleFuzzWithValidatorCommand()

/**
 * Finds the function under test (FUT) for a given validator function.
 *
 * @param validator The validator function
 * @param allFunctions All exported functions in the module
 * @returns The associated FUT, or undefined if not found
 */
function findFunctionUnderTest(
  validator: FunctionDef,
  allFunctions: FunctionDef[]
): FunctionDef | undefined {
  const validatorTarget = validator.getValidatorTargetName();
  for (const fn of allFunctions) {
    if (fn.getName() === validatorTarget) {
      return fn; // validator target found
    }
  }
  return undefined; // no matching validator target found
} // fn: findFunctionUnderTest()

/**
 * Creates a standard CodeLens for a non-validator function.
 *
 * @param document The document containing the function
 * @param fn The function definition
 * @returns A CodeLens object
 */
function createStandardCodeLens(
  document: vscode.TextDocument,
  fn: FunctionDef
): vscode.CodeLens {
  return new vscode.CodeLens(
    new vscode.Range(
      document.positionAt(fn.getRef().startOffset),
      document.positionAt(fn.getRef().endOffset)
    ),
    {
      title: `${toolName}...`,
      command: commands.fuzz.name,
      arguments: [{ document, ref: fn.getRef() }],
    }
  );
} // fn: createStandardCodeLens()

/**
 * Creates a CodeLens for testing the FUT with property validators enabled.
 *
 * @param document The document containing the validator
 * @param validator The validator function
 * @param fut The function under test
 * @returns A CodeLens object
 */
function createFutTestCodeLens(
  document: vscode.TextDocument,
  validator: FunctionDef,
  fut: FunctionDef | undefined
): vscode.CodeLens {
  let title;
  let argument;
  if (fut) {
    title = `${toolName} (${fut.getName()})...`;
    argument = {
      document,
      validator: validator.getRef(),
      fut: fut.getRef(),
    };
  } else {
    title = `${toolName} (no associated function found)...`;
    argument = undefined;
  }

  return new vscode.CodeLens(
    new vscode.Range(
      document.positionAt(validator.getRef().startOffset),
      document.positionAt(validator.getRef().endOffset)
    ),
    {
      title,
      command: commands.fuzzWithValidator.name,
      arguments: [argument],
    }
  );
} // fn: createFutTestCodeLens()

/**
 * Creates a CodeLens for testing the validator itself.
 *
 * @param document The document containing the validator
 * @param validator The validator function
 * @returns A CodeLens object
 */
function createValidatorTestCodeLens(
  document: vscode.TextDocument,
  validator: FunctionDef
): vscode.CodeLens {
  return new vscode.CodeLens(
    new vscode.Range(
      document.positionAt(validator.getRef().startOffset),
      document.positionAt(validator.getRef().endOffset)
    ),
    {
      title: `${toolName} (${validator.getName()})...`,
      command: commands.fuzz.name,
      arguments: [{ document, ref: validator.getRef() }],
    }
  );
} // fn: createValidatorTestCodeLens()

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
  const codeLenses: vscode.CodeLens[] = [];
  try {
    const program = ProgramFactory.fromFileAndSource(document.fileName, () =>
      document.getText()
    );

    // Skip analyzing files that we are configured to ignore
    const fuzzIgnore: string = Config.get(
      "nanofuzz.ui.codeLens.ignoreFilePattern",
      ""
    );
    if (fuzzIgnore !== "" && document.fileName.match(fuzzIgnore)) {
      return [];
    }

    // Also skip decorating input transformers if configured to skip them
    const fuzzTransformers = vscode.workspace
      .getConfiguration("nanofuzz.ui.codeLens")
      .get("includeTransformers");

    // Skip decorating validators if configured to skip them
    const fuzzValidators = Config.get<boolean>(
      "nanofuzz.ui.codeLens.includeValidators",
      true
    );
    const allFunctions = Object.values(program.functions);
    const functions = (fuzzValidators === undefined ? true : fuzzValidators)
      ? allFunctions
      : allFunctions.filter((fn) => !fn.isValidator());

    for (const fn of functions) {
      {
        if (!fn.isValidator()) {
          if (!fn.isTransformer() || fuzzTransformers) {
            // Regular function: single button for testing the function itself
            codeLenses.push(createStandardCodeLens(document, fn));
          }
        } else {
          // Validator: find the FUT and create one button for testing the FUT,
          // and one button for testing the validator itself
          const fut = findFunctionUnderTest(fn, functions);
          codeLenses.push(
            createFutTestCodeLens(document, fn, fut),
            createValidatorTestCodeLens(document, fn)
          );
        }
      }
    }
  } catch (e: unknown) {
    const msg = isError(e) ? e.message : JSON.stringify(e);
    console.error(
      `Error parsing source file: ${document.fileName} error: ${msg}`
    );
  }

  return codeLenses;
} // fn: provideCodeLenses()

/**
 * Applies a set of argument overrides (e.g., from the UI) to a
 * function's arguments. E.g., min, max, and so on.
 *
 * @param fn Function under test
 * @param argOverrides Overrides for default argument options
 */
function _applyArgOverrides(
  fn: FunctionDef,
  argOverrides: fuzzer.FuzzArgOverride[],
  argDefaults: ArgOptions
) {
  // Get the flattened list of function arguments
  const argsFlat = fn.getArgDefsFlat();

  // Make the user aware if it appears that the function arguments changed
  if (argOverrides.length && argOverrides.length !== argsFlat.length) {
    vscode.window.showInformationMessage(
      `Check the testing config: arguments for '${fn.getName()}()' changed`
    );
  }

  // Apply argument option changes
  FuzzConfigStore.applyArgOverrides(fn, argOverrides, argDefaults);
} // fn: _applyArgOverrides()

/**
 * Returns a default set of fuzzer options.
 *
 * @returns default set of fuzzer options
 */
export const getDefaultFuzzOptions = (): fuzzer.FuzzOptions => {
  return FuzzConfigStore.getDefaultFuzzOptions();
}; // fn: getDefaultFuzzOptions()

/**
 * Normalizes a FuzzOptions object by deeply populating missing fields with default options.
 *
 * @param options partial fuzzer options
 * @returns a complete, normalized FuzzOptions object
 */
export const normalizeFuzzOptions = (
  options?: Partial<fuzzer.FuzzOptions>
): fuzzer.FuzzOptions => {
  return FuzzConfigStore.normalizeFuzzOptions(options);
}; // fn: normalizeFuzzOptions()

/**
 * Type guard function that returns true if `obj` is a JSONN envelope
 *
 * @param obj object to check
 * @returns true if `obj` is a JSONN envelope
 */
function isJsonnEnvelope(obj: unknown): obj is { jsonn: string } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "jsonn" in obj &&
    typeof obj.jsonn === "string"
  );
} // fn: isJsonnEnvelope()

/**
 * Initializes the module
 *
 * @param context extension context
 */
export function init(context: vscode.ExtensionContext): void {
  FuzzPanel.context = context; // Set the context

  // Listen for active text editor changes and refresh the heatmap
  vscode.window.onDidChangeActiveTextEditor(
    () => {
      FuzzPanel.refreshCoverageHeatmap();
    },
    null,
    context.subscriptions
  );
}

/**
 * De-initializes the module
 */
export function deinit(): void {
  // noop
} // fn: deinit

/**
 * Creates a listener object wrapping an event subscription.
 *
 * @param event The VS Code event to listen to
 * @param fn The callback function to execute on event
 * @returns A Listener object
 */
function createListener<T>(
  event: vscode.Event<T>,
  fn: (e: T) => void
): Listener {
  return { register: () => event(fn) };
} // fn: createListener()

/**
 * Export this module's listeners to the extension.
 */
export const listeners: Listener[] = [
  createListener(vscode.workspace.onDidChangeConfiguration, (): void => {
    // Notify the open webviews about configuration changes
    Object.values(FuzzPanel.currentPanels).forEach((panel) => {
      panel.onDidChangeConfiguration();
    });
  }),
];

// --------------------------- Constants --------------------------- //

/**
 * Commands supported by this module
 *
 * Note: Manually update package.json.
 */
export const commands = {
  fuzz: { name: "nanofuzz.Fuzz", fn: handleFuzzCommand },
  fuzzWithValidator: {
    name: "nanofuzz.FuzzWithValidator",
    fn: handleFuzzWithValidatorCommand,
  },
  clearCompileCache: {
    name: "nanofuzz.ClearCompileCache",
    fn: () => {
      CompilerFactory.clean();
      vscode.window.showInformationMessage(`Compile cache cleared`);
    },
  },
};

/**
 * The tool's current name (used for studies)
 */
export const toolName = Config.get("nanofuzz.name", "NaNofuzz");

/**
 * Languages supported by this module
 */
export const languages = ["typescript", "typescriptreact", "python"];

/**
 * The Fuzzer State Version we currently support.
 */
const fuzzPanelStateVer = "FuzzPanelStateSerialized-0.4.0"; // !!!!!!! Increment if fmt changes

// ----------------------------- Types ----------------------------- //

/**
 * Represents a message from the WebView client to its FuzzPanel.
 */
export type FuzzPanelMessageFromWebView =
  | {
      command:
        | "fuzz.run"
        | "fuzz.continue"
        | "fuzz.retest"
        | "fuzz.addTestInput"
        | "fuzz.clear"
        | "test.pin"
        | "test.unpin"
        | "columns.sorted";
      json: string; // !!! Improve typing here
    }
  | {
      command:
        | "fuzz.coverage.show"
        | "fuzz.coverage.hide"
        | "fuzz.pause"
        | "validator.add"
        | "validator.getList"
        | "transformer.add"
        | "transformer.getList"
        | "userGenerator.add"
        | "userGenerator.show"
        | "userGenerator.getList"
        | "open.source"
        | "open.settings.ai"
        | "fuzz.ready";
    };

/**
 * Represents the possible states of the FuzzPanel
 */
export enum FuzzPanelState {
  init = "init", // Nothing has been fuzzed yet
  busyTesting = "busyTesting", // Testing is in progress
  done = "done", // Testing is done
  error = "error", // Testing stopped due to an error
}

/**
 * Event listener registration wrapper
 */
export type Listener = {
  register: () => vscode.Disposable;
};

/**
 * The serialized state of a FuzzPanel
 */
export type FuzzPanelStateSerialized = {
  tag: string;
  fnRef: FunctionRef;
  options: fuzzer.FuzzOptions;
};

/**
 * Represents a link between a vscode document and a function definition
 */
export type FunctionMatch = {
  document: vscode.TextDocument;
  ref: FunctionRef;
};

/**
 * Represents a link between a validator and its function under test
 */
export type ValidatorMatch = {
  document: vscode.TextDocument;
  validator: FunctionRef;
  fut: FunctionRef;
};

export type FuzzPanelActiveButtons = {
  run?: boolean;
  continue?: boolean;
  pause?: boolean;
  retest?: boolean;
  clear?: boolean;
  add?: boolean;
  coverage?: boolean | "disabled";
  options?: boolean;
};

/**
 * Unified view state payload packed and passed to FuzzPanelView
 */
export type FuzzPanelViewState = {
  results?: fuzzer.FuzzTestResults;
  focusInput?: [fuzzer.FuzzResultCategory, number];
  inputCols: string[];
  sortColumns?: fuzzer.FuzzSortColumns;
  showCoverageHeatmap: boolean;
  hiddenColumns: string[];
  validators: string[];
  transformers: string[];
  userGenerators: string[];
  lang: ProgramLanguage;
  panelState: FuzzPanelStateSerialized;
  argDefs?: ArgDefLike[];
  argOverrides?: fuzzer.FuzzArgOverride[];
  disabled?: boolean;
  fuzzState: FuzzPanelState;
  activeButtons: FuzzPanelActiveButtons;
  errorMessage?: string;
  errorStack?: string;
  retestingReason?: string | false;
  generatorDiagnostics?: string[];
  runInfoHtml?: string;
  resultSummary?: Record<fuzzer.FuzzResultCategory, number>;
};

/**
 * Message to start Fuzzer
 */
export type FuzzPanelFuzzRunMessage = {
  fuzzer: Omit<fuzzer.FuzzOptions, "argDefaults">;
  args: fuzzer.FuzzArgOverride[];
  lastTab?: fuzzer.FuzzResultTab;
  input?: ArgValueTypeWrapped[];
};

/**
 * Message to pin or unpin test
 */
export type FuzzPanelPinMessage = {
  id: number;
  test: fuzzer.FuzzPinnedTest;
};

/**
 * Message structure for updating the webview
 */
export type FuzzPanelMessageToWebView =
  | {
      command: "state.update";
      viewState: FuzzPanelViewState;
    }
  | {
      command: "validator.list";
      validators: string[];
    }
  | {
      command: "transformer.list";
      transformers: string[];
    }
  | {
      command: "userGenerator.list";
      userGenerators: string[];
    }
  | { command: "busy.message"; message: fuzzer.FuzzBusyStatusMessage }
  | { command: "busy.ending" }
  | {
      command: "config.updated";
      config: {
        ai: {
          provider: string;
          model?: string;
        };
      };
    }
  | { command: "coverage.hidden" }
  | { command: "coverage.stale" };
