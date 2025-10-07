import { FuzzEnv } from "../Fuzzer";
import { AbstractMeasure } from "./AbstractMeasure";
import { CoverageMeasure } from "./CoverageMeasure";
import { FailedTestMeasure } from "./FailedTestMeasure";

export function MeasureFactory(env: FuzzEnv): AbstractMeasure[] {
  env; // !!!!!!! Base list of measures on FuzzEnv; measure weight
  return [new CoverageMeasure() /* !!!!!!!!, new FailedTestMeasure()*/];
}
