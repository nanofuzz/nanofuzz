import { FuzzEnv } from "../Fuzzer";
import { AbstractMeasure } from "./AbstractMeasure";
import { CoverageMeasure } from "./CoverageMeasure";

export function MeasureFactory(env: FuzzEnv): AbstractMeasure[] {
  env; // !!!!!!! Base list of measures on FuzzEnv
  return [new CoverageMeasure()];
}
