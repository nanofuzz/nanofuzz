import { ProgramLanguage } from "../analysis/Types";
import { AbstractCoverageMeasure } from "./AbstractCoverageMeasure";
import { AbstractMeasure } from "./AbstractMeasure";
import { TypescriptCoverageMeasure } from "./TypescriptCoverageMeasure";
import { FailedTestMeasure } from "./FailedTestMeasure";
import { PythonCoverageMeasure } from "./PythonCoverageMeasure";

export function MeasureFactory(lang: ProgramLanguage): AbstractMeasure[] {
  let covMeasure: AbstractCoverageMeasure;
  if (lang === "python") {
    covMeasure = new PythonCoverageMeasure();
  } else {
    covMeasure = new TypescriptCoverageMeasure();
  }
  const testMeasure = new FailedTestMeasure(covMeasure);
  return [covMeasure, testMeasure];
}
