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
export function _calculateDecorationRanges(
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

  // Collect all non-zero hit counts to compute the Winsorized maximum
  // threshold (95th percentile). Winsorization caps extreme hit count
  // outliers (e.g., from infinite loop timeouts or tight loops) so that
  // normal code statements executed 10x vs 100x retain distinct
  // appropriate visual contrast.
  const allHitCounts: number[] = [
    ...Object.values(fileMap.s),
    ...Object.values(fileMap.b).flatMap((b) =>
      b.filter((e) => !Number.isNaN(e))
    ),
    ...Object.values(fileMap.f),
  ]
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b);

  const maxHits =
    allHitCounts.length > 0 ? allHitCounts[allHitCounts.length - 1] : 0;

  // Winsorized maximum (95th percentile threshold). Hit counts above this cap
  // are clamped to effectiveMaxHits so outlier loops do not compress the scale.
  let effectiveMaxHits = maxHits;
  if (allHitCounts.length >= 5) {
    const p95Idx = Math.floor((allHitCounts.length - 1) * 0.95);
    effectiveMaxHits = Math.max(1, allHitCounts[p95Idx]);
  }

  // Helper function to assign a hit count to a decoration bucket using
  // Square-Root Scaling with Winsorization:
  //
  // 1. Winsorization (95th percentile capping): Clamps extreme outlier hit
  //    counts, such as 1,000,000 iterations in an infinite loop timeout,
  //    to effectiveMaxHits so they do not overwhelm the heat contrast for
  //    other hits in the heatmap.
  // 2. Square-root scaling (sqrt(hits) / sqrt(max)): Provides "better"
  //    perceptual contrast for execution frequencies (e.g., 1x vs 10x vs
  //    100x) without the severe compression of logarithmic scaling or the
  //    distortion that can result from linear scaling.
  function _gradientLevelForRatio(hits: number): number {
    if (hits === 0 || !Number.isFinite(hits) || hits <= 0) return 0;
    if (effectiveMaxHits <= 1) return GRANULARITY;

    const clampedHits = Math.min(hits, effectiveMaxHits);
    const ratio = Math.sqrt(clampedHits) / Math.sqrt(effectiveMaxHits);

    if (ratio <= 0) return 1;
    if (ratio >= 1) return GRANULARITY;
    return Math.max(1, Math.min(GRANULARITY, Math.ceil(ratio * GRANULARITY)));
  } // fn: _gradientLevelForRatio

  // Function coverage
  for (const f of Object.keys(fileMap.f)) {
    const element = fileMap.fnMap[f]; // hit element
    if (!element?.decl?.start || !element?.decl?.end) continue;

    const startCol = element.decl.start.column;
    let endCol = element.decl.end.column;
    const startLine = element.decl.start.line - 1;

    // If doc is available, expand arrow function declaration headers
    // (e.g. `(x) => ` or `x => `) so the parameter header is covered
    // as a complete unit instead of leaving isolated single-char
    // `(` highlights.
    if (doc && startLine >= 0 && startLine < doc.lineCount) {
      const lineText = doc.lineAt(startLine).text;
      const arrowIdx = lineText.indexOf("=>", startCol);
      if (arrowIdx >= startCol) {
        let afterArrow = arrowIdx + 2;
        while (
          afterArrow < lineText.length &&
          /\s/.test(lineText[afterArrow])
        ) {
          afterArrow++;
        }
        if (afterArrow > endCol) {
          endCol = afterArrow;
        }
      }
    }

    spans.insert(
      {
        begin: {
          line: startLine,
          col: startCol,
        },
        end: { line: element.decl.end.line - 1, col: endCol },
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
      for (let i = 0; i < hits.length; i++) {
        const loc = element.locations[i];
        if (!loc?.start || !loc?.end) continue;

        let startCol = loc.start.column;
        const startLine = loc.start.line - 1;

        // For conditional expressions (ternary `? :`), expand branch arm
        // start leftward if preceded by `: ` or `? ` on the same line so
        // the operator syntax is grouped with its arm
        if (
          element.type === "cond-expr" &&
          doc &&
          startLine >= 0 &&
          startLine < doc.lineCount
        ) {
          const lineText = doc.lineAt(startLine).text;
          const prefix = lineText.substring(0, startCol);
          const operatorMatch = prefix.match(/([?:])\s*$/);
          if (operatorMatch && operatorMatch.index !== undefined) {
            startCol = operatorMatch.index;
          }
        }

        spans.insert(
          {
            begin: {
              line: startLine,
              col: startCol,
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

  // First pass: compute expanded begin position for each statement.
  // If source map points to an inner expression/rvalue on the line
  // (e.g. initializers for const/let/var), expand begin.col leftwards
  // to the start of the statement (line's first non-whitespace character).
  const expandedBegins: Record<string, { line: number; col: number }> = {};
  for (const s of statementKeys) {
    const element = fileMap.statementMap[s];
    if (!element?.start || !element?.end) continue;

    const begin = {
      line: element.start.line - 1,
      col: element.start.column,
    };

    if (doc && begin.line >= 0 && begin.line < doc.lineCount) {
      const lineText = doc.lineAt(begin.line).text;
      const firstNonWsCol = lineText.search(/\S/);
      if (firstNonWsCol >= 0 && firstNonWsCol < begin.col) {
        let minAllowedCol = firstNonWsCol;
        let isInsideOtherStmt = false;

        for (const otherKey of statementKeys) {
          if (otherKey === s) continue;
          const other = fileMap.statementMap[otherKey];
          if (!other?.start || !other?.end) continue;

          // If another statement on the same line ends before s, do not
          // expand past its end
          if (
            other.end.line === element.start.line &&
            other.end.column <= element.start.column
          ) {
            if (other.end.column > minAllowedCol) {
              minAllowedCol = other.end.column;
            }
          }

          // If another statement contains s (whether on the same line or
          // starting on an earlier line)
          if (
            (other.start.line < element.start.line ||
              (other.start.line === element.start.line &&
                other.start.column <= element.start.column)) &&
            (other.end.line > element.end.line ||
              (other.end.line === element.end.line &&
                other.end.column >= element.end.column))
          ) {
            isInsideOtherStmt = true;
            const startColInLine =
              other.start.line === element.start.line
                ? other.start.column
                : firstNonWsCol;
            if (startColInLine > minAllowedCol) {
              minAllowedCol = startColInLine;
            }
          }
        }

        // Search for declaration/return keyword in lineText starting
        // between minAllowedCol and begin.col
        const linePrefix = lineText.substring(
          minAllowedCol,
          element.end.column
        );
        const kwMatches = [
          ...linePrefix.matchAll(
            /\b(const|let|var|return|throw|await|yield|def|val)\b/g
          ),
        ].filter((m) => minAllowedCol + (m.index ?? 0) <= begin.col);

        if (kwMatches.length > 0) {
          const lastKw = kwMatches[kwMatches.length - 1];
          const kwCol = minAllowedCol + (lastKw.index ?? 0);
          const kwPrefix = lineText.substring(kwCol, begin.col);
          if (!/[/*#;]/.test(kwPrefix)) {
            begin.col = kwCol;
          }
        } else if (!isInsideOtherStmt) {
          // If no keyword and not inside a container statement, expand
          // to first non-whitespace character after the last comment
          // delimiter or semicolon
          const lastSepMatch = linePrefix.match(/.*[/*#;]/);
          const safeStart = lastSepMatch ? lastSepMatch[0].length : 0;
          const cleanSuffix = linePrefix.substring(safeStart);
          const nonWsRel = cleanSuffix.search(/\S/);
          if (nonWsRel >= 0) {
            begin.col = minAllowedCol + safeStart + nonWsRel;
          }
        }
      }
    }
    expandedBegins[s] = begin;
  }

  // Second pass: insert statement ranges
  for (const s of statementKeys) {
    const element = fileMap.statementMap[s]; // hit element
    if (!element?.start || !element?.end || !expandedBegins[s]) continue;

    const begin = expandedBegins[s];
    let end = {
      line: element.end.line - 1,
      col: element.end.column,
    };

    if (doc && begin.line >= 0 && begin.line < doc.lineCount) {
      const lineText = doc.lineAt(begin.line).text;
      // If single-line statement ends near a trailing semicolon on lineText, include trailing semicolon
      if (begin.line === end.line) {
        while (end.col < lineText.length && lineText[end.col] === ";") {
          end.col++;
        }
      }
    }

    // Check if s is a block container statement (e.g. while, if, for,
    // try, switch, do)
    let isBlockContainer = false;
    if (doc && begin.line >= 0 && begin.line < doc.lineCount) {
      const lineText = doc.lineAt(begin.line).text;
      const stmtStartText = lineText.substring(begin.col);
      if (
        /^\s*\b(while|if|for|try|switch|do)\b/.test(stmtStartText) ||
        /\b(while|if|for|try|switch|do)\s*\(/.test(stmtStartText)
      ) {
        isBlockContainer = true;
      }
    }

    // Only trim container statement headers if s is a block container
    if (isBlockContainer) {
      let earliestChildStart: { line: number; column: number } | undefined;
      for (const childKey of statementKeys) {
        if (childKey === s) continue;
        const child = fileMap.statementMap[childKey];
        const childBegin = expandedBegins[childKey];
        if (!child?.start || !child?.end || !childBegin) continue;

        if (
          (childBegin.line > element.start.line ||
            (childBegin.line === element.start.line &&
              childBegin.col > begin.col)) &&
          (child.end.line < element.end.line ||
            (child.end.line === element.end.line &&
              child.end.column <= element.end.column))
        ) {
          if (
            !earliestChildStart ||
            childBegin.line < earliestChildStart.line ||
            (childBegin.line === earliestChildStart.line &&
              childBegin.col < earliestChildStart.column)
          ) {
            earliestChildStart = {
              line: childBegin.line + 1,
              column: childBegin.col,
            };
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
          // Multi-line container statement: trim end to the end of the
          // container header line
          end = {
            line: element.start.line - 1,
            col:
              doc &&
              element.start.line - 1 >= 0 &&
              element.start.line - 1 < doc.lineCount
                ? doc.lineAt(element.start.line - 1).text.length
                : Number.MAX_SAFE_INTEGER,
          };
        }

        // Insert a dedicated span for the container's closing brace '}' at
        // element.end ONLY if a '}' is present
        const closingLine = element.end.line - 1;
        const closingCol = element.end.column;
        if (
          doc &&
          closingLine >= 0 &&
          closingLine < doc.lineCount &&
          closingCol > 0
        ) {
          const closingLineText = doc.lineAt(closingLine).text;
          let braceStartCol = -1;
          let braceEndCol = closingCol;

          if (
            closingCol <= closingLineText.length &&
            closingLineText[closingCol - 1] === "}"
          ) {
            braceStartCol = closingCol - 1;
            if (
              braceEndCol < closingLineText.length &&
              closingLineText[braceEndCol] === ";"
            ) {
              braceEndCol++;
            }
          } else if (
            closingCol <= closingLineText.length &&
            closingLineText[closingCol - 1] === ";" &&
            closingCol >= 2 &&
            closingLineText[closingCol - 2] === "}"
          ) {
            braceStartCol = closingCol - 2;
          }

          if (braceStartCol >= 0) {
            spans.insert(
              {
                begin: { line: closingLine, col: braceStartCol },
                end: { line: closingLine, col: braceEndCol },
              },
              fileMap.s[s]
            );
          }
        }
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
