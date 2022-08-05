import * as vscode from "vscode";
import { Logger, LoggerEntry } from "./Logger";
import { Memory } from "./Memory";

let currentWindow = "";
let currentTerm = "";
let memory: Memory;
let dataLog: Logger;
let context: vscode.ExtensionContext;
const config: PurseConfig = {};

/**
 * Initialize the module.
 *
 * @param context extension context
 */
export async function init(inContext: vscode.ExtensionContext): Promise<void> {
  console.info("Telemetry is starting...");
  context = inContext;

  // Setup Workspace Storage
  memory = new Memory(context.workspaceState);
  dataLog = new Logger(memory);

  // Load config
  const cfg = vscode.workspace.getConfiguration("nanofuzz.telemetry");
  config.timeoutMinutes = cfg.get("timeoutMinutes", 0);
  config.purseCallbackUri = cfg.get("purseCallbackUri");
  config.purseCallbackSecs = cfg.get("purseCallbackSecs", 15);
  config.purseCallbackKey = cfg.get("purseCallbackKey");

  console.info("Telemetry is active");
}

/**
 * Called when extension is deactivated
 */
export function deinit(): void {
  currentWindow = "";
  currentTerm = "";

  console.debug("Telemetry de-activated");
}

/**
 * Filenames for code editors start with '/' or '\'
 *
 * @param fn filename
 * @returns true if filename starts with '/' or '\'
 */
function isCodeEditor(fn: string): boolean {
  return fn.charAt(0) === "/" || fn.charAt(0) === "\\";
}

/**
 * Export this module's commands to the extension.
 *
 * Note: Manually update package.json.
 */
export const commands = {
  dumpLog: {
    name: "nanofuzz.telemetry.DumpLog",
    fn: (): void => {
      vscode.workspace
        .openTextDocument({ content: dataLog.toJSON(), language: "json" })
        .then((document) => {
          vscode.window.showTextDocument(document);
          vscode.window.showInformationMessage(
            `Log Data dumped to document ${document.uri}`
          );
        });
    },
  },
  clearLog: {
    name: "nanofuzz.telemetry.ClearLog",
    fn: (): void => {
      dataLog.clear();
      dataLog.push(new LoggerEntry("logDataCleared"));
      vscode.window.showInformationMessage("Log Data cleared");
    },
  },
};

/**
 * Export this module's listeners to the extension.
 */
export const listeners: Listener<any>[] = [
  //
  // ----------------------- Workspace Handlers ---------------------- //

  {
    event: vscode.workspace.onDidChangeConfiguration,
    fn: (e: vscode.ConfigurationChangeEvent): void => {
      dataLog.push(new LoggerEntry("onDidChangeConfiguration"));
    },
  },
  {
    event: vscode.workspace.onDidChangeTextDocument,
    fn: (e: vscode.TextDocumentChangeEvent): void => {
      for (const c of e.contentChanges) {
        dataLog.push(
          new LoggerEntry(
            "onDidChangeTextDocument",
            "%s:%s to %s:%s in [%s] replaced with: %s`",
            [
              c.range.start.line.toString(),
              c.range.start.character.toString(),
              c.range.end.line.toString(),
              c.range.end.character.toString(),
              e.document.fileName,
              c.text,
            ]
          )
        );
      }
    },
  },

  // ------------------------ Window Handlers ------------------------ //

  {
    event: vscode.window.onDidChangeActiveTextEditor,
    fn: (editor: vscode.TextEditor | undefined): void => {
      const previousWindow = currentWindow;
      currentWindow =
        editor !== undefined && isCodeEditor(editor.document.fileName)
          ? editor.document.fileName
          : "";
      dataLog.push(
        new LoggerEntry(
          "onDidChangeActiveTextEditor",
          "Current editor: [%s]; Previous editor: [%s]",
          [currentWindow, previousWindow]
        )
      );
    },
  },
  {
    event: vscode.window.onDidChangeTextEditorSelection,
    fn: (e: vscode.TextEditorSelectionChangeEvent): void => {
      for (const s of e.selections) {
        const selectedText = e.textEditor.document.getText(s);
        dataLog.push(
          new LoggerEntry(
            "onDidChangeTextEditorSelection",
            "%s:%s to %s:%s in [%s] text: %s",
            [
              s.start.line.toString(),
              s.start.character.toString(),
              s.end.line.toString(),
              s.end.character.toString(),
              e.textEditor.document.fileName,
              selectedText,
            ]
          )
        );
      }
    },
  },
  {
    event: vscode.window.onDidChangeTextEditorVisibleRanges,
    fn: (e: vscode.TextEditorVisibleRangesChangeEvent): void => {
      for (const r of e.visibleRanges) {
        dataLog.push(
          new LoggerEntry(
            "onDidChangeTextEditorVisibleRanges",
            "%s:%s to %s:%s [%s]",
            [
              r.start.line.toString(),
              r.start.character.toString(),
              r.end.line.toString(),
              r.end.character.toString(),
              e.textEditor.document.fileName,
            ]
          )
        );
      }
    },
  },

  // ----------------------- Terminal Handlers ----------------------- //

  {
    event: vscode.window.onDidOpenTerminal,
    fn: (term: vscode.Terminal): void => {
      dataLog.push(
        new LoggerEntry("onDidOpenTerminal", "Opened terminal: [%s]", [
          term.name,
        ])
      );
    },
  },
  {
    event: vscode.window.onDidChangeActiveTerminal,
    fn: (term: vscode.Terminal | undefined): void => {
      const previousTerm: string = currentTerm;
      currentTerm = term === undefined ? "" : term.name;
      dataLog.push(
        new LoggerEntry(
          "onDidChangeActiveTerminal",
          "Current terminal: [%s]; Previous terminal: [%s]",
          [currentTerm, previousTerm]
        )
      );
    },
  },
  {
    event: vscode.window.onDidChangeTerminalState,
    fn: (term: vscode.Terminal): void => {
      dataLog.push(
        new LoggerEntry(
          "onDidChangeTerminalState",
          "Current terminal: [%s]; InteractedWith: [%s]",
          [term.name, term.state.isInteractedWith ? "true" : "false"]
        )
      );
    },
  },
  {
    event: vscode.window.onDidCloseTerminal,
    fn: (term: vscode.Terminal): void => {
      dataLog.push(
        new LoggerEntry("onDidCloseTerminal", "Closed terminal: [%s]", [
          term.name,
        ])
      );
    },
  },
];

// ----------------------------- Types ----------------------------- //

// !!!
type Listener<T extends any> = {
  event: vscode.Event<T>;
  fn: (e: T) => void;
};

// !!!
type PurseConfig = {
  openMessage?: string; // Message to display on experiment start
  timeoutMinutes?: number; // Devcontainer inactivity timeout
  machineType?: string; // Devcontainer machine image type
  purseCallbackUri?: string; // URI callback to PURSE experiment server
  purseCallbackSecs?: number; // Interval (in seconds) for callback to PURSE
  purseCallbackKey?: string; // Key for this experiment participant
};

/*
function onDidTerminalOutput(context: vscode.TerminalLinkContext) {
  dataLog.push(
    new LoggerEntry("onDidTerminalOutput", "[%s] %s", [
      context.terminal.name,
      context.line,
    ])
  );
}
function onDidWriteTerminalData(context : vscode.TerminalDataWriteEvent) {
	dataLog.push(new DataLogEntry('onDidWriteTerminalData','[%s] %s',
		[
			context.terminal.name,
			context.data,
		]
	));
}
*/

//context.subscriptions.push(vscode.window.onDidWriteTerminalData( e => onDidWriteTerminalData(e)));

// Terminal Link Handlers
/*
vscode.window.registerTerminalLinkProvider({
    provideTerminalLinks: (context, token) => {
    onDidTerminalOutput(context);
    return [];
    },
    handleTerminalLink: (link: any) => {
    // noop
    },
});
*/
