import * as vscode from "vscode";
import { FileCoverage } from "../fuzzer/measures/CoverageMeasure";

// The number of different heat levels to visualize
const GRANULARITY = 20;

// Create buckets for code coverage decorations
const gradientDecorationTypes: vscode.TextEditorDecorationType[] = [];
for (let i = 0; i <= GRANULARITY; i++) {
  const alpha = 0.1 + (0.34 * i) / GRANULARITY;

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
  const spans = new TextSpans<number>();

  if (!editor.document.lineCount) {
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

  // Bucket decorations by type and relative heat
  const rangesByGradientLevel: vscode.Range[][] = Array.from(
    { length: GRANULARITY + 1 },
    () => []
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
      fileMap.f[f] // number of hits
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
      fileMap.s[s] // number of hits
    );
  }

  // Flatten the spans & assign them to decoration buckets
  for (const span of spans.flatten()) {
    rangesByGradientLevel[_gradientLevelForRatio(span.value)].push(
      new vscode.Range(
        new vscode.Position(span.begin.line, span.begin.col),
        new vscode.Position(span.end.line, span.end.col)
      )
    );
  }

  // Apply the editor decorations to the hit elements
  // Note: skip coloring elements with no hits (i===0))
  for (let i = 1; i <= GRANULARITY; i++) {
    editor.setDecorations(gradientDecorationTypes[i], rangesByGradientLevel[i]);
  }
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

/**
 * A tree of text spans with values organized by line and column.
 * The values of more-specific spans (e.g., leaves) have precedence
 * over ancestor spans.
 */
class TextSpans<T> {
  protected _root: TextSpanRoot<T> = { spans: [] }; // span tree

  /**
   * Insert a new text span in the tree
   *
   * @param `range` to which value applies
   * @param `value` of type `T` for this range
   */
  public insert(range: TextSpanRange, value: T): void {
    let insertionPoint: TextSpanNode<T> | undefined = undefined;
    for (const span of this._root.spans) {
      insertionPoint = this._findInsertionPoint(span, range);
      if (insertionPoint) {
        break;
      }
    }
    (insertionPoint ? insertionPoint.spans : this._root.spans).push({
      ...range,
      spans: [],
      value,
    });
  } // fn: insert

  /**
   * Traverses the tree of TextSpans starting at `span` and
   * returns the most-specific span node that contains range.
   * This returned node is the insertion point.
   *
   * @param `span` node from which to start search
   * @param `range` range to insert
   * @returns the most-specific `TextSpanNode` that contains
   * `range` or `undefined` if no match is found.
   */
  protected _findInsertionPoint(
    span: TextSpanNode<T>,
    range: TextSpanRange
  ): TextSpanNode<T> | undefined {
    const rangeStartsWithinSpan =
      range.begin.line > span.begin.line ||
      (range.begin.line === span.begin.line &&
        range.begin.col >= span.begin.col);
    const rangeEndsWithinSpan =
      range.end.line < span.end.line ||
      (range.end.line === span.end.line && range.end.col <= span.end.col);
    if (rangeStartsWithinSpan && rangeEndsWithinSpan) {
      // Search for & return a more-precise span if found
      for (const subSpan of span.spans) {
        const insertionPoint = this._findInsertionPoint(subSpan, range);
        if (insertionPoint) {
          return insertionPoint;
        }
      }
      return span; // this span is the most precise
    }
    return undefined; // not a match
  } // fn: _findInsertionPoint

  /**
   * Flattens the tree of text spans into an array of spans
   * with values where the values of more-specific
   * spans have precedence.
   *
   * @returns array of `TextSpan<T>`
   */
  public flatten(): TextSpan<T>[] {
    const flatSpans: TextSpan<T>[] = [];

    // Helper function to traverse the span tree
    const traverse = (span: TextSpanNode<T>): void => {
      // Sort the spans by begin position
      span.spans.sort((a, b) => positionComparator(a.begin, b.begin));

      // If we have subspans, flatten those and handle gaps
      if (span.spans.length) {
        const lastSubSpan = span.spans.length - 1;
        // If there's a gap between the span's start and its first child's
        // start, output a span for the gap.
        if (positionComparator(span.begin, span.spans[0].begin) === -1) {
          flatSpans.push({
            begin: span.begin,
            end: span.spans[0].begin,
            value: span.value,
          });
        }
        for (const i in span.spans) {
          // If a gap exists between this and the prior subspan,
          // output a span for the gap
          if (
            Number(i) > 0 &&
            positionComparator(
              span.spans[Number(i) - 1].end,
              span.spans[i].begin
            ) === -1
          ) {
            flatSpans.push({
              begin: span.spans[lastSubSpan].end,
              end: span.end,
              value: span.value,
            });
          }

          // Handle the subspan
          traverse(span.spans[i]);
        }
        // If there's a gap between the span's end and its last child's
        // end, output a span for the gap.
        if (positionComparator(span.spans[lastSubSpan].end, span.end) === -1) {
          flatSpans.push({
            begin: span.spans[lastSubSpan].end,
            end: span.end,
            value: span.value,
          });
        }
      } else {
        // Base case: no subspans. Output a span for the span.
        flatSpans.push({
          begin: span.begin,
          end: span.end,
          value: span.value,
        });
      }
    };

    // Sort the spans by begin position and traverse them
    this._root.spans
      .sort((a, b) => positionComparator(a.begin, b.begin))
      .forEach((span) => {
        traverse(span);
      });

    return flatSpans;
  } // fn: flatten
} // class: TextSpans

/**
 * Compares two `TestSpanPosition`s
 *
 * @param `a` the first `TextSpanPosition`
 * @param `b` the second `TextSpanPosition`
 * @returns -1 if `a`<`b`, 0 if `a`===`b`, 1 if `a`>`b`
 */
function positionComparator(a: TextSpanPosition, b: TextSpanPosition): number {
  if (a.line === b.line && a.col === b.col) {
    return 0; // a===b
  } else if (a.line < b.line || (a.line === b.line && a.col < b.col)) {
    return -1; // a<b
  } else {
    return 1; // a>b
  }
} // fn: positionComparator

/**
 * Types for TextSpans
 */
type TextSpanPosition = {
  line: number;
  col: number;
};
type TextSpanRange = {
  begin: TextSpanPosition;
  end: TextSpanPosition;
};
type TextSpanRoot<T> = {
  spans: TextSpanNode<T>[];
};
type TextSpan<T> = TextSpanRange & {
  value: T;
};
type TextSpanNode<T> = TextSpan<T> & TextSpanRoot<T>;
