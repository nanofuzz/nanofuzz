import { ProgramLanguage } from "../analysis/ProgramFactory";
import { AbstractCoverageMeasure } from "./AbstractCoverageMeasure";
import { AbstractMeasure } from "./AbstractMeasure";
import { CoverageMeasure } from "./CoverageMeasure";
import { FailedTestMeasure } from "./FailedTestMeasure";
import { PythonCoverageMeasure } from "./PythonCoverageMeasure";

export function MeasureFactory(lang: ProgramLanguage): AbstractMeasure[] {
  let covMeasure: AbstractCoverageMeasure;
  if (lang === 'python') {
    covMeasure = new PythonCoverageMeasure();
  } else { // ts
    covMeasure = new CoverageMeasure();
  }
  const testMeasure = new FailedTestMeasure(covMeasure);
  return [covMeasure, testMeasure];
}
