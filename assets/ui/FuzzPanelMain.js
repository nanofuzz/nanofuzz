const vscode = acquireVsCodeApi();

// Attach main to the window onLoad() event
window.addEventListener("load", main);

// List of output grids that store fuzzer results
const gridTypes = ["timeout", "exception", "badOutput", "passed"];

// Column labels
const pinnedLabel = "pinned";
const idLabel = "id";
const correctLabel = "correct output?";

// Pin button states
const pinState = {
  htmlPinned: `<span class="codicon codicon-pinned"></span>`,
  htmlPin: `<span class="codicon codicon-pin"></span>`,
  classPinned: "fuzzGridCellPinned",
  classPin: "fuzzGridCellPin",
};

const correctState = {
  htmlCheck: `<span class="codicon codicon-pass"></span>`, // check in circle
  htmlError: `<span class="codicon codicon-error"></span>`, // X in circle
  htmlQuestion: `<span class="codicon codicon-question"></span>`, // ? in circle

  classCheckOn: "classCheckOn",
  classErrorOn: "classErrorOn",
  classQuestionOn: "classQuestionOn",
  classCheckOff: "classCheckOff",
  classErrorOff: "classErrorOff",
  classQuestionOff: "classQuestionOff",
};

// Correct icon sorting values
const correctVals = {
  check: 0,
  error: 1,
  question: 2,
  none: 3,
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
      const correct = { [correctLabel]: e.correct };

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
          "running time (ms)": e.elapsedTime.toFixed(3),
          ...pinned,
          ...correct,
        });
      } else {
        if (e.exception) {
          data["exception"].push({
            ...id,
            ...inputs,
            exception: e.exceptionMessage,
            "running time (ms)": e.elapsedTime.toFixed(3),
            ...pinned,
            ...correct,
          });
        } else if (e.timeout) {
          data["timeout"].push({
            ...id,
            ...inputs,
            "running time (ms)": e.elapsedTime.toFixed(3),
            ...pinned,
            ...correct,
          });
        } else {
          data["badOutput"].push({
            ...id,
            ...inputs,
            ...outputs,
            "running time (ms)": e.elapsedTime.toFixed(3),
            ...pinned,
            ...correct,
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
              handleColumnSort(cell, hRow, type, k, data, tbody, true);
            });
          } else if (k === idLabel) {
            // noop
          } else if (k === correctLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.innerHTML = `<big>correct output?</big>`;
            cell.colSpan = 3;
            cell.addEventListener("click", () => {
              handleColumnSort(cell, hRow, type, k, data, tbody, true);
            });
          } else {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.innerHTML = `<big>${htmlEscape(k)}</big>`;
            cell.addEventListener("click", () => {
              handleColumnSort(cell, hRow, type, k, data, tbody, true);
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
              cell.addEventListener("click", (e) =>
                handlePinToggle(
                  e.currentTarget.parentElement.getAttribute("id"),
                  type,
                  data
                )
              );
            } else if (k === idLabel) {
              id = parseInt(e[k]);
              row.setAttribute("id", id);
            } else if (k === correctLabel) {
              // Add check mark icon
              const cell1 = row.appendChild(document.createElement("td"));
              cell1.innerHTML = correctState.htmlCheck;
              cell1.setAttribute("correctType", "check");
              cell1.addEventListener("click", (e) =>
                handleCorrectToggle(
                  cell1,
                  e.currentTarget.parentElement.getAttribute("id"),
                  data,
                  type,
                  cell1,
                  cell2,
                  cell3
                )
              );
              // Add X mark icon
              const cell2 = row.appendChild(document.createElement("td"));
              cell2.innerHTML = correctState.htmlError;
              cell2.setAttribute("correctType", "error");
              cell2.addEventListener("click", (e) =>
                handleCorrectToggle(
                  cell2,
                  e.currentTarget.parentElement.getAttribute("id"),
                  data,
                  type,
                  cell1,
                  cell2,
                  cell3,
                  data
                )
              );
              // Add question mark icon
              const cell3 = row.appendChild(document.createElement("td"));
              cell3.innerHTML = correctState.htmlQuestion;
              cell3.setAttribute("correctType", "question");
              cell3.addEventListener("click", (e) =>
                handleCorrectToggle(
                  cell3,
                  e.currentTarget.parentElement.getAttribute("id"),
                  data,
                  type,
                  cell1,
                  cell2,
                  cell3,
                  data
                )
              );
              // Determine if on or off
              // Set to default initially
              cell1.className = correctState.classCheckOff;
              cell1.setAttribute("onOff", false);
              cell2.className = correctState.classErrorOff;
              cell2.setAttribute("onOff", false);
              cell3.className = correctState.classQuestionOff;
              cell3.setAttribute("onOff", false);
              // Check if any are on
              if (e[k] === "none") {
                // noop
              } else if (e[k] === "check") {
                cell1.className = correctState.classCheckOn;
                cell1.setAttribute("onOff", true);
              } else if (e[k] === "error") {
                cell2.className = correctState.classErrorOn;
                cell2.setAttribute("onOff", true);
              } else if (e[k] === "question") {
                cell3.className = correctState.classQuestionOn;
                cell3.setAttribute("onOff", true);
              } else {
                assert(false);
              }
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
          handleColumnSort(cell, hRow, type, col, data, tbody, false);
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
 * @param type grid type (e.g., passed, invalid)
 * @param data the back-end data structure
 */
function handlePinToggle(id, type, data) {
  // Get the control that was clicked
  const button = document.getElementById(`fuzzSaveToggle-${id}`);

  // Are we pinning or unpinning the test?
  const pinning = button.innerHTML === pinState.htmlPin;

  // Get the test data for the test case
  const testInput = {
    input: resultsData.results[id].input,
    output: resultsData.results[id].output,
    pinned: pinning,
    correct: "none",
  };

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
    const index = data[type].findIndex((element) => element.id == id);
    if (index > -1) {
      data[type][index][pinnedLabel] = pinning;
    } else {
      console.log("invalid id");
    }

    // Disable the control while we wait for the response
    button.disabled = false;
  });
} // fn: handleSaveToggle()

/**
 * Toggles the correct icons on or off (check mark, X mark, question mark).
 * @param button
 * @param id
 * @param cell1
 * @param cell2
 * @param cell3
 */
function handleCorrectToggle(button, id, data, type, cell1, cell2, cell3) {
  const index = data[type].findIndex((element) => element.id == id);
  if (index <= -1) {
    console.log("invalid id");
    throw e;
  }

  // Change the state of the correct icon that was clicked
  // Only one icon should be selected at a time; if an icon is turned on, all
  // others should be turned off
  switch (button.className) {
    case correctState.classCheckOn:
      // clicking check off
      button.className = correctState.classCheckOff;
      button.setAttribute("onOff", false);
      data[type][index][correctLabel] = "none";
      break;

    case correctState.classErrorOn:
      // clicking error off
      button.className = correctState.classErrorOff;
      button.setAttribute("onOff", false);
      data[type][index][correctLabel] = "none";
      break;

    case correctState.classQuestionOn:
      // clicking question off
      button.className = correctState.classQuestionOff;
      button.setAttribute("onOff", false);
      data[type][index][correctLabel] = "none";
      break;

    case correctState.classCheckOff:
      // clicking check on
      button.className = correctState.classCheckOn;
      button.setAttribute("onOff", true);
      data[type][index][correctLabel] = "check";
      // turn others off
      cell2.className = correctState.classErrorOff;
      cell2.setAttribute("onOff", false);
      cell3.className = correctState.classQuestionOff;
      cell3.setAttribute("onOff", false);
      break;

    case correctState.classErrorOff:
      // clicking error on
      button.className = correctState.classErrorOn;
      button.setAttribute("onOff", true);
      data[type][index][correctLabel] = "error";
      // turn others off
      cell1.className = correctState.classCheckOff;
      cell1.setAttribute("onOff", false);
      cell3.className = correctState.classQuestionOff;
      cell3.setAttribute("onOff", false);
      break;

    case correctState.classQuestionOff:
      // clicking question on
      button.className = correctState.classQuestionOn;
      button.setAttribute("onOff", true);
      data[type][index][correctLabel] = "question";
      // turn others off
      cell1.className = correctState.classCheckOff;
      cell1.setAttribute("onOff", false);
      cell2.className = correctState.classErrorOff;
      cell2.setAttribute("onOff", false);
      break;
  }

  const onOff = JSON.parse(button.getAttribute("onOff"));
  const pinCell = document.getElementById(`fuzzSaveToggle-${id}`);
  const isPinned = pinCell.className === pinState.classPinned;

  // Get the test data for the test case
  const testInput = {
    input: resultsData.results[id].input,
    output: resultsData.results[id].output,
    pinned: isPinned,
    correct: onOff ? button.getAttribute("correctType") : "none", // check, error, question, or none
  };

  // Disable the control while we wait for the response
  button.disabled = true;

  // Send the request to the extension
  window.setTimeout(() => {
    vscode.postMessage({
      command: onOff ? "test.pin" : "test.unpin",
      json: JSON5.stringify(testInput),
    });
    // Disable the control while we wait for the response
    button.disabled = false;
  });
}

/**
 * Sorts table based on a column. Each column can be toggled between 'asc', 'desc', and
 * 'none'. The most recent column that the user clicks has the highest precedence.
 * Uses stable sort, so previously sorted rows will not change unless they have to.
 *
 * @param cell cell of hRow
 * @param hRow header row
 * @param type (timeout, exception, badOutput, passed)
 * @param col (ex: input:a, output, pin)
 * @param data
 * @param tbody table body
 * @param isClicking bool determining if the initial sort is occurring, or if the function
 * is being called because the user clicked on a column
 *
 * 'Initial sort' could be:
 *  - Making sure the pinned/correct columns are sorted at the beginning
 *  - Making sure we retain previous sort settings if you click 'Test' again
 */
function handleColumnSort(cell, hRow, type, column, data, tbody, isClicking) {
  // We are only explicitly sorting by one column at a time (with the pinned and correct
  // columns being special cases)
  // Reset the other column arrows to 'none'
  if (isClicking) resetOtherColumnArrows(hRow, type, column, data);
  updateColumnArrow(cell, type, column, isClicking);

  // If we're toggling, sort based on column 'col'.
  // Otherwise, we also need to sort based on column 'correct output?' and 'pinned'.
  let cols;
  if (isClicking) {
    cols = [column];
  } else {
    cols = [column, correctLabel, pinnedLabel];
  }
  for (const col of cols) {
    data[type].sort((a, b) => {
      // Ascending, descending, or none?
      // If none, return; if descending, switch a and b
      if (columnSortOrders[type][col] == "none") {
        return;
      } else if (columnSortOrders[type][col] == "desc") {
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

      // How are we sorting?
      switch (aType) {
        case "string":
          if (col === correctLabel) {
            // Sort by numerical values
            // "check": 0, "error": 1, "question": 2, "none": 3
            a = correctVals[a[correctLabel]];
            b = correctVals[b[correctLabel]];
          } else {
            // Sort by length, break ties alphabetically
            a = a[col].length;
            b = b[col].length;
          }
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

  // Sorting done, display table
  displaySortedTableBody(data, tbody, type);

  // Send message to extension (so that if you click Test again, your sort order will
  // be retained)
  if (isClicking) {
    vscode.postMessage({
      command: "columnSortOrders",
      json: JSON5.stringify(columnSortOrders),
    });
  }
} // fn: handleColumnSort`

/**
 * For a given type, set columns arrows to 'none', unless the column is
 * the current column being sorted by. The 'pinned' column is a special case
 *
 * @param hRow header row
 * @param type (timeout, exception, badOutput, passed)
 * @param thisCol the current column being sorted by
 * @param data
 */
function resetOtherColumnArrows(hRow, type, thisCol, data) {
  // For a given type, iterate over the columns (ex: input:a, output, pin)
  let hRowIdx = 0;
  for (let k = 0; k < Object.keys(data[type][0]).length; ++k) {
    let col = Object.keys(data[type][0])[k];
    let cell = hRow.cells[hRowIdx];
    if (col === "id") {
      continue;
    }
    if (col === thisCol || col === "pinned" || thisCol == "pinned") {
      ++hRowIdx;
      continue;
    }
    // Reset the column arrow to 'none'
    columnSortOrders[type][col] = "none";
    cell.setAttribute("class", "columnSortNone");
    ++hRowIdx;
  }
}

/**
 * Displays column arrow in header row, and updates columnSortOrders
 *
 * @param cell cell of hRow
 * @param type (timeout, exception, badOutput, passed)
 * @param col (ex: input:a, output, pin)
 * @param isClicking bool determining if the initial sort is occurring, or if the function
 * is being called because the user clicked on a column
 * @returns
 */
function updateColumnArrow(cell, type, col, isClicking) {
  // Pinned column is a special case -- will always check at the end to see if it wants
  // the pinned column sorted in a certain way. That arrow should be displayed.

  let currOrder = columnSortOrders[type][col]; // 'asc', 'desc', or 'none'
  let currIndex = -1;
  // Here, currIndex represents an index of sortOrder = ['asc','desc','none']
  if (!currOrder) {
    // If currOrder is undefined, either return or set currOrder to default value 'asc'
    if (!isClicking) {
      return;
    } else {
      currOrder = "asc";
      currIndex = 0;
    }
  } else {
    // If currOrder is already defined and isFirst is not true (meaning the user clicked
    // on a column), change the sorting direction to the next value in the cycle
    // (asc -> desc, desc -> none, none -> asc)
    if (isClicking) {
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

  if (isClicking) {
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
  // Change values in tbody, based on sorted data structure `data[type]`
  let i = 0;
  data[type].forEach((e) => {
    // For each entry e in the array `data[type]`
    // e.g.  e = {id: , input: , correct: ...}
    let id = -1;
    let j = 0;
    Object.keys(e).forEach((k) => {
      // For each column name k
      // e.g.  k = id, input, correct, ...

      // Iterate over rows
      let row = tbody.rows[i];
      // Iterate over cells
      // j will update with k (j corresponds to a column in the tbody row)
      // i will update with e (i corresponds to a row in the tbody)
      let cell = row.cells[j];
      if (k === pinnedLabel) {
        cell.className = e[k] ? pinState.classPinned : pinState.classPin;
        cell.id = `fuzzSaveToggle-${id}`;
        cell.setAttribute("aria-label", e[k] ? "pinned" : "pin");
        cell.innerHTML = e[k] ? pinState.htmlPinned : pinState.htmlPin;
      } else if (k === idLabel) {
        id = parseInt(e[k]);
        row.setAttribute("id", id);
        --j; // don't count this column (hidden)
      } else if (k === correctLabel) {
        let cell1 = row.cells[j];
        let cell2 = row.cells[j + 1];
        let cell3 = row.cells[j + 2];

        // Set to default initially
        cell1.className = correctState.classCheckOff;
        // cell1.setAttribute("cellId", id);
        cell1.setAttribute("onOff", false);
        cell2.className = correctState.classErrorOff;
        cell2.setAttribute("onOff", false);
        cell3.className = correctState.classQuestionOff;
        cell3.setAttribute("onOff", false);
        // Check if any are on
        if (e[k] === "none") {
          // noop
        } else if (e[k] === "check") {
          cell1.className = correctState.classCheckOn;
          cell1.setAttribute("onOff", true);
          resultsData.results[id].correct = e[k];
        } else if (e[k] === "error") {
          cell2.className = correctState.classErrorOn;
          cell2.setAttribute("onOff", true);
        } else if (e[k] === "question") {
          cell3.className = correctState.classQuestionOn;
          cell3.setAttribute("onOff", true);
        } else {
          assert(false);
        }
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
