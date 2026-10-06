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
    selectChatModels: async (selector) => {
      const mockModels = [
        {
          id: "copilot-claude-3.5-sonnet",
          name: "Claude 3.5 Sonnet",
          vendor: "copilot",
          family: "claude-3.5-sonnet",
          version: "1.0",
          maxInputTokens: 8192,
          sendRequest: async (_messages) => ({
            text: (async function* () {
              yield '{"programInputs":[]}';
            })(),
          }),
        },
        {
          id: "copilot-gemini-2.0-flash",
          name: "Gemini 2.0 Flash",
          vendor: "copilot",
          family: "gemini-2.0-flash",
          version: "1.0",
          maxInputTokens: 8192,
          sendRequest: async (_messages) => ({
            text: (async function* () {
              yield '{"programInputs":[]}';
            })(),
          }),
        },
        {
          id: "google-gemini-3.7-flash",
          name: "Gemini 3.7 Flash",
          vendor: "google",
          family: "gemini-3.7-flash",
          version: "1.0",
          maxInputTokens: 8192,
          sendRequest: async (_messages) => ({
            text: (async function* () {
              yield '{"programInputs":[]}';
            })(),
          }),
        },
        {
          id: "copilot-gpt-4o",
          name: "GPT-4o",
          vendor: "copilot",
          family: "gpt-4o",
          version: "1.0",
          maxInputTokens: 8192,
          sendRequest: async (_messages) => ({
            text: (async function* () {
              yield '{"programInputs":[]}';
            })(),
          }),
        },
      ];
      if (selector && selector.family) {
        return mockModels.filter((m) => m.family === selector.family);
      }
      return mockModels;
    },
  },
};
