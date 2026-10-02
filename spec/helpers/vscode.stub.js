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
    workspaceFolders: [
      {
        uri: {
          fsPath: process.cwd(),
        },
      },
    ],
  },
  window: {
    createTextEditorDecorationType: () => ({}),
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
  Range: class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  Position: class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Uri: {
    file: (k) => {
      return {
        fsPath: k,
      };
    },
  },
  CancellationTokenSource: class CancellationTokenSource {
    constructor() {
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      };
    }
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
  LanguageModelToolResult: class LanguageModelToolResult {
    constructor(content) {
      this.content = content;
    }
  },
  LanguageModelTextPart: class LanguageModelTextPart {
    constructor(value) {
      this.value = value;
    }
  },
  LanguageModelChatMessage: {
    User: (content) => ({ role: 1, content }),
    Assistant: (content) => ({ role: 2, content }),
  },
  lm: {
    registerTool: (_name, _tool) => ({ dispose: () => {} }),
    selectChatModels: async (_selector) => [],
  },
};
