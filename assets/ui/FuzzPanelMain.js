const vscode = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {
  const howdyButton = document.getElementById("fuzz.start");
  howdyButton.addEventListener("click", handleFuzzStart);
}

function handleFuzzStart() {
  const argOverrides = { fuzzer: {}, args: [] };

  // TODO: Fuzzer options

  for (let i = 0; document.getElementById(getIdBase(i)) !== null; i++) {
    const idBase = getIdBase(i);
    const thisOverride = {};
    argOverrides.args.push(thisOverride);

    // Get the min and max values
    const min = document
      .getElementById(idBase + "-min")
      ?.getAttribute("current-value");
    const max = document
      .getElementById(idBase + "-max")
      ?.getAttribute("current-value");
    if (min !== undefined && max !== undefined) {
      thisOverride["min"] = min;
      thisOverride["max"] = max;
    } // TODO: Validation !!!

    // Get the string length min and max
    const minStrLen = document
      .getElementById(idBase + "-minStrLen")
      ?.getAttribute("current-value");
    const maxStrLen = document
      .getElementById(idBase + "-maxStrLen")
      ?.getAttribute("current-value");
    if (minStrLen !== undefined && maxStrLen !== undefined) {
      thisOverride["minStrLen"] = minStrLen;
      thisOverride["maxStrLen"] = maxStrLen;
    } // TODO: Validation !!!
  }

  vscode.postMessage({
    command: "fuzz.start", // !!!
    json: JSON.stringify(argOverrides),
  });
}

function getIdBase(i) {
  return "argDef-" + i;
}

export {};
