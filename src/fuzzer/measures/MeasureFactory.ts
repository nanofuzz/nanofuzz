import { AbstractMeasure } from "./AbstractMeasure";
import { CoverageMeasure } from "./CoverageMeasure";
import { FailedTestMeasure } from "./FailedTestMeasure";

export function MeasureFactory(): AbstractMeasure[] {
  const covMeasure = new CoverageMeasure();
  const testMeasure = new FailedTestMeasure(covMeasure);
  return [covMeasure, testMeasure];
}
