// import {
//   ArgDef,
//   ArgOptionOverrides,
//   ArgOptions,
//   ArgType,
// } from "../../src/fuzzer/analysis/typescript/ArgDef";

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

// Sort order for each grid and column vvvvvvvvvvvvvvvvvvvvvvvv
const sortOrder = ["asc", "desc", "none"];
function getDefaultColumnSortOrder() {
  return { pinned: "desc" }; //!!!!!!supposed to say desc
}
// Data structure object we created on the spot:
const columnSortOrders = {
  timeout: getDefaultColumnSortOrder(),
  exception: getDefaultColumnSortOrder(),
  badOutput: getDefaultColumnSortOrder(),
  passed: getDefaultColumnSortOrder(),
};
// ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

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

  // Load and save the state back to the webview.  There does not seem to be
  // an 'official' way to directly persist state within the extension itself,
  // at least as of vscode 1.69.2.  Hence, the roundtrip.
  vscode.setState(
    JSON5.parse(
      htmlUnescape(document.getElementById("fuzzPanelState").innerHTML)
    )
  );

  // Thinking we start here...
  // Actually, we already have `data` set up, so probably later on

  // Fill the result grids
  if (Object.keys(resultsData).length) {
    const data = {}; // !!!!!!!!!used to be `const data = {}`
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

      //console.log("Elapsed time:" + e.elapsedTime);

      // Toss each result into the appropriate grid
      if (e.passed) {
        data["passed"].push({
          ...id,
          ...inputs,
          ...outputs,
          //"running time (ms)": JSON5.stringify(e.elapsedTime), // convert to string
          "running time (ms)": e.elapsedTime.toFixed(3), // converts to string
          ...pinned,
        });
      } else {
        if (e.exception) {
          data["exception"].push({
            ...id,
            ...inputs,
            exception: e.exceptionMessage,
            "running time (ms)": e.elapsedTime.toFixed(3), // converts to string
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

    // Thinking maybe here: vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv

    // Fill the grids with data
    // (note: forEach() performs an action on every element of the array)
    gridTypes.forEach((type) => {
      if (data[type].length) {
        //document.getElementById(`fuzzResultsGrid-${type}`).rowsData = data[type];
        const thead = document.getElementById(`fuzzResultsGrid-${type}-thead`);
        // Note: I'm changing this so that I can replace the tbody later
        // (tbody used to be a const variable)
        //const tbody = document.getElementById(`fuzzResultsGrid-${type}-tbody`);

        // Render the header row//////////////////////////////////////////////////////////////////
        const hRow = thead.appendChild(document.createElement("tr"));
        Object.keys(data[type][0]).forEach((k) => {
          if (k === pinnedLabel) {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.className = "fuzzGridCellPinned";
            cell.innerHTML = `<big>pin</big>`;
            cell.addEventListener("click", () => {
              // NOTE: don't forget to change this!!!!!!!!!!!!!!
              handleColumnSort(
                type,
                k,
                data,
                document.getElementById(`fuzzResultsGrid-${type}-tbody`)
              );
              //var empty_tbody = document.createElement("tbody");
              //tbody = empty_tbody;
            }); //the event listener
            // will "listen" for click on the column header
          } else if (k === idLabel) {
            // noop
          } else {
            const cell = hRow.appendChild(document.createElement("th"));
            cell.innerHTML = `<big>${htmlEscape(k)}</big>`;
            cell.addEventListener("click", () => {
              // tbody.remove();
              handleColumnSort(
                type,
                k,
                data,
                document.getElementById(`fuzzResultsGrid-${type}-tbody`)
              );
              // displayTableBody(data, tbody); //moved this into other function

              // var empty_tbody = document.createElement("tbody");
              // for (
              //   var cn = tbody.childNodes, l = cn.length, i = 0;
              //   i < l;
              //   i++
              // ) {
              //   cn[i].parentNode.removeChild(cn[i]);
              // }
              // tbody.remove(); //This works!!!!!!!

              // document.replaceChild(empty_tbody, tbody); //Uncaught DOMException: Failed to execute 'replaceChild' on 'Node': The node to be replaced is not a child of this node.
            });
            //console.log(data[type]);
          }
        });

        // Render the data rows
        var tbody = document.getElementById(`fuzzResultsGrid-${type}-tbody`);
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

        // const empty_tbody = document.createElement("tbody");
      }
    });
  } // (the end of the if statement)
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
      command: pinning ? "test.pin" : "test.unpin", //or
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

function handleColumnSort(type, col, data, oldTbody) {
  /**
   * TO DO:
   *
   * Currently simplified version, need to include the for loop to go through all the
   * columns (for a given tab).
   *
   * Figure out how to update the screen after sorting.
   *
   * Come up with way to deal with sorting different types of objects.
   *
   * Then: Also need to make use of data structure, allow user to keep clicking and clicking,
   * do more stuff with UI, etc.
   */

  console.log(data[type]);

  data[type].sort((a, b) => {
    var aType;
    //If the values are not numeric, then we should sort alphabetically
    //  (Would it make more sense to sort strings by length?)    console.log("typeof a[col]:", typeof a[col]);
    try {
      aType = typeof JSON.parse(a[col]);
    } catch (error) {
      aType = "string"; //sort alphabetically
    }
    // if (Number(a[col]).toString() == "NaN") {
    //   aType = "string";
    //   console.log("it's a string-------");
    //   // Here, it could be a string, or it could also be a bool (alphabetically probably is
    //   // still okay?), or it could be one of the exceptions (NaN, null, undefined, etc)
    // } else aType = typeof JSON.parse(a[col]);

    /**
     * NOTE: Doesn't work for arrays of strings/literal objects
     * (currently sorting alphabetically, not by length)
     *
     * It does work for arrays of numbers
     *
     * Don't think it's working for the pinned column (or maybe it is..)
     *
     * Can we assume that a and b have the same type? Not always
     */
    switch (aType) {
      case "string":
        console.log("string");
        a = a[col];
        b = b[col];
        break;
      case "number":
        console.log("number");
        a = Number(a[col]);
        b = Number(b[col]);
        break;
      case "object":
        console.log("object:");
        //trying to sort by length in this case...
        //(assuming options here are array vs literal object)
        if (a[col].length) {
          console.log("array");
          //Means it's an array
          a = a[col].length;
          b = b[col].length;
        } else {
          console.log("literal object");
          //Means it's a literal object
          a = Object.keys(a[col]).length;
          b = Object.keys(b[col]).length;
          break;
        }
    }

    // if (aType == "number") {
    //   console.log("number");
    //   a = Number(a[col]);
    //   b = Number(b[col]);
    // } else if (aType == "object") {
    //   //trying to sort by length in this case...
    //   if (a[col].length) {
    //     console.log("array");
    //     //means it's an array, assuming options are array vs literal object
    //     a = a[col].length;
    //     b = b[col].length;
    //   } else {
    //     console.log("literal object");
    //     //means it's a literal object, assuming options are array vs literal object
    //     a = Object.keys(a[col]).length;
    //     b = Object.keys(b[col]).length;
    //   }
    // }
    // //Otherwise, assume it's a string or bool
    // else console.log("string or bool");

    /*
    if (Number(a) != NaN) {
      console.log("Number(a) != NaN, meaning it's a number");
      console.log("a:", a);
      //a and b are currently objects
      // console.log(Object.prototype.toString.call(a)); //yields [object Object]
      // console.log(Object.prototype.toString.call(new FormData()));
      // console.log(
      //   Object.prototype.toString.call(new FormData()) === "[object FormData]"
      // );
      a = Number(a[col]);
      b = Number(b[col]);
    } else console.log("it's not a number");
    */

    if (a === b) {
      return 0; //same
    } else if (a > b) {
      return 2; //a > b
    } else {
      return -2; //a < b
    }

    // for (col in columnSortOrders["passed"]) {
    //   //console.log("for (col in columnSortOrders['passed'])");
    //   if (a[col] === b[col]) return 0; //same
    //   else if (a[col] > b[col]) return -2; //a > b
    //   else return 2; //a < b
    // }
  });
  console.log("..finished sort function..");
  console.log("AFTER:", data[type]);

  displayTableBody(data, oldTbody, type);

  //What we want is data[type], which will be an array of the bracket objects
  //Each bracket object corresponds to 1 test:
  //{id: 0, input: __, output: "NaN", pinned = true, running time = ".5"}

  // Get the test data for the test case
  // Get the control that was clicked
  // Are we pinning or unpinning the test?
  // Disable the control while we wait for the response
  // Send the request to the extension
} // fn: handleColumnSort

/**
 * NOTE:
 * Current status: Not correct - can sort it once and update the screen, but cannot do multiple times.
 * */
function displayTableBody(data, oldTbody, type) {
  // Making me add these, which are defined in the main function:
  const pinnedLabel = "pinned";
  const idLabel = "id";

  // oldTbody.remove();
  let tbId = -1;

  // Fill the grids with data
  //gridTypes.forEach((type) => {
  if (data[type].length) {
    //document.getElementById(`fuzzResultsGrid-${type}`).rowsData = data[type];
    //////// const tbody = document.getElementById(`fuzzResultsGrid-${type}-tbody`); //Don't know how to make this work - need unique ID
    ++tbId;
    let table = oldTbody.parentNode;
    let tbody = document.createElement("tbody");
    console.log(oldTbody.parentNode);
    oldTbody.remove();
    table.appendChild(tbody);
    tbody.setAttribute("id", oldTbody.getAttribute("id"));

    console.log(tbody.parentNode);
    // Now we've created a new table body ^^^

    // Render the data rows
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
    // console.log(oldTbody);
    // console.log(tbody);
    // console.log(oldTbody.parentNode);
    // oldTbody.parentNode.replaceChild(tbody, oldTbody);
    // tbody = document.getElementById(`fuzzResultsGrid-${type}-tbody`); //Don't think this is doing anything
  }

  // oldTbody.remove();
  //});
}

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
