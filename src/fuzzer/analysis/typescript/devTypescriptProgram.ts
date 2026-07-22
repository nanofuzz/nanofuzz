import { TypescriptProgram } from "./TypescriptProgram";

class DebugTypescriptProgram extends TypescriptProgram {
  public get unsupportedFunctions() {
    return this._functions.unsupported;
  }
}

const source = `type Scores = number[][];
type UserMeta = { key: string; value: number };
type Pair = [string, number];
type User = { id: number };

function combine(
  userId: number,
  name: string,
  scores: Scores,
  weights: number[],
  active: boolean,
  pair: Pair,
  metadata: UserMeta
): boolean {
  return active;
}

/** Example doc string */
function summarize(
  users: User[],
  labels: { key: string; value: number },
  flags: boolean[]
): Scores {
  return [[users.length, labels.key.length, flags.length]];
}

function unsupported(value: MissingType): number {
  return 1;
}
`;

const program = new DebugTypescriptProgram(() => source, "example.ts");

console.log(
  JSON.stringify(
    {
      source,
      imports: program.imports,
      types: program.types,
      functions: Object.fromEntries(
        Object.entries(program.functions).map(([name, fn]) => [
          name,
          fn.getRef(),
        ])
      ),
      unsupportedFunctions: program.unsupportedFunctions,
    },
    null,
    2
  )
);
