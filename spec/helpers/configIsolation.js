/**
 * Global Jasmine test helper to ensure configuration isolation across all
 * specs. Clears temporary Config overrides before and after each test so
 * that test execution order does not leak between test cases.
 */
require("./vscodeStub.js");
const Config = require("../../src/Config");

beforeEach(() => {
  Config.clearOverrides();
  Config.override("nanofuzz.fuzzer.workers", 2);
});

afterEach(() => {
  Config.clearOverrides();
});
