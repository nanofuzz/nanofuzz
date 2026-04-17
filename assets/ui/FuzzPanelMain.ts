import * as JSON5 from "json5";
import { getElementByIdOrThrow, getElementByIdWithTypeOrThrow } from "./utils";
import {
  FuzzArgOverride,
  FuzzIoElement,
  FuzzPinnedTest,
  FuzzResultCategory,
  FuzzSortColumns,
  FuzzSortOrder,
  FuzzValueOrigin,
  isFuzzResultTab,
} from "fuzzer/Types";
import {
  ArgValueType,
  ArgValueTypeWrapped,
  FuzzTestResults,
} from "fuzzer/Fuzzer";
import {
  FuzzPanelFuzzRunMessage,
  FuzzPanelMessageToWebView,
  FuzzPanelMessageFromWebView,
  FuzzPanelPinMessage,
} from "ui/FuzzPanel";

const vscode = acquireVsCodeApi();

// Attach main to the window onLoad() event
window.addEventListener("load", main);

// List of output grids that store fuzzer results
const gridTypes = [
  "failure",
  "disagree",
  "exception",
  "timeout",
  "badValue",
  "ok",
] as const;

// Column name labels
const pinnedLabel = "pinned";
const idLabel = "id";
const srcLabel = "src";
const correctLabel = "correct output?";
const expectedLabel = "expectedOutput";
const validatorLabel = "validator";
const allValidatorsLabel = "allValidators";
const implicitLabel = "implicit";
const expandLabel = "expandColumn";
const collapseLabel = "collapseColumn";

// List of hidden columns
const hiddenColumns = [expectedLabel, allValidatorsLabel];

// Pin button states
const pinState = {
  htmlPinned: `<span class="codicon codicon-pinned" title="pinned"></span>`,
  htmlPin: `<span class="codicon codicon-pin" title="not pinned"></span>`,
  classPinned: "fuzzGridCellPinned",
  classPin: "fuzzGridCellPin",
};

// Correct icon states
const correctState = {
  htmlCheck: `<span class="codicon codicon-pass" title="passed"></span>`, // check in circle
  htmlError: `<span class="codicon codicon-error" title="failed"></span>`, // X in circle
  classCheckOn: "classCheckOn",
  classCheckOff: "classCheckOff",
  classErrorOn: "classErrorOn",
  classErrorOff: "classErrorOff",
};

// Correct icon sorting validator results
const validatorResult = {
  true: 3,
  false: 2,
  undefined: 1,
};

// Sort order for each grid and column
function getDefaultColumnSortOrder(): Record<string, FuzzSortOrder> {
  return {
    [pinnedLabel]: FuzzSortOrder.desc,
    [correctLabel]: FuzzSortOrder.desc,
  };
}
const defaultColumnSortOrders: FuzzSortColumns = {
  failure: {}, // no pinned column
  timeout: getDefaultColumnSortOrder(),
  exception: getDefaultColumnSortOrder(),
  badValue: getDefaultColumnSortOrder(),
  ok: getDefaultColumnSortOrder(),
  disagree: getDefaultColumnSortOrder(),
};

// Column sort orders (filled by main or handleColumnSort())
let columnSortOrders: FuzzSortColumns;
// Fuzzer Results (filled by main during load event)
let resultsData: FuzzTestResults;
// Results grouped by type (filled by main during load event)
const data: Record<FuzzResultCategory, any[]> = {
  ok: [],
  badValue: [],
  timeout: [],
  exception: [],
  disagree: [],
  failure: [],
};
// Validator functions (filled by main during load event)
let validators: string[];

// Tab scroll positions by tab
const tabScrollPosition: Record<string, number> = {};

// Last results tab & clicked
let lastResultsTabClicked: Element | undefined = undefined;
let lastResultsTableShown: Element | undefined = undefined;

/**
 * Sets up the UI when the page is loaded, including setting up
 * event handlers and filling the output grids if data is available.
 */
function main() {
  // Add event listener for the fuzz.run button
  getElementByIdOrThrow("fuzz.run").addEventListener("click", () => {
    handleFuzzRun();
  });

  // Add event listener for the fuzz.retest button
  getElementByIdOrThrow("fuzz.retest").addEventListener("click", () => {
    handleFuzzRetest();
  });

  // Add event listener for the fuzz.clear button
  getElementByIdOrThrow("fuzz.clear").addEventListener("click", () => {
    handleFuzzClear();
  });

  // Add event listener for the fuzz.options buttons
  getElementByIdOrThrow("fuzz.options.open").addEventListener(
    "click",
    toggleFuzzOptions
  );
  getElementByIdOrThrow("fuzz.options.close").addEventListener(
    "click",
    toggleFuzzOptions
  );
  getElementByIdOrThrow("fuzzOptions-close").addEventListener(
    "click",
    toggleFuzzOptions
  );

  // Add event listeners for the fuzz.addTestInputOptions controls
  getElementByIdOrThrow("fuzz.addTestInputOptions.open").addEventListener(
    "click",
    toggleAddTestInputOptions
  );
  getElementByIdOrThrow("fuzz.addTestInputOptions.close").addEventListener(
    "click",
    toggleAddTestInputOptions
  );
  getElementByIdOrThrow("fuzzAddTestInputOptions-close").addEventListener(
    "click",
    toggleAddTestInputOptions
  );
  document
    .getElementById("fuzz.addTestInput")
    ?.addEventListener("click", handleAddTestInput);
  for (let i = 0; document.getElementById(`addInputArg-${i}-value`); i++) {
    getElementByIdOrThrow(`addInputArg-${i}-value`).addEventListener(
      "change",
      () => {
        getInputValues();
      }
    );
  }

  // Add event listener for opening the function source code
  getElementByIdOrThrow("openSourceLink").addEventListener(
    "click",
    handleOpenSource
  );

  // Add event listener to toggle fuzz.options.interesting.inputs.button
  // if it is present
  document
    .getElementById("fuzz.options.interesting.inputs.button")
    ?.addEventListener("click", toggleInterestingInputs);

  // Add event listeners for all the union generate checkboxes
  document.querySelectorAll(".isNoInput vscode-checkbox").forEach((element) => {
    element.addEventListener("click", (e) => {
      const target = e.target;
      if (!target) {
        throw new Error("no target");
      }
      if (!(target instanceof HTMLElement)) {
        throw new Error("target not HTMLElement");
      }
      setIsNoInput(
        target,
        (target.getAttribute("value") ??
          target.getAttribute("current-checked")) !== "true" // changing state
      );
    });
    // Set the UI state
    setIsNoInput(
      element,
      (element.getAttribute("value") ??
        element.getAttribute("current-checked")) === "true" // steady state
    );
  });

  // Add event listener for LLM configuration button
  getElementByIdOrThrow("open.settings.ai").addEventListener("click", () => {
    // Send the message to open the ai settings
    const message: FuzzPanelMessageFromWebView = {
      command: "open.settings.ai",
    };
    vscode.postMessage(message);

    // Undo the the parent checkbox click
    getElementByIdOrThrow("fuzz-gen-AiInputGenerator-enabled").click();
  });

  // Load the fuzzer results data from the HTML
  resultsData = JSON5.parse(
    htmlUnescape(getElementByIdOrThrow("fuzzResultsData").innerHTML)
  );

  // Add event listener for the validator buttons
  getElementByIdOrThrow("validator.add").addEventListener(
    "click",
    handleAddValidator
  );
  getElementByIdOrThrow(`validator.getList`).addEventListener(
    "click",
    handleGetListOfValidators
  );

  // Add event listeners for the pause button
  getElementByIdOrThrow("fuzz.pause").addEventListener("click", () => {
    const message: FuzzPanelMessageFromWebView = { command: "fuzz.pause" };
    vscode.postMessage(message);
    getElementByIdOrThrow("fuzz.pause").setAttribute("disabled", "true");
  });

  // Add event listeners for results tabs
  //
  // Note: we don't use the vscode ui toolkit's tab panes necause
  // we want sticky scroll and more control over rendering.
  const resultsTabStrip = document.querySelector("#fuzzResultsTabStrip");
  if (resultsTabStrip) {
    // Tab style override
    resultsTabStrip.shadowRoot
      ?.querySelector(".tablist")
      ?.setAttribute(
        "style",
        "column-gap: calc(var(--design-unit) * 4px); padding-left: 0; padding-right: 0;"
      );

    // Event handlers
    const tabs = document.querySelectorAll(
      `.fuzzResults #fuzzResultsTabStrip vscode-panel-tab`
    );
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const htmlElement = document.querySelector("html");
        if (!htmlElement) {
          throw new Error("Cannot find html element");
        }
        if (!lastResultsTabClicked) {
          throw new Error("lastTabClicked not defined");
        }
        // Save the current tab's scroll position
        const lastTabId = lastResultsTabClicked.id.replace("tab-", "");
        const lastGridId = lastResultsTabClicked.id.replace(
          "tab-",
          "fuzzResultsGrid-"
        );
        const lastGridElement = document.querySelector(`#${lastGridId}`);

        // Is the heading collapsed? (handle both grids and non-grids)
        const headingCollapsed = lastGridElement
          ? lastGridElement.getBoundingClientRect().top <
            resultsTabStrip.getBoundingClientRect().bottom
          : resultsTabStrip.getBoundingClientRect().top < 0;

        // Only save the tab position if the heading is collapsed
        if (headingCollapsed) {
          tabScrollPosition[lastTabId] = htmlElement.scrollTop;
        } else {
          delete tabScrollPosition[lastTabId];
        }

        // Sync visibility of tabs and panels
        syncResultsTabsAndPanels(resultsTabStrip, tabs, tab);

        // If a scroll position was saved for the clicked tab &
        // the headings are collapsed, scroll to the previous position
        const tabId = tab.id.replace("tab-", "");
        const gridId = tab.id.replace("tab-", "fuzzResultsGrid-");
        const viewId = tab.id.replace("tab-", "view-");
        const pos = tabScrollPosition[tabId];
        const gridElement = document.querySelector(`#${gridId}`);
        const gridHeadElement = document.querySelector(`#${gridId}-thead`);
        const viewElement = document.querySelector(`#${viewId}`);

        // Only restore a scroll position if the heading is collapsed
        // Otherwise, go the top of the tab
        if (headingCollapsed) {
          if (pos) {
            // Position was saved
            htmlElement.scrollTo({ top: pos });
          } else if (gridElement && gridHeadElement) {
            // Grid tab w/o saved position: scroll to top of tab
            htmlElement.scrollTo({
              top:
                gridElement.getBoundingClientRect().top -
                gridHeadElement.getBoundingClientRect().height -
                htmlElement.getBoundingClientRect().top +
                resultsTabStrip.getBoundingClientRect().top,
            });
          } else if (viewElement) {
            // Non-grid tab w/o saved position: scroll to top of tab
            htmlElement.scrollTo({
              top:
                viewElement.getBoundingClientRect().top -
                htmlElement.getBoundingClientRect().top -
                resultsTabStrip.getBoundingClientRect().height,
            });
          } else {
            // shouldn't reach here
          }
        }
      }); // tab onClick event
    }); // for each: grid tab

    // Sync the tabs and panes after load
    window.setTimeout(() => {
      lastResultsTabClicked =
        resultsTabStrip.querySelector(
          `vscode-panel-tab[aria-selected="true"]`
        ) ?? undefined;
      if (lastResultsTabClicked) {
        syncResultsTabsAndPanels(resultsTabStrip, tabs, lastResultsTabClicked);
      }
    });

    // Event listener for window resize
    window.addEventListener("resize", () => {
      if (lastResultsTableShown) {
        syncTabStripWidth(resultsTabStrip, lastResultsTableShown);
      }
    }); // onResize event handler

    // Event listener for scroll
    let scrollEvent: NodeJS.Timeout | undefined = undefined;
    const scrollButton = getElementByIdOrThrow("scroll-to-top");
    window.addEventListener("scroll", () => {
      clearTimeout(scrollEvent);
      scrollEvent = setTimeout(() => {
        if (resultsTabStrip.getBoundingClientRect().top < 2) {
          scrollButton.classList.add("revealed");
        } else {
          scrollButton.classList.remove("revealed");
        }
      }, 100);
    }); // onScroll event handler
  } // if: tabstrip found

  // Load & display the validator functions from the HTML
  validators = JSON5.parse(
    htmlUnescape(getElementByIdOrThrow("validators").innerHTML)
  );
  refreshValidators(validators);

  // Load column sort orders from the HTML
  columnSortOrders = JSON5.parse(
    htmlUnescape(getElementByIdOrThrow("fuzzSortColumns").innerHTML)
  );
  if (Object.keys(columnSortOrders).length === 0) {
    columnSortOrders = defaultColumnSortOrders;
  }

  // Listen for messages from the extension
  window.addEventListener("message", async (event) => {
    const data: FuzzPanelMessageToWebView = event.data;
    switch (data.command) {
      case "validator.list":
        refreshValidators(data.validators);
        break;
      case "config.updated": {
        getElementByIdOrThrow("llm-model").innerText =
          data.config.ai.provider === "disabled" ||
          data.config.ai.model === undefined
            ? "disabled"
            : data.config.ai.model;
        break;
      }
      case "busy.message": {
        const nonMilestone = getElementByIdOrThrow(
          "fuzzBusyMessageNonMilestone"
        );
        nonMilestone.innerHTML = htmlEscape(data.message.msg);
        if (data.message.pct) {
          const pct = Math.min(data.message.pct, 100);
          const progressBar = getElementByIdOrThrow("fuzzBusyStatusBar");
          progressBar.style.width = pct + "%";
          if (pct > 0) {
            progressBar.innerHTML = Math.floor(pct) + "%";
          } else {
            progressBar.innerHTML = "";
          }
        }
        break;
      }
      case "busy.ending":
        getElementByIdOrThrow("fuzz.pause").setAttribute("disabled", "true");
        break;
    }
  });

  // Load and save the state back to the webview.  There does not seem to be
  // an 'official' way to directly persist state within the extension itself,
  // at least as of vscode 1.69.2.  Hence, the roundtrip.
  vscode.setState(
    JSON5.parse(htmlUnescape(getElementByIdOrThrow("fuzzPanelState").innerHTML))
  );

  // Update the list of hidden columns
  const addlHiddenColumns = JSON5.parse(
    htmlUnescape(getElementByIdOrThrow("fuzzHideColumns").innerHTML)
  );
  if (Array.isArray(addlHiddenColumns)) {
    hiddenColumns.push(...addlHiddenColumns);
  }

  // Fill the result grids
  if (Object.keys(resultsData).length) {
    gridTypes.forEach((type) => {
      data[type] = [];
    });

    // Loop over each result
    let idx = 0;
    for (const e of resultsData.results) {
      // Indicate which tests are pinned
      const pinned = { [pinnedLabel]: !!e.pinned };
      const id = { [idLabel]: idx++ };

      // Input Source
      const inputSrc: FuzzValueOrigin = e.input.length
        ? e.input[0].origin
        : { type: "unknown" };
      let src: { [srcLabel]: string };
      switch (inputSrc.type) {
        case "unknown":
          src = { [srcLabel]: "n/a" };
          break;
        case "user":
          src = { [srcLabel]: "usr" };
          break;
        case "put":
          src = { [srcLabel]: "pgm" };
          break;
        case "generator":
          switch (inputSrc.generator) {
            case "AiInputGenerator":
              src = { [srcLabel]: "ai" };
              break;
            case "MutationInputGenerator":
              src = { [srcLabel]: "mut" };
              break;
            case "RandomInputGenerator":
              src = { [srcLabel]: "rnd" };
              break;
            default:
              throw new Error(
                `Unexpected FuzzValueOrigin generator at input# ${idx}: ${JSON5.stringify(
                  inputSrc
                )}`
              );
          }
          break;
        default:
          throw new Error(
            `Unexpected FuzzValueOrigin at input# ${idx}: ${JSON5.stringify(
              inputSrc
            )}`
          );
      }

      // Implicit validation result
      const passedImplicit = resultsData.env.options.useImplicit
        ? { [implicitLabel]: e.passedImplicit }
        : {};

      // Human validation expectation and result
      const passedHuman = resultsData.env.options.useHuman
        ? { [correctLabel]: e.passedHuman }
        : {};
      const expectedOutput = resultsData.env.options.useHuman
        ? { [expectedLabel]: e.expectedOutput }
        : {};

      // Property validator summary (true if passed all validator functions)
      const passedValidator = resultsData.env.options.useProperty
        ? { [validatorLabel]: e.passedValidator }
        : {};

      // Array of all property validator results (array of bools, each is true if passed)
      // const allValidators = resultsData.env.options.useProperty
      //   ? { [allValidatorsLabel]: e.passedValidators }
      //   : {};

      // Result for each property validator (true if passed)
      const validatorFns: Record<string, boolean | undefined> = {};
      e.passedValidators?.forEach((v, i) => {
        validatorFns[validators[i]] = v;
      });

      // Name each input argument and make it clear which inputs were not provided
      // (i.e., the argument was optional).  Otherwise, stringify the value for
      // display.
      const inputs: Record<string, string> = {};
      e.input.forEach((i) => {
        inputs[`input: ${i.name}`] =
          i.value === undefined ? "(no input)" : JSON5.stringify(i.value);
      });

      // There are 0-1 outputs: if an output is present, just name it `output`
      // and make it clear which outputs are undefined.  Otherwise, stringify
      // the value for display.
      const outputs: Record<string, string> = {};
      e.output.forEach((o) => {
        outputs[`output`] =
          o.value === undefined ? "undefined" : JSON5.stringify(o.value);
      });
      if (e.validatorException) {
        outputs[`output`] =
          `(${e.validatorExceptionFunction} exception) ${e.validatorExceptionMessage}`;
      } else if (e.exception) {
        outputs[`output`] = "(exception) " + e.exceptionMessage;
      }
      if (e.timeout) {
        outputs[`output`] = "(timeout)";
      }

      // Toss each result into the appropriate grid
      if (e.category === "failure") {
        data[e.category].push({
          ...id,
          ...src,
          ...inputs,
          ...outputs, // Exception message contained in outputs
        });
      } else {
        data[e.category].push({
          ...id,
          ...src,
          ...inputs,
          ...outputs,
          //...elapsedTimes,
          ...passedImplicit,
          ...passedValidator,
          // ...allValidators,
          ...validatorFns,
          ...passedHuman,
          ...pinned,
          ...expectedOutput,
        });
      }
    } // for: each result

    // Fill the grids with data
    gridTypes.forEach((type) => {
      if (data[type].length) {
        const thead = getElementByIdOrThrow(`fuzzResultsGrid-${type}-thead`);
        const tbody = getElementByIdWithTypeOrThrow(
          `fuzzResultsGrid-${type}-tbody`,
          HTMLTableSectionElement
        );

        // Render the header row
        const hRow = thead.appendChild(document.createElement("tr"));
        Object.keys(data[type][0]).forEach((k) => {
          if (k === pinnedLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.classList.add(
              "colorColumn",
              "fuzzGridCellPinned",
              "clickable"
            );
            cell.id = type + "-" + pinnedLabel;
            cell.innerHTML = /* html */ `
              <span class="tooltipped tooltipped-sw" aria-label="Include in persistent test suite?">
                <span class="codicon codicon-pinned"></span>
              </span>`;
            cell.addEventListener("click", () => {
              handleColumnSort(type, k, tbody, true);
            });
          } else if (hiddenColumns.indexOf(k) !== -1) {
            // noop (hidden)
          } else if (k === implicitLabel) {
            if (resultsData.env.options.useImplicit) {
              const heuristicValidatorDescription =
                getElementByIdOrThrow("fuzz-useImplicit").children[0].ariaLabel;
              const cell = hRow.appendChild(document.createElement("th"));
              cell.id = type + "-" + implicitLabel;
              cell.classList.add("colorColumn", "clickable");
              cell.innerHTML = /* html */ `
              <span class="tooltipped tooltipped-s" aria-label="${heuristicValidatorDescription}">
                <span class="codicon codicon-debug"></span>
              </span>`;
              cell.addEventListener("click", () => {
                handleColumnSort(type, k, tbody, true);
              });
            }
          } else if (k === validatorLabel) {
            if (resultsData.env.options.useProperty) {
              // Property validator column (summary)
              const cell = hRow.appendChild(document.createElement("th"));
              cell.id = type + "-" + validatorLabel;
              cell.classList.add("colorColumn", "clickable");
              if (validators.length > 1) {
                cell.style.paddingRight = "3px"; // close to twistie column
              }
              cell.innerHTML = /* html */ `
                <span class="tooltipped tooltipped-sw" aria-label="${
                  validators.length < 2
                    ? "Property validator"
                    : "Property validator summary"
                }">
                  <span class="codicon codicon-hubot"></span>
                </span>`;
              cell.id = type + "-" + k;
              cell.addEventListener("click", () => {
                handleColumnSort(type, k, tbody, true);
              });
            } // if useProperty
          } else if (validators.indexOf(k) !== -1) {
            // Individual property validator columns and twistie columns
            if (resultsData.env.options.useProperty && validators.length > 1) {
              if (validators.indexOf(k) === 0) {
                // Twistie column with right arrow (to expand validator columns)
                const expandCell = hRow.appendChild(
                  document.createElement("th")
                );
                expandCell.innerHTML = /* html */ `
                <span class="tooltipped tooltipped-sw" aria-label="Expand">
                  <span class="codicon codicon-chevron-right"></span>
                </span>`;
                expandCell.id = type + "-" + expandLabel;
                expandCell.classList.add("expandCollapseColumn", "clickable");
                if (columnSortOrders[type][expandLabel] !== "asc") {
                  // asc = columns currently hidden; !asc = columns currently expanded
                  expandCell.classList.add("hidden"); // hide if currently expanded
                }
                expandCell.addEventListener("click", () => {
                  toggleExpandColumn(type);
                });
              }
              // Individual property validator column
              const cell = hRow.appendChild(document.createElement("th"));
              cell.classList.add("colorColumn", "clickable");
              cell.innerHTML = /* html */ `
                <span class="tooltipped tooltipped-sw" aria-label="${k}">
                  <span class="codicon codicon-hubot" style="font-size: 1em;"></span> <!-- small -->
                </span>`;
              cell.id = type + "-" + k;
              cell.style.paddingLeft = "0px";
              cell.style.paddingRight = "0px";
              if (validators.indexOf(k) === 0) {
                // add padding to first custom validator header cell
                cell.style.paddingLeft = "16px";
                cell.style.paddingRight = "6px";
              }
              if (columnSortOrders[type][expandLabel] === "asc") {
                cell.classList.add("hidden"); // hide individual validators if currently collapsed
              }
              cell.addEventListener("click", () => {
                handleColumnSort(type, k, tbody, true);
              });
              if (validators.indexOf(k) === validators.length - 1) {
                // Twistie column with left arrow (to collapse validator columns)
                const collapseCell = hRow.appendChild(
                  document.createElement("th")
                );
                collapseCell.innerHTML = /* html */ `
                <span class="tooltipped tooltipped-sw" aria-label="Collapse">
                  <span class="codicon codicon-chevron-left" style=""></span>
                </span>`;
                if (columnSortOrders[type][expandLabel] === "asc") {
                  collapseCell.classList.add("hidden");
                }
                collapseCell.id = type + "-" + collapseLabel;
                collapseCell.classList.add("expandCollapseColumn", "clickable");
                collapseCell.addEventListener("click", () => {
                  toggleExpandColumn(type);
                });
              }
            } // if useProperty and multiple validators
          } else if (k === correctLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.classList.add("colorColumn", "clickable");
            cell.id = type + "-" + correctLabel;
            cell.innerHTML = /* html */ `
              <span class="tooltipped tooltipped-sw" aria-label="Human validator">
                <span class="codicon codicon-person" id="humanIndicator"></span>
              </span>`;
            cell.colSpan = 2;
            cell.addEventListener("click", () => {
              handleColumnSort(type, k, tbody, true);
            });
          } else if (k === srcLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            const label = k;
            cell.id = type + "-" + k;
            cell.classList.add("clickable", `tableCol-${k.replace(" ", "")}`);
            cell.innerHTML = /*html*/ `
              <span class="tooltipped tooltipped-se" aria-label="Input source: Random, Mutation, AI, User">
                <strong>${htmlEscape(label)}</strong>
              </span>`;
            cell.addEventListener("click", () => {
              handleColumnSort(type, k, tbody, true);
            });
          } else {
            const cell = hRow.appendChild(document.createElement("th"));
            const label =
              type === "failure" && k === "output" ? "exception" : k;
            cell.id = type + "-" + k;
            cell.classList.add("clickable", `tableCol-${k.replace(" ", "")}`);
            cell.innerHTML = `<strong>${htmlEscape(label)}</strong>`;
            cell.addEventListener("click", () => {
              handleColumnSort(type, k, tbody, true);
            });
          }
        }); // for each column k

        // Initial sort, according to columnSortOrders
        const cols = Object.keys(data[type][0]);
        for (let i = 0; i < Object.keys(data[type][0]).length; ++i) {
          const col = cols[i]; // back-end column
          const cell = document.getElementById(type + "-" + col); // front-end column
          if (!(col in hiddenColumns) && cell !== null) {
            if (!(cell instanceof HTMLTableCellElement)) {
              throw new Error("cell not HTMLTableCellElement");
            }
            // Only sort if a sort order is set for this column
            const sortOrder = columnSortOrders[type][col];
            if (
              sortOrder === FuzzSortOrder.asc ||
              sortOrder === FuzzSortOrder.desc
            ) {
              handleColumnSort(type, col, tbody, false);
            }
          }
        } // for i

        // Sorting complete: render the table body
        drawTableBody({ type, tbody, isClicking: false });
      } // if data[type].length
    }); // for each type (e.g. bad output, passed)

    // If we need to toast a result, do that now
    const toastResultElement = document.getElementById("fuzzFocusInput");
    if (toastResultElement) {
      const toastResult: unknown = JSON5.parse(
        htmlUnescape(toastResultElement.innerHTML)
      );
      if (
        Array.isArray(toastResult) &&
        toastResult.length === 2 &&
        typeof toastResult[0] === "string" &&
        typeof toastResult[1] === "number"
      ) {
        scrollAndToastResult(
          toastResult[1].toString(),
          `tab-${toastResult[0]}`,
          "Input added and tested"
        );
      } else {
        throw new Error(
          `Command to toast result ${JSON5.stringify(toastResult)} is invalid.`
        );
      }
    }
  } // if we have results data
} // fn: main()

/**
 * Toggles whether more fuzzer options are shown.
 */
function toggleFuzzOptions() {
  toggleHidden(getElementByIdOrThrow("fuzzOptions"));
  toggleHidden(getElementByIdOrThrow("fuzz.options.open"));
  toggleHidden(getElementByIdOrThrow("fuzz.options.close"));

  // Refresh the list of validators
  handleGetListOfValidators();
} // fn: toggleFuzzOptions()

/**
 * Toggles whether add test case options are shown.
 */
function toggleAddTestInputOptions() {
  toggleHidden(getElementByIdOrThrow("fuzz.addTestInputOptions.open"));
  toggleHidden(getElementByIdOrThrow("fuzz.addTestInputOptions.close"));

  const fuzzAddTestInputOptionsPane = getElementByIdOrThrow(
    "fuzzAddTestInputOptions-pane"
  );
  if (isHidden(fuzzAddTestInputOptionsPane)) {
    toggleHidden(fuzzAddTestInputOptionsPane);
    getElementByIdOrThrow("addInputArg-0-value").focus();
  } else {
    toggleHidden(fuzzAddTestInputOptionsPane);
  }
} // fn: toggleAddTestInputOptions

/**
 * Add custom test input to the test results table.
 */
function handleAddTestInput() {
  const overrides = getConfigFromUi();
  overrides.input = getInputValues();

  // Return if the inputs are unavaiable
  if (!overrides.input) {
    return;
  }

  // Only call the fuzzer if the input is not already in the grid
  const tick = resultsData.results.findIndex(
    (r) =>
      JSON5.stringify(r.input.map((i) => i.value)) ===
      JSON5.stringify(overrides.input?.map((i) => i.value))
  );
  if (tick === -1) {
    // Call the extension to test this one input
    const message: FuzzPanelMessageFromWebView = {
      command: "fuzz.addTestInput",
      json: JSON5.stringify(overrides),
    };
    vscode.postMessage(message);
  } else {
    // Input already in the grid. Hide the add input pane.
    toggleAddTestInputOptions();

    // Switch to the tab containing the value, scroll, and toast
    scrollAndToastResult(
      tick.toString(),
      `tab-${resultsData.results[tick].category}`,
      "Input previously added &amp; tested"
    );
  }
} // fn: handleAddTestInputCase

/**
 * Gets a single input value.
 *
 * Note: Also maintains the error state of the input fields.
 *
 * @returns an `ArgValueTypeWrapped` if successful, undefined otherwise
 */
function getInputValues(): ArgValueTypeWrapped[] | undefined {
  const inputs: ArgValueTypeWrapped[] = [];
  let errors = false;

  for (let i = 0; document.getElementById(`addInputArg-${i}-value`); i++) {
    const e = getElementByIdOrThrow(`addInputArg-${i}-value`);
    const message = getElementByIdOrThrow(`addInputArg-${i}-message`);
    const unparsedValue = e.getAttribute("current-value");
    try {
      e.classList.remove("classErrorCell");
      message.classList.remove("expectedOutputErrorMessage");
      message.innerHTML = "";
      // Attempt to parse & add the input value
      inputs.push({
        tag: "ArgValueTypeWrapped",
        value:
          unparsedValue === null ||
          unparsedValue === "undefined" ||
          unparsedValue === ""
            ? undefined
            : JSON5.parse(unparsedValue),
      });
    } catch (err) {
      // Error feedback
      e.classList.add("classErrorCell");
      message.classList.add("expectedOutputErrorMessage");
      message.innerHTML = " (invalid value)";
      errors = true;
    }
  }

  const testButton = getElementByIdOrThrow("fuzz.addTestInput");
  if (errors) {
    testButton.setAttribute("disabled", "true");
    return undefined;
  } else {
    testButton.removeAttribute("disabled");
    return inputs;
  }
} // fn: getInputValue

/**
 * Scrolls to a particular id and switches tabs if needed.
 *
 * @param `id` element id to scroll to
 * @param `tab` optional tab id to switch to
 */
function scrollAndToastResult(
  id: string,
  tabId?: string,
  message?: string
): void {
  setTimeout(async () => {
    // click the tab if needed
    if (tabId) {
      getElementByIdOrThrow(tabId).click();
    }
    setTimeout(async () => {
      const focusRow = getElementByIdOrThrow(id);

      // Scroll to the row
      focusRow.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });

      setTimeout(async () => {
        // Throb the row
        focusRow.classList.add("focus");
        setTimeout(async () => {
          focusRow.classList.remove("focus");
        }, 4000);

        // If we have a message, show it on a snackbar
        if (message) {
          setTimeout(async () => {
            // Create the snackbar
            const snackbarRoot = getElementByIdOrThrow("snackbarRoot");
            const snackbar = document.createElement("div");
            snackbar.classList.add("snackbar");
            snackbarRoot.parentElement?.append(snackbar);

            // Add the message
            snackbar.innerHTML = `<big>${message}</big>`;

            // Position the snackbar above the row & display it
            const focusRowTop =
              focusRow.getBoundingClientRect().top + window.scrollY;
            snackbar.style.top = `${focusRowTop - snackbar.clientHeight - 5}px`;
            snackbar.classList.add("snackbarShow");

            // Remove the snackbar after 4s
            setTimeout(async () => {
              snackbar.remove();
            }, 4000);
          });
        }
      });
    });
  });
} // scrollAndToast

/**
 * Toggles whether interesting inputs are shown
 */
function toggleInterestingInputs(): void {
  toggleHidden(getElementByIdOrThrow("fuzz.options.interesting.inputs.show"));
  toggleHidden(getElementByIdOrThrow("fuzz.options.interesting.inputs.hide"));
  toggleHidden(getElementByIdOrThrow("fuzz.options.interesting.inputs"));
} // fn: toggleInterestingInputs

/**
 * Sets whether the argument should generate inputs
 *
 * @param vsCodeCheckbox the checkbox that was clicked
 * @param isChecked whether the checkbox is checked
 */
function setIsNoInput(vsCodeCheckbox: Element, isChecked: boolean) {
  const checkboxWrapper = vsCodeCheckbox.parentElement;
  if (!checkboxWrapper || !(checkboxWrapper instanceof HTMLDivElement)) {
    throw new Error("invalid checkboxWrapper");
  }
  const thisArg = vsCodeCheckbox.parentElement.parentElement;
  if (!thisArg) {
    throw new Error("invalid thisArg");
  }

  // Fade/un-fade the arg (except the checkbox wrapper)
  thisArg.querySelectorAll(":scope > div").forEach((child: Element) => {
    if (child !== checkboxWrapper) {
      if (isChecked) {
        child.classList.remove("faded");
      } else {
        child.classList.add("faded");
      }
    }
  });
  // Hide/Show the arg settings
  thisArg
    .querySelectorAll(
      ":scope > .argDef-type, :scope > .argDef-array, :scope > .argDef-preClose"
    )
    .forEach((child: Element) => {
      (isChecked ? show : hide)(child);
    });
  // Hide/Show the ellipsis
  thisArg
    .querySelectorAll(":scope > .argDef-name > .argDef-ellipsis")
    .forEach((child: Element) => {
      (isChecked ? hide : show)(child);
    });
} // fn: setIsNoInput()

/**
 * Toggles whether a test is pinned for CI and the next test run.
 *
 * @param id offset of test in resultsData
 * @param type grid type (e.g., passed, invalid)
 * @param data the back-end data structure
 */
function handlePinToggle(id: number, type: FuzzResultCategory) {
  const index = data[type].findIndex((element) => element.id === id);
  if (index <= -1) throw new Error("invalid id");

  // Get the control that was clicked
  const button = getElementByIdWithTypeOrThrow(
    `fuzzSaveToggle-${id}`,
    HTMLTableCellElement
  );

  // Are we pinning or unpinning the test?
  const pinning = button.innerHTML === pinState.htmlPin;
  data[type][index][pinnedLabel] = pinning;

  // Get the test data for the test case
  const testCase: FuzzPinnedTest = {
    input: resultsData.results[id].input,
    output: resultsData.results[id].output,
    pinned: data[type][index][pinnedLabel],
  };
  if (data[type][index][expectedLabel]) {
    testCase.expectedOutput = data[type][index][expectedLabel];
  }

  // Send the request to the extension
  const msg: FuzzPanelPinMessage = {
    id,
    test: testCase,
  };
  window.setTimeout(() => {
    const message: FuzzPanelMessageFromWebView = {
      command: pinning ? "test.pin" : "test.unpin",
      json: JSON5.stringify(msg),
    };
    vscode.postMessage(message);

    // Update the control state
    if (pinning) {
      button.innerHTML = pinState.htmlPinned;
      button.className = pinState.classPinned;
      button.setAttribute("aria-label", "pinned");
    } else {
      button.innerHTML = pinState.htmlPin;
      button.className = pinState.classPin;
      button.setAttribute("aria-label", "pin");
    }
  });
} // fn: handlePinToggle()

/**
 * Toggles the correct icons on or off (check mark, X mark, question mark).
 *
 * @param button icon that was clicked
 * @param row current row
 * @param type e.g. bad output, passed
 * @param tbody table body for 'type'
 * @param cell1 check icon
 * @param cell2 error icon
 */
function handleCorrectToggle(
  button: HTMLTableCellElement,
  row: HTMLTableRowElement,
  type: FuzzResultCategory,
  tbody: HTMLTableSectionElement,
  cell1: HTMLTableCellElement,
  cell2: HTMLTableCellElement
) {
  const idStr = row.getAttribute("id");
  if (idStr === null) {
    throw new Error("no id");
  }
  const id = parseInt(idStr, 10);
  const index = data[type].findIndex((element) => element.id === id);
  if (index <= -1) throw new Error("invalid id");

  // Change the state of the correct icon that was clicked
  // Only one icon should be selected at a time; if an icon is turned on, all
  // others should be turned off
  if (button.classList.contains(correctState.classCheckOn)) {
    // clicking check off
    button.className = correctState.classCheckOff;
    button.setAttribute("onOff", "false");
    data[type][index][correctLabel] = undefined;
    // delete saved expected value
    delete data[type][index][expectedLabel];
  } else if (button.classList.contains(correctState.classErrorOn)) {
    // clicking error off
    button.className = correctState.classErrorOff;
    button.setAttribute("onOff", "false");
    data[type][index][correctLabel] = undefined;
    // delete saved expected value
    delete data[type][index][expectedLabel];
  } else if (button.classList.contains(correctState.classCheckOff)) {
    // clicking check on
    button.className = correctState.classCheckOn;
    button.setAttribute("onOff", "true");
    data[type][index][correctLabel] = "true";
    // turn others off
    cell2.className = correctState.classErrorOff;
    cell2.setAttribute("onOff", "false");
    //save expected output value
    if (resultsData.results[id].timeout) {
      data[type][index][expectedLabel] = [
        { name: "0", offset: 0, isTimeout: true },
      ];
    } else if (resultsData.results[id].exception) {
      data[type][index][expectedLabel] = [
        { name: "0", offset: 0, isException: true },
      ];
    } else {
      data[type][index][expectedLabel] = resultsData.results[id].output;
    }
  } else if (button.classList.contains(correctState.classErrorOff)) {
    // clicking error on
    button.className = correctState.classErrorOn;
    button.setAttribute("onOff", "true");
    data[type][index][correctLabel] = "false";
    // turn others off
    cell1.className = correctState.classCheckOff;
    cell1.setAttribute("onOff", "false");
    // save expected output value
    data[type][index][expectedLabel] = resultsData.results[id].output;
  }

  // Redraw table
  drawTableBody({ type, tbody, isClicking: true, button });

  // Get the pinned state
  const isPinned = getElementByIdWithTypeOrThrow(
    `fuzzSaveToggle-${id}`,
    HTMLTableCellElement
  ).classList.contains(pinState.classPinned);

  // Build the test case for the back-end
  const msg: FuzzPanelPinMessage = {
    id,
    test: {
      input: resultsData.results[id].input,
      output: resultsData.results[id].output,
      pinned: isPinned,
      expectedOutput: data[type][index][expectedLabel],
    },
  };

  // Send the request to the extension
  window.setTimeout(() => {
    const message: FuzzPanelMessageFromWebView = {
      command: isPinned ? "test.pin" : "test.unpin",
      json: JSON5.stringify(msg),
    };
    vscode.postMessage(message);
  });
} // fn: handleCorrectToggle

/**
 * Toggles the property validator expand and collapse options
 *
 * @param `type` grid type (`FuzzResultcategory`)
 */
function toggleExpandColumn(type: FuzzResultCategory) {
  const thead = getElementByIdWithTypeOrThrow(
    `fuzzResultsGrid-${type}-thead`,
    HTMLTableSectionElement
  );
  const tbody = getElementByIdWithTypeOrThrow(
    `fuzzResultsGrid-${type}-tbody`,
    HTMLTableSectionElement
  );

  const valIdx = getIdxInTableHeader(type + "-" + validators[0], thead.rows[0]); // idx of first custom validator in table header

  // Show or hide custom validator fn header
  for (const valName of validators) {
    toggleHidden(getElementByIdOrThrow(type + "-" + valName));
  }
  // Show or hide custom validator table cells
  for (const row of Array.from(tbody.rows)) {
    if (row.getAttribute("class") === "classErrorExpectedOutputRow") continue;
    for (let i = valIdx; i < valIdx + validators.length; ++i) {
      toggleHidden(row.cells[i]); // custom validator cell
    }
    toggleHidden(row.cells[valIdx - 1]); // expand column cell
    toggleHidden(row.cells[valIdx + validators.length]); // collapse column cell
  }

  // Show or hide twistie column headers (expand, collapse)
  toggleHidden(getElementByIdOrThrow(type + "-" + expandLabel));
  toggleHidden(getElementByIdOrThrow(type + "-" + collapseLabel));

  // Send message to extension to retain whether columns are expanded or hidden
  columnSortOrders[type][expandLabel] =
    columnSortOrders[type][expandLabel] === "desc"
      ? FuzzSortOrder.asc
      : FuzzSortOrder.desc;
  const message: FuzzPanelMessageFromWebView = {
    command: "columns.sorted",
    json: JSON5.stringify(columnSortOrders),
  };
  vscode.postMessage(message);
} // fn: toggleExpandColumn

/**
 * Syncs the tabs and panels so that only the pane for the
 * selected tab is shown. are displaying
 *
 * @param `clickedTab` the tab clicked
 */
function syncResultsTabsAndPanels(
  gridTabStrip: Element,
  gridTabs: NodeListOf<Element>,
  clickedTab: Element
) {
  lastResultsTabClicked = clickedTab;
  lastResultsTableShown = undefined;

  const gridPanels = document.querySelectorAll(`.fuzzResults .fuzzGridPanel`);
  gridTabStrip.setAttribute("activeId", clickedTab.id);
  gridTabs.forEach((tab) => {
    tab.setAttribute(
      "aria-selected",
      clickedTab.id === tab.id ? "true" : "false"
    );
  });
  const viewId = clickedTab.id.replace("tab-", "view-");
  const gridId = clickedTab.id.replace("tab-", "fuzzResultsGrid-");
  gridPanels.forEach((panel) => {
    if (panel.id === viewId) {
      show(panel);
      const table = document.querySelector(`#${gridId} table`);
      if (table) {
        lastResultsTableShown = table;
        // Bounce to set the tabstrip width to be the same as the visible table after the redraw
        window.setTimeout(() => {
          syncTabStripWidth(gridTabStrip, table);
        });
      }
    } else {
      hide(panel);
    }
  });
} // fn: syncResultsTabsAndPanels

/**
 * Sets the tabstrip width to be the same as a grid table
 *
 * @param `tabStrip` Tabstrip element to resize
 * @param `activeTable` Active grid table
 */
function syncTabStripWidth(tabStrip: Element, activeTable: Element) {
  tabStrip.setAttribute(
    "style",
    `width: ${activeTable.getBoundingClientRect().width}px; overflow-x: visible;`
  );
} // fn: syncTabStripWidth

/**
 * Sorts table based on a column (each column toggles between asc, desc, none).
 * The most recent column clicked has the highest precedence.
 * Uses stable sort, so previously sorted rows will not change unless they have to.
 *
 * @param `type`` (timeout, exception, badValue, ok, etc.)
 * @param `column` (ex: input:a, output, pin)
 * @param `tbody` table body
 * @param `isClicking` true if user clicked a column; false if an 'initial sort'
 */
function handleColumnSort(
  type: FuzzResultCategory, // tab
  column: string, // back-end column
  tbody: HTMLTableSectionElement, // front-end table for tab
  isClicking: boolean // true=user clicked on the sort button
) {
  // If the user clicked a column, updating the sort for that column
  if (isClicking) {
    updateSortOrders(type, column);
  }

  // Update the front-end column arrows
  updateColumnArrows(type);

  // Define sorting function:
  // Sort current column value based on sort order
  const sortFn = (a: any, b: any, thisCol: string) => {
    const sortOrder = columnSortOrders[type][thisCol];
    if (sortOrder !== FuzzSortOrder.desc && sortOrder !== FuzzSortOrder.asc) {
      return 0; // no need to sort
    } else if (sortOrder === FuzzSortOrder.desc) {
      const temp = a;
      a = b;
      b = temp; // swap a and b
    }
    // Determine type of object
    let aType;
    try {
      aType = typeof JSON.parse(a[thisCol]);
    } catch (error) {
      aType = "string";
    }
    // Save original strings (to break ties alphabetically)
    let aVal = (a[thisCol] ?? "undefined") + "";
    let bVal = (b[thisCol] ?? "undefined") + "";

    // How are we sorting?
    if (thisCol === correctLabel || thisCol === validatorLabel) {
      // Sort by numerical values in validatorResult map.
      const aId = (a[thisCol] ?? "undefined") + "";
      const bId = (b[thisCol] ?? "undefined") + "";
      if (aId !== "true" && aId !== "false" && aId !== "undefined") {
        throw new Error(`Invalid validator result: ${aId}`);
      }
      if (bId !== "true" && bId !== "false" && bId !== "undefined") {
        throw new Error(`Invalid validator result: ${bId}`);
      }
      a = validatorResult[aId];
      b = validatorResult[bId];
    } else {
      switch (aType) {
        case "number":
          // Sort numerically
          a = Number(a[thisCol]);
          b = Number(b[thisCol]);
          break;
        case "object":
          // Sort by length
          if (a[thisCol].length) {
            a = a[thisCol].length;
            b = b[thisCol].length;
            // If numerical values, break ties based on number
            try {
              aVal = JSON.parse(a[thisCol]);
              bVal = JSON.parse(b[thisCol]);
            } catch (error) {
              // noop; if not numerical, break ties alphabetically
            }
          } else {
            a = Object.keys(a[thisCol]).length;
            b = Object.keys(b[thisCol]).length;
          }
          break;
        default:
          // Sort as string by length, break ties alphabetically
          a = (a[thisCol] ?? "").length;
          b = (b[thisCol] ?? "").length;
          break;
      } // switch
    }
    // Compare values and sort
    if (a === b) {
      if (aVal === bVal) {
        return 0; // a = b
      } else if (aVal > bVal) {
        return 2; // break tie
      } else {
        return -2; // break tie
      }
    } else if (a > b) {
      return 2; // a > b
    } else {
      return -2; // a < b
    }
  }; // fn: sortFn()

  // Call sorting function:
  // Sort data in order of sort columns (next col is tiebreaker for current col)
  data[type].sort((a, b) => {
    for (const col of Object.keys(columnSortOrders[type])) {
      const result = sortFn(a, b, col);
      if (result !== 0) return result;
    }
    return 0; // a = b for all columns
  });

  // If sorting was user-initiated, re-render table contents
  // and send message to extension to persist the sort order
  if (isClicking) {
    drawTableBody({ type, tbody, isClicking: false });

    const message: FuzzPanelMessageFromWebView = {
      command: "columns.sorted",
      json: JSON5.stringify(columnSortOrders),
    };
    vscode.postMessage(message);
  }
} // fn: handleColumnSort

/**
 * Respond to a user clicking a column by updating the column sort orders
 *
 * @param `type` (timeout, exception, badValue, ok)
 * @param `thisCol` the current column being sorted by
 */
function updateSortOrders(type: FuzzResultCategory, thisCol: string) {
  // Update sorting direction for the clicked column
  // Note: a missing column sort means "none"
  switch (
    thisCol in columnSortOrders[type]
      ? columnSortOrders[type][thisCol]
      : FuzzSortOrder.none
  ) {
    case FuzzSortOrder.asc:
      columnSortOrders[type][thisCol] = FuzzSortOrder.desc;
      break;
    case FuzzSortOrder.desc:
      delete columnSortOrders[type][thisCol]; // not present, meaning "none"
      break;
    default:
      columnSortOrders[type][thisCol] = FuzzSortOrder.asc;
  }
} // fn: updateSortOrders

/**
 * Updates front-end column headings to match the current sort order
 *
 * @param `type` (timeout, exception, badValue, ok, etc.)
 */
function updateColumnArrows(type: FuzzResultCategory) {
  // Get the front-end column names
  const cols = Object.keys(data[type][0]);

  // Loop over the columns and update the arrows
  for (let i = 0; i < Object.keys(data[type][0]).length; ++i) {
    const col = cols[i]; // back-end column
    const cell = document.getElementById(type + "-" + col); // front-end column

    // Only process front-end columns
    if (cell !== null) {
      cell.classList.remove(
        "columnSortAsc",
        "columnSortDesc",
        "columnSortAscSmall",
        "columnSortDescSmall"
      );

      // A missing sort order means "none"
      const thisColSort =
        col in columnSortOrders[type]
          ? columnSortOrders[type][col]
          : FuzzSortOrder.none;

      // Add the appropriate arrow (small arrows for property validator columns)
      if (thisColSort !== FuzzSortOrder.none) {
        cell.classList.add(
          `columnSort${thisColSort === FuzzSortOrder.asc ? "Asc" : "Desc"}${validators.indexOf(col) === -1 ? "" : "Small"}`
        );
      }
    } // if
  } // for i
} // fn: updateColumnArrows

/**
 * Draw table body and fill in with values from data[type]. Add event listeners
 * for pinning, toggling correct icons
 *
 * @param `type` e.g. bad output, passed, etc
 * @param `tbody` table body element
 * @param `isClicking` bool `true` if user is clicking
 */
function drawTableBody({
  type,
  tbody,
  isClicking,
  button,
}: {
  type: FuzzResultCategory;
  tbody: HTMLTableSectionElement;
} & (
  | { isClicking: true; button: HTMLElement }
  | { isClicking: false; button?: undefined }
)) {
  // Clear table
  tbody.innerHTML = "";

  // For each entry in data[type]
  data[type].forEach((e) => {
    let id = -1;
    const row = tbody.appendChild(document.createElement("tr"));
    Object.keys(e).forEach((k) => {
      if (k === pinnedLabel) {
        const cell = row.appendChild(document.createElement("td"));
        // Add pin icon
        cell.className = e[k] ? pinState.classPinned : pinState.classPin;
        cell.classList.add("clickable");
        cell.id = `fuzzSaveToggle-${id}`;
        cell.setAttribute("aria-label", e[k] ? "pinned" : "pin");
        cell.innerHTML = e[k] ? pinState.htmlPinned : pinState.htmlPin;
        cell.addEventListener("click", (e) => {
          const currentTarget = e.currentTarget;
          if (
            currentTarget === null ||
            !("parentElement" in currentTarget) ||
            !currentTarget.parentElement ||
            !(currentTarget.parentElement instanceof HTMLElement)
          ) {
            throw new Error("Invalid event target");
          }
          const idStr = currentTarget.parentElement.getAttribute("id");
          if (idStr === null || isNaN(parseInt(idStr))) {
            throw new Error("Invalid event target");
          }
          handlePinToggle(parseInt(idStr), type);
        });
      } else if (k === idLabel) {
        id = parseInt(e[k]);
        row.setAttribute("id", `${id}`);
      } else if (hiddenColumns.indexOf(k) !== -1) {
        // noop (hidden)
      } else if (k === implicitLabel) {
        if (resultsData.env.options.useImplicit) {
          const cell = row.appendChild(document.createElement("td"));
          const span = cell.appendChild(document.createElement("span"));
          // Fade the indicator if overridden by another validator
          if (
            e[correctLabel] !== undefined ||
            e[validatorLabel] !== undefined
          ) {
            span.classList.add("overridden");
          }
          if (e[k] === undefined) {
            span.innerHTML = "";
          } else if (e[k]) {
            cell.classList.add("classCheckOn", "colGroupStart", "colGroupEnd");
            span.classList.add("codicon", "codicon-pass");
            span.setAttribute("title", "passed");
          } else {
            cell.classList.add("classErrorOn", "colGroupStart", "colGroupEnd");
            span.classList.add("codicon", "codicon-error");
            span.setAttribute("title", "failed");
          }
        }
      } else if (k === validatorLabel) {
        if (resultsData.env.options.useProperty) {
          // Property validator column (summary)
          const cell = row.appendChild(document.createElement("td"));
          if (validators.length > 1) {
            cell.style.paddingRight = "0px"; // close to twistie column if multiple validators
          }
          if (e[k] === undefined) {
            cell.classList.add("classUnknown", "colGroupStart", "colGroupEnd");
            const span = cell.appendChild(document.createElement("span"));
            span.classList.add("codicon", "codicon-circle-large");
            span.setAttribute("title", "undecided");
          } else if (e[k]) {
            cell.classList.add("classCheckOn", "colGroupStart", "colGroupEnd");
            const span = cell.appendChild(document.createElement("span"));
            span.classList.add("codicon", "codicon-pass");
            span.setAttribute("title", "passed");
          } else {
            cell.classList.add("classErrorOn", "colGroupStart", "colGroupEnd");
            const span = cell.appendChild(document.createElement("span"));
            span.classList.add("codicon", "codicon-error");
            span.setAttribute("title", "failed");
          }
        } // if useProperty
      } else if (validators.indexOf(k) !== -1) {
        // Individual validator columns and twistie columns
        if (resultsData.env.options.useProperty && validators.length > 1) {
          if (validators.indexOf(k) === 0) {
            // Empty cell for twistie column (expand)
            const emptyCell = row.appendChild(document.createElement("td"));
            emptyCell.classList.add("expandCollapseColumn");
            if (columnSortOrders[type][expandLabel] !== "asc") {
              emptyCell.classList.add("hidden"); // hide if currently expanded
            }
          }
          // Individual property validator column
          const cell = row.appendChild(document.createElement("td"));
          const span = cell.appendChild(document.createElement("span"));
          cell.style.textAlign = "right";
          if (e[k] === undefined || e[k] === null) {
            cell.classList.add("classUnknown", "colGroupStart", "colGroupEnd");
            span.classList.add("codicon", "codicon-circle-large");
            span.setAttribute("title", "undecided");
          } else if (e[k]) {
            cell.classList.add("classCheckOn", "colGroupStart", "colGroupEnd");
            span.classList.add("codicon", "codicon-pass", "overridden"); // Fade check mark for passed tests
            span.setAttribute("title", "passed");
          } else {
            cell.classList.add("classErrorOn", "colGroupStart", "colGroupEnd");
            span.classList.add("codicon", "codicon-error");
            span.setAttribute("title", "failed");
          }
          if (columnSortOrders[type][expandLabel] === "asc") {
            cell.classList.add("hidden"); // hide individual validator columns if currently collapsed
          } else {
            cell.classList.remove("hidden"); // show individual validator columns if currently expanded
          }
          if (validators.indexOf(k) === validators.length - 1) {
            // Empty cell for twistie column (collapse)
            const emptyCell = row.appendChild(document.createElement("td"));
            if (columnSortOrders[type][expandLabel] === "asc") {
              emptyCell.classList.add("hidden"); // hide if currently collapsed
            }
          }
        } // if useProperty and multiple validators
      } else if (k === correctLabel) {
        // Add check mark icon
        const cell1 = row.appendChild(document.createElement("td"));
        cell1.innerHTML = correctState.htmlCheck;
        cell1.setAttribute("correctType", "true");
        cell1.className = correctState.classCheckOff; // updated below
        cell1.setAttribute("onOff", "false"); // updated below

        // Add X mark icon
        const cell2 = row.appendChild(document.createElement("td"));
        cell2.innerHTML = correctState.htmlError;
        cell2.setAttribute("correctType", "false");
        cell2.className = correctState.classErrorOff; // updated below
        cell2.setAttribute("onOff", "false"); // updated below

        // Add event listeners
        cell1.addEventListener("click", () => {
          handleCorrectToggle(cell1, row, type, tbody, cell1, cell2);
        });
        cell2.addEventListener("click", () => {
          handleCorrectToggle(cell2, row, type, tbody, cell1, cell2);
        });

        // Update the front-end buttons to match the back-end state
        switch (e[k] + "") {
          case undefined:
            break;
          case "true":
            cell1.className = correctState.classCheckOn;
            cell1.setAttribute("onOff", "true");
            handleExpectedOutput({
              type,
              row,
              tbody,
              ...(isClicking ? { isClicking, button } : { isClicking }),
            });
            break;
          case "false":
            cell2.className = correctState.classErrorOn;
            cell2.setAttribute("onOff", "true");
            handleExpectedOutput({
              type,
              row,
              tbody,
              ...(isClicking ? { isClicking, button } : { isClicking }),
            });
            break;
        }
        cell1.classList.add("colGroupStart", "clickable");
        cell2.classList.add("colGroupEnd", "clickable");
      } else {
        const cell = row.appendChild(document.createElement("td"));
        cell.classList.add(
          `tableCol-${k.replace(" ", "")}`,
          `editorFont`,
          `preWrap`
        );
        if (e[k] === "(no input)") {
          cell.classList.add("noInput");
        }
        cell.textContent = e[k];
      }
    });
  });
} //fn: drawTableBody()

/**
 * Checks if actual output matches expected output (based on correct icons selected).
 * If not, shows error message.
 * Assumes that either the check or error icon is selected.
 *
 * @param type e.g. bad output, passed
 * @param row row of tbody
 * @param tbody table body for 'type'
 */
function handleExpectedOutput({
  type,
  row,
  tbody,
  isClicking,
  button,
}: {
  type: FuzzResultCategory;
  row: HTMLTableRowElement;
  tbody: HTMLTableSectionElement;
} & (
  | { isClicking: true; button: HTMLElement }
  | { isClicking: false; button?: undefined }
)) {
  const idStr = row.getAttribute("id");
  if (idStr === null) {
    throw new Error("no id");
  }
  const id = parseInt(idStr, 10);
  let toggledId;
  if (isClicking) {
    if (!button.parentElement) {
      throw new Error("no parent element");
    }
    const toggledIdStr =
      button.parentElement.getAttribute("id") ?? // human validation X button
      button.getAttribute("rowId"); // expected value edit button
    if (toggledIdStr !== null) {
      toggledId = parseInt(toggledIdStr);
    }
  }

  const index = data[type].findIndex((element) => {
    return element.id === id;
  });
  if (index <= -1) {
    throw new Error("invalid id");
  }
  const correctType = data[type][index][correctLabel];
  const numInputs = resultsData.results[id].input.length;

  // If actual output does not match expected output, show expected/actual output
  if (correctType + "" === "false") {
    const expectedRow = row.insertAdjacentElement(
      "afterend",
      document.createElement("tr")
    );
    if (expectedRow === null) {
      throw new Error("failed to create expected row");
    }
    const cell = expectedRow.appendChild(document.createElement("td"));
    cell.colSpan = getColCountForTable(type);

    if (isClicking && id === toggledId) {
      // If marked X and it's the row being clicked on, ask for expected output
      expectedRow.className = "classGetExpectedOutputRow";
      cell.innerHTML = expectedOutputHtml(id, index, type);

      // Event handler for text field
      const textField = getElementByIdOrThrow(`fuzz-expectedOutput${id}`);
      textField.addEventListener("change", () => {
        buildExpectedTestCase(id, type, index);
      });

      // Event handler for timeout radio button
      const radioTimeout = getElementByIdOrThrow(`fuzz-radioTimeout${id}`);
      radioTimeout.addEventListener("change", () =>
        buildExpectedTestCase(id, type, index)
      );

      // Event handler for exception radio button
      const radioException = getElementByIdOrThrow(`fuzz-radioException${id}`);
      radioException.addEventListener("change", () =>
        buildExpectedTestCase(id, type, index)
      );

      // Event handler for value radio button
      const radioValue = getElementByIdOrThrow(`fuzz-radioValue${id}`);
      radioValue.addEventListener("change", () => {
        if ("checked" in radioValue && radioValue.checked) {
          show(textField);
        } else {
          hide(textField);
        }
        buildExpectedTestCase(id, type, index);
      });

      // Event handler for ok button
      const okButton = getElementByIdOrThrow(`fuzz-expectedOutputOk${id}`);
      okButton.addEventListener("click", () => {
        // Build the test case from the expected output panel
        const testCase = buildExpectedTestCase(id, type, index);

        // If the test case is valid, save it & exit the screen
        if (testCase) {
          // Update the front-end data structure
          data[type][index][expectedLabel] = testCase.expectedOutput;

          // Back-end message
          const msg: FuzzPanelPinMessage = {
            id,
            test: testCase,
          };

          // Send the test case to the back-end
          window.setTimeout(() => {
            const message: FuzzPanelMessageFromWebView = {
              command: "test.pin",
              json: JSON5.stringify(msg),
            };
            vscode.postMessage(message);
          });

          // Re-draw the expected output row again
          handleExpectedOutput({ type, row, tbody, isClicking: false });

          // Hide this panel that is collecting the expected output
          expectedRow.remove();
        }
      });

      // Bounce & give focus to the value field if the value radio is selected
      window.setTimeout(() => {
        if ("checked" in radioValue && radioValue.checked) {
          textField.focus();
        }
      });
    } else {
      // Marked X but not currently being edited; display expected output
      row.cells[numInputs + 1].className = "classErrorCell"; // red wavy underline
      expectedRow.className = "classErrorExpectedOutputRow";

      // Display the expected outout
      const expectedOutput = data[type][index][expectedLabel];
      let expectedText;
      if (expectedOutput && expectedOutput.length) {
        if (expectedOutput[0].isTimeout) {
          expectedText = "timeout";
        } else if (expectedOutput[0].isException) {
          expectedText = "exception";
        } else {
          // expectedText = `output value: ${JSON5.stringify(expectedOutput[0].value)}`;
          expectedText = `output: ${JSON5.stringify(expectedOutput[0].value)}`;
        }
      } else {
        expectedText = "value: undefined";
      }
      cell.innerHTML = /* html */ `
        <div class="slightFade">
          <span class="codicon codicon-person"></span>
        </div>
        <div class="slightFade">
          <!-- expected ${expectedText}&nbsp; -->
          &nbsp; expected ${expectedText}&nbsp;
        </div>
        <div class="alignAsMidCell">
          <vscode-button id="fuzz-editExpectedOutput${id}" rowId="${row.id}" appearance="icon" aria-label="Edit">
            <span class="tooltipped tooltipped-n" aria-label="Edit">
              <span class="codicon codicon-edit"></span>
            </span>
          </vscode-button>
        </div>`;

      // Create event handler for edit click
      const editButton = getElementByIdOrThrow(`fuzz-editExpectedOutput${id}`);
      editButton.addEventListener("click", () => {
        toggleHidden(expectedRow);
        handleExpectedOutput({
          type,
          row,
          tbody,
          isClicking: true,
          button: editButton,
        });
      });
    }
  }
}

/**
 * HTML for X icon expected output row. Adds radio buttons for operator
 * type -- 'not equal' (default), 'equal'. Adds text field for expected output
 *
 * @param id id of row
 * @param index index in `data`
 * @param type e.g. bad output, passed
 */
function expectedOutputHtml(
  id: number,
  index: number,
  type: FuzzResultCategory
) {
  const expectedOutput = data[type][index][expectedLabel];
  let defaultOutput;

  if (expectedOutput && expectedOutput.length) {
    defaultOutput = expectedOutput[0];
  } else {
    defaultOutput = { value: "" };
  }

  const isValueAnnotation =
    !defaultOutput.isTimeout && !defaultOutput.isException;

  // prettier-ignore
  const html = /*html*/ `
    What is the expected ouput?
    <vscode-radio-group>
      <vscode-radio id="fuzz-radioException${id}" ${defaultOutput.isException ? " checked " : ""}>Exception</vscode-radio>
      <vscode-radio class="hidden" id="fuzz-radioTimeout${id}" ${defaultOutput.isTimeout ? " checked " : ""}>Timeout</vscode-radio>
      <vscode-radio id="fuzz-radioValue${id}" ${isValueAnnotation ? " checked " : ""}>Value:</vscode-radio>
    </vscode-radio-group> 
    <div>
      <vscode-text-field id="fuzz-expectedOutput${id}" class="${isValueAnnotation ? "" : "hidden"}" placeholder="Literal value (JSON)" value=${JSON5.stringify(defaultOutput.value)}></vscode-text-field>
      <span><vscode-button id="fuzz-expectedOutputOk${id}" aria-label="ok" style="display: table-cell; vertical-align: top;">ok</vscode-button></span>
      <span id="fuzz-expectedOutputMessage${id}"></span>
    </div>
  `;
  return html;
}

/**
 * Builds a test case from the expected output panel
 *
 * @param id id of row
 * @param type e.g. bad output, passed
 * @param index index in `data`
 *
 * @returns test case object or undefined if the expected value is invalid
 */
function buildExpectedTestCase(
  id: number,
  type: FuzzResultCategory,
  index: number
): FuzzPinnedTest | undefined {
  const textField = getElementByIdOrThrow(`fuzz-expectedOutput${id}`);
  const radioTimeout = getElementByIdOrThrow(`fuzz-radioTimeout${id}`);
  const radioException = getElementByIdOrThrow(`fuzz-radioException${id}`);
  const radioValue = getElementByIdOrThrow(`fuzz-radioValue${id}`);
  const errorMessage = getElementByIdOrThrow(`fuzz-expectedOutputMessage${id}`);
  const okButton = getElementByIdOrThrow(`fuzz-expectedOutputOk${id}`);

  // Check if the expected value is valid JSON
  const expectedValue = textField.getAttribute("current-value");
  let parsedExpectedValue: ArgValueType;
  try {
    // Attempt to parse the expected value
    parsedExpectedValue =
      expectedValue === null ||
      expectedValue === "undefined" ||
      expectedValue === ""
        ? undefined
        : JSON5.parse(expectedValue);
  } catch (e) {
    // Only validate the value if we are doing a value check
    if ("checked" in radioValue && radioValue.checked) {
      // Indicate to the user that there is an error
      textField.classList.add("classErrorCell");
      errorMessage.classList.add("expectedOutputErrorMessage");
      errorMessage.innerHTML = "invalid; not saved";
      hide(okButton);

      // Return w/o saving
      return undefined;
    }
  }

  // Update the UI -- everything looks fine
  textField.classList.remove("classErrorCell");
  errorMessage.classList.remove("expectedOutputErrorMessage");
  errorMessage.innerHTML = "";
  show(okButton);

  // Build the expected output object
  const expectedOutput: FuzzIoElement = {
    name: "0",
    offset: 0,
    isTimeout: !!("checked" in radioTimeout && radioTimeout.checked),
    isException: !!("checked" in radioException && radioException.checked),
    value: parsedExpectedValue,
    origin: { type: "user" },
  };

  // Build & return the test case object
  return {
    input: resultsData.results[id].input,
    output: resultsData.results[id].output,
    pinned: data[type][index][pinnedLabel],
    expectedOutput: [expectedOutput],
  };
} // fn: buildExpectedTestCase()

/**
 * Handles the fuzz.run button onClick() event: retrieves the fuzzer options
 * from the UI and sends them to the extension to start the fuzzer.
 */
function handleFuzzRun() {
  const message: FuzzPanelMessageFromWebView = {
    command: "fuzz.run",
    json: JSON5.stringify(getConfigFromUi()),
  };
  vscode.postMessage(message);
} // fn: handleFuzzRun

/**
 * Handles the fuzz.retest button onClick() event: retrieves the fuzzer options
 * from the UI and sends them to the extension to start the fuzzer.
 */
function handleFuzzRetest() {
  const message: FuzzPanelMessageFromWebView = {
    command: "fuzz.retest",
    json: JSON5.stringify(getConfigFromUi()),
  };
  vscode.postMessage(message);
} // fn: handleFuzzRetest

/**
 * Handles the fuzz.clear button onClick() event: retrieves the fuzzer options
 * from the UI and sends them to the extension to clear the FuzzPanel
 */
function handleFuzzClear() {
  const message: FuzzPanelMessageFromWebView = {
    command: "fuzz.clear",
    json: JSON5.stringify(getConfigFromUi()),
  };
  vscode.postMessage(message);
} // fn: handleFuzzClear

/**
 * Disable UI controls
 *
 * @param disableArr list of controls to disable
 */
function disableUiControls(disableArr: EventTarget[]): void {
  disableArr.forEach((e) => {
    if (
      "style" in e &&
      typeof e.style === "object" &&
      e.style &&
      "disabled" in e.style
    ) {
      e.style.disabled = true;
    }
  });
} // fn: disableUiControls

/**
 * Returns the on-screen fuzzer configuration.
 * Also disables controls in preparation for calling fuzzer.
 *
 * @returns FuzzPanelFuzzRunMessage containing the configuration
 */
function getConfigFromUi(): FuzzPanelFuzzRunMessage {
  const fuzzBase = "fuzz"; // Base html id name

  // Get input elements
  const MutationInputGeneratorEnabled = getElementByIdOrThrow(
    `${fuzzBase}-gen-MutationInputGenerator-enabled`
  );
  const AiInputGeneratorEnabled = getElementByIdOrThrow(
    `${fuzzBase}-gen-AiInputGenerator-enabled`
  );
  const CoverageMeasureEnabled = getElementByIdOrThrow(
    `${fuzzBase}-measure-CoverageMeasure-enabled`
  );
  const CoverageMeasureWeight = getElementByIdOrThrow(
    `${fuzzBase}-measure-CoverageMeasure-weight`
  );
  const FailedTestMeasureEnabled = getElementByIdOrThrow(
    `${fuzzBase}-measure-FailedTestMeasure-enabled`
  );
  const FailedTestMeasureWeight = getElementByIdOrThrow(
    `${fuzzBase}-measure-FailedTestMeasure-enabled`
  );

  // List of controls to disable while fuzzer is busy
  const disableArr = [
    getElementByIdOrThrow("fuzz.run"),
    document.getElementById("fuzz.addTestInput"), // may be null
    MutationInputGeneratorEnabled,
    CoverageMeasureEnabled,
    CoverageMeasureWeight,
    FailedTestMeasureEnabled,
    FailedTestMeasureWeight,
  ].filter((e) => e !== null);

  // Helper: integer values
  const getIntValue = (e: string): number => {
    const item = getElementByIdOrThrow(fuzzBase + "-" + e);
    disableArr.push(item);
    const currentValue = item.getAttribute("current-value");
    if (currentValue === null) {
      throw new Error("current-value is null");
    }
    return Math.max(parseInt(currentValue), 0);
  };

  // Helper: boolean values boolean
  const getBooleanValue = (e: string): boolean => {
    const item = getElementByIdOrThrow(fuzzBase + "-" + e);
    disableArr.push(item);
    return (
      (item.getAttribute("value") ?? item.getAttribute("current-checked")) ===
      "true"
    );
  };

  // Last tab
  const lastTabRaw =
    document
      .getElementById("fuzzResultsTabStrip")
      ?.getAttribute("activeId")
      ?.replace("tab-", "") ?? undefined;
  const lastTab = isFuzzResultTab(lastTabRaw) ? lastTabRaw : undefined;

  // Fuzzer option overrides (from UI)
  const overrides: FuzzPanelFuzzRunMessage = {
    fuzzer: {
      maxTests: getIntValue("maxTests"),
      maxDupeInputs: getIntValue("maxDupeInputs"),
      maxFailures: getIntValue("maxFailures"),
      fnTimeout: getIntValue("fnTimeout"),
      suiteTimeout: getIntValue("suiteTimeout"),
      useImplicit: getBooleanValue("useImplicit"),
      useHuman: true, // always active
      useProperty: getBooleanValue("useProperty"),
      measures: {
        CoverageMeasure: {
          enabled:
            (CoverageMeasureEnabled.getAttribute("value") ??
              CoverageMeasureEnabled.getAttribute("current-checked")) ===
            "true",
          weight: Math.min(
            Number(CoverageMeasureWeight.getAttribute("value")),
            1
          ),
        },
        FailedTestMeasure: {
          enabled:
            (FailedTestMeasureEnabled.getAttribute("value") ??
              FailedTestMeasureEnabled.getAttribute("current-checked")) ===
            "true",
          weight: Math.min(
            Number.parseFloat(
              FailedTestMeasureWeight.getAttribute("value") ?? "1"
            ),
            1
          ),
        },
      },
      generators: {
        RandomInputGenerator: {
          enabled: true, // always enabled
        },
        MutationInputGenerator: {
          enabled:
            (MutationInputGeneratorEnabled.getAttribute("value") ??
              MutationInputGeneratorEnabled.getAttribute("current-checked")) ===
            "true",
        },
        AiInputGenerator: {
          enabled:
            (AiInputGeneratorEnabled.getAttribute("value") ??
              AiInputGeneratorEnabled.getAttribute("current-checked")) ===
            "true",
        },
      },
    },
    args: [],
    lastTab,
  };

  // Process all the argument overrides
  for (let i = 0; document.getElementById(getIdBase(i)) !== null; i++) {
    const idBase = getIdBase(i);
    const thisOverride: FuzzArgOverride = {};
    overrides.args.push(thisOverride);

    // Get all the possible controls for this argument
    const min = document.getElementById(idBase + "-min");
    const max = document.getElementById(idBase + "-max");
    const numInteger = document.getElementById(idBase + "-numInteger");
    const trueFalse = document.getElementById(idBase + "-trueFalse");
    const trueOnly = document.getElementById(idBase + "-trueOnly");
    const falseOnly = document.getElementById(idBase + "-falseOnly");
    const minStrLen = document.getElementById(idBase + "-minStrLen");
    const maxStrLen = document.getElementById(idBase + "-maxStrLen");
    const strCharset = document.getElementById(idBase + "-strCharset");
    const isNoInput = document.getElementById(idBase + "-isNoInput");

    // Process numeric overrides
    if (numInteger && min && max) {
      disableArr.push(numInteger, min, max);
      const minVal = Number(min.getAttribute("current-value"));
      const maxVal = Number(max.getAttribute("current-value"));
      thisOverride.number = {
        numInteger:
          numInteger.getAttribute("current-checked") === "true" ? true : false,
        min: Math.min(minVal, maxVal),
        max: Math.max(minVal, maxVal),
      };
    } // TODO: Validation !!!

    // Process boolean overrides
    if (trueFalse !== null && trueOnly !== null && falseOnly !== null) {
      disableArr.push(trueFalse, trueOnly, falseOnly);
      thisOverride.boolean = {
        min: trueOnly.getAttribute("current-checked") === "true" ? true : false,
        max:
          falseOnly.getAttribute("current-checked") === "true" ? false : true,
      };
    } // TODO: Validation !!!

    // Process string overrides
    if (minStrLen && maxStrLen && strCharset) {
      disableArr.push(minStrLen, maxStrLen);
      const minStrLenVal = minStrLen.getAttribute("current-value");
      const maxStrLenVal = maxStrLen.getAttribute("current-value");
      const strCharsetVal = strCharset.getAttribute("current-value");
      if (
        minStrLenVal !== null &&
        maxStrLenVal !== null &&
        strCharsetVal !== null
      ) {
        thisOverride.string = {
          minStrLen: Math.max(
            0,
            Math.min(Number(minStrLenVal), Number(maxStrLenVal))
          ),
          maxStrLen: Math.max(Number(minStrLenVal), Number(maxStrLenVal), 0),
          strCharset: strCharsetVal,
        };
      }
    } // TODO: Validation !!!

    // Process isNoInput overrides
    if (isNoInput !== null) {
      disableArr.push(isNoInput);
      thisOverride["isNoInput"] =
        (isNoInput.getAttribute("value") ??
          isNoInput.getAttribute("current-checked")) !== "true";
    }

    // Process array dimension overrides
    const dimLength = [];
    let dim = 0;
    let arrayBase = `${idBase}-array-${dim}`;
    while (document.getElementById(`${arrayBase}-min`) !== null) {
      const min = document.getElementById(`${arrayBase}-min`);
      const max = document.getElementById(`${arrayBase}-max`);
      if (min !== null && max !== null) {
        disableArr.push(min, max);
        const minVal = min.getAttribute("current-value");
        const maxVal = max.getAttribute("current-value");
        if (minVal !== null && maxVal !== null) {
          dimLength.push({
            min: Math.max(Math.min(Number(minVal), Number(maxVal)), 0),
            max: Math.max(Number(minVal), Number(maxVal), 0),
          });
        }
      }
      arrayBase = `${idBase}-array-${++dim}`;
    }
    if (dimLength.length > 0) {
      thisOverride.array = {
        dimLength: dimLength,
      };
    }
  }

  // Disable input elements while the Fuzzer runs.
  disableUiControls(disableArr);
  return overrides;
} // fn: getConfigFromUi

/**
 * Refreshes the displayed list of validators based on a list of
 * validators provided from the back-end.
 *
 * @param {*} validatorList of type: {
 *  validator?: string,   // selected custom validator
 *  validators: string[], // list of available custom validators
 * }
 */
function refreshValidators(validatorList: string[]) {
  const validatorFnList = getElementByIdOrThrow("validator-functionList");
  const validatorFnCount = getElementByIdOrThrow("validator-functionCount");
  validatorFnList.setAttribute(
    "aria-label",
    listForValidatorFnTooltip(validatorList)
  );
  validatorFnCount.innerText = String(validatorList.length);
} // fn: refreshValidators

/**
 * Send message to back-end to add code skeleton to source code (because the
 * user clicked the customValidator button)
 */
function handleAddValidator() {
  const message: FuzzPanelMessageFromWebView = {
    command: "validator.add",
  };
  vscode.postMessage(message);
} // fn: handleAddValidator()

/**
 * Send message to back-end to add code skeleton to source code (because the
 * user clicked the customValidator button)
 */
function handleOpenSource() {
  const message: FuzzPanelMessageFromWebView = {
    command: "open.source",
  };
  vscode.postMessage(message);
} // fn: handleOpenSource()

/**
 * Send message to back-end to refresh the validators
 */
function handleGetListOfValidators() {
  const message: FuzzPanelMessageFromWebView = {
    command: "validator.getList",
  };
  vscode.postMessage(message);
} // fn: handleGetListOfValidators()

/**
 * Returns true if the DOM node is hidden using the 'hidden' class.
 *
 * @param e The DOM node to check for the 'hidden' class
 * @returns true if the DOM node is hidden; false otherwise
 */
function isHidden(e: HTMLElement) {
  return e.classList.contains("hidden");
} // fn: isHidden()

/**
 * Toggles whether an element is hidden or not
 *
 * @param e DOM element to toggle
 */
function toggleHidden(e: Element) {
  if (e.classList.contains("hidden")) {
    e.classList.remove("hidden");
  } else {
    e.classList.add("hidden");
  }
} // fn: toggleHidden()

/**
 * Hides a DOM element
 *
 * @param e DOM element to hide
 */
function hide(e: Element) {
  e.classList.add("hidden");
} // fn: hide()

/**
 * Shows a DOM element
 *
 * @param e DOM element to hide
 */
function show(e: Element) {
  e.classList.remove("hidden");
} // fn: show()

/**
 * Returns the number of columns in a table
 *
 * @param type Table type key
 * @returns sum of colspans for table header
 */
function getColCountForTable(type: FuzzResultCategory) {
  // Get the table header row
  const thead = getElementByIdWithTypeOrThrow(
    `fuzzResultsGrid-${type}-thead`,
    HTMLTableSectionElement
  );
  const theadRow = thead.rows[0];

  // Return the sum of the cell colspans
  return Array.from(theadRow.cells)
    .map((cell) => cell.colSpan)
    .reduce((a, b) => a + b, 0);
} // fn: getColCountForTable()

/**
 * Return index of a column in table header
 * @param {*} id
 * @param {*} hRow
 * @returns
 */
function getIdxInTableHeader(id: string, hRow: HTMLTableRowElement) {
  // Get idx of first custom validator col
  let idx = 0;
  for (const hCell of Array.from(hRow.cells)) {
    if (hCell.id === id) {
      break;
    }
    ++idx;
  }
  return idx;
}

/**
 * Returns string of validator function names
 *
 * @param {*} validatorList list of validator fn names
 * @returns
 */
function listForValidatorFnTooltip(validatorList: string[]) {
  let list = "Property validators:\n";
  if (validatorList.length === 0) {
    list += "(none)";
  }
  validatorList.forEach((validator, idx) => {
    list += validatorList[idx];
    if (idx !== validatorList.length) {
      list += "\n";
    }
  });
  return list;
}

/**
 * Returns a base id name for a particular argument input.
 *
 * @param i unique argument id
 * @returns HTML id for the argument
 */
function getIdBase(i: number) {
  return "argDef-" + i;
} // fn: getIdBase()

/**
 * Adapted from: escape-goat/index.js
 *
 * Unescapes an HTML string.
 *
 * @param html HTML to unescape
 * @returns unescaped string
 */
function htmlUnescape(html: string) {
  return html
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
} // fn: htmlUnescape()

/**
 * Adapted from: escape-goat/index.js
 *
 * Escapes a string for use in HTML.
 *
 * @param str string to escape
 * @returns escaped string
 */
function htmlEscape(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
} // fn: htmlEscape()
