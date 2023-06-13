const vscode = acquireVsCodeApi();

// Attach main to the window onLoad() event
window.addEventListener("load", main);

// List of output grids that store fuzzer results
const gridTypes = ["timeout", "exception", "badOutput", "passed"];

// Pin button states
const pinState = {
  htmlPinned: `<span class="codicon codicon-pinned"></span>`,
  htmlPin: `<span class="codicon codicon-pin"></span>`,
  classPinned: "fuzzGridCellPinned",
  classPin: "fuzzGridCellPin",
};

// Sort order for each grid and column
const sortOrder = ["asc", "desc", "none"];
function getDefaultColumnSortOrder() {
  return { pinned: "desc" };
}
const defaultColumnSortOrders = {
  timeout: getDefaultColumnSortOrder(),
  exception: getDefaultColumnSortOrder(),
  badOutput: getDefaultColumnSortOrder(),
  passed: getDefaultColumnSortOrder(),
};

// Column sort orders (filled by main or handleColumnSort())
let columnSortOrders;
// Fuzzer Results (filled by main during load event)
let resultsData;

/**
 * Sets up the UI when the page is loaded, including setting up
 * event handlers and filling the output grids if data is available.
 */
function main() {
  const pinnedLabel = "pinned";
  const idLabel = "id";

  // Add event listener for the fuzz.start button
  document
    .getElementById("fuzz.start")
    .addEventListener("click", (e) => handleFuzzStart(e));

  // Add event listener for the fuzz.options button
  document
    .getElementById("fuzz.options")
    .addEventListener("click", (e) => toggleFuzzOptions(e));

  // Load the data from the HTML
  resultsData = JSON5.parse(
    htmlUnescape(document.getElementById("fuzzResultsData").innerHTML)
  );

  // Load column sort orders from the HTML
  let message = JSON5.parse(
    htmlUnescape(document.getElementById("fuzzSortColumns").innerHTML)
  );
  if (Object.keys(message).length === 0) {
    columnSortOrders = defaultColumnSortOrders;
  } else {
    columnSortOrders = JSON.parse(JSON.stringify(message));
  }

  // Load and save the state back to the webview.  There does not seem to be
  // an 'official' way to directly persist state within the extension itself,
  // at least as of vscode 1.69.2.  Hence, the roundtrip.
  vscode.setState(
    JSON5.parse(
      htmlUnescape(document.getElementById("fuzzPanelState").innerHTML)
    )
  );

  // Fill the result grids
  if (Object.keys(resultsData).length) {
    const data = {};
    gridTypes.forEach((type) => {
      data[type] = [];
    });

    // Loop over each result
    let idx = 0;
    for (const e of resultsData.results) {
      // Indicate which tests are pinned
      const pinned = { [pinnedLabel]: !!(e.pinned ?? false) };
      const id = { [idLabel]: idx++ };

      // Name each input argument and make it clear which inputs were not provided
      // (i.e., the argument was optional).  Otherwise, stringify the value for
      // display.
      const inputs = {};
      e.input.forEach((i) => {
        inputs[`input: ${i.name}`] =
          i.value === undefined ? "(no input)" : JSON5.stringify(i.value);
      });

      // There are 0-1 outputs: if an output is present, just name it `output`
      // and make it clear which outputs are undefined.  Otherwise, stringify
      // the value for display.
      const outputs = {};
      e.output.forEach((o) => {
        outputs[`output`] =
          o.value === undefined ? "undefined" : JSON5.stringify(o.value);
      });

      // Toss each result into the appropriate grid
      if (e.passed) {
        data["passed"].push({
          ...id,
          ...inputs,
          ...outputs,
          "running time (ms)": e.elapsedTime.toFixed(3), // converts to string
          ...pinned,
        });
      } else {
        if (e.exception) {
          data["exception"].push({
            ...id,
            ...inputs,
            exception: e.exceptionMessage,
            "running time (ms)": e.elapsedTime.toFixed(3),
            ...pinned,
          });
        } else if (e.timeout) {
          data["timeout"].push({
            ...id,
            ...inputs,
            "running time (ms)": e.elapsedTime.toFixed(3),
            ...pinned,
          });
        } else {
          data["badOutput"].push({
            ...id,
            ...inputs,
            ...outputs,
            "running time (ms)": e.elapsedTime.toFixed(3),
            ...pinned,
          });
        }
      }
    } // for: each result

    // Fill the grids with data
    gridTypes.forEach((type) => {
      if (data[type].length) {
        //document.getElementById(`fuzzResultsGrid-${type}`).rowsData = data[type];
        const thead = document.getElementById(`fuzzResultsGrid-${type}-thead`);
        const tbody = document.getElementById(`fuzzResultsGrid-${type}-tbody`);

        // Render the header row
        const hRow = thead.appendChild(document.createElement("tr"));
        Object.keys(data[type][0]).forEach((k) => {
          if (k === pinnedLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.className = "fuzzGridCellPinned";
            cell.innerHTML = `<big>pin</big>`;
            cell.setAttribute("class", "columnSortDesc");
            cell.addEventListener("click", () => {
              handleColumnSort(cell, type, k, data, tbody, false);
            });
          } else if (k === idLabel) {
            // noop
          } else {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.innerHTML = `<big>${htmlEscape(k)}</big>`;
            cell.addEventListener("click", () => {
              handleColumnSort(cell, type, k, data, tbody, false);
            });
          }
        });

        // Render the data rows
        // var tbody = document.getElementById(`fuzzResultsGrid-${type}-tbody`);
        data[type].forEach((e) => {
          let id = -1;
          const row = tbody.appendChild(document.createElement("tr"));
          Object.keys(e).forEach((k) => {
            if (k === pinnedLabel) {
              const cell = row.appendChild(document.createElement("td"));
              cell.className = e[k] ? pinState.classPinned : pinState.classPin;
              cell.id = `fuzzSaveToggle-${id}`;
              cell.setAttribute("aria-label", e[k] ? "pinned" : "pin");
              cell.innerHTML = e[k] ? pinState.htmlPinned : pinState.htmlPin;
              cell.addEventListener("click", () => handlePinToggle(id));
            } else if (k === idLabel) {
              id = parseInt(e[k]);
            } else {
              const cell = row.appendChild(document.createElement("td"));
              cell.innerHTML = htmlEscape(e[k]);
            }
          });
        });

        // Initial sort, according to columnSortOrders
        let hRowIdx = 0;
        for (let k = 0; k < Object.keys(data[type][0]).length; ++k) {
          let col = Object.keys(data[type][0])[k];
          let cell = hRow.cells[hRowIdx];
          if (col === idLabel) {
            continue;
          }
          handleColumnSort(cell, type, col, data, tbody, true);
          ++hRowIdx;
        }
      } // for: each type
    });
  }
} // fn: main()

/**
 * Toggles whether more fuzzer options are shown.
 *
 * @param e onClick() event
 */
function toggleFuzzOptions(e) {
  const fuzzOptions = document.getElementById("fuzzOptions");
  if (fuzzOptions.style.display === "none") {
    fuzzOptions.style.display = "block";
    e.currentTarget.innerHTML = "Fewer options";
  } else {
    fuzzOptions.style.display = "none";
    e.currentTarget.innerHTML = "More options";
  }
} // fn: toggleFuzzOptions()

/**
 * Toggles whether a test is pinned for CI and the next AutoTest.
 *
 * @param id offset of test in resultsData
 */
function handlePinToggle(id) {
  // Get the test data for the test case
  const testInput = { input: resultsData.results[id].input };

  // Get the control that was clicked
  const button = document.getElementById(`fuzzSaveToggle-${id}`);

  // Are we pinning or unpinning the test?
  const pinning = button.innerHTML === pinState.htmlPin;

  // Disable the control while we wait for the response
  button.disabled = true;

  // Send the request to the extension
  window.setTimeout(() => {
    vscode.postMessage({
      command: pinning ? "test.pin" : "test.unpin",
      json: JSON5.stringify(testInput),
    });

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

    // Disable the control while we wait for the response
    button.disabled = false;
  });
} // fn: handleSaveToggle()

/**
 * Sorts table based on columns. Each column can be toggled between 'asc', 'desc', and
 * 'none'. The first columns that the user clicks have the highest priority. Later
 * columns that are clicked are used to break ties.
 *
 * @param cell cell of hRow
 * @param type (timeout, exception, badOutput, passed)
 * @param col (ex: input:a, output, pin)
 * @param data
 * @param tbody table body
 * @param isFirst bool determining if the initial sort is occurring, or if the function
 * is being called because the user clicked on a column
 */
function handleColumnSort(cell, type, col, data, tbody, isFirst) {
  updateColumnArrows(cell, type, col, isFirst);

  // Add column names in order
  var colNames = [];
  for (var colName in columnSortOrders[type]) {
    colNames.push(colName);
  }

  // Sort columns
  // (This was the original plan:)
  // Go through the columns in backwards order, so that the first columns you
  // clicked on take precedence over later ones
  // (Potential new plan:)
  // Go through the columns in order, so that the most recent columns you click
  // on take precedence over earlier ones
  // Still need to figure out how to deal with pin - special case
  for (let i = colNames.length - 1; i >= 0; --i) {
    col = colNames[i];
    data[type].sort((a, b) => {
      if (columnSortOrders[type][col] == "none") {
        // If none, return
        return;
      } else if (columnSortOrders[type][col] == "desc") {
        // If descending, reverse a and b
        let temp = a;
        a = b;
        b = temp;
      }
      // Determine type of object
      var aType;
      try {
        aType = typeof JSON.parse(a[col]);
      } catch (error) {
        aType = "string";
      }
      // Save original strings (to break ties alphabetically)
      var aVal = a[col],
        bVal = b[col];

      switch (aType) {
        case "string":
          // Sort by length, break ties alphabetically
          a = a[col].length;
          b = b[col].length;
          break;
        case "boolean":
          // Sort alphabetically
          a = a[col];
          b = b[col];
          break;
        case "number":
          // Sort numerically
          a = Number(a[col]);
          b = Number(b[col]);
          break;
        case "object":
          // Sort by length
          if (a[col].length) {
            a = a[col].length;
            b = b[col].length;
            // If numerical values, break ties based on number
            try {
              aVal = JSON.parse(a[col]);
              bVal = JSON.parse(b[col]);
            } catch (error) {
              // noop
              // If not numerical values, break ties alphabetically
            }
          } else {
            a = Object.keys(a[col]).length;
            b = Object.keys(b[col]).length;
            break;
          }
      }

      // Compare values and sort
      if (a === b) {
        if (aVal === bVal) {
          return 0; // a = b
        } else if (aVal > bVal) {
          // break tie
          return 2;
        } else {
          // break tie
          return -2;
        }
      } else if (a > b) {
        return 2; // a > b
      } else {
        return -2; // a < b
      }
    });
  }
  // Sorting done, display sorted table
  displaySortedTableBody(data, tbody, type);

  // Send message to extension (so that if you click Test again, your sort order will
  // be retained)
  if (!isFirst) {
    vscode.postMessage({
      command: "columnSortOrders",
      json: JSON5.stringify(columnSortOrders),
    });
  }
} // fn: handleColumnSort`

/**
 * Displays column arrows in header row, and updates columnSortOrders
 *
 * @param cell cell of hRow
 * @param type (timeout, exception, badOutput, passed)
 * @param col (ex: input:a, output, pin)
 * @param isFirst bool determining if the initial sort is occurring, or if the function
 * is being called because the user clicked on a column
 * @returns
 */
function updateColumnArrows(cell, type, col, isFirst) {
  let currOrder = columnSortOrders[type][col]; // 'asc', 'desc', or 'none'
  let currIndex = -1;
  // Here, currIndex represents an index of sortOrder = ['asc','desc','none']
  if (!currOrder) {
    // If currOrder is undefined, either return or set currOrder to default value 'asc'
    if (isFirst) {
      return;
    } else {
      currOrder = "asc";
      currIndex = 0;
    }
  } else {
    // If currOrder is already defined and isFirst is not true (meaning the user clicked
    // on a column), change the sorting direction to the next value in the cycle
    // (asc -> desc, desc -> none, none -> asc)
    if (!isFirst) {
      for (let i = 0; i < sortOrder.length; ++i) {
        if (currOrder === sortOrder[i]) currIndex = i;
      }
      currIndex = (currIndex + 1) % sortOrder.length;
      currOrder = sortOrder[currIndex];
    }
  }

  // Set attribute to display appropriate arrow
  switch (currOrder) {
    case "asc":
      cell.setAttribute("class", "columnSortAsc");
      break;
    case "desc":
      cell.setAttribute("class", "columnSortDesc");
      break;
    case "none":
      cell.setAttribute("class", "columnSortNone");
      break;
    default:
      assert(false); // shouldn't get here
  }
  // To ensure that the order of keys in columnSortOrders reflects the order that the
  // user clicked the columns, delete the modified key and add it back to the end.
  if (!isFirst) {
    delete columnSortOrders[type][col];
    columnSortOrders[type][col] = sortOrder[currIndex];
  }
} //fn: updateColumnArrows

/**
 * Updates the table body to reflect new sorted order
 *
 * @param data
 * @param tbody table body
 * @param type (timeout, exception, badOutput, passed)
 */
function displaySortedTableBody(data, tbody, type) {
  const pinnedLabel = "pinned";
  const idLabel = "id";

  // Change data rows
  let i = 0;
  data[type].forEach((e) => {
    let id = -1;
    let j = 0;
    Object.keys(e).forEach((k) => {
      // Iterate over rows
      let row = tbody.rows[i];
      // Iterate over cells
      let cell = row.cells[j];
      if (k === pinnedLabel) {
        cell.className = e[k] ? pinState.classPinned : pinState.classPin;
        cell.id = `fuzzSaveToggle-${id}`;
        cell.setAttribute("aria-label", e[k] ? "pinned" : "pin");
        cell.innerHTML = e[k] ? pinState.htmlPinned : pinState.htmlPin;
        cell.addEventListener("click", () => handlePinToggle(id));
      } else if (k === idLabel) {
        id = parseInt(e[k]);
        --j; // don't count this column
      } else {
        cell.innerHTML = htmlEscape(e[k]);
      }
      ++j;
    });
    ++i;
  });
} //fn: displaySortedTableBody

/**
 * Handles the fuzz.start button onClick() event: retrieves the fuzzer options
 * from the UI and sends them to the extension to start the fuzzer.
 *
 * @param e onClick() event
 */
function handleFuzzStart(e) {
  const overrides = { fuzzer: {}, args: [] }; // Fuzzer option overrides (from UI)
  const disableArr = [e.currentTarget]; // List of controls to disable while fuzzer is busy
  const fuzzBase = "fuzz"; // Base html id name

  // Process fuzzer options
  ["suiteTimeout", "maxTests", "fnTimeout"].forEach((e) => {
    const item = document.getElementById(fuzzBase + "-" + e);
    if (item !== null) {
      disableArr.push(item);
      overrides.fuzzer[e] = parseInt(item.getAttribute("current-value"));
    }
  });

  // Process all the argument overrides
  for (let i = 0; document.getElementById(getIdBase(i)) !== null; i++) {
    const idBase = getIdBase(i);
    const thisOverride = {};
    overrides.args.push(thisOverride);

    // Get the min and max values
    const min = document.getElementById(idBase + "-min");
    const max = document.getElementById(idBase + "-max");
    if (min !== null && max !== null) {
      disableArr.push(min, max);
      const minVal = min.getAttribute("current-value");
      const maxVal = max.getAttribute("current-value");
      if (minVal !== undefined && maxVal !== undefined) {
        thisOverride["min"] = Math.min(Number(minVal), Number(maxVal));
        thisOverride["max"] = Math.max(Number(minVal), Number(maxVal));
      }
    } // TODO: Validation !!!

    // Get the number type
    const numInteger = document.getElementById(idBase + "-numInteger");
    if (numInteger !== null) {
      disableArr.push(numInteger);
      thisOverride["numInteger"] =
        numInteger.getAttribute("current-checked") === "true" ? true : false;
    }

    // Get boolean values
    const trueFalse = document.getElementById(idBase + "-trueFalse");
    const trueOnly = document.getElementById(idBase + "-trueOnly");
    const falseOnly = document.getElementById(idBase + "-falseOnly");
    if (trueFalse !== null && trueOnly !== null && falseOnly !== null) {
      disableArr.push(trueFalse, trueOnly, falseOnly);
      thisOverride["min"] =
        trueOnly.getAttribute("current-checked") === "true" ? true : false;
      thisOverride["max"] =
        falseOnly.getAttribute("current-checked") === "true" ? false : true;
    }

    // Get the string length min and max
    const minStrLen = document.getElementById(idBase + "-minStrLen");
    const maxStrLen = document.getElementById(idBase + "-maxStrLen");
    if (minStrLen !== null && maxStrLen !== null) {
      disableArr.push(minStrLen, maxStrLen);
      const minStrLenVal = minStrLen.getAttribute("current-value");
      const maxStrLenVal = maxStrLen.getAttribute("current-value");
      if (minStrLenVal !== undefined && maxStrLenVal !== undefined) {
        thisOverride["minStrLen"] = Math.max(
          0,
          Math.min(Number(minStrLenVal), Number(maxStrLenVal))
        );
        thisOverride["maxStrLen"] = Math.max(
          Number(minStrLenVal),
          Number(maxStrLenVal),
          0
        );
      }
    } // TODO: Validation !!!

    // Get the min and max for each array dimension
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
        if (minVal !== undefined && maxVal !== undefined) {
          dimLength.push({
            min: Math.max(Math.min(Number(minVal), Number(maxVal)), 0),
            max: Math.max(Number(minVal), Number(maxVal), 0),
          });
        }
      }
      arrayBase = `${idBase}-array-${++dim}`;
    }
    if (dimLength.length > 0) {
      thisOverride["dimLength"] = dimLength;
    }
  }

  // Disable input elements while the Fuzzer runs.
  disableArr.forEach((e) => {
    e.style.disabled = true;
  });

  // Send the fuzzer start command to the extension
  vscode.postMessage({
    command: "fuzz.start",
    json: JSON5.stringify(overrides),
  });
} // fn: handleFuzzStart

/**
 * Returns a base id name for a particular argument input.
 *
 * @param i unique argument id
 * @returns HTML id for the argument
 */
function getIdBase(i) {
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
function htmlUnescape(html) {
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
function htmlEscape(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
} // fn: htmlEscape()
