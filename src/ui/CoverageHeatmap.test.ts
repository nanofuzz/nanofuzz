import { createInstrumenter } from "istanbul-lib-instrument";
import { createFileCoverage, FileCoverageData } from "istanbul-lib-coverage";
import * as vscode from "vscode";
import { _calculateDecorationRanges } from "./CoverageHeatmap";

declare global {
  var __coverage__: Record<string, FileCoverageData> | undefined;
}

function createDocMock(lines: string[]): vscode.TextDocument {
  const lineAtFunc = (
    lineOrPosition: number | vscode.Position
  ): vscode.TextLine => {
    const line =
      typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    const text = lines[line] ?? "";
    const range = new vscode.Range(
      new vscode.Position(line, 0),
      new vscode.Position(line, text.length)
    );
    const nonWs = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range,
      rangeIncludingLineBreak: range,
      firstNonWhitespaceCharacterIndex: nonWs >= 0 ? nonWs : text.length,
      isEmptyOrWhitespace: text.trim().length === 0,
    };
  };

  return {
    uri: vscode.Uri.file("/test.ts"),
    fileName: "/test.ts",
    isUntitled: false,
    languageId: "typescript",
    encoding: "utf8",
    version: 1,
    isDirty: false,
    isClosed: false,
    save: () => Promise.resolve(true),
    eol: vscode.EndOfLine ? vscode.EndOfLine.LF : 1,
    lineCount: lines.length,
    lineAt: lineAtFunc,
    offsetAt: (_position: vscode.Position) => 0,
    positionAt: (_offset: number) => new vscode.Position(0, 0),
    getText: (_range?: vscode.Range) => lines.join("\n"),
    getWordRangeAtPosition: (_position: vscode.Position, _regex?: RegExp) =>
      undefined,
    validateRange: (range: vscode.Range) => range,
    validatePosition: (position: vscode.Position) => position,
  };
}

describe("CoverageHeatmap decoration ranges", () => {
  it("Line 3: const b = 2 inside while(false) should have 0 hits", () => {
    const data: FileCoverageData = {
      path: "/test.ts",
      statementMap: {
        "0": { start: { line: 1, column: 2 }, end: { line: 1, column: 13 } },
        "1": { start: { line: 1, column: 15 }, end: { line: 1, column: 41 } },
        "2": { start: { line: 1, column: 39 }, end: { line: 1, column: 40 } },
      },
      fnMap: {},
      branchMap: {},
      s: {
        "0": 1,
        "1": 1,
        "2": 0,
      },
      f: {},
      b: {},
    };

    const fileMap = createFileCoverage(data);
    const docMock = createDocMock([
      "  const a = 1; while(false) {const b = 2};",
    ]);

    const ranges = _calculateDecorationRanges(fileMap, docMock);

    expect(ranges[0].length).toBe(1);
    expect(ranges[0][0].start.character).toBe(29);
    expect(ranges[0][0].end.character).toBe(40);
  });

  it("Line 6: optionB in multi-line object literal should be covered", () => {
    const data: FileCoverageData = {
      path: "/test.ts",
      statementMap: {
        "0": { start: { line: 1, column: 17 }, end: { line: 4, column: 4 } },
        "1": { start: { line: 2, column: 32 }, end: { line: 2, column: 35 } },
      },
      fnMap: {},
      branchMap: {},
      s: {
        "0": 1,
        "1": 3,
      },
      f: {},
      b: {},
    };

    const fileMap = createFileCoverage(data);
    const docMock = createDocMock([
      "  const config = {",
      "    optionA: [1,2,3].map((x) => x*2),",
      "    optionB: 2,",
      "  };",
    ]);

    const ranges = _calculateDecorationRanges(fileMap, docMock);

    const coversLine3 = ranges.some(
      (bucket, level) =>
        level > 0 && bucket.some((r) => r.start.line <= 2 && r.end.line >= 2)
    );
    expect(coversLine3).toBe(true);
  });

  it("Line 12: const b=g inside single-line while(true)", () => {
    const data: FileCoverageData = {
      path: "/test.ts",
      statementMap: {
        "0": { start: { line: 1, column: 12 }, end: { line: 1, column: 13 } },
        "1": { start: { line: 1, column: 15 }, end: { line: 1, column: 39 } },
        "2": { start: { line: 1, column: 36 }, end: { line: 1, column: 37 } },
        "3": { start: { line: 1, column: 49 }, end: { line: 1, column: 50 } },
      },
      fnMap: {},
      branchMap: {},
      s: {
        "0": 1,
        "1": 1,
        "2": 1000,
        "3": 1,
      },
      f: {},
      b: {},
    };

    const fileMap = createFileCoverage(data);
    const docMock = createDocMock([
      "  const g = 2; while(true) {const b=g;}; const v=g;",
    ]);

    const ranges = _calculateDecorationRanges(fileMap, docMock);

    expect(ranges[20].length).toBe(1);
    expect(ranges[20][0].start.character).toBe(28);
    expect(ranges[20][0].end.character).toBe(38);
  });

  it("Real istanbul instrumentation for optionA map x*2", () => {
    const code = [
      "const config = {",
      "  optionA: [1,2,3,4,5,6,7,8,9,10].map((x) => x*2),",
      "};",
    ].join("\n");

    const inst = createInstrumenter({ compact: false });
    const instrumented = inst.instrumentSync(code, "/realtest.js");

    globalThis.__coverage__ = {};
    eval(instrumented);

    const covData = globalThis.__coverage__["/realtest.js"];
    expect(covData).toBeDefined();

    const cov = createFileCoverage(covData);
    const docMock = createDocMock(code.split("\n"));

    const ranges = _calculateDecorationRanges(cov, docMock);

    const level20 = ranges[20];
    const callbackRange = level20.find(
      (r) => r.start.line === 1 && r.start.character === 45
    );
    expect(callbackRange).toBeDefined();
    expect(callbackRange?.end.character).toBe(48); // Ends right after x*2, not extending into closing parenthesis ')'

    const coversArrowHeader = level20.some(
      (r) => r.start.line === 1 && r.start.character === 38
    );
    expect(coversArrowHeader).toBe(true);

    const coversOuterLine = ranges.some(
      (bucket, level) =>
        level > 0 &&
        level < 20 &&
        bucket.some((r) => r.start.line === 0 && r.start.character === 0)
    );
    expect(coversOuterLine).toBe(true);
  });

  it("Winsorized square-root scaling handles extreme outlier infinite loop hit counts", () => {
    const data: FileCoverageData = {
      path: "/test.ts",
      statementMap: {
        "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        "1": { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
        "2": { start: { line: 3, column: 0 }, end: { line: 3, column: 10 } },
        "3": { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } },
        "4": { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
      },
      fnMap: {},
      branchMap: {},
      s: {
        "0": 10,
        "1": 10,
        "2": 100,
        "3": 1000,
        "4": 1000000,
      },
      f: {},
      b: {},
    };

    const fileMap = createFileCoverage(data);
    const docMock = createDocMock([
      "line1;",
      "line2;",
      "line3;",
      "line4;",
      "line5;",
    ]);

    const ranges = _calculateDecorationRanges(fileMap, docMock);

    const level7HasStmt2 = ranges[7].some((r) => r.start.line === 2);
    expect(level7HasStmt2).toBe(true);

    const level20HasStmt3 = ranges[20].some((r) => r.start.line === 3);
    const level20HasStmt4 = ranges[20].some((r) => r.start.line === 4);
    expect(level20HasStmt3).toBe(true);
    expect(level20HasStmt4).toBe(true);
  });

  it("Line 12 with comment: const g = 2; /*while(true) {const b=g;}*/; const v=w;", () => {
    const data: FileCoverageData = {
      path: "/test.ts",
      statementMap: {
        "0": { start: { line: 1, column: 2 }, end: { line: 1, column: 13 } },
        "1": { start: { line: 1, column: 49 }, end: { line: 1, column: 60 } },
      },
      fnMap: {},
      branchMap: {},
      s: {
        "0": 1,
        "1": 1,
      },
      f: {},
      b: {},
    };

    const fileMap = createFileCoverage(data);
    const docMock = createDocMock([
      "  const g = 2; /*while(true) {const b=g;}*/; const v=w;",
    ]);

    const ranges = _calculateDecorationRanges(fileMap, docMock);

    let commentCovered = false;
    ranges.forEach((bucket) => {
      bucket.forEach((r) => {
        if (r.start.character < 41 && r.end.character > 15) {
          commentCovered = true;
        }
      });
    });
    expect(commentCovered).toBe(false);

    // Verify statement 1 (const v=w;) expanded leftward to 'const' (column 45) across the comment gap
    const coversConstV = ranges.some((bucket) =>
      bucket.some((r) => r.start.line === 0 && r.start.character === 45)
    );
    expect(coversConstV).toBe(true);
  });
});
