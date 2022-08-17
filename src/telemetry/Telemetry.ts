import * as vscode from "vscode";
import { Logger, LoggerEntry } from "./Logger";

let currentWindow = ""; // Current editor window filename / uri
let currentTerm = ""; // Current terminal window name
let logger: Logger; // Telemetry logger
let context: vscode.ExtensionContext; // Context of this extension
let config: PurseConfig; // Configuration settings

/**
 * Initialize the module.
 *
 * @param context extension context
 */
export async function init(inContext: vscode.ExtensionContext): Promise<void> {
  console.info("Telemetry is starting...");
  context = inContext;

  // Setup Workspace Storage
  logger = Logger.getLogger(context.extensionUri);

  // Load config
  const cfg = vscode.workspace.getConfiguration("telemetry");
  config = {
    active: cfg.get("active", false),
  };
  if (config.active) {
    console.info("Telemetry is active");
  } else {
    console.info("Telemetry is inactive");
  }
}

/**
 * Called when extension is deactivated
 */
export function deinit(): void {
  currentWindow = "";
  currentTerm = "";

  /**
   * The following code is usually ineffective when the vscode window
   * is closed. For an explanation as to why, see Microsoft's explanation
   * below. The long and short of it is we may not be able to persist data.
   * https://github.com/microsoft/vscode/issues/122825#issuecomment-814218149
   */
  logger.flush();
}

/**
 * Filenames for code editors start with '/' or '\'
 *
 * !!! Not sure this is what we want here.
 *
 * @param fn filename
 * @returns true if filename starts with '/' or '\'
 */
function isCodeEditor(fn: string): boolean {
  console.debug(`isCodeEditor: ${fn}`); // !!!
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
      logger.flush();
      vscode.window.showInformationMessage(`Log Data flushed to file system`);
    },
  },
  clearLog: {
    name: "nanofuzz.telemetry.ClearLog",
    fn: (): void => {
      logger.clear();
      logger.push(new LoggerEntry("logDataCleared"));
      vscode.window.showInformationMessage("Log Data cleared");
    },
  },
  logTelemetry: {
    name: "nanofuzz.telemetry.log",
    fn: (le?: LoggerEntry): void => {
      if (le !== undefined && typeof le === "object") logger.push(le);
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
      logger.push(new LoggerEntry("onDidChangeConfiguration"));
    },
  },
  {
    event: vscode.workspace.onDidChangeTextDocument,
    fn: (e: vscode.TextDocumentChangeEvent): void => {
      for (const c of e.contentChanges) {
        logger.push(
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
          : editor?.document.uri.toString() ?? "";
      logger.push(
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
        logger.push(
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
        logger.push(
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
      logger.push(
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
      logger.push(
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
      logger.push(
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
      logger.push(
        new LoggerEntry("onDidCloseTerminal", "Closed terminal: [%s]", [
          term.name,
        ])
      );
    },
  },
];

// ----------------------------- Types ----------------------------- //

/**
 * Associates a callback function with an vscode event.
 */
type Listener<T extends any> = {
  event: vscode.Event<T>;
  fn: (e: T) => void;
};

/**
 * Telemetry configuration
 *
 * Note: Also update package.json
 */
type PurseConfig = {
  active: boolean; // Indicates whether to start telemetry
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

export { LoggerEntry };
