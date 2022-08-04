import * as vscode from "vscode";
import * as fuzzer from "./fuzzer/Fuzzer";
import { FunctionRef } from "./fuzzer/Fuzzer";
import { FuzzPanel } from "./ui/FuzzPanel";

const languages = ["typescript", "typescriptreact"]; // Languages supported
const commands = {
  fuzz: "nanofuzz.Fuzz", // Commands supported
};

/**
 * Called by VS Code to activates the extension.
 *
 * @param context extension context provided by the VS Code extension host
 */
export function activate(context: vscode.ExtensionContext): void {
  /**
   * Push the Fuzz command to the VS Code command palette.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand(
      commands.fuzz,
      async (match?: FunctionMatch) => {
        // Get the function name (only present on a CodeLens match)
        const fnName: string | undefined = match ? match.ref.name : undefined;

        // Get the current active document
        const editor = vscode.window.activeTextEditor;
        const document = match
          ? match.document
          : vscode.window.activeTextEditor?.document;
        if (!document || !editor) {
          vscode.window.showErrorMessage(
            "Please select a function to autotest in the editor."
          );
          return; // If there is no active editor, return.
        }

        // Ensure the document is saved / not dirty
        if (document.isDirty) {
          vscode.window.showErrorMessage(
            "Please save the file before autotesting."
          );
          return;
        }

        // Get the current active editor filename
        const srcFile = document.uri.path; //full path of the file which the function is in.

        // Get the current cursor offset
        const pos = match
          ? match.ref.startOffset
          : document.offsetAt(editor.selection.active);

        // Call the fuzzer to analyze the function
        const fuzzOptions = fuzzer.getDefaultFuzzOptions();
        let fuzzSetup: fuzzer.FuzzEnv;
        try {
          fuzzSetup = fuzzer.setup(fuzzOptions, srcFile, fnName, pos);
        } catch (e: any) {
          vscode.window.showErrorMessage(
            `Could not find or does not support this function. Messge: "${e.message}"`
          );
          return;
        }

        // Load the fuzz panel
        FuzzPanel.render(context.extensionUri, fuzzSetup);

        return;
      }
    )
  ); // push command: nanofuzz.Fuzz

  /**
   * Push our CodeLens provider to the VS Code editor
   */
  languages.forEach((lang) => {
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(lang, { provideCodeLenses })
    );
  }); // push CodeLens provider

  /**
   * The CodeLens Provider
   */
  function provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ) {
    // Use the TypeScript analyzer to find all fn declarations in the module
    const matches: FunctionMatch[] = [];
    try {
      const functions = fuzzer.FunctionDef.find(
        document.getText(),
        document.fileName
      );
      for (const fn of functions) {
        matches.push({
          document,
          ref: fn.getRef(),
        });
      }
    } catch (e: any) {
      console.error(
        `Error parsing typescript file: ${document.fileName} error: ${e.message}`
      );
    }

    // Build the map of CodeLens objects at each function location
    return matches.map(
      (match) =>
        new vscode.CodeLens(
          new vscode.Range(
            document.positionAt(match.ref.startOffset),
            document.positionAt(match.ref.endOffset)
          ),
          {
            title: "AutoTest...",
            command: commands.fuzz,
            arguments: [match],
          }
        )
    );
  } // fn: provideCodeLenses()
} // fn: activate()

/**
 * De-activaton logic for the extension
 */
export function deactivate(): void {
  // !!!
} // fn: deactivate()

/**
 * Represents a link between a vscode document and a function definition
 */
type FunctionMatch = {
  document: vscode.TextDocument;
  ref: FunctionRef;
};
