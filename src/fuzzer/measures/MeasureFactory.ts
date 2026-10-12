import { ProgramLanguage } from "../analysis/Types";
import { CoverageMeasure } from "./CoverageMeasure";
import { AbstractMeasure } from "./AbstractMeasure";
import { FailedTestMeasure } from "./FailedTestMeasure";

export function MeasureFactory(_lang: ProgramLanguage): AbstractMeasure[] {
  const covMeasure = new CoverageMeasure();
  const testMeasure = new FailedTestMeasure(covMeasure);
  return [covMeasure, testMeasure];
} // fn: MeasureFactory
