import * as vscode from "vscode";
import { FileCoverage } from "../fuzzer/measures/CoverageMeasure";
import { TextSpans } from "./TextSpans";

// The number of different heat levels to visualize
const GRANULARITY = 20;

// Create buckets for code coverage decorations
const gradientDecorationTypes: vscode.TextEditorDecorationType[] = [];
for (let i = 0; i <= GRANULARITY; i++) {
  const alpha = 0.2 + (0.3 * i) / GRANULARITY;

  gradientDecorationTypes.push(
    vscode.window.createTextEditorDecorationType({
      light: {
        backgroundColor: `hsla(3, 80%, 60%, ${alpha.toFixed(2)})`,
      },
      dark: {
        backgroundColor: `hsla(3, 80%, 45%, ${alpha.toFixed(2)})`,
      },
    })
  );
}

// Cache of range decorations by editor. We maintain this because
// vscode redraws editor when their visibility changes, which means
// applyCoverageHeatmapToEditor can be called quite a lot.
const rangeCache: {
  [k: string]: {
    ranges: vscode.Range[][];
    fileMap: FileCoverage;
  };
} = {};

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
  if (!editor.document.lineCount) {
    clearCoverageHeatmapFromEditor(editor);
    return;
  }

  // Use the cached ranges if we have them; otherwise create new
  const rangesByGradientLevel: vscode.Range[][] =
    editor.document.fileName in rangeCache &&
    rangeCache[editor.document.fileName].fileMap === fileMap
      ? rangeCache[editor.document.fileName].ranges // cached ranges
      : _calculateDecorationRanges(fileMap); // create new

  // Apply the editor decorations to the hit elements
  // Note: skip coloring elements with no hits (i===0))
  for (let i = 1; i <= GRANULARITY; i++) {
    editor.setDecorations(gradientDecorationTypes[i], rangesByGradientLevel[i]);
  }

  // Update the range cache
  rangeCache[editor.document.fileName] = {
    fileMap: fileMap,
    ranges: rangesByGradientLevel,
  };
} // fn: applyCoverageHeatmapToEditor

/**
 * Creates a set of bucketed ranges for the given file coverage map.
 *
 * @param `fileMap` file coverage map
 * @returns `vscode.Range`s bucketed according to hit count
 */
function _calculateDecorationRanges(fileMap: FileCoverage): vscode.Range[][] {
  // We use a text span tree to represent the coverage map hierarchically,
  // which we may then flatten into a set of non-overlapping text editor
  // decorations where the hit count of child (e.g., leaf) nodes have
  // precedence over the hit counts of their parent nodes.
  //
  // For instance, we need statements with no hits to have precedence
  // of the (possibly numerous) hits of their containing `if` statement.
  const spans = new TextSpans<number>();

  // Determine the maximum number of hits so that we appropriately
  // assign hit counts to buckets.
  const maxHits = Math.max(
    0,
    ...Object.values(fileMap.s),
    ...Object.values(fileMap.b).map((b) =>
      Math.max(0, ...b.filter((e) => !Number.isNaN(e)))
    ),
    ...Object.values(fileMap.f)
  );

  // Helper function to assign a hit count to a decoration bucket
  function _gradientLevelForRatio(hits: number): number {
    const ratio = hits / maxHits;
    if (hits === 0 || !Number.isFinite(ratio) || ratio <= 0) return 0;
    if (ratio >= 1) return GRANULARITY;
    return Math.max(1, Math.min(GRANULARITY, Math.ceil(ratio * GRANULARITY)));
  } // fn: _gradientLevelForRatio

  // Function coverage
  for (const f of Object.keys(fileMap.f)) {
    const element = fileMap.fnMap[f]; // hit element
    spans.insert(
      {
        begin: {
          line: element.decl.start.line - 1,
          col: element.decl.start.column,
        },
        end: { line: element.loc.end.line - 1, col: element.loc.end.column },
      },
      fileMap.f[f]
    );
  }

  // Branch coverage
  for (const b of Object.keys(fileMap.b)) {
    const element = fileMap.branchMap[b]; // hit element
    const hits = fileMap.b[b]; // array of hits

    // Note: instanbul's branch locations for if statements are broken.
    // See https://github.com/istanbuljs/istanbuljs/issues/130
    // Workaround here: ignore if branches.
    if (element.type !== "if") {
      for (const i in hits) {
        spans.insert(
          {
            begin: {
              line: element.locations[i].start.line - 1,
              col: element.locations[i].start.column,
            },
            end: {
              line: element.locations[i].end.line - 1,
              col: element.locations[i].end.column,
            },
          },
          hits[i]
        );
      }
    }
  }

  // Statement coverage
  for (const s of Object.keys(fileMap.s)) {
    const element = fileMap.statementMap[s]; // hit element
    spans.insert(
      {
        begin: {
          line: element.start.line - 1,
          col: element.start.column,
        },
        end: { line: element.end.line - 1, col: element.end.column },
      },
      fileMap.s[s]
    );
  }

  // Flatten the spans & assign each to a decoration bucket
  const rangesByGradientLevel: vscode.Range[][] = Array.from(
    { length: GRANULARITY + 1 },
    () => []
  );
  for (const span of spans.flatten()) {
    rangesByGradientLevel[_gradientLevelForRatio(span.value)].push(
      new vscode.Range(
        new vscode.Position(span.begin.line, span.begin.col),
        new vscode.Position(span.end.line, span.end.col)
      )
    );
  }

  return rangesByGradientLevel;
} // fn: _calculateDecorationRanges

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

  // Invalidate the range cache for this editor
  delete rangeCache[editor.document.fileName];
} // fn: clearCoverageHeatmapFromEditor
