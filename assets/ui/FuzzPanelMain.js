const vscode = acquireVsCodeApi();

window.addEventListener("load", main);

// !!!
const gridTypes = ["timeout", "exception", "badOutput", "passed"];

// !!!
function main() {
  // Add event listener for the fuzz.start button
  document
    .getElementById("fuzz.start")
    .addEventListener("click", (e) => handleFuzzStart(e));

  // Add event listener for the fuzz.options button
  document
    .getElementById("fuzz.options")
    .addEventListener("click", (e) => toggleFuzzOptions(e));

  // Add event listeners to the grid type filters
  gridTypes.forEach((type) => {
    document
      .getElementById(`link-${type}`)
      ?.addEventListener("click", (e) => showGrid(type));
  });

  // Load the data from the HTML
  const resultsData = JSON.parse(
    document.getElementById("fuzzResultsData").innerHTML
  );

  // Get the results grid object
  const resultsGrid = document.getElementById("fuzzResultsGrid");

  // Fill the result grids
  if (Object.keys(resultsData).length) {
    const data = {};
    gridTypes.forEach((type) => {
      data[type] = [];
    });

    for (const e of resultsData.results) {
      const inputs = {};
      e.input.forEach((i) => {
        inputs[`input-${i.name}`] =
          i.value === undefined ? "undefined" : JSON.stringify(i.value);
      });
      const outputs = {};
      e.output.forEach((o) => {
        outputs[`output-${o.name}`] =
          o.value === undefined ? "undefined" : JSON.stringify(o.value);
      });

      e.output !== undefined && e.output.length === 1
        ? JSON.stringify(e.output[0].value)
        : JSON.stringify(e.output.map((f) => f.value));

      if (e.passed) {
        data["passed"].push({ ...inputs, ...outputs });
      } else {
        if (e.exception) {
          data["exception"].push({ ...inputs, exception: e.exceptionMessage });
        } else if (e.timeout) {
          data["timeout"].push({ ...inputs });
        } else {
          data["badOutput"].push({ ...inputs, ...outputs });
        }
      }
    }

    let setVisibleYet = false; // only allow one visible grid
    gridTypes.forEach((type) => {
      document.getElementById(`fuzzResultsGrid-${type}`).rowsData = data[type];
      if (data[type].length && !setVisibleYet) {
        document.getElementById(type).style.display = "block";
        setVisibleYet = true;
      } else {
        document.getElementById(type).style.display = "none";
      }
    });
  }
} // fn: main

// !!!
function showGrid(gridType) {
  debugger;
  gridTypes.forEach((type) => {
    if (type === gridType) {
      document.getElementById(type).style.display = "block";
    } else {
      document.getElementById(type).style.display = "none";
    }
  });
} // fn: showGrid

// !!!
function toggleFuzzOptions(e) {
  const fuzzOptions = document.getElementById("fuzzOptions");
  if (fuzzOptions.style.display === "none") {
    fuzzOptions.style.display = "block";
    e.currentTarget.innerHTML = "Fewer options";
  } else {
    fuzzOptions.style.display = "none";
    e.currentTarget.innerHTML = "More options";
  }
} // fn: toggleFuzzOptions

// !!!
function handleFuzzStart(e) {
  const overrides = { fuzzer: {}, args: [] };
  const disableArr = [e.currentTarget]; // TODO: fuzz.options button
  const fuzzBase = "fuzz";

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
      const minVal = min?.getAttribute("current-value");
      const maxVal = max?.getAttribute("current-value");
      if (minVal !== undefined && maxVal !== undefined) {
        thisOverride["min"] = minVal;
        thisOverride["max"] = maxVal;
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
    const minStrLen = document
      .getElementById(idBase + "-minStrLen")
      ?.getAttribute("current-value");
    const maxStrLen = document
      .getElementById(idBase + "-maxStrLen")
      ?.getAttribute("current-value");
    if (minStrLen !== undefined && maxStrLen !== undefined) {
      disableArr.push(document.getElementById(idBase + "-minStrLen"));
      disableArr.push(document.getElementById(idBase + "-maxStrLen"));
      thisOverride["minStrLen"] = minStrLen;
      thisOverride["maxStrLen"] = maxStrLen;
    } // TODO: Validation !!!
  }

  // Disable input elements while the Fuzzer runs.
  disableArr.forEach((e) => {
    e.style.disabled = true;
  });

  // Send the fuzzer start command to the extension
  vscode.postMessage({
    command: "fuzz.start", // !!!
    json: JSON.stringify(overrides),
  });
} // fn: handleFuzzStart

// !!!
function getIdBase(i) {
  return "argDef-" + i;
}

export {};
