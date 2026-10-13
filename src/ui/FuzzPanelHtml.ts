import * as vscode from "vscode";
import * as fuzzer from "../fuzzer/Types";
import * as Config from "../Config";
import * as ValueMapper from "../fuzzer/mappers/ValueMapper";
import * as JSONN from "../Jsonn";
import { isError } from "../fuzzer/Util";
import { htmlEscape, toPrettyList, getSequentialFailures } from "./Util";
import { parseCoverageScope } from "../fuzzer/measures/Util";
import { ArgValueTypeWrapped } from "../fuzzer/analysis/Types";
import {
  FuzzPanelActiveButtons,
  FuzzPanelState,
  FuzzPanelViewState,
  toolName,
  getUri,
} from "./FuzzPanelController";

/**
 * Generates the one-time static HTML shell containing all structural
 * containers, scripts, and initial view state.
 *
 * @param options Static HTML generation options
 * @returns Complete HTML document string
 */
export function getStaticHtmlShell(options: StaticHtmlShellOptions): string {
  const {
    webview,
    extensionUri,
    fuzzEnv: env,
    state,
    activeButtons,
    viewState,
    fuzzTestsFilename,
  } = options;

  let html = "";
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline' 'self'`,
    `font-src ${webview.cspSource} data: 'self'`,
    `img-src ${webview.cspSource} data: blob:`,
    `script-src ${webview.cspSource} 'self' 'wasm-unsafe-eval'`,
    `connect-src ${webview.cspSource}`,
  ].join("; ");

  const htmlHead = /*html*/ `
    <head>
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script type="module" src="${getUri(webview, extensionUri, [
        "node_modules",
        "@vscode",
        "webview-ui-toolkit",
        "dist",
        "toolkit.js",
      ])}"></script>
      <script type="module" src="${getUri(webview, extensionUri, [
        "build",
        "ui",
        "FuzzPanelView.js",
      ])}"></script>
      <link rel="stylesheet" type="text/css" href="${getUri(
        webview,
        extensionUri,
        ["build", "ui", "FuzzPanelView.css"]
      )}">
      <link rel="stylesheet" type="text/css" href="${getUri(
        webview,
        extensionUri,
        ["node_modules", "@vscode", "codicons", "dist", "codicon.css"]
      )}">
      <title>${toolName} Panel</title>
    </head>
  `;

  try {
    const disabledFlag =
      state === FuzzPanelState.busyTesting ? ` disabled ` : "";
    const fn = env.function;
    const lang = fn.getLang();

    const heuristicFailValues = [
      ...new Set(
        (fn.isVoid() ? [undefined] : [null, undefined, Infinity, NaN]).map(
          (v) => ValueMapper.toLang(lang, v)
        )
      ),
    ].join(", ");

    const heuristicValidatorDescription = fn.isVoid()
      ? `Heuristic validator (for void functions). Fails: timeout, exception, values!==${heuristicFailValues}`
      : `Heuristic validator. Fails: timeout, exception, ${heuristicFailValues}`;

    const aiProvider = Config.get<string>("nanofuzz.ai.provider", "disabled");
    const aiModel = Config.get<string>("nanofuzz.ai.model", "");
    const aiModelDisplay =
      aiProvider === "disabled" || !aiModel ? "disabled" : aiModel;

    // prettier-ignore
    html += /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        ${htmlHead}
        <body>

        <!-- ${toolName} pane -->
        <div id="pane-nanofuzz"> 
          <!-- PUT -->
          <p class="fuzzPanelHeading" style="padding-bottom: 0.2em;">${state === FuzzPanelState.busyTesting ? "Testing:" : "Test:"}
            ${htmlEscape(fn.getName())} 
            <span class="tooltipped tooltipped-s" aria-label="Open source code">
              <span id="openSourceLink" ${disabledFlag} class="codicon codicon-go-to-file clickable"></span>
            </span>
            w/inputs:
          </p>

          <!-- Function Arguments -->
          <div id="argDefs"></div>

          <!-- Change Validators Options -->
          <div style="clear: both;">
          <p class="fuzzPanelHeading">Categorize outputs using:</p>
          <div style="padding-left: .76em;">
            <!-- Checkboxes -->
            <div class="fuzzInputControlGroup">
              <!-- Heuristic Validator -->
              <span class="tooltipped tooltipped-ne" aria-label="${heuristicValidatorDescription}">
                <vscode-checkbox ${disabledFlag} id="fuzz-useImplicit" ${env.options.useImplicit ? "checked" : ""}>
                  Heuristic validator 
                </vscode-checkbox>
              </span>

              <!-- Property Validator -->
              <span style="padding-left:1.3em;"> </span>
              <span style="display:inline-block;">
                <span id="validator-functionList" class="tooltipped tooltipped-ne" aria-label=""> 
                  <vscode-checkbox ${disabledFlag} id="fuzz-useProperty" ${env.options.useProperty ? "checked" : ""}>
                    Property validator${env.validators.length===1 ? "" : "s"}
                   (<span id="validator-functionCount">${env.validators.length}</span>)
                  </vscode-checkbox>
                </span>
                <span id="validator.add" class="tooltipped tooltipped-nw clickable" aria-label="Add new property validator">
                  <span ${disabledFlag} class="classAddRefreshValidator">
                    <span class="codicon codicon-add" style="padding-left:0.1em; padding-right:0.1em;"></span>
                  </span>
                </span>
                <span id="validator.getList" class="tooltipped tooltipped-nw clickable" aria-label="Refresh list">
                  <span ${disabledFlag} class="classAddRefreshValidator">
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
              <vscode-panel-tab aria-label="Stopping options tab">Stopping</vscode-panel-tab>
              <vscode-panel-tab aria-label="Input generation options tab">Generating Inputs</vscode-panel-tab>
              <vscode-panel-tab aria-label="Input transformer tab">Transforming Inputs</vscode-panel-tab>

              <vscode-panel-view>
                <p>
                  These settings control how long testing runs. Testing pauses and results are returned when any limit is reached.  
                  Previously saved or pinned tests do not count against the maximum runtime or number of tests. 
                  For max runtime, 0 indicates no limit.
                </p>
                <div class="fuzzInputControlGroup">
                  <vscode-text-field ${disabledFlag} size="3" id="fuzz-suiteTimeout" name="fuzz-suiteTimeout" value="${env.options.suiteTimeout}">
                    Max runtime (ms)
                  </vscode-text-field>
                  <vscode-text-field ${disabledFlag} size="3" id="fuzz-maxTests" name="fuzz-maxTests" value="${env.options.maxTests}">
                    Max number of tests
                  </vscode-text-field>
                  <vscode-text-field class="hidden" ${disabledFlag} size="3" id="fuzz-maxFailures" name="fuzz-maxFailures" value="${env.options.maxFailures}">
                    Max failed tests
                  </vscode-text-field>
                  <vscode-text-field ${disabledFlag} size="3" id="fuzz-maxDupeInputs" name="fuzz-maxDupeInputs" value="${env.options.maxDupeInputs}">
                    Max dupe inputs
                  </vscode-text-field>
                </div>
  
                <p>
                  To ensure testing completes, stop long-running function calls and categorize them as timeouts.
                </p>
                <div class="fuzzInputControlGroup">
                  <vscode-text-field ${disabledFlag} size="3" id="fuzz-fnTimeout" name="fuzz-fnTimeout" value="${env.options.fnTimeout}">
                    Test function timeout (ms)
                  </vscode-text-field>
                </div>
              </vscode-panel-view>

              <vscode-panel-view>
                <p>
                  What makes an input interesting?
                </p>
                <div class="fuzzInputControlGroup">
                  <vscode-checkbox ${disabledFlag} id="fuzz-measure-CoverageMeasure-enabled" ${env.options.measures.CoverageMeasure.enabled ? "checked" : ""}>
                    <span> 
                      Increases code coverage
                    </span>
                  </vscode-checkbox>
                  <vscode-text-field class="hidden" ${disabledFlag} size="3" id="fuzz-measure-CoverageMeasure-weight" name="fuzz-measures-CoverageMeasure-weight" value="${env.options.measures.FailedTestMeasure.weight}">
                    Weight of measure (&gt;=1)
                  </vscode-text-field>
                  <vscode-checkbox ${disabledFlag} id="fuzz-measure-FailedTestMeasure-enabled" ${env.options.measures.FailedTestMeasure.enabled ? "checked" : ""}>
                    <span> 
                      Causes a new test to fail
                    </span>
                  </vscode-checkbox>
                  <vscode-text-field  class="hidden" ${disabledFlag} size="3" id="fuzz-measures-FailedTestMeasure-weight" name="fuzz-measures-FailedTestMeasure-weight" value="${env.options.measures.FailedTestMeasure.weight}">
                    Weight of measure (&gt;=1)
                  </vscode-text-field>
                </div>

                <p>
                  Generate inputs:
                </p>
                <div class="fuzzInputControlGroup">
                  <vscode-checkbox ${disabledFlag} id="fuzz-gen-RandomInputGenerator-enabled" ${env.options.generators.RandomInputGenerator.enabled ? "checked" : ""}>
                    <span> 
                      Randomly
                    </span>
                  </vscode-checkbox>                    
                  <vscode-checkbox ${disabledFlag} id="fuzz-gen-MutationInputGenerator-enabled" ${env.options.generators.MutationInputGenerator.enabled ? "checked" : ""}>
                    <span> 
                      By mutating interesting inputs
                    </span>
                  </vscode-checkbox>                    
                  <vscode-checkbox ${disabledFlag} id="fuzz-gen-AiInputGenerator-enabled" ${env.options.generators.AiInputGenerator.enabled ? "checked" : ""}>
                    <span> 
                      With AI (<span class="editorFont" id="llm-model">${htmlEscape(aiModelDisplay)}</span>)
                      <vscode-link id="open.settings.ai">change</vscode-link>
                    </span>
                  </vscode-checkbox>
                  <span style="display:inline-block;">
                    <vscode-checkbox ${disabledFlag} id="fuzz-gen-UserInputGenerator-enabled" ${env.options.generators.UserInputGenerator?.enabled ? "checked" : ""}>
                      <span> 
                        With a custom input generator
                      </span>
                    </vscode-checkbox>
                    <span id="userGenerator.show" class="${env.userGenerators.length > 0 ? "" : "hidden "}tooltipped tooltipped-nw clickable" aria-label="Open custom generator in editor">
                      <span ${disabledFlag} class="classAddRefreshValidator">
                        <span class="codicon codicon-go-to-file" style="padding-left:0.1em; padding-right:0.1em;"></span>
                      </span>
                    </span>
                    <span id="userGenerator.add" class="${env.userGenerators.length > 0 ? "hidden " : ""}tooltipped tooltipped-nw clickable" aria-label="Create new custom generator">
                      <span ${disabledFlag} class="classAddRefreshValidator">
                        <span class="codicon codicon-add" style="padding-left:0.1em; padding-right:0.1em;"></span>
                      </span>
                    </span>
                    <span id="userGenerator.getList" class="tooltipped tooltipped-nw clickable" aria-label="Refresh list">
                      <span ${disabledFlag} class="classAddRefreshValidator">
                        <span class="codicon codicon-refresh" style="padding-left:0.1em;"></span>
                      </span>
                    </span>
                  </span>
                </div>
              </vscode-panel-view>

              <vscode-panel-view>
                <p>
                  An input transformer allows you to skip or manipulate a generated input (e.g., to calculate check-sums) before it is dispatched for execution.
                </p>
                
                <div class="fuzzInputControlGroup">
                  <span style="display:inline-block;">
                    <vscode-checkbox ${disabledFlag} id="fuzz-useTransformer" ${env.options.useTransformer ? "checked" : ""}>
                      <span> 
                        Input Transformer
                      </span>
                    </vscode-checkbox>
                    <span id="transformer.show" class="${env.transformers.length > 0 ? "" : "hidden "}tooltipped tooltipped-nw clickable" aria-label="Open input transformer in editor">
                      <span ${disabledFlag} class="classAddRefreshValidator">
                        <span class="codicon codicon-go-to-file" style="padding-left:0.1em; padding-right:0.1em;"></span>
                      </span>
                    </span>
                    <span id="transformer.add" class="${env.transformers.length > 0 ? "hidden " : ""}tooltipped tooltipped-nw clickable" aria-label="Create new input transformer">
                      <span ${disabledFlag} class="classAddRefreshValidator">
                        <span class="codicon codicon-add" style="padding-left:0.1em; padding-right:0.1em;"></span>
                      </span>
                    </span>
                    <span id="transformer.getList" class="tooltipped tooltipped-nw clickable" aria-label="Refresh list">
                      <span ${disabledFlag} class="classAddRefreshValidator">
                        <span class="codicon codicon-refresh" style="padding-left:0.1em;"></span>
                      </span>
                    </span>
                  </span>
                </div>
              </vscode-panel-view>
            </vscode-panels>

            <vscode-divider></vscode-divider>
          </div>

          <!-- Button Bar -->
          <div>
            <vscode-button ${disabledFlag} ${!activeButtons.run ? `class="hidden"` : ""} id="fuzz.run" class="tooltipped tooltipped-ne" appearance="primary icon" aria-label="${options.results ? "Test again": "Start testing"}">
              ${options.results ? `<span class="codicon codicon-debug-rerun"></span>` : `<span class="codicon codicon-play"></span>`}
            </vscode-button>
            <span id="fuzzPauseWrapper" class="${!activeButtons.pause ? `hidden ` : ""}tooltipped tooltipped-ne" appearance="primary icon" aria-label="Pause testing">
              <vscode-button ${!activeButtons.pause ? `class="hidden"` : ""} id="fuzz.pause" appearance="primary icon">
                <span class="codicon codicon-debug-pause"></span>
              </vscode-button>
            </span>
            <span id="fuzzRetestWrapper" class="${!activeButtons.retest ? `hidden ` : ""}tooltipped tooltipped-ne" aria-label="Retest these examples">
              <vscode-button ${disabledFlag} ${!activeButtons.retest ? `class="hidden"` : ""} id="fuzz.retest" appearance="secondary icon">
                <span class="codicon codicon-sync"></span>
              </vscode-button>
            </span>
            <span id="fuzzContinueWrapper" class="${!activeButtons.continue ? `hidden ` : ""}tooltipped tooltipped-ne" aria-label="Generate more examples">
              <vscode-button ${disabledFlag} ${!activeButtons.continue ? `class="hidden"` : ""} id="fuzz.continue" appearance="secondary icon">
                <span class="codicon codicon-debug-continue"></span>
              </vscode-button>
            </span>
            <span id="fuzzAddWrapper" ${!activeButtons.add ? `class="hidden"` : ""}>
              <vscode-button ${disabledFlag} id="fuzz.addTestInputOptions.open" class="tooltipped tooltipped-n" appearance="secondary icon" aria-label="Add one example">
                <span class="codicon codicon-add"></span>
              </vscode-button>
              <vscode-button ${disabledFlag} id="fuzz.addTestInputOptions.close" class="hidden tooltipped tooltipped-n" appearance="secondary icon depressed" aria-label="Add one example (close)">
                <span class="codicon codicon-add"></span>
              </vscode-button>
            </span>

            ${activeButtons.coverage ? "&nbsp;" : ""}

            <span id="fuzzCoverageWrapper" ${!activeButtons.coverage ? `class="hidden"` : ``}>
              <span class="tooltipped tooltipped-n" aria-label="${activeButtons.coverage === "disabled" ? "Coverage measure is disabled" : "Show coverage heatmap"}">
                <vscode-button ${disabledFlag || activeButtons.coverage === "disabled" ? " disabled" : ""} id="fuzz.coverage.show" appearance="secondary icon">
                  <span class="codicon codicon-coverage"></span>
                </vscode-button>
              </span>
              <span class="tooltipped tooltipped-n" aria-label="${activeButtons.coverage === "disabled" ? "Coverage measure is disabled" : "Hide coverage heatmap"}">
                <vscode-button ${disabledFlag || activeButtons.coverage === "disabled" ? " disabled" : ""} id="fuzz.coverage.hide" appearance="secondary icon depressed" class="hidden">
                  <span class="codicon codicon-coverage"></span>
                </vscode-button>  
              </span>
            </span>

            ${activeButtons.run || activeButtons.pause || activeButtons.retest || activeButtons.add || activeButtons.coverage ? `&nbsp;` : ""}

            <span id="fuzzClearWrapper" ${!activeButtons.clear ? `class="hidden"` : ""}>
              <vscode-button ${disabledFlag} id="fuzz.clear" class="tooltipped tooltipped-n" appearance="secondary icon" aria-label="Start over">
                <span class="codicon codicon-discard"></span>
              </vscode-button>
              &nbsp;
            </span>
            
            <span id="fuzzOptionsWrapper" ${!activeButtons.options ? `class="hidden"` : ""}>
              <vscode-button ${disabledFlag} id="fuzz.options.open" class="tooltipped tooltipped-n" appearance="secondary icon"  aria-label="More options">
                <span class="codicon codicon-settings-gear"></span>
              </vscode-button>
              <vscode-button ${disabledFlag} id="fuzz.options.close" class="hidden tooltipped tooltipped-n" appearance="secondary icon depressed" aria-label="Close more options">
                <span class="codicon codicon-settings-gear"></span>
              </vscode-button>
            </span>
          </div>
          <!-- End Button Bar -->

          <!-- Add New Test Input Pane -->
          <div id="fuzzAddTestInputOptions-pane" class="hidden">
            <vscode-divider></vscode-divider>
            <div class="panelButton">
              <span class="clickable codicon codicon-close" id="fuzzAddTestInputOptions-close"></span>
            </div>
            <h2>Add an example</h2>
            <p>
              Specify argument values for a new test input, and then click the button below to add it.
            </p>
            <div id="fuzzAddTestInputOptions-args"></div>
            <p>
              <vscode-button ${disabledFlag} id="fuzz.addTestInput" appearance="secondary">
                Add this example
              </vscode-button>
            </p>
          </div>

          <!-- Fuzzer Warnings and Errors -->
          <div class="fuzzWarnings hidden" id="fuzzWarningsNoValidators">
            <p>
              No validators are active, so ${toolName} cannot determine if any test has passed or failed.
            </p>
          </div>

          <div class="fuzzWarnings hidden" id="fuzzWarningsNoProperty">
            <p>No property validators were found, so the property validator column is blank.</p>
          </div>

          <div id="fuzzWarningsDiagnostics" class="hidden"></div>

          <!-- Fuzzer Info -->
          <div class="fuzzInfo hidden"></div>
          
          <!-- Retesting Reason -->
          <div class="fuzzInfo hidden" id="fuzzRetestingReason">
            <p id="fuzzRetestingReasonText"></p>
          </div>

          <!-- Fuzzer Busy Status Message -->
          <div id="fuzzBusyStatus" class="hidden">
            <div id="fuzzBusyStatusBarContainer">
              <div id="fuzzBusyStatusBar" style="width: 0%;">0%</div>
            </div>
            <div id="fuzzBusyMessage">
              <pre id="fuzzBusyMessageNonMilestone">Initializing...</pre>
            </div>
          </div>

          <!-- Fuzzer Output -->
          <div class="fuzzResults hidden" id="fuzzResults">
            <div class="fuzzResultsTabStripWrapper">
              <a id="scroll-to-top" class="clickable" role="button" aria-label="scroll to top" href="#" title="Scroll to top">
                <span class="clickable codicon codicon-chevron-up"></span>
              </a>
              <vscode-panels aria-label="Test result tabs" id="fuzzResultsTabStrip" class="fuzzTabStrip">
              </vscode-panels>
            </div>

            <div class="fuzzGridPanel hidden" id="view-failure">
              <div class="fuzzPanelDescription">A property validator or input transformer threw an exception for these inputs. Fix the bug in the testing code and retest.</div>
              <div id="fuzzResultsGrid-failure">
                <table class="fuzzGrid">
                  <thead class="columnSortOrder sticky" id="fuzzResultsGrid-failure-thead"></thead>
                  <tbody id="fuzzResultsGrid-failure-tbody"></tbody>
                </table>
              </div>
            </div>

            <div class="fuzzGridPanel hidden" id="view-disagree">
              <div class="fuzzPanelDescription">The property and human validators disagreed about how to categorize these outputs. Usually this indicates the property validator has a bug.</div>
              <div id="fuzzResultsGrid-disagree">
                <table class="fuzzGrid">
                  <thead class="columnSortOrder sticky" id="fuzzResultsGrid-disagree-thead"></thead>
                  <tbody id="fuzzResultsGrid-disagree-tbody"></tbody>
                </table>
              </div>
            </div>

            <div class="fuzzGridPanel hidden" id="view-timeout">
              <div class="fuzzPanelDescription">These inputs did not terminate within ${env.options.fnTimeout}ms, and no validator categorized them as passed.</div>
              <div id="fuzzResultsGrid-timeout">
                <table class="fuzzGrid">
                  <thead class="columnSortOrder sticky" id="fuzzResultsGrid-timeout-thead"></thead>
                  <tbody id="fuzzResultsGrid-timeout-tbody"></tbody>
                </table>
              </div>
            </div>

            <div class="fuzzGridPanel hidden" id="view-exception">
              <div class="fuzzPanelDescription">These inputs resulted in a runtime exception, and no validator categorized them as passed.</div>
              <div id="fuzzResultsGrid-exception">
                <table class="fuzzGrid">
                  <thead class="columnSortOrder sticky" id="fuzzResultsGrid-exception-thead"></thead>
                  <tbody id="fuzzResultsGrid-exception-tbody"></tbody>
                </table>
              </div>
            </div>

            <div class="fuzzGridPanel hidden" id="view-badValue">
              <div class="fuzzPanelDescription" id="badValueDescription">Failed</div>
              <div id="fuzzResultsGrid-badValue">
                <table class="fuzzGrid">
                  <thead class="columnSortOrder sticky" id="fuzzResultsGrid-badValue-thead"></thead>
                  <tbody id="fuzzResultsGrid-badValue-tbody"></tbody>
                </table>
              </div>
            </div>

            <div class="fuzzGridPanel hidden" id="view-ok">
              <div class="fuzzPanelDescription">Passed</div>
              <div id="fuzzResultsGrid-ok">
                <table class="fuzzGrid">
                  <thead class="columnSortOrder sticky" id="fuzzResultsGrid-ok-thead"></thead>
                  <tbody id="fuzzResultsGrid-ok-tbody"></tbody>
                </table>
              </div>
            </div>

            <div class="fuzzGridPanel hidden" id="view-skip">
              <div class="fuzzPanelDescription">These inputs were generated but skipped due to a user defined filter or assume statement.</div>
              <div id="fuzzResultsGrid-skip">
                <table class="fuzzGrid">
                  <thead class="columnSortOrder sticky" id="fuzzResultsGrid-skip-thead"></thead>
                  <tbody id="fuzzResultsGrid-skip-tbody"></tbody>
                </table>
              </div>
            </div>

            <div class="fuzzGridPanel hidden" id="view-runInfo">
              <div class="fuzzPanelDescription" id="runInfoDescription"></div>
            </div>
          </div> <!-- fuzzResults -->

          <!-- Unified Fuzzer View State (MessagePack base64) -->
          <script id="fuzzViewState" type="application/octet-stream">${Buffer.from(
            JSONN.pack(viewState)
          ).toString("base64")}</script>
        </div>
        <div id="snackbarRoot" class="hidden" />
        </body>
      </html>
    `;
  } catch (e: unknown) {
    const msg = isError(e) ? e.message : "Unknown error";
    const stack = isError(e) ? e.stack : "<no stack>";
    html = /*html*/ `
    ${htmlHead}
    <body>
      <h1>:-(</h1>
      <p>Unable to render this panel due to an internal error in FuzzPanel Html generation.</p>
      <p>You may want to make a copy of the following file then delete it. Then close and re-open this panel.
      <small><pre>${htmlEscape(fuzzTestsFilename)}</pre></small>
      <p>Stack trace:</p>
      <small><pre>${stack}</pre></small>
    </body>`;
    console.debug(`Exception in getStaticHtmlShell(): ${msg} stack: ${stack}`);
  }

  return html;
} // fn: getStaticHtmlShell()

/**
 * Formats the HTML content for the Run Info tab.
 *
 * @param options Run info formatting parameters
 * @returns formatted HTML string for Run Info
 */
export function formatRunInfoHtml(options: RunInfoHtmlOptions): string {
  const {
    results,
    fuzzEnv: env,
    workerCount,
    engine: testerEngine,
    coverageStats,
  } = options;
  if (!results) {
    return "";
  }
  const textReason = {
    [fuzzer.FuzzStopReason.PAUSE]: `because the user paused testing.`,
    [fuzzer.FuzzStopReason.CRASH]: `because it crashed.`,
    [fuzzer.FuzzStopReason.MAXTIME]:
      `because it exceeded the maximum time configured (${results.env.options.suiteTimeout} ms) for it to run.`,
    [fuzzer.FuzzStopReason.MAXFAILURES]:
      `because it found ${results.env.options.maxFailures} failing test${
        results.env.options.maxFailures !== 1 ? "s" : ""
      }. This is the maximum number configured.`,
    [fuzzer.FuzzStopReason.MAXTESTS]:
      `because it reached the maximum number of new tests configured (${
        results.env.options.maxTests
      }). This is in addition to the ${results.stats.counters.inputsInjected} prior input${
        results.stats.counters.inputsInjected !== 1 ? "s" : ""
      } ${toolName} retested.`,
    [fuzzer.FuzzStopReason.MAXDUPES]:
      `because it reached the maximum number of sequentially-generated duplicate inputs configured (${results.env.options.maxDupeInputs}). This can mean that ${toolName} is having difficulty generating further new inputs: the function's input space might be small or near exhaustion.`,
    "": `because of an unknown reason.`,
    [fuzzer.FuzzStopReason.NOMOREINPUTS]:
      `because it ran out of inputs to test (e.g., it was retesting prior inputs or testing a single additional input).`,
  };

  const genTextEnabled: string[] = [];
  const genTextDisabled: string[] = [];
  let g: keyof typeof results.env.options.generators;
  for (g in results.env.options.generators) {
    const shortName = g.replace("InputGenerator", "").toLowerCase();
    const genStats = results.stats.generators[g];
    if (genStats.counters.inputsGenerated > 0) {
      genTextEnabled.push(
        `${shortName} produced ${
          genStats.counters.inputsGenerated
        } inputs (${genStats.counters.dupesGenerated} of which ${
          genStats.counters.dupesGenerated === 1
            ? "was a duplicate"
            : "were duplicates"
        }) in ${genStats.timers.gen.toFixed(2)} ms (${(
          genStats.timers.gen /
          (genStats.counters.inputsGenerated + genStats.counters.dupesGenerated)
        ).toFixed(2)} ms/input)`
      );
    } else {
      if (results.env.options.generators[g].enabled) {
        genTextEnabled.push(
          `${shortName} was enabled but did not produce any inputs before testing ended`
        );
      } else {
        genTextDisabled.push(`${shortName}`);
      }
    }
  }

  const generatorsText =
    genTextEnabled.length === 0 && results.stats.counters.inputsGenerated === 0
      ? `${toolName} did not generate any new inputs.`
      : `${toolName} generated inputs using the following strateg${
          genTextEnabled.length === 1 ? "y" : "ies"
        }: ${toPrettyList(genTextEnabled)}. ${
          genTextDisabled.length
            ? `The following strateg${
                genTextDisabled.length === 1 ? "y was" : "ies were"
              } not used because ${
                genTextDisabled.length === 1 ? "it was" : "they were"
              } not enabled: `
            : ``
        }${toPrettyList(genTextDisabled)}${genTextDisabled.length ? "." : ""}`;

  const aiGenStats = results.stats.generators["AiInputGenerator"];
  const aiGeneratorText: string[] = [];
  if (aiGenStats.gen && aiGenStats.gen.calls.sent) {
    let moreCalls = aiGenStats.gen.calls.sent;
    const pendingCalls =
      aiGenStats.gen.calls.sent -
      aiGenStats.gen.calls.valid -
      aiGenStats.gen.calls.invalid -
      aiGenStats.gen.calls.failed;

    const { count: sequentialFailures, message: latestFailureMessage } =
      getSequentialFailures(aiGenStats.gen.calls.history);

    aiGeneratorText.push(
      `The ai input generator sent ${aiGenStats.gen.calls.sent} request${aiGenStats.gen.calls.sent === 1 ? "" : "s"} to the LLM, of which`
    );
    let callCategories = 0;
    if (pendingCalls) {
      moreCalls -= pendingCalls;
      callCategories++;
      aiGeneratorText.push(
        `${pendingCalls} ${pendingCalls === 1 ? "was" : "were"} still in-flight when testing ended, and their results will be used if you click the "continue" button${moreCalls ? "," : "."}`
      );
    }
    if (aiGenStats.gen.calls.valid) {
      moreCalls -= aiGenStats.gen.calls.valid;
      callCategories++;
      aiGeneratorText.push(
        `${aiGenStats.gen.calls.valid} received a well-formed response${moreCalls ? "," : "."}`
      );
    }
    if (aiGenStats.gen.calls.invalid) {
      callCategories++;
      moreCalls -= aiGenStats.gen.calls.invalid;
      aiGeneratorText.push(
        `${aiGenStats.gen.calls.invalid} received a malformed response that was discarded${moreCalls ? "," : "."}`
      );
    }
    if (aiGenStats.gen.calls.failed) {
      callCategories++;
      aiGeneratorText.push(
        `${aiGenStats.gen.calls.failed} failed. ${sequentialFailures ? `The most recent ${sequentialFailures === 1 ? "" : sequentialFailures} response${sequentialFailures === 1 ? "" : "s"} failed for reason: <span class="editorText">${latestFailureMessage}</span>.` : ""}`
      );
    }
    if (callCategories > 1) {
      aiGeneratorText.push("and", aiGeneratorText.pop() ?? "");
    }

    if (aiGenStats.gen.inputs.invalid || aiGenStats.gen.inputs.invalidLater) {
      aiGeneratorText.push(
        `In addition to the ${aiGenStats.counters.inputsGenerated} input${aiGenStats.counters.inputsGenerated === 1 ? "" : "s"} returned by the generator (${aiGenStats.counters.dupesGenerated} of which ${aiGenStats.counters.dupesGenerated === 1 ? "was a duplicate" : "were duplicates"}),`
      );
      aiGeneratorText.push(
        `${aiGenStats.gen.inputs.invalid + aiGenStats.gen.inputs.invalidLater} input${aiGenStats.gen.inputs.invalid + aiGenStats.gen.inputs.invalidLater === 1 ? " was discarded because it" : "s were discarded because they"} did not satisfy the input schema.`
      );
    }
    if (aiGenStats.gen.inputs.inQueue) {
      aiGeneratorText.push(
        `${aiGenStats.gen.inputs.inQueue} input${aiGenStats.gen.inputs.inQueue === 1 ? "" : "s"} remained queued when testing finished.`
      );
    }
    if (aiGenStats.gen.tokens.sent + aiGenStats.gen.tokens.received) {
      aiGeneratorText.push(
        `These non in-flight interactions used ${aiGenStats.gen.tokens.sent} input tokens and ${aiGenStats.gen.tokens.received} output tokens.`
      );
      if (
        !(
          aiGenStats.gen.tokens.receivedCost === undefined ||
          aiGenStats.gen.tokens.sentCost === undefined ||
          aiGenStats.gen.tokens.receivedCost.unit !==
            aiGenStats.gen.tokens.sentCost.unit
        )
      ) {
        aiGeneratorText.push(
          `The estimated retail cost of which is ${
            aiGenStats.gen.tokens.sentCost.amt +
            aiGenStats.gen.tokens.receivedCost.amt
          } ${aiGenStats.gen.tokens.receivedCost.unit}.`
        );
      }
    }
  }

  const fmtPct = (n: number, d: number) =>
    d === 0 ? "na%" : ((n * 100) / d).toFixed(0).toString() + "%";
  const coverageScopeRaw = Config.get<unknown>(
    "nanofuzz.fuzzer.coverageScope",
    "project static"
  );
  const scopeConfig = parseCoverageScope(coverageScopeRaw);
  const scopeItems = ["dynamic executions"];
  if (scopeConfig.collectStaticCoverage) {
    scopeItems.push("static loads");
  }
  if (scopeConfig.target.includes("directimports")) {
    scopeItems.push("direct imports");
  }
  const scopeText = `The scope of coverage instrumentation included ${toPrettyList(
    scopeItems
  )}.`;
  const coverageText =
    coverageStats === undefined
      ? ""
      : `The executed tests exercised ${
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
        } executed. ${scopeText}`;

  const validatorsUsed: string[] = [];
  const validatorsNotUsed: string[] = [];
  let validatorsUsedText: string;
  let validatorsUsedText2 = "";
  (env.options.useImplicit ? validatorsUsed : validatorsNotUsed).push(
    "heuristic"
  );
  (env.options.useHuman ? validatorsUsed : validatorsNotUsed).push("human");
  if (env.validators.length && env.options.useProperty) {
    env.validators.forEach((e) => {
      validatorsUsed.push(`${e.name}`);
    });
  } else if (!env.options.useProperty) {
    validatorsNotUsed.push(`property`);
  } else {
    validatorsUsedText2 = `The property validator was active, but no property validators were found, so ${toolName} raised an on-screen warning.`;
  }
  if (validatorsUsed.length) {
    validatorsUsedText = `
      ${toolName} categorized outputs using the ${toPrettyList(
        validatorsUsed
      )} validator${validatorsUsed.length !== 1 ? "s" : ""}. `;
    if (validatorsNotUsed.length) {
      validatorsUsedText += `The ${toPrettyList(validatorsNotUsed)} validator${
        validatorsNotUsed.length !== 1 ? "s were" : " was"
      } not enabled.`;
    }
  } else {
    validatorsUsedText = `${toolName} did not use any validators in this test. This means that all tests were categorized as passed.`;
  }

  const totalReported =
    results.stats.outcomes.total !== undefined
      ? results.stats.outcomes.total + results.stats.counters.inputsSkipped
      : results.results.length;
  const executedInputs =
    results.stats.outcomes.total || results.results.length || 1;
  const workersCount = workerCount;
  const engine =
    testerEngine ?? Config.get<string>("nanofuzz.fuzzer.engine", "auto");
  const scheduler =
    results.stats.generators.CompositeInputGenerator?.config?.scheduler ??
    Config.get<string>("nanofuzz.generators.scheduler.impl", "mab");
  const coverageScope = Config.get<string>(
    "nanofuzz.fuzzer.coverageScope",
    "project static"
  );

  return /*html*/ `
    <div class="fuzzResultHeading">What did ${toolName} do?</div>
    <p>
      ${toolName} ran ${results.stats.counters.testingRuns} time${
        results.stats.counters.testingRuns === 1 ? "" : "s"
      } for a total of ${Math.round(results.stats.timers.total)} ms, retested ${
        results.stats.counters.inputsInjected
      } prior input${
        results.stats.counters.inputsInjected !== 1 ? "s" : ""
      }, generated ${results.stats.counters.inputsGenerated} new input${
        results.stats.counters.inputsGenerated !== 1 ? "s" : ""
      } (${results.stats.counters.dupesGenerated} of which ${
        results.stats.counters.dupesGenerated !== 1
          ? "were duplicates"
          : "was a duplicate"
      } previously tested), and reported ${totalReported} test result${
        totalReported !== 1 ? "s" : ""
      } before testing ended.
    </p>

    <div class="fuzzResultHeading">Why did testing stop?</div>
    <p>
      ${toolName} most recently stopped testing ${
        results.stopReason in textReason
          ? textReason[results.stopReason]
          : textReason[""]
      }
      ${
        Config.get<boolean>("nanofuzz.ui.hideMoreOptionsButton", false)
          ? ``
          : ` You can adjust why ${toolName} stops using the gear button above.`
      }
    </p>

    <div class="fuzzResultHeading">What was returned?</div>
    <p>
      ${toolName} returned ${totalReported} test result${
        totalReported === 1 ? "" : "s"
      }
      ${
        totalReported
          ? ` (${(results.stats.timers.put / executedInputs).toFixed(
              2
            )} ms/test execution)` +
            (totalReported
              ? ` across ${results.results.length} unique example${
                  results.results.length === 1 ? "" : "s"
                }`
              : ``) +
            `, which you can view in the other tabs.`
          : `.`
      }
    </p>

    <div class="fuzzResultHeading">How were inputs generated?</div>
    <p>
      ${generatorsText}
      The selected measures classified ${
        results.interesting.inputs.length
      } input${
        results.interesting.inputs.length !== 1 ? "s" : ""
      } as interesting. (<a id="fuzz.options.interesting.inputs.button" href="#" role="button"><span id="fuzz.options.interesting.inputs.show">show</span><span id="fuzz.options.interesting.inputs.hide" class="hidden">hide</span></a>)
      <table class="fuzzGrid hidden" id="fuzz.options.interesting.inputs">
        <thead>
          <th><strong>#</strong></th>
          ${results.env.function
            .getArgDefs()
            .map((a) => `<th><strong>input: ${a.getName()}</strong></th>`)
            .join("")}
          <th><strong>score</strong></th>
          <th><strong>measures</strong></th>
        </thead>
        <tbody>
          ${results.interesting.inputs
            .map(
              (inp, i) =>
                `<tr>` +
                `<td>${i + 1}</td>` +
                inp.input.value
                  .map(
                    (a: ArgValueTypeWrapped) =>
                      `<td>${ValueMapper.toLang(
                        env.function.getLang(),
                        a.value
                      )}</td>`
                  )
                  .join("") +
                `<td>${inp.score.toFixed(2)}</td>` +
                `<td>${toPrettyList(
                  inp.measurements.map((m) => m.name)
                )}</td>` +
                `</tr>`
            )
            .join("")}
        </tbody>
      </table>
    </p>
    ${aiGeneratorText.length ? `<p>${aiGeneratorText.join(" ")}</p>` : ""}

    <div class="fuzzResultHeading">How were outputs categorized?</div>
    <p>
      ${validatorsUsedText} ${validatorsUsedText2}
    </p>

    <div class="fuzzResultHeading">What code was executed?</div>
    <p>
      ${coverageText}
    </p>

    <div class="fuzzResultHeading">What are some internal details?</div>
    <p>
      ${toolName} used the ${engine} engine and ${scheduler} scheduler to coordinate test execution with ${workersCount} worker${
        workersCount === 1 ? "" : "s"
      } and ${coverageScope} coverage scope.
    </p>
  `;
} // fn: formatRunInfoHtml()

// ----------------------------- Types ----------------------------- //

export interface StaticHtmlShellOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  fuzzEnv: fuzzer.FuzzEnv;
  state: FuzzPanelState;
  results?: fuzzer.FuzzTestResults;
  activeButtons: FuzzPanelActiveButtons;
  viewState: FuzzPanelViewState;
  fuzzTestsFilename: string;
}

export interface RunInfoHtmlOptions {
  results: fuzzer.FuzzTestResults;
  fuzzEnv: fuzzer.FuzzEnv;
  workerCount: number;
  engine?: string;
  coverageStats?: {
    counters: {
      functionsCovered: number;
      functionsTotal: number;
      statementsCovered: number;
      statementsTotal: number;
      branchesCovered: number;
      branchesTotal: number;
    };
    files: Array<{ path: string }>;
  };
}
