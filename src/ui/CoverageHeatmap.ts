import * as vscode from "vscode";
import { FileCoverage } from "../fuzzer/measures/CoverageMeasure";

// The number of different heat levels to visualize
const GRANULARITY = 20;

// Create buckets for code coverage decorations
const gradientDecorationTypes: vscode.TextEditorDecorationType[] = [];
for (let i = 0; i <= GRANULARITY; i++) {
  const hue = (60 * i) / GRANULARITY;
  const alpha =
    0.06 +
    0.24 * ((Math.abs(i - Math.floor(GRANULARITY / 2)) / GRANULARITY) * 2);

  gradientDecorationTypes.push(
    vscode.window.createTextEditorDecorationType({
      light: {
        backgroundColor: `hsla(${hue}, 80%, 60%, ${alpha.toFixed(2)})`,
      },
      dark: {
        backgroundColor: `hsla(${hue}, 80%, 45%, ${alpha.toFixed(2)})`,
      },
    })
  );
}

/**
 * Decorates a vscode editor with a heatmap that visualizes
 * its corresponding coverage map
 *
 * @param `editor` vscode editor
 * @param `fileMap` file coverage map
 */
export function applyCoverageHeatmapToEditor(
  editor: vscode.TextEditor,
  fileMap: FileCoverage
): void {
  const totalLines = editor.document.lineCount;
  if (totalLines === 0) {
    clearCoverageHeatmapFromEditor(editor);
    return;
  }

  const maxHits = Math.max(
    0,
    ...Object.values(fileMap.s),
    ...Object.values(fileMap.b).map((b) =>
      Math.max(0, ...b.filter((e) => !Number.isNaN(e)))
    ),
    ...Object.values(fileMap.f)
  );

  const rangesByGradientLevel: vscode.Range[][] = Array.from(
    { length: GRANULARITY + 1 },
    () => []
  );

  // Helper function to assign hits to decoration buckets
  function _gradientLevelForRatio(hits: number): number {
    const ratio = hits / maxHits;
    if (hits === 0 || !Number.isFinite(ratio) || ratio <= 0) return 0;
    if (ratio >= 1) return GRANULARITY;
    return Math.max(1, Math.min(GRANULARITY, Math.ceil(ratio * GRANULARITY)));
  } // fn: _gradientLevelForRatio

  // Note: instanbul coverage lines are 1-based & columns are 0-based.

  // Function coverage
  for (const f of Object.keys(fileMap.f)) {
    const element = fileMap.fnMap[f]; // hit element
    const hits = fileMap.f[f]; // number of hits

    rangesByGradientLevel[_gradientLevelForRatio(hits)].push(
      new vscode.Range(
        new vscode.Position(
          element.decl.start.line - 1,
          element.decl.start.column
        ),
        new vscode.Position(element.loc.end.line - 1, element.loc.end.column)
      )
    );
  }

  // Branch coverage
  for (const b of Object.keys(fileMap.b)) {
    const element = fileMap.branchMap[b]; // hit element
    const hits = fileMap.b[b]; // array of hits

    // Note: instanbul's branch locations for if statements are broken.
    // See https://github.com/istanbuljs/istanbuljs/issues/130
    // Workaround is to ignore if branches.
    if (element.type === "if") {
      rangesByGradientLevel[_gradientLevelForRatio(Math.min(...hits))].push(
        new vscode.Range(
          new vscode.Position(
            element.loc.start.line - 1,
            element.loc.start.column
          ),
          new vscode.Position(element.loc.end.line - 1, element.loc.end.column)
        )
      );
    } else {
      // non-if branches
      for (const i in hits) {
        rangesByGradientLevel[_gradientLevelForRatio(hits[i])].push(
          new vscode.Range(
            new vscode.Position(
              element.locations[i].start.line - 1,
              element.locations[i].start.column
            ),
            new vscode.Position(
              element.locations[i].end.line - 1,
              element.locations[i].end.column
            )
          )
        );
      }
    }
  }

  // Statements
  for (const s of Object.keys(fileMap.s)) {
    const element = fileMap.statementMap[s]; // hit element
    const hits = fileMap.s[s]; // number of hits

    rangesByGradientLevel[_gradientLevelForRatio(hits)].push(
      new vscode.Range(
        new vscode.Position(element.start.line - 1, element.start.column),
        new vscode.Position(element.end.line - 1, element.end.column)
      )
    );
  }

  // Apply the editor decorations for hit elements
  for (let i = 0; i <= GRANULARITY; i++) {
    editor.setDecorations(gradientDecorationTypes[i], rangesByGradientLevel[i]);
  }

  // Clear the background of statements without hits
  editor.setDecorations(
    vscode.window.createTextEditorDecorationType({
      light: {
        backgroundColor: new vscode.ThemeColor(`editor.background`),
      },
      dark: {
        backgroundColor: new vscode.ThemeColor(`editor.background`),
      },
    }),
    rangesByGradientLevel[0]
  );
  editor.setDecorations(
    vscode.window.createTextEditorDecorationType({
      light: {
        backgroundColor: new vscode.ThemeColor(`editor.background`),
      },
      dark: {
        backgroundColor: new vscode.ThemeColor(`editor.background`),
      },
    }),
    rangesByGradientLevel[0]
  );
  console.debug(
    `0 ranges: ${JSON.stringify(rangesByGradientLevel[0], null, 2)}`
  ); // !!!!!!!!!!!
} // fn: applyCoverageHeatmapToEditor

/**
 * Clears heatmap decorations from an editor
 *
 * @param `editor` vscode editor
 */
export function clearCoverageHeatmapFromEditor(
  editor: vscode.TextEditor
): void {
  for (const type of gradientDecorationTypes) {
    editor.setDecorations(type, []);
  }
} // fn: clearCoverageHeatmapFromEditor
