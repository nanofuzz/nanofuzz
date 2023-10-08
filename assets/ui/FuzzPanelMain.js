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
];

// Column name labels
const pinnedLabel = "pinned";
const idLabel = "id";
const correctLabel = "correct output?";
const expectedLabel = "expectedOutput";
const validatorLabel = "validator";
const elapsedTimeLabel = "running time (ms)";

// Pin button states
const pinState = {
  htmlPinned: `<span class="codicon codicon-pinned"></span>`,
  htmlPin: `<span class="codicon codicon-pin"></span>`,
  classPinned: "fuzzGridCellPinned",
  classPin: "fuzzGridCellPin",
};

// Implicit Oracle Validator Name
const implicitOracleValidatorName = "none";

// Correct icon states
const correctState = {
  htmlCheck: `<span class="codicon codicon-pass"></span>`, // check in circle
  htmlError: `<span class="codicon codicon-error"></span>`, // X in circle
  //htmlQuestion: `<span class="codicon codicon-question"></span>`, // ? in circle

  classCheckOn: "classCheckOn",
  classCheckOff: "classCheckOff",
  classErrorOn: "classErrorOn",
  classErrorOff: "classErrorOff",
  //classQuestionOn: "classQuestionOn",
  //classQuestionOff: "classQuestionOff",
};

// Correct icon sorting values
const correctVals = {
  check: 0,
  error: 1,
  //question: 2,
  none: 3,
};

// Sort order for each grid and column
const sortOrder = ["asc", "desc", "none"];
function getDefaultColumnSortOrder() {
  return { pinned: "desc" };
}
const defaultColumnSortOrders = {
  failure: {}, // no pinned column
  timeout: getDefaultColumnSortOrder(),
  exception: getDefaultColumnSortOrder(),
  badValue: getDefaultColumnSortOrder(),
  ok: getDefaultColumnSortOrder(),
  disagree: getDefaultColumnSortOrder(),
};

// Column sort orders (filled by main or handleColumnSort())
let columnSortOrders;
// Fuzzer Results (filled by main during load event)
let resultsData;
// Validator functions (filled by main during load event)
let validators;

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

  // Load the fuzzer results data from the HTML
  resultsData = JSON5.parse(
    htmlUnescape(document.getElementById("fuzzResultsData").innerHTML)
  );

  // Add event listener for the validator buttons
  document
    .getElementById("validator.add")
    .addEventListener("click", (e) => handleAddValidator(e));
  document
    .getElementById(`validator.getList`)
    .addEventListener("click", (e) => handleGetListOfValidators(e));

  // Load & display the validator functions from the HTML
  const validators = JSON5.parse(
    htmlUnescape(document.getElementById("validators").innerHTML)
  );
  refreshValidators(validators);

  // Load column sort orders from the HTML
  let message = JSON5.parse(
    htmlUnescape(document.getElementById("fuzzSortColumns").innerHTML)
  );
  if (Object.keys(message).length === 0) {
    columnSortOrders = defaultColumnSortOrders;
  } else {
    columnSortOrders = JSON.parse(JSON.stringify(message));
  }

  // Listen for messages from the extension
  window.addEventListener("message", (event) => {
    const { command, json } = event.data;
    console.debug(
      "Message received: " + JSON5.stringify(command) + ": " + json
    );
    switch (command) {
      case "validator.list":
        refreshValidators(JSON5.parse(json));
        break;
    }
  });

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

      // Human validation expectation and result
      const passedHuman = { [correctLabel]: e.passedHuman };
      const expectedOutput = {
        [expectedLabel]: e.expectedOutput,
      };

      // Customer validator result (if a customer validator was used)
      const passedValidator =
        validators.validator !== implicitOracleValidatorName
          ? { [validatorLabel]: e.passedValidator }
          : {};

      // Test case runtime
      const elapsedTime = {
        [elapsedTimeLabel]: e.elapsedTime.toFixed(3),
      };

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
      if (e.validatorException) {
        outputs[`validator exception`] = e.validatorExceptionMessage;
      } else if (e.exception) {
        outputs[`exception`] = e.exceptionMessage;
      }
      if (e.timeout) {
        outputs[`timeout`] = "timeout";
      }

      // Toss each result into the appropriate grid
      if (e.category === "failure") {
        data[e.category].push({
          ...id,
          ...inputs,
          ...outputs, // Exception message contained in outputs
        });
      } else {
        data[e.category].push({
          ...id,
          ...inputs,
          ...outputs,
          //...elapsedTimes,
          ...passedValidator,
          ...passedHuman,
          ...pinned,
          ...expectedOutput,
        });
      }
    } // for: each result

    // Fill the grids with data
    gridTypes.forEach((type) => {
      if (data[type].length) {
        const thead = document.getElementById(`fuzzResultsGrid-${type}-thead`);
        const tbody = document.getElementById(`fuzzResultsGrid-${type}-tbody`);

        // Render the header row
        const hRow = thead.appendChild(document.createElement("tr"));
        Object.keys(data[type][0]).forEach((k) => {
          if (k === pinnedLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.style = "text-align: center";
            cell.className = "fuzzGridCellPinned";
            cell.innerHTML = `<big>pin</big>`;
            cell.setAttribute("class", "columnSortDesc");
            cell.addEventListener("click", () => {
              handleColumnSort(cell, hRow, type, k, data, tbody, true);
            });
          } else if (k === idLabel) {
            // noop
          } else if (k === expectedLabel) {
            // noop
          } else if (k === correctLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.className = "colorColumn";
            cell.innerHTML = `<big><span class="codicon codicon-person"></span></big>`;
            cell.colSpan = 2;
            cell.addEventListener("click", () => {
              handleColumnSort(cell, hRow, type, k, data, tbody, true);
            });
          } else if (k === validatorLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.className = "colorColumn";
            cell.innerHTML = `<big><span class="codicon codicon-hubot"></span></big>`;
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
        }); // for each column k

        // Render the data rows, set up event listeners
        drawTableBody(data, type, tbody, false);

        // Initial sort, according to columnSortOrders
        let hRowIdx = 0;
        for (let k = 0; k < Object.keys(data[type][0]).length; ++k) {
          let col = Object.keys(data[type][0])[k];
          let cell = hRow.cells[hRowIdx];
          if (col === idLabel || col === expectedLabel) {
            continue;
          }
          handleColumnSort(cell, hRow, type, col, data, tbody, false);
          ++hRowIdx;
        }
      } // if (data[type].length)
    }); // for each type (e.g. bad output, passed)
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
 * Toggles whether a test is pinned for CI and the next test run.
 *
 * @param id offset of test in resultsData
 * @param type grid type (e.g., passed, invalid)
 * @param data the back-end data structure
 */
function handlePinToggle(id, type, data) {
  const index = data[type].findIndex((element) => element.id == id);
  if (index <= -1) throw e("invalid id");

  // Get the control that was clicked
  const button = document.getElementById(`fuzzSaveToggle-${id}`);

  // Are we pinning or unpinning the test?
  const pinning = button.innerHTML === pinState.htmlPin;
  data[type][index][pinnedLabel] = pinning;

  // Get the test data for the test case
  const testCase = {
    input: resultsData.results[id].input,
    output: resultsData.results[id].output,
    pinned: data[type][index][pinnedLabel],
    //correct: data[type][index][correctLabel],
  };
  if (data[type][index][expectedLabel]) {
    testCase.expectedOutput = data[type][index][expectedLabel];
  }

  // Disable the control while we wait for the response
  button.disabled = true;

  // Send the request to the extension
  window.setTimeout(() => {
    vscode.postMessage({
      command: pinning ? "test.pin" : "test.unpin",
      json: JSON5.stringify(testCase),
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
 * Toggles the correct icons on or off (check mark, X mark, question mark).
 *
 * @param button icon that was clicked
 * @param row current row
 * @param data backend data structure
 * @param type e.g. bad output, passed
 * @param tbody table body for 'type'
 * @param cell1 check icon
 * @param cell2 error icon
 */
function handleCorrectToggle(
  button,
  row,
  data,
  type,
  tbody,
  cell1,
  cell2
  //cell3
) {
  const id = row.getAttribute("id");
  const index = data[type].findIndex((element) => element.id == id);
  if (index <= -1) throw e("invalid id");

  // Change the state of the correct icon that was clicked
  // Only one icon should be selected at a time; if an icon is turned on, all
  // others should be turned off
  switch (button.className) {
    case correctState.classCheckOn:
      // clicking check off
      button.className = correctState.classCheckOff;
      button.setAttribute("onOff", "false");
      data[type][index][correctLabel] = undefined;
      // delete saved expected value
      delete data[type][index][expectedLabel];
      console.debug("correctState.classCheckOn"); // !!!!!
      break;

    case correctState.classErrorOn:
      // clicking error off
      button.className = correctState.classErrorOff;
      button.setAttribute("onOff", "false");
      data[type][index][correctLabel] = undefined;
      // delete saved expected value
      delete data[type][index][expectedLabel];
      console.debug("correctState.classErrorOn"); // !!!!!
      break;
    /*
    case correctState.classQuestionOn:
      // clicking question off
      button.className = correctState.classQuestionOff;
      button.setAttribute("onOff", false);
      data[type][index][correctLabel] = "none";
      break;
    */

    case correctState.classCheckOff:
      // clicking check on
      button.className = correctState.classCheckOn;
      button.setAttribute("onOff", "true");
      data[type][index][correctLabel] = "true";
      // turn others off
      cell2.className = correctState.classErrorOff;
      cell2.setAttribute("onOff", "false");
      //cell3.className = correctState.classQuestionOff;
      //cell3.setAttribute("onOff", false);
      //save expected output value
      data[type][index][expectedLabel] = resultsData.results[id].output;
      console.debug("correctState.classCheckOff"); // !!!!!

      break;

    case correctState.classErrorOff:
      // clicking error on
      button.className = correctState.classErrorOn;
      button.setAttribute("onOff", "true");
      data[type][index][correctLabel] = "false";
      // turn others off
      cell1.className = correctState.classCheckOff;
      cell1.setAttribute("onOff", "false");
      //cell3.className = correctState.classQuestionOff;
      //cell3.setAttribute("onOff", false);
      //save expected output value
      // !!!!!data[type][index][expectedLabel] = data[type][index]["output"]; //How am I doing this????????
      console.debug("correctState.classErrorOff"); // !!!!!
      break;
    /*
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
      // delete saved expected value
      delete data[type][index][expectedLabel];
      break;
    */
  }

  // Redraw table !!!!! Do we need to do this?
  drawTableBody(data, type, tbody, true, button);

  const onOff = JSON.parse(button.getAttribute("onOff"));
  const pinCell = document.getElementById(`fuzzSaveToggle-${id}`);
  const isPinned = pinCell.className === pinState.classPinned;

  // Get the test data for the test case
  const testCase = {
    input: resultsData.results[id].input,
    output: resultsData.results[id].output,
    pinned: isPinned,
    //correct: data[type][index][correctLabel],
    expectedOutput: data[type][index][expectedLabel],
  };
  console.debug("testCase: " + JSON5.stringify(testCase)); // !!!!

  // !!!! If switching from ErrorOn state, we may not want to wait
  // until we have an expected value prior to generating a test case

  // Disable the control while we wait for the response
  button.disabled = true;

  // Send the request to the extension
  window.setTimeout(() => {
    vscode.postMessage({
      command: onOff ? "test.pin" : "test.unpin",
      json: JSON5.stringify(testCase),
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
 * @param type (timeout, exception, badValue, ok, etc.)
 * @param col (ex: input:a, output, pin)
 * @param data backend data structure
 * @param tbody table body
 * @param isClicking bool determining if the function is being called because the user
 * clicked on a column, or if an initial sort is occurring
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
  const cols = [column];
  if (!isClicking && type !== "failure") {
    cols.push(correctLabel, pinnedLabel);
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
            a = (a[col] ?? "").length;
            b = (b[col] ?? "").length;
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
  drawTableBody(data, type, tbody, false);

  // Send message to extension (so that the sort order is retained if you click
  // 'Test' again)
  if (isClicking) {
    vscode.postMessage({
      command: "columns.sorted",
      json: JSON5.stringify(columnSortOrders),
    });
  }
} // fn: handleColumnSort`

/**
 * For a given type, set columns arrows to 'none', unless the column is
 * the current column being sorted by. The 'pinned' column is a special case
 *
 * @param hRow header row
 * @param type (timeout, exception, badValue, ok)
 * @param thisCol the current column being sorted by
 * @param data
 */
function resetOtherColumnArrows(hRow, type, thisCol, data) {
  // For a given type, iterate over the columns (ex: input a, output, pin)
  let hRowIdx = 0;
  for (let k = 0; k < Object.keys(data[type][0]).length; ++k) {
    let col = Object.keys(data[type][0])[k];
    let cell = hRow.cells[hRowIdx];
    if (col === "id" || col === expectedLabel) {
      continue; // hidden
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
 * @param type (timeout, exception, badValue, ok, etc.)
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
      currIndex = 0; // index in [asc, desc, none]
    }
  } else {
    // If currOrder is already defined and the user clicked on a column,
    // change the sorting direction to the next value in the cycle
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
 * Draw table body and fill in with values from data[type]. Add event listeners
 * for pinning, toggling correct icons
 *
 * @param data backend data structure
 * @param type e.g. bad output, passed, etc
 * @param tbody table body
 */
function drawTableBody(data, type, tbody, isClicking, button) {
  // Clear table
  while (tbody.rows.length > 0) tbody.deleteRow(0);

  // For each entry in data[type]
  data[type].forEach((e) => {
    let id = -1;
    const row = tbody.appendChild(document.createElement("tr"));
    Object.keys(e).forEach((k) => {
      if (k === pinnedLabel) {
        const cell = row.appendChild(document.createElement("td"));
        // Add pin icon
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
      } else if (k === expectedLabel) {
        // noop
      } else if (k === validatorLabel) {
        const cell = row.appendChild(document.createElement("td"));
        if (e[k] === undefined) {
          cell.innerHTML = "";
        } else if (e[k]) {
          cell.className = "classCheckOn";
          const span = cell.appendChild(document.createElement("span"));
          span.className = "codicon codicon-pass";
        } else {
          cell.className = "classErrorOn";
          const span = cell.appendChild(document.createElement("span"));
          span.className = "codicon codicon-error";
        }
      } else if (k === correctLabel) {
        // Add check mark icon
        const cell1 = row.appendChild(document.createElement("td"));
        cell1.innerHTML = correctState.htmlCheck;
        cell1.setAttribute("correctType", "true");
        cell1.addEventListener("click", () =>
          handleCorrectToggle(
            cell1,
            row,
            data,
            type,
            tbody,
            cell1,
            cell2
            //cell3
          )
        );
        // Add X mark icon
        const cell2 = row.appendChild(document.createElement("td"));
        cell2.innerHTML = correctState.htmlError;
        cell2.setAttribute("correctType", "false");
        cell2.addEventListener("click", () =>
          handleCorrectToggle(
            cell2,
            row,
            data,
            type,
            tbody,
            cell1,
            cell2
            //cell3
          )
        );
        // Add question mark icon
        /*
        const cell3 = row.appendChild(document.createElement("td"));
        cell3.innerHTML = correctState.htmlQuestion;
        cell3.setAttribute("correctType", "question");
        cell3.addEventListener("click", () =>
          handleCorrectToggle(
            cell3,
            row,
            data,
            type,
            tbody,
            cell1,
            cell2,
            cell3
          )
        );
        */
        // Determine if on or off (set to default initially)
        cell1.className = correctState.classCheckOff;
        cell1.setAttribute("onOff", false);

        cell2.className = correctState.classErrorOff;
        cell2.setAttribute("onOff", false);
        //cell3.className = correctState.classQuestionOff;
        //cell3.setAttribute("onOff", false);

        // Update the front-end buttons to match the back-end state
        switch (e[k] + "") {
          case undefined:
            break;
          case "true":
            cell1.className = correctState.classCheckOn;
            cell1.setAttribute("onOff", "true");
            handleExpectedOutput(data, type, row, tbody, isClicking, button);
            break;
          case "false":
            cell2.className = correctState.classErrorOn;
            cell2.setAttribute("onOff", "true");
            handleExpectedOutput(data, type, row, tbody, isClicking, button);
            // !!!! We should unhide the expected value in the call above
            break;
          /*
          case "question":
            cell3.className = correctState.classQuestionOn;
            cell3.setAttribute("onOff", true);
            break;
          */
        }
      } else {
        const cell = row.appendChild(document.createElement("td"));
        cell.innerHTML = htmlEscape(e[k]);
      }
    });
  });
} //fn: drawTableBody()

/**
 * Checks if actual output matches expected output (based on correct icons selected).
 * If not, shows error message.
 * Assumes that either the check or error icon is selected.
 *
 * @param data backend data structure
 * @param type e.g. bad output, passed
 * @param row row of tbody
 * @param tbody table body for 'type'
 */
function handleExpectedOutput(data, type, row, tbody, isClicking, button) {
  const id = row.getAttribute("id");
  let toggledId;
  if (isClicking) toggledId = button.parentElement.getAttribute("id");

  const index = data[type].findIndex((element) => element.id == id);
  if (index <= -1) {
    throw e("invalid id");
  }
  const correctType = data[type][index][correctLabel];
  const numInputs = resultsData.results[id].input.length;

  // If actual output does not match expected output, show expected/actual output
  if (correctType + "" === "false") {
    const expectedRow = tbody.appendChild(document.createElement("tr"));
    const cell = expectedRow.appendChild(document.createElement("td"));
    cell.colSpan = row.cells.length;

    if (isClicking && id === toggledId) {
      // If marked X and it's the row being clicked on, ask for expected output
      expectedRow.className = "classGetExpectedOutputRow";
      cell.innerHTML = expectedOutputHtml(id, index, data, type);

      const textField = document.getElementById(`fuzz-expectedOutput${id}`);
      textField.addEventListener("change", (e) =>
        handleSaveExpectedOutput(textField, id, data, type, index)
      );

      const radioTimeout = document.getElementById(`fuzz-radioTimeout${id}`);
      radioTimeout.addEventListener("change", () =>
        handleSaveExpectedOutput(radioTimeout, id, data, type, index)
      );

      const radioException = document.getElementById(
        `fuzz-radioException${id}`
      );
      radioException.addEventListener("change", () =>
        handleSaveExpectedOutput(radioException, id, data, type, index)
      );

      const radioValue = document.getElementById(`fuzz-radioValue${id}`);
      radioValue.addEventListener("change", () =>
        handleSaveExpectedOutput(radioValue, id, data, type, index)
      );
      if (radioValue.getAttribute("current-checked") === "true") {
        textField.focus();
      }
    } else {
      console.debug("handleExpectedOutput() else branch"); // !!!!!
      // Marked X but not currently being edited; display expected output
      row.cells[numInputs].className = "classErrorCell"; // red box
      expectedRow.className = "classErrorExpectedOutputRow";
      resultsData.results[id];

      const expectedOutput = data[type][index][expectedLabel];
      if (expectedOutput && expectedOutput.length) {
        if (expectedOutput[0].isTimeout) {
          cell.innerHTML = `Failed: expected timeout`;
        } else if (expectedOutput[0].isException) {
          cell.innerHTML = `Failed: expected exception`;
        } else {
          cell.innerHTML = `Failed: expected output: ${JSON5.stringify(
            expectedOutput[0].value
          )}`;
        }
      } else {
        cell.innerHTML = `Failed: expected no output`;
      }
    }
  }
}

/**
 * HTML for X icon expected output row. Adds radio buttons for operator
 * type -- 'not equal' (default), 'equal'. Adds text field for expected output
 *
 * @param id id of row
 * @param index index in `data`
 * @param data back-end data structure
 * @param type e.g. bad output, passed
 */
function expectedOutputHtml(id, index, data, type) {
  const expectedOutput = data[type][index][expectedLabel];
  let defaultOutput;

  if (expectedOutput && expectedOutput.length) {
    defaultOutput = expectedOutput[0];
  } else {
    defaultOutput = { value: "" };
  }

  // prettier-ignore
  let html = /*html*/ `
    What is the expected ouput?
    <vscode-radio-group>
    <vscode-radio id="fuzz-radioException${id}" ${defaultOutput.isException ? "checked" : ""}>Exception</vscode-radio>
    <vscode-radio id="fuzz-radioTimeout${id}" ${defaultOutput.isTimeout ? "checked" : ""}>Timeout</vscode-radio>
    <vscode-radio id="fuzz-radioValue${id}" ${!defaultOutput.isTimeout && !defaultOutput.isException ? "checked" : ""} >Value:</vscode-radio>
    </vscode-radio-group> 

    <vscode-text-field id="fuzz-expectedOutput${id}" placeholder="Literal value (JSON)" value=${JSON5.stringify(defaultOutput.value)}>
    </vscode-text-field>
    `;
  return html;
}

/**
 * If the check mark icon is selected, verify that the actual output and expected output
 * are equal. If the X icon is selected, verify that the actual output and expected output
 * are not equal.
 * @param id
 * @param type
 * @param data
 * @returns
 */
function sameExpectedOutput(index, type, data, correctType) {
  // !!!!!
  const actualOut = data[type][index]["output"];
  const expectedOut = data[type][index][expectedLabel];

  let actualType, expectedType;
  try {
    actualType = typeof JSON.parse(actualOut);
  } catch (error) {
    actualType = "string";
  }
  try {
    expectedType = typeof JSON.parse(expectedOut);
  } catch (error) {
    expectedType = "string";
  }

  if (correctType === "true") {
    return actualOut === expectedOut && actualType === expectedType;
  } else if (correctType === "false") {
    return actualOut !== expectedOut || actualType !== expectedType;
  } else {
  }
} // fn: sameExpectedOutput()

/**
 * Saves the value of the expected output typed into the text field.
 *
 * @param e on-change event
 * @param id id of row
 * @param data back-end data structure
 * @param type e.g. bad output, passed
 * @param index index in `data`
 */
function handleSaveExpectedOutput(e, id, data, type, index) {
  const textField = document.getElementById(`fuzz-expectedOutput${id}`);
  const radioTimeout = document.getElementById(`fuzz-radioTimeout${id}`);
  const radioException = document.getElementById(`fuzz-radioException${id}`);

  // Build the expected output object
  const expectedOutput = {
    name: "0",
    offset: 0,
  };
  try {
    textField.classList.add("classErrorCell");
    const expectedValue = textField.getAttribute("current-value");
    if (expectedValue === null || expectedValue === "undefined") {
      expectedOutput["value"] = "undefined";
    } else {
      expectedOutput["value"] = JSON5.parse(expectedValue);
    }
    textField.classList.remove("classErrorCell");
  } catch (e) {
    console.debug(`Error processing user data: ${e.message}`); // !!!!!
    // continue -- we turned the box red
  }
  if (radioTimeout.checked) {
    expectedOutput["isTimeout"] = true;
    textField.classList.remove("classErrorCell");
  } else if (radioException.checked) {
    expectedOutput["isException"] = true;
    textField.classList.remove("classErrorCell");
  }

  // Update the front-end data structure
  data[type][index][expectedLabel] = [expectedOutput];

  // Build the test case object
  const testCase = {
    input: resultsData.results[id].input,
    output: resultsData.results[id].output,
    pinned: data[type][index][pinnedLabel],
    //correct: data[type][index][correctLabel],
    expectedOutput: data[type][index][expectedLabel],
  };

  // Send the test case to the extension
  window.setTimeout(() => {
    vscode.postMessage({
      command: "test.pin",
      json: JSON5.stringify(testCase),
    });
  });
} // fn: handleSaveExpectedOutput()

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
 * Refreshes the displayed list of validtors based on a list of
 * validators provided from the back-end.
 *
 * @param {*} object of type: {
 *  validator?: string,   // selected custom validator
 *  validators: string[], // list of available custom validators
 * }
 */
function refreshValidators(validatorList) {
  // If no default validator is selected or the selected validator does not
  // exist, then select the implicit validator
  if (
    "validator" in validatorList &&
    validatorList.validator !== undefined &&
    validatorList.validators.some((e) => e === validatorList.validator)
  ) {
    // noop; we have a valid validator
  } else {
    validatorList.validator = implicitOracleValidatorName;
  }

  // Clear the current list of validator radio buttons
  const validatorFnGrp = document.getElementById("validatorFunctions");
  const deleteList = [];
  for (const child of validatorFnGrp.children) {
    if (child.tagName === "VSCODE-RADIO") {
      deleteList.push(child);
    }
  }
  deleteList.forEach((e) => validatorFnGrp.removeChild(e));

  // Add buttons w/event listeners for each validator
  [implicitOracleValidatorName, ...validatorList.validators]
    .reverse() // because of pre-pending before add and refresh buttons
    .forEach((name) => {
      // The implicit oracle has a special display name
      const displayName =
        name === implicitOracleValidatorName ? "(none)" : `${name}()`;

      // Create the radio button
      const radio = document.createElement("vscode-radio");
      radio.setAttribute("id", `validator-${name}`);
      radio.setAttribute("name", name);
      radio.setAttribute("value", name);
      radio.innerHTML = displayName;
      if (name === validatorList.validator) {
        radio.setAttribute("checked", "true");
      }

      // Add the radio button to the radio group
      validatorFnGrp.prepend(radio);

      // Add the onClick event handler
      radio.addEventListener("click", (e) => handleSetValidator(e));
    });

  // Set the radio group's value b/c this is necessary to maintain
  // consistent button state when a selected radio is deleted
  validatorFnGrp.setAttribute("value", validatorList.validator);
} // fn: refreshValidators

/**
 * Send message to back-end to add code skeleton to source code (because the
 * user clicked the customValidator button)
 *
 * @param e on-click event
 */
function handleAddValidator(e) {
  vscode.postMessage({
    command: "validator.add",
    json: JSON5.stringify(""),
  });
}

/**
 * Send message to back-end to save the validator that the user selected
 * using the radio buttons
 *
 * @param e on-click event
 */
function handleSetValidator(e) {
  const validatorName = e.currentTarget.getAttribute("name");

  vscode.postMessage({
    command: "validator.set",
    json: JSON5.stringify(
      validatorName === implicitOracleValidatorName ? "" : validatorName
    ),
  });
}

/**
 * Send message to back-end to refresh the validators
 *
 * @param e on-click event
 */
function handleGetListOfValidators(e) {
  vscode.postMessage({
    command: "validator.getList",
    json: "{}",
  });
}

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
