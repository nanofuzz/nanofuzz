import { Measure } from "./Measure";
import { FuzzTestResults } from "../Fuzzer";

// export class CoverageMeasure implements Measure {
//   public readonly name = "CoverageMeasure";

//   private _weight = 1;

//   // measure function
//   // measure(result: FuzzTestResult): number {
//   //   return result.coverage;
//   // }

//   // progress

//   public get weight(): number {
//     return this._weight;
//   }
// }

export class CoverageMeasure extends Measure {
  static readonly _id = "CoverageMeasure";

  static get id(): string {
    return CoverageMeasure._id;
  }

  static measure(results: FuzzTestResults): number {
    console.log(
      "CoverageMeasure.measure",
      results.aggregateCoverageSummary?.statements.pct ?? 0,
      results.aggregateCoverageSummary,
      results.aggregateCoverageSummary?.statements
    );
    const coverageStatements = results.aggregateCoverageSummary?.statements;
    if (coverageStatements && coverageStatements.covered === 0) return 0;
    return coverageStatements?.pct ?? 0;
  }
}
