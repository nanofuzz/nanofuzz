import { PythonProgram } from "./PythonProgram";

class DebugPythonProgram extends PythonProgram {
  public get unsupportedFunctions() {
    return this._findFunctions().unsupported;
  }
}

const source = `from typing import Dict, List, Tuple

Scores = List[List[int]]
UserMeta = Dict[str, int]
Pair = Tuple[str, float]

class User:
    pass

def combine(
    user_id: int,
    /,
    name: str = "guest",
    scores: Scores = [[1, 2]],
    *weights: float,
    active: bool = True,
    pair: Pair,
    **metadata: UserMeta,
) -> bool:
    return active

def summarize(users: list[User], labels: dict[str, int], *flags: bool) -> Scores:
    """Example doc string"""
    return [[len(users), len(labels), len(flags)]]

def unsupported(value: MissingType) -> int:
    return 1
`;

const program = new DebugPythonProgram(() => source, "example.py");

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
