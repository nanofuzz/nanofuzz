import * as vscode from "vscode";
import * as fp from "./ui/FuzzPanel";
import * as tm from "./telemetry/Telemetry";

const disposables: vscode.Disposable[] = []; // Keep track of disposables
const modules = [fp, tm];
let extensionContext: vscode.ExtensionContext | undefined; // Extension context

/**
 * Called by VS Code to activates the extension.
 *
 * @param context extension context provided by the VS Code extension host
 */
export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  modules.forEach((module) => {
    module.init(context);
  });

  // --------------------------- Commands --------------------------- //

  /**
   * Push the commands to the VS Code command palette.
   */
  for (const module of modules) {
    for (const cmd of Object.values(module.commands)) {
      const reg = vscode.commands.registerCommand(cmd.name, cmd.fn);
      context.subscriptions.push(reg);
      disposables.push(reg);
    }
  }

  // ---------------------------- Panels ---------------------------- //

  /**
   * Register a FuzzPanelSerializer so the FuzzPanel window persists
   * across VS Code sessions.
   */
  vscode.window.registerWebviewPanelSerializer(fp.FuzzPanel.viewType, {
    async deserializeWebviewPanel(
      webviewPanel: vscode.WebviewPanel,
      state: fp.FuzzPanelStateSerialized
    ): Promise<void> {
      // Restore content of the webview.
      fp.FuzzPanel.revive(webviewPanel, context.extensionUri, state);
    },
  });

  // --------------------------- CodeLens --------------------------- //

  /**
   * Push our CodeLens provider to the VS Code editor
   */
  fp.languages.forEach((lang) => {
    const lens = vscode.languages.registerCodeLensProvider(lang, {
      provideCodeLenses: fp.provideCodeLenses,
    });
    context.subscriptions.push(lens);
    disposables.push(lens);
  }); // push CodeLens provider

  // --------------------------- Listeners -------------------------- //

  /**
   * Push event listeners to VS Code
   */
  tm.listeners.forEach((listener) => {
    context.subscriptions.push(listener.event(listener.fn));
  });
} // fn: activate()

/**
 * De-activaton logic for the extension
 */
export function deactivate(): void {
  disposables.forEach((e) => e.dispose());
  modules.forEach((module) => {
    module.deinit();
  });
} // fn: deactivate()

/**
 * Returns the current extension context
 */
export function getExtensionContext(): vscode.ExtensionContext {
  if (extensionContext === undefined) {
    throw new Error("Extension context is undefined");
  } else {
    return extensionContext;
  }
} // fn: getExtensionContext()
