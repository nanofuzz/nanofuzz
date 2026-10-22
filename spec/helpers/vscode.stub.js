const path = require("path");

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
    visibleTextEditors: [],
    showInformationMessage: () => Promise.resolve(),
    showErrorMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    registerWebviewPanelSerializer: () => ({ dispose: () => {} }),
    createWebviewPanel: (viewType, title, showOptions, options) => {
      let isDisposed = false;
      const panel = {
        viewType,
        title,
        options: options || {},
        visible: true,
        active: true,
        iconPath: undefined,
        webview: {
          options: options || {},
          cspSource: "'self'",
          html: "",
          asWebviewUri: (uri) => {
            const p = uri.fsPath || uri.path || String(uri);
            const rel = path.relative(process.cwd(), p).replace(/\\/g, "/");
            return "/" + (rel.startsWith("/") ? rel.slice(1) : rel);
          },
          onDidReceiveMessage: (callback) => {
            panel._messageListener = callback;
            return { dispose: () => {} };
          },
          postMessage: async (message) => {
            if (panel._onPostMessage) {
              panel._onPostMessage(message);
            }
            return true;
          },
        },
        onDidDispose: (callback) => {
          panel._disposeListener = callback;
          return { dispose: () => {} };
        },
        onDidChangeViewState: (callback) => {
          panel._viewStateListener = callback;
          return { dispose: () => {} };
        },
        reveal: () => {
          panel.visible = true;
          panel.active = true;
        },
        dispose: () => {
          if (!isDisposed) {
            isDisposed = true;
            panel.visible = false;
            panel.active = false;
            if (panel._disposeListener) {
              panel._disposeListener();
            }
          }
        },
      };
      return panel;
    },
  },
  ViewColumn: {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2,
    Three: 3,
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
    file: (k) => ({
      fsPath: k,
      path: k,
      toString: () => k,
    }),
    joinPath: (base, ...segments) => {
      const basePath =
        base.fsPath ||
        base.path ||
        (typeof base.toString === "function" ? base.toString() : String(base));
      const p = path.join(basePath, ...segments);
      return {
        fsPath: p,
        path: p,
        toString: () => p,
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
  LanguageModelToolCallPart: class LanguageModelToolCallPart {
    constructor(callId, name, input) {
      this.callId = callId;
      this.name = name;
      this.input = input;
    }
  },
  LanguageModelChatToolMode: {
    Auto: 1,
    Required: 2,
  },
  LanguageModelChatMessage: {
    User: (content) => ({ role: 1, content }),
    Assistant: (content) => ({ role: 2, content }),
  },
};

const createResponse = (options) => {
  const hasTools =
    options && Array.isArray(options.tools) && options.tools.length > 0;
  return {
    text: (async function* () {
      yield '{"programInputs":[]}';
    })(),
    stream: (async function* () {
      if (hasTools) {
        yield new module.exports.LanguageModelToolCallPart(
          "call-1",
          options.tools[0].name,
          { programInputs: [] }
        );
      } else {
        yield new module.exports.LanguageModelTextPart('{"programInputs":[]}');
      }
    })(),
  };
};

const mockModels = [
  {
    id: "copilot-claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    vendor: "copilot",
    family: "claude-3.5-sonnet",
    version: "1.0",
    maxInputTokens: 8192,
    sendRequest: async (_messages, options) => createResponse(options),
  },
  {
    id: "copilot-gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    vendor: "copilot",
    family: "gemini-2.0-flash",
    version: "1.0",
    maxInputTokens: 8192,
    sendRequest: async (_messages, options) => createResponse(options),
  },
  {
    id: "google-gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    vendor: "google",
    family: "gemini-3.7-flash",
    version: "1.0",
    maxInputTokens: 8192,
    sendRequest: async (_messages, options) => createResponse(options),
  },
  {
    id: "copilot-gpt-4o",
    name: "GPT-4o",
    vendor: "copilot",
    family: "gpt-4o",
    version: "1.0",
    maxInputTokens: 8192,
    sendRequest: async (_messages, options) => createResponse(options),
  },
];

module.exports.lm = {
  registerTool: (_name, _tool) => ({ dispose: () => {} }),
  selectChatModels: async (selector) => {
    if (selector && selector.family) {
      return mockModels.filter((m) => m.family === selector.family);
    }
    return mockModels;
  },
};
