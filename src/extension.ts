import * as vscode from "vscode";
import * as fuzzer from "./fuzzer/index";

/**
 * Called by VS Code to activates the extension.
 *
 * @param context extension context provided by the VS Code extension host
 */
export function activate(context: vscode.ExtensionContext): void {
  /**
   * The status bar item that displays summarized fuzzer output.
   */
  const fuzzStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  fuzzStatusBar.hide();

  /**
   * Push the Fuzz command to the VS Code command palette.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand("nanofuzz.Fuzz", async () => {
      fuzzStatusBar.hide();

      // Get the current active editor
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(
          "Please select a function to fuzz in the editor."
        );
        return; // If there is no active editor, return.
      }

      // Ensure the editor is saved / not dirty
      if (editor.document.isDirty)
        vscode.window.showErrorMessage("Please save the file before fuzzing.");

      // Get the current active editor filename
      const srcFile = editor.document.uri.path; //full path of the file which the function is in.

      // Get the current cursor offset
      const pos = editor.document.offsetAt(editor.selection.active);
      if (!pos) {
        vscode.window.showErrorMessage(
          "Please select a function to fuzz in the editor."
        );
        return; // If there is no word at the cursor, return.
      }

      // Call the fuzzer to analyze the function
      const fuzzOptions = fuzzer.getDefaultFuzzOptions();
      let fuzzSetup: fuzzer.FuzzEnv;
      try {
        fuzzSetup = fuzzer.setup(fuzzOptions, srcFile, undefined, pos);
      } catch (e: any) {
        vscode.window.showErrorMessage(
          `The fuzzer either could not find or does not support fuzzing the function at the cursor location. Messge: "${e.message}"`
        );
        return;
      }

      // Now ask the user for input
      // TODO: make this a dialog - and remember the input !!!
      // TODO: ask about number of fuzz iterations !!!
      // TODO: ask about matrix dimensions !!!
      fuzzStatusBar.text = `$(loading~spin) Fuzzing '${fuzzSetup.fnName}'...`;
      fuzzStatusBar.show();

      for (const i in fuzzSetup.inputs) {
        const thisInput = fuzzSetup.inputs[i];
        const argPrefix = `${thisInput.getName()}:`;

        if (thisInput.getType() === fuzzer.ArgTag.NUMBER) {
          // Ask if it's a float or an integer
          const floatOrInt = await vscode.window.showQuickPick(
            [
              { label: "Integer", description: "Integer" },
              { label: "Float", description: "Float" },
            ],
            {
              placeHolder: `${argPrefix} Fuzz with floats or an integers? (default: integers)`,
            }
          );
          let cvtFn: typeof parseInt;
          if (floatOrInt && floatOrInt.label === "Float") {
            cvtFn = parseFloat;
            thisInput.setOptions({
              ...thisInput.getOptions(),
              numInteger: false,
            });
          } else {
            cvtFn = parseInt;
            thisInput.setOptions({
              ...thisInput.getOptions(),
              numInteger: true,
            });
          }

          // Allow the user to override the default min/max
          const intervals = thisInput.getIntervals();
          const min =
            (await vscode.window.showInputBox({
              prompt: `${argPrefix} Please enter a MINIMUM number to fuzz`,
              value: Number(intervals[0].min).toString(),
            })) ?? Number(intervals[0].min).toString();
          const max =
            (await vscode.window.showInputBox({
              prompt: `${argPrefix} Please enter a MAXIMUM number to fuzz`,
              value: Number(intervals[0].max).toString(),
            })) ?? Number(intervals[0].max).toString();
          thisInput.setIntervals([{ min: cvtFn(min), max: cvtFn(max) }]);
        } // if: Numeric Input

        if (thisInput.getType() === fuzzer.ArgTag.STRING) {
          // Allow the user to override the default min/max
          const intervals = thisInput.getIntervals();
          const min =
            (await vscode.window.showInputBox({
              prompt: `${argPrefix} Please enter a MINIMUM string value to fuzz`,
              value: intervals[0].min.toString(),
            })) ?? intervals[0].min.toString();
          const max =
            (await vscode.window.showInputBox({
              prompt: `${argPrefix} Please enter a MAXIMUM string value to fuzz`,
              value: intervals[0].max.toString(),
            })) ?? intervals[0].max.toString();
          thisInput.setIntervals([{ min: min, max: max }]);

          // Allow the user to override the default string length
          const inputOptions = thisInput.getOptions();
          const minLength = parseInt(
            (await vscode.window.showInputBox({
              prompt: `${argPrefix} Please enter a MINIMUM string length to fuzz`,
              value: inputOptions.strLength.min.toString(),
            })) ?? inputOptions.strLength.min.toString()
          );
          const maxLength = parseInt(
            (await vscode.window.showInputBox({
              prompt: `${argPrefix} Please enter a MAXIMUM string length to fuzz`,
              value: inputOptions.strLength.max.toString(),
            })) ?? inputOptions.strLength.max.toString()
          );
          thisInput.setOptions({
            ...inputOptions,
            strLength: {
              min: isNaN(minLength) ? inputOptions.strLength.min : minLength,
              max: isNaN(maxLength) ? inputOptions.strLength.max : maxLength,
            },
          });
        } // if: String Input
      } // for: fuzzSetup.inputs

      // Finally, call the fuzzer & keep the user updated
      const results = await fuzzer.fuzz(fuzzSetup);
      vscode.window.showInformationMessage(
        `Done fuzzing '${fuzzSetup.fnName}'`
      );
      const pass = results.results.reduce(
        (sum: number, e: fuzzer.FuzzTestResult) => (e.passed ? sum + 1 : sum),
        0
      );
      const fail = results.results.length - pass;
      const icon = fail === 0 ? "$(pass)" : "$(error)";
      fuzzStatusBar.text = `${icon} Last fuzz: ${pass} pass, ${fail} fail (${fuzzSetup.fnName})`;

      // Display the results in a new editor (TODO: user report goes here)
      vscode.workspace
        .openTextDocument({
          language: "json",
          content: JSON.stringify(results, null, 2),
        })
        .then((doc) => {
          vscode.window.showTextDocument(doc);
        });
    })
  ); // push command: nanofuzz.Fuzz
}

/**
 * De-activaton logic for the extension
 */
export function deactivate(): void {
  // !!!
}
