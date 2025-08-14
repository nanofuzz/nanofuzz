/**
 * This is a very ugly hack that mocks the `vscode` object in Jasmine
 * somewhat similar to how we previously mocked it in Jest.
 *
 * We switched from Jest because Jest lacks a facility (or escape hatch)
 * that allows NaNofuzz to hook the Require object during testing, which
 * was becoming increasingly problematic as we now want to dynamically
 * instrument code in addition to simply transpiling it. Another option
 * might be to switch to Mocha and use the vscode testing module if it
 * will also not step on our need to hook Require.
 *
 * If any Jasmine tests use additional aspects of the vscode object in
 * the future, then those aspects will need to be mocked here and those
 * modules will need to explicitly point to this mock object.
 *
 * When we update the @types/vscode package in the future, we need to
 * also update the corresponding index.d.ts here and comment out the
 * module statement again. Perhaps this particular aspect can be
 * automated in the future.
 **/
let vscode = {
  workspace: {
    getConfiguration: (k) => {
      return {
        get: (k, dft) => dft,
      };
    },
  },
};
try {
  vscode = require("vscode");
} catch (e) {
  e;
}
export const workspace = vscode.workspace;
