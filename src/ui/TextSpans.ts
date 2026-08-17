/**
 * A tree of text spans organized by line and column. Each node has a
 * value of type T. The values of more-specific spans (e.g., children)
 * have precedence over less-specific spans (e.g., parents).
 */
export class TextSpans<T> {
  protected _root: TextSpanNode<T> = {
    begin: { line: -1, col: 0 },
    end: { line: Number.MAX_SAFE_INTEGER, col: 0 },
    spans: [],
  }; // span tree

  /**
   * Insert a new text span in the tree
   *
   * @param `range` to which value applies
   * @param `value` of type `T` for this range
   */
  public insert(range: TextSpanRange, value: T): void {
    let insertionPoint: (TextSpanRange & TextSpanNode<T>) | undefined =
      undefined;
    const newSpan: TextSpanValueNode<T> = {
      ...range,
      spans: [],
      value,
    };

    // check: range end >= range begin
    if (positionComparator(range.begin, range.end) === 1) {
      throw new Error(
        `Invalid insertion range: end (${JSON.stringify(range.end)}) cannot precede begin (${JSON.stringify(range.begin)})`
      );
    }

    // Find the insertion point for this span
    for (const span of this._root.spans) {
      insertionPoint = this._findInsertionPoint(span, range);
      if (insertionPoint) {
        break;
      }
    }

    // No insertion point: insert at the root
    insertionPoint = insertionPoint ?? this._root;

    // If prior subspans at the insertion point would be contained by the
    // inserted span, move those spans into the span we are inserting.
    const parentSpans: TextSpanValueNode<T>[] = [];
    for (const i in insertionPoint.spans) {
      if (
        this._spanContainsRange(
          { ...range, spans: [] },
          insertionPoint.spans[i]
        )
      ) {
        newSpan.spans.push(insertionPoint.spans[i]);
      } else {
        parentSpans.push(insertionPoint.spans[i]);
      }
    }
    insertionPoint.spans = parentSpans;

    // Insert the span
    insertionPoint.spans.push(newSpan);
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
    span: TextSpanValueNode<T>,
    range: TextSpanRange
  ): TextSpanValueNode<T> | undefined {
    if (this._spanContainsRange(span, range)) {
      // Search for & return a more-precise span if found
      for (const subspan of span.spans) {
        const insertionPoint = this._findInsertionPoint(subspan, range);
        if (insertionPoint) {
          return insertionPoint;
        }
      }
      return span; // this span is the most precise
    }
    return undefined; // not a match
  } // fn: _findInsertionPoint

  /**
   * Returns `true` if the given `span` contains the given `range`
   *
   * @param `span` potentially-containing span
   * @param `range` potentially-contained range
   * @returns `true` if `span` contains `range` and `false` otherwise
   */
  protected _spanContainsRange(
    span: TextSpanRange & TextSpanNode<T>,
    range: TextSpanRange
  ): boolean {
    return (
      positionComparator(span.begin, range.begin) !== 1 &&
      positionComparator(range.end, span.end) !== 1
    );
  } // fn: _spanContainsRange

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
    const traverse = (span: TextSpanValueNode<T>): void => {
      // Sort the spans by begin position
      span.spans.sort((a, b) => positionComparator(a.begin, b.begin));

      // If we have subspans, flatten those and handle gaps
      if (span.spans.length) {
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
              begin: span.spans[Number(i) - 1].end,
              end: span.spans[i].begin,
              value: span.value,
            });
          }

          // Handle the subspan
          traverse(span.spans[i]);
        }
        // If there's a gap between the span's end and its last child's
        // end, output a span for the gap.
        const lastSubSpan = span.spans.length - 1;
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

  /**
   * Returns `true` if the rep is consistent; `false` otherwise
   */
  public repOk(): boolean {
    // Helper function to check individual spans
    const spanOk = (span: TextSpanRange & TextSpanNode<T>): boolean => {
      let priorSubspan: (TextSpanRange & TextSpanNode<T>) | undefined =
        undefined;
      // check: begin <= end
      if (positionComparator(span.begin, span.end) === 1) {
        console.error(
          `Rep not ok: span end cannot precede begin ${JSON.stringify({ begin: span.begin, end: span.end })}`
        );
        return false;
      }

      // check individual subspans
      for (const subspan of span.spans.sort((a, b) =>
        positionComparator(a.begin, b.begin)
      )) {
        // check: span contains its subspan
        if (!this._spanContainsRange(span, subspan)) {
          console.error(
            `Rep not ok: subspan of range ${JSON.stringify({ begin: subspan.begin, end: subspan.end })} not contained by parent span of range: ${JSON.stringify({ begin: span.begin, end: span.end })}`
          );
          return false;
        }

        // check: no overlap with prior subspan
        if (
          priorSubspan &&
          positionComparator(priorSubspan.end, subspan.begin) === 1
        ) {
          console.error(
            `Rep not ok: subspan of range ${JSON.stringify({ begin: subspan.begin, end: subspan.end })} overlaps with prior subspan of range: ${JSON.stringify({ begin: priorSubspan.begin, end: priorSubspan.end })}`
          );
          return false;
        }

        // check individual subspan
        spanOk(subspan);

        priorSubspan = subspan;
      }
      return true;
    }; // fn: spanOk

    // Check the root
    return spanOk(this._root);
  } // fn: repOk

  /**
   * Produce a string representation of the TextSpan tree.
   */
  public toString(): string {
    return JSON.stringify(this._root, null, 2);
  } // fn: toString
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
type TextSpanNode<T> = TextSpanRange & {
  spans: TextSpanValueNode<T>[];
};
type TextSpan<T> = TextSpanRange & {
  value: T;
};
type TextSpanValueNode<T> = TextSpanNode<T> & {
  value: T;
};
