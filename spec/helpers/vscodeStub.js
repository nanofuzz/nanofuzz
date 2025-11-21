const Module = require("module");
const path = require("path");

if (!globalThis.__nanofuzzVscodeStubbed) {
  const originalResolveFilename = Module._resolveFilename;

  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === "vscode") {
      return path.join(__dirname, "vscode.stub.js");
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  globalThis.__nanofuzzVscodeStubbed = true;
}
