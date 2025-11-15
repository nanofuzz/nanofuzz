import * as vscode from "vscode";
import { LineHits } from "fuzzer/measures/CoverageMeasure";

// The number of different heat levels to visualize
const GRANULARITY = 20;

let gradientDecorationTypes: vscode.TextEditorDecorationType[] | null = null;

function _initGradientDecorationTypes() {
  if (gradientDecorationTypes) return;
  gradientDecorationTypes = [];

  for (let i = 0; i <= GRANULARITY; i++) {
    const hue = (120 * i) / GRANULARITY;
    const alpha =
      0.06 +
      0.24 * ((Math.abs(i - Math.floor(GRANULARITY / 2)) / GRANULARITY) * 2);

    const lightColor = `hsla(${hue}, 80%, 60%, ${alpha.toFixed(2)})`;
    const darkColor = `hsla(${hue}, 80%, 45%, ${alpha.toFixed(2)})`;

    gradientDecorationTypes.push(
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        light: { backgroundColor: lightColor },
        dark: { backgroundColor: darkColor },
      })
    );
  }
}

function _gradientLevelForRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 1) return GRANULARITY;
  return Math.max(1, Math.min(GRANULARITY, Math.round(ratio * GRANULARITY)));
}

export function applyCoverageHeatmap(
  editor: vscode.TextEditor,
  lineHits: LineHits
): void {
  _initGradientDecorationTypes();
  if (!gradientDecorationTypes) return;

  const totalLines = editor.document.lineCount;
  if (totalLines === 0) {
    clearCoverageHeatmap(editor);
    return;
  }

  const maxHits = Math.max(0, ...Object.values(lineHits));

  const rangesByGradientLevel: vscode.Range[][] = Array.from(
    { length: GRANULARITY + 1 },
    () => []
  );

  for (let line = 0; line < totalLines; line++) {
    if (!(line + 1 in lineHits)) continue;

    // +1 to convert to 1-based line numbers.
    const hits = lineHits[line + 1];

    const range = new vscode.Range(
      new vscode.Position(line, 0),
      new vscode.Position(line, 0)
    );

    const ratio = hits / maxHits;
    const gradientLevel = _gradientLevelForRatio(ratio);
    console.log(ratio, gradientLevel);
    rangesByGradientLevel[gradientLevel].push(range);
  }

  for (let i = 0; i <= GRANULARITY; i++) {
    editor.setDecorations(gradientDecorationTypes[i], rangesByGradientLevel[i]);
  }
}

export function clearCoverageHeatmap(editor: vscode.TextEditor): void {
  if (!gradientDecorationTypes) return;
  for (const type of gradientDecorationTypes) {
    editor.setDecorations(type, []);
  }
}
