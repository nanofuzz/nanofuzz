import { FuzzEnv } from "../Fuzzer";
import { AbstractMeasure } from "./AbstractMeasure";
import { CoverageMeasure } from "./CoverageMeasure";
import { FailedTestMeasure } from "./FailedTestMeasure";

export function MeasureFactory(env: FuzzEnv): AbstractMeasure[] {
  const measures: AbstractMeasure[] = [];

  let covMeasure: CoverageMeasure | undefined;
  if (env.options.measures["CoverageMeasure"].enabled) {
    covMeasure = new CoverageMeasure();
    measures.push(covMeasure);
  }

  if (env.options.measures["FailedTestMeasure"].enabled) {
    measures.push(new FailedTestMeasure(covMeasure));
  }

  return measures;
}
