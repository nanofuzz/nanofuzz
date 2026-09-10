import * as vscode from "vscode";
import { FileCoverage } from "../fuzzer/measures/AbstractCoverageMeasure";
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
      : _calculateDecorationRanges(fileMap, editor.document); // create new

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
 * @param `doc` optional vscode text document for statement start column alignment
 * @returns `vscode.Range`s bucketed according to hit count
 */
function _calculateDecorationRanges(
  fileMap: FileCoverage,
  doc?: vscode.TextDocument
): vscode.Range[][] {
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
    if (!element?.decl?.start || !element?.decl?.end) continue;
    spans.insert(
      {
        begin: {
          line: element.decl.start.line - 1,
          col: element.decl.start.column,
        },
        end: { line: element.decl.end.line - 1, col: element.decl.end.column },
      },
      fileMap.f[f]
    );
  }

  // Branch coverage
  for (const b of Object.keys(fileMap.b)) {
    const element = fileMap.branchMap[b]; // hit element
    if (!element || !element.locations) continue;
    const hits = fileMap.b[b]; // array of hits

    // Note: instanbul's branch locations for if statements are broken.
    // See https://github.com/istanbuljs/istanbuljs/issues/130
    // Workaround here: ignore if branches.
    if (element.type !== "if") {
      for (const i in hits) {
        const loc = element.locations[i];
        if (!loc?.start || !loc?.end) continue;
        spans.insert(
          {
            begin: {
              line: loc.start.line - 1,
              col: loc.start.column,
            },
            end: {
              line: loc.end.line - 1,
              col: loc.end.column,
            },
          },
          hits[i]
        );
      }
    }
  }

  // Statement coverage
  const statementKeys = Object.keys(fileMap.s);
  for (const s of statementKeys) {
    const element = fileMap.statementMap[s]; // hit element
    if (!element?.start || !element?.end) continue;

    const begin = {
      line: element.start.line - 1,
      col: element.start.column,
    };
    let end = {
      line: element.end.line - 1,
      col: element.end.column,
    };

    // If source map points to an inner expression/rvalue on the line
    // (e.g. initializers for const/let/var), expand begin.col leftwards
    // to the start of the statement (line's first non-whitespace character)
    if (doc && begin.line >= 0 && begin.line < doc.lineCount) {
      const lineText = doc.lineAt(begin.line).text;
      const firstNonWsCol = lineText.search(/\S/);
      if (firstNonWsCol >= 0 && firstNonWsCol < begin.col) {
        let minAllowedCol = firstNonWsCol;
        for (const otherKey of statementKeys) {
          if (otherKey === s) continue;
          const other = fileMap.statementMap[otherKey];
          if (
            other?.end &&
            other.end.line === element.start.line &&
            other.end.column <= element.start.column
          ) {
            if (other.end.column > minAllowedCol) {
              minAllowedCol = other.end.column;
            }
          }
        }
        if (minAllowedCol < begin.col) {
          begin.col = minAllowedCol;
        }
      }

      // If single-line statement ends near a trailing semicolon on lineText, include the semicolon
      if (
        begin.line === end.line &&
        end.col < lineText.length &&
        lineText[end.col] === ";"
      ) {
        end.col++;
      }
    }

    // If this statement contains child statements, trim its end to the header line(s) before its earliest child
    // so container headers (e.g. while/if/for/try) are highlighted without bleeding into children's line indentation
    let earliestChildStart: { line: number; column: number } | undefined;
    for (const childKey of statementKeys) {
      if (childKey === s) continue;
      const child = fileMap.statementMap[childKey];
      if (!child?.start || !child?.end) continue;

      if (
        (child.start.line > element.start.line ||
          (child.start.line === element.start.line &&
            child.start.column > element.start.column)) &&
        (child.end.line < element.end.line ||
          (child.end.line === element.end.line &&
            child.end.column <= element.end.column))
      ) {
        if (
          !earliestChildStart ||
          child.start.line < earliestChildStart.line ||
          (child.start.line === earliestChildStart.line &&
            child.start.column < earliestChildStart.column)
        ) {
          earliestChildStart = child.start;
        }
      }
    }

    if (earliestChildStart) {
      if (earliestChildStart.line === element.start.line) {
        end = {
          line: earliestChildStart.line - 1,
          col: earliestChildStart.column,
        };
      } else {
        end = {
          line: earliestChildStart.line - 2,
          col: Number.MAX_SAFE_INTEGER,
        };
      }
    }

    spans.insert({ begin, end }, fileMap.s[s]);
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
