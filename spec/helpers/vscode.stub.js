module.exports = {
  isShim: true,
  workspace: {
    getConfiguration: function () {
      return {
        get: function (_key, defaultValue) {
          return defaultValue;
        },
      };
    },
    onDidChangeConfiguration: {},
    onDidChangeTextDocument: {},
    onDidChangeActiveTextEditor: {},
    getWorkspaceFolder: function () {
      return {
        uri: {
          fsPath: () => process.cwd(),
        },
      };
    },
  },
  window: {
    onDidChangeActiveTextEditor: {},
    onDidChangeTextEditorSelection: {},
    onDidChangeTextEditorVisibleRanges: {},
    onDidChangeTerminalState: {},
    onDidCloseTerminal: {},
    onDidChangeActiveTerminal: {},
    onDidOpenTerminal: {},
  },
  commands: {
    executeCommand: () => null,
  },
  TextEditorSelectionChangeEvent: {},
  TextEditorVisibleRangesChangeEvent: {},
  Terminal: {},
  Uri: {
    file: (k) => {
      return {
        fsPath: k,
      };
    },
  },
};
