import * as ProgramFactory from "../ProgramFactory";
import { ArgDef } from "../ArgDef";
import { ArgTag } from "../Types";
import { PythonProgram } from "./PythonProgram";
import * as fs from "fs";
import * as path from "path";
import * as Parser from "../../adapters/ParserAdapter";

class InspectablePythonProgram extends PythonProgram {
  public get unsupportedFunctions() {
    return this._functions.unsupported;
  }
}

describe("fuzzer/analysis/python/PythonProgram: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("distinguishes int and float input options", () => {
    // Set the global default to false so this verifies that `int` supplies
    // its own constraint rather than inheriting the default by coincidence.
    const options = ArgDef.getDefaultOptions();
    options.numInteger = false;
    const fn = ProgramFactory.fromSource(
      () => `type UserId = int
def update(user_id: UserId, count: int, ratio: float, values: list[float]) -> None:
  pass`,
      "python",
      "",
      options
    ).functionsExported["update"];

    const args = fn.getArgDefs();
    expect(args.map((arg) => arg.getType())).toEqual([
      ArgTag.NUMBER,
      ArgTag.NUMBER,
      ArgTag.NUMBER,
      ArgTag.NUMBER,
    ]);
    expect(args.map((arg) => arg.getOptions().numInteger)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("Local type alias", () => {
    expect(
      ProgramFactory.fromSource(
        () => `type a = str
def greeting(name: a) -> a:
  return 'Hello ' + name`,
        "python"
      ).types
    ).toEqual({
      a: {
        isExported: true,
        optional: false,
        dims: 0,
        module: "",
        type: {
          dims: 0,
          type: ArgTag.STRING,
          children: [],
          resolved: true,
        },
      },
    });
  });

  it("Local type alias in function", () => {
    const fns = ProgramFactory.fromSource(
      () => `type a = str
def greeting(name: a) -> a:
  return 'Hello ' + name`,
      "python"
    ).functionsExported;
    expect(Object.keys(fns).length).toEqual(1);
    expect(fns["greeting"]).toBeDefined();
    expect(fns["greeting"].getName()).toEqual("greeting");
    expect(fns["greeting"].getCmt()).not.toBeDefined();
    expect(fns["greeting"].getSrc()).toEqual(`def greeting(name: a) -> a:
  return 'Hello ' + name`);

    const args = fns["greeting"].getArgDefs();
    expect(args.length).toEqual(1);
    expect(args[0].getName()).toEqual("name");
    expect(args[0].getDim()).toEqual(0);
    expect(args[0].getChildren().length).toEqual(0);
    expect(args[0].getType()).toEqual(ArgTag.STRING);
    expect(args[0].isConstant()).toBeFalse();
    expect(args[0].getTypeRef()).toEqual("a");
    expect(PythonProgram.getTypeAnnotation(args[0])).toEqual("a");
  });

  it("extracts Python function docstrings", () => {
    const functions = ProgramFactory.fromSource(
      () => `def plain():
  "one line"
def multiline():
  r"""first line
  second line"""
def concatenated():
  "first" " second"
def formatted():
  f"value {1}"
def not_first():
  pass
  "not a docstring"`,
      "python"
    ).functionsExported;

    expect(
      ["plain", "multiline", "concatenated", "formatted", "not_first"].map(
        (name) => functions[name].getCmt()
      )
    ).toEqual([
      '"one line"',
      'r"""first line\n  second line"""',
      '"first" " second"',
      undefined,
      undefined,
    ]);
  });

  it("extracts primitive, collection, union, and literal aliases", () => {
    // PEP 695 aliases are analyzed without importing a runtime typing module.
    const types = ProgramFactory.fromSource(
      () => `type Count = int
type Ratio = float
type ComplexNumber = complex
type Label = str
type Enabled = bool
type Matrix = list[list[int]]
type Pair = tuple[str, float]
type Result = int | str
type Status = Literal["ok"]`,
      "python"
    ).types;

    expect(types["Count"].type?.type).toEqual(ArgTag.NUMBER);
    expect(types["Ratio"].type?.type).toEqual(ArgTag.NUMBER);
    expect(types["ComplexNumber"].type?.type).toEqual(ArgTag.NUMBER);
    expect(types["Label"].type?.type).toEqual(ArgTag.STRING);
    expect(types["Enabled"].type?.type).toEqual(ArgTag.BOOLEAN);
    expect(types["Matrix"].type).toEqual(
      jasmine.objectContaining({ type: ArgTag.NUMBER, dims: 2 })
    );
    expect(
      types["Pair"].type?.children.map((child) => child.type?.type)
    ).toEqual([ArgTag.STRING, ArgTag.NUMBER]);
    expect(
      types["Result"].type?.children.map((child) => child.type?.type)
    ).toEqual([ArgTag.NUMBER, ArgTag.STRING]);
    expect(types["Status"].type).toEqual(
      jasmine.objectContaining({ type: ArgTag.LITERAL, value: "ok" })
    );
  });

  it("extracts Python Literal values in several source forms", () => {
    const types = ProgramFactory.fromSource(
      () => `type RetryCount = Literal[0x10]
type EnabledFlag = Literal[True]
type EmptyLabel = Literal[""]`,
      "python"
    ).types;

    expect(types["RetryCount"].type?.value).toEqual(16);
    expect(types["EnabledFlag"].type?.value).toBeTrue();
    expect(types["EmptyLabel"].type?.value).toEqual("");
  });

  it("preserves deep collection dimensions and heterogeneous children", () => {
    // These are PEP 585 built-in generics, rather than typing.List/Tuple.
    const types = ProgramFactory.fromSource(
      () => `type Volume = list[list[list[float]]]
type Row = tuple[list[int], tuple[str, bool]]
type MixedColumn = list[int | str]`,
      "python"
    ).types;

    expect(types["Volume"].type).toEqual(
      jasmine.objectContaining({ type: ArgTag.NUMBER, dims: 3 })
    );
    expect(types["Row"].type?.type).toEqual(ArgTag.TUPLE);
    expect(types["Row"].type?.children[0].type).toEqual(
      jasmine.objectContaining({ type: ArgTag.NUMBER, dims: 1 })
    );
    expect(
      types["Row"].type?.children[1].type?.children.map(
        (child) => child.type?.type
      )
    ).toEqual([ArgTag.STRING, ArgTag.BOOLEAN]);
    expect(types["MixedColumn"].type).toEqual(
      jasmine.objectContaining({ type: ArgTag.UNION, dims: 1 })
    );
    expect(
      types["MixedColumn"].type?.children.map((child) => child.type?.type)
    ).toEqual([ArgTag.NUMBER, ArgTag.STRING]);
  });

  it("collapses singleton annotation unions", () => {
    const types = ProgramFactory.fromSource(
      () => "type MaybeCount = Optional[int]",
      "python"
    ).types;

    expect(types["MaybeCount"].type?.type).toEqual(ArgTag.NUMBER);
  });

  it("extracts TypedDict annotations as fixed objects", () => {
    const types = ProgramFactory.fromSource(
      () => `class Player(TypedDict):
    name: str
    rating: int
    tags: list[str]`,
      "python"
    ).types;

    expect(types["Player"].type?.type).toEqual(ArgTag.OBJECT);
    expect(types["Player"].type?.children.map((child) => child.name)).toEqual([
      "name",
      "rating",
      "tags",
    ]);
    expect(types["Player"].type?.children[0].type?.type).toEqual(ArgTag.STRING);
    expect(types["Player"].type?.children[1].type?.type).toEqual(ArgTag.NUMBER);
    expect(types["Player"].type?.children[2].type).toEqual(
      jasmine.objectContaining({ type: ArgTag.STRING, dims: 1 })
    );
  });

  it("recognizes qualified TypedDict bases and composite field annotations", () => {
    const types = ProgramFactory.fromSource(
      () => `class Settings(typing.TypedDict):
    retries: int | None
    labels: tuple[str, bool]`,
      "python"
    ).types;

    expect(types["Settings"].type?.type).toEqual(ArgTag.OBJECT);
    expect(types["Settings"].type?.children.map((child) => child.name)).toEqual(
      ["retries", "labels"]
    );
    expect(types["Settings"].type?.children[0].type?.type).toEqual(
      ArgTag.UNION
    );
    expect(
      types["Settings"].type?.children[0].type?.children.map(
        (child) => child.type?.type
      )
    ).toEqual([ArgTag.NUMBER, ArgTag.LITERAL]);
    expect(types["Settings"].type?.children[1].type?.type).toEqual(
      ArgTag.TUPLE
    );
  });

  it("recognizes aliased and typing_extensions TypedDict bases", () => {
    const types = ProgramFactory.fromSource(
      () => `from typing import TypedDict as TD

class User(TD):
    id: int

class Flags(typing_extensions.TypedDict):
    enabled: bool

class Admin(User):
    role: str`,
      "python"
    ).types;

    expect(types["User"].type?.type).toEqual(ArgTag.OBJECT);
    expect(types["User"].type?.children[0].name).toEqual("id");
    expect(types["Flags"].type?.type).toEqual(ArgTag.OBJECT);
    expect(types["Flags"].type?.children[0].type?.type).toEqual(ArgTag.BOOLEAN);
    expect(types["Admin"].type?.children.map((child) => child.name)).toEqual([
      "id",
      "role",
    ]);
  });

  it("does not export ordinary Python classes as TypedDict objects", () => {
    const types = ProgramFactory.fromSource(
      () => `class Player:
    name: str`,
      "python"
    ).types;

    expect(types["Player"]).toBeUndefined();
  });

  it("does not model ordinary dictionaries as fixed objects", () => {
    const types = ProgramFactory.fromSource(
      () => "type DynamicConfig = dict[str, int]",
      "python"
    ).types;

    expect(types["DynamicConfig"].type).toBeUndefined();
    expect(types["DynamicConfig"].typeRefName).toEqual("dict");
  });

  it("handles Python numeric literal spellings", () => {
    // Python allows bases and digit separators; both should become JS numbers.
    const types = ProgramFactory.fromSource(
      () => `type BinaryMask = Literal[0b1010]
type SeparatedCount = Literal[1_000]
type LearningRate = Literal[0.125]`,
      "python"
    ).types;

    expect(types["BinaryMask"].type?.value).toEqual(10);
    expect(types["SeparatedCount"].type?.value).toEqual(1000);
    expect(types["LearningRate"].type?.value).toEqual(0.125);
  });

  it("retains ML-library annotations as unresolved external type references", () => {
    // Parsing imports does not require ML packages to be installed. Their
    // member types remain references until a corresponding program is loaded.
    const types = ProgramFactory.fromSource(
      () => `import numpy as np
import torch
from pandas import DataFrame

type NumpyArray = np.ndarray
type TorchTensor = torch.Tensor
type Table = DataFrame`,
      "python"
    ).types;

    expect(types["NumpyArray"].type).toBeUndefined();
    expect(types["NumpyArray"].typeRefName).toEqual("np.ndarray");
    expect(types["TorchTensor"].type).toBeUndefined();
    expect(types["TorchTensor"].typeRefName).toEqual("torch.Tensor");
    expect(types["Table"].type).toBeUndefined();
    expect(types["Table"].typeRefName).toEqual("DataFrame");
  });

  it("records common machine-learning library import styles", () => {
    // Imports are recorded structurally; no numpy, torch, sklearn, or pandas
    // installation is required for this parser-level test.
    const imports = ProgramFactory.fromSource(
      () => `import numpy as np
import torch
from sklearn.model_selection import train_test_split
from pandas import DataFrame as Frame`,
      "python"
    ).imports;

    expect(imports["np"]).toEqual(
      jasmine.objectContaining({ local: "np", imported: "*", default: false })
    );
    expect(imports["torch"]).toEqual(
      jasmine.objectContaining({
        local: "torch",
        imported: "*",
        default: false,
      })
    );
    expect(imports["train_test_split"]).toEqual(
      jasmine.objectContaining({
        local: "train_test_split",
        imported: "train_test_split",
        default: false,
      })
    );
    expect(imports["Frame"]).toEqual(
      jasmine.objectContaining({
        local: "Frame",
        imported: "DataFrame",
        default: false,
      })
    );
  });

  it("records relative, aliased, and wildcard imports", () => {
    // Relative imports are common in packages; wildcard imports intentionally
    // retain their module name so resolution can happen later.
    const imports = ProgramFactory.fromSource(
      () => `from .models import User as ModelUser
from .schemas import *`,
      "python",
      "package/routes.py"
    ).imports;

    expect(imports["ModelUser"]).toEqual(
      jasmine.objectContaining({ local: "ModelUser", imported: "User" })
    );
    expect(imports["*:.schemas"]).toEqual(
      jasmine.objectContaining({ local: "*", imported: "*" })
    );
  });

  describe("Python fuzzer test-fixture imports", () => {
    // These tests use real `.py` files instead of inline source strings. They
    // cover the same multi-file setup a Python fuzz target would use: fixture
    // one imports graph helpers and type aliases from fixture two.
    const fixtureDir = path.join(__dirname, "test_fixtures");
    const fixtureOne = path.join(fixtureDir, "fuzzer_testfixtures.py");
    const fixtureTwo = path.join(fixtureDir, "fuzzer_testfixtures2.py");
    const frameworkFixture = path.join(fixtureDir, "framework_dependencies.py");

    const loadFixtureOne = () =>
      new PythonProgram(() => fs.readFileSync(fixtureOne, "utf8"), fixtureOne);

    const loadFixtureTwo = () =>
      new PythonProgram(() => fs.readFileSync(fixtureTwo, "utf8"), fixtureTwo);

    const loadFrameworkFixture = () =>
      new InspectablePythonProgram(
        () => fs.readFileSync(frameworkFixture, "utf8"),
        frameworkFixture
      );

    it("resolves imported graph functions and type aliases", () => {
      const program = loadFixtureOne();
      const expectedImports = [
        "AdjacencyList",
        "EdgeList",
        "Items",
        "Matrix",
        "Vertex",
        "bfs_adj_list",
        "dfs_adj_list",
        "fibonacci",
        "knapsack_max_value",
        "make_adj_list",
        "minimum_coin_count",
        "multi_bfs",
        "topological_sort",
        "torch_probability_sum",
      ];

      expect(Object.keys(program.imports).sort()).toEqual(
        expectedImports.sort()
      );
      for (const name of expectedImports) {
        const sourceProgram =
          name === "torch_probability_sum" ? frameworkFixture : fixtureTwo;
        expect(program.imports[name]).toEqual(
          jasmine.objectContaining({
            local: name,
            imported: name,
            programPath: sourceProgram,
            resolved: true,
            default: false,
          })
        );
      }
    });

    it("finds every fixture-one wrapper and preserves its typed signature", () => {
      const functions = loadFixtureOne().functionsExported;
      expect(Object.keys(functions).sort()).toEqual([
        "bfs_from_imported_edges",
        "coin_count_from_imported_helper",
        "dfs_from_imported_edges",
        "fibonacci_from_imported_helper",
        "graph_fixture_demo",
        "knapsack_from_imported_helper",
        "source_distances_from_imported_grid",
        "topological_order_from_imported_edges",
        "torch_score_from_imported_helper",
      ]);

      const bfs = functions["bfs_from_imported_edges"];
      expect(bfs.getArgDefs().map((argument) => argument.getName())).toEqual([
        "start",
        "edges",
      ]);
      expect(
        bfs
          .getArgDefs()
          .map((argument) => PythonProgram.getTypeAnnotation(argument))
      ).toEqual(["Vertex", "List[ImportedEdges]"]);
      expect(bfs.getReturnType()).toEqual(
        jasmine.objectContaining({ typeRefName: "Traversal" })
      );

      const topological = functions["topological_order_from_imported_edges"];
      expect(
        topological.getArgDefs().map((argument) => argument.getName())
      ).toEqual(["vertex_count", "edges"]);
      expect(topological.getArgDefs()[0].getType()).toEqual(ArgTag.NUMBER);
      expect(
        PythonProgram.getTypeAnnotation(topological.getArgDefs()[1])
      ).toEqual("List[ImportedEdges]");

      const knapsack = functions["knapsack_from_imported_helper"];
      expect(
        knapsack.getArgDefs().map((argument) => argument.getName())
      ).toEqual(["items", "capacity"]);
      expect(PythonProgram.getTypeAnnotation(knapsack.getArgDefs()[0])).toEqual(
        "List[List[KnapsackItems]]"
      );
      expect(knapsack.getArgDefs()[1].getType()).toEqual(ArgTag.NUMBER);

      const torchScore = functions["torch_score_from_imported_helper"];
      expect(torchScore.getArgDefs()[0].getType()).toEqual(ArgTag.NUMBER);
      expect(torchScore.getArgDefs()[0].getDim()).toEqual(1);
      expect(torchScore.getReturnType()?.type?.type).toEqual(ArgTag.NUMBER);
    });

    it("extracts exported graph aliases and algorithms from fixture two", () => {
      const program = loadFixtureTwo();
      expect(Object.keys(program.types).sort()).toEqual([
        "AdjacencyList",
        "Coordinate",
        "Edge",
        "EdgeList",
        "Items",
        "Matrix",
        "Vertex",
      ]);
      for (const name of Object.keys(program.types)) {
        expect(program.types[name]).toEqual(
          jasmine.objectContaining({ isExported: true, module: fixtureTwo })
        );
      }

      expect(Object.keys(program.functionsExported).sort()).toEqual([
        "bfs_adj_list",
        "bfs_matrix",
        "dfs_adj_list",
        "dfs_matrix",
        "fibonacci",
        "is_source",
        "knapsack_max_value",
        "make_adj_list",
        "minimum_coin_count",
        "multi_bfs",
        "topological_sort",
      ]);
      expect(
        program.functionsExported["bfs_matrix"]
          .getArgDefs()
          .map((argument) => argument.getName())
      ).toEqual(["start", "matrix"]);
      expect(
        program.functionsExported["topological_sort"].getReturnType()
      ).toEqual(
        // `list[Vertex]` resolves to the shared numeric element type plus
        // one array dimension, so the retained type reference is `Vertex`.
        jasmine.objectContaining({ typeRefName: "Vertex" })
      );
    });

    it("keeps fixture-one aliases as module exports", () => {
      const types = loadFixtureOne().types;
      expect(Object.keys(types).sort()).toEqual([
        "DistanceGrid",
        "ImportedEdges",
        "ImportedGraph",
        "KnapsackItems",
        "Traversal",
      ]);
      expect(types["ImportedEdges"]).toEqual(
        jasmine.objectContaining({ isExported: true, typeRefName: "EdgeList" })
      );
    });

    it("records FastAPI, Pydantic, and PyTorch dependency import styles", () => {
      // Accessing the program may also analyze its decorated endpoint. The
      // Pydantic request type is intentionally unsupported in this fixture.
      spyOn(console, "debug");
      const imports = loadFrameworkFixture().imports;

      expect(imports["FastAPI"]).toEqual(
        jasmine.objectContaining({
          local: "FastAPI",
          imported: "FastAPI",
          default: false,
        })
      );
      expect(imports["Depends"]).toEqual(
        jasmine.objectContaining({
          local: "Depends",
          imported: "Depends",
          default: false,
        })
      );
      expect(imports["BaseModel"]).toEqual(
        jasmine.objectContaining({
          local: "BaseModel",
          imported: "BaseModel",
          default: false,
        })
      );
      expect(imports["torch"]).toEqual(
        jasmine.objectContaining({
          local: "torch",
          imported: "*",
          resolved: false,
        })
      );
      expect(imports["torch_functional"]).toEqual(
        jasmine.objectContaining({
          local: "torch_functional",
          imported: "*",
          resolved: false,
        })
      );
    });

    it("keeps PyTorch-backed helpers fuzzable and safely rejects model endpoints", () => {
      // Framework request models are intentionally unsupported today. Silence
      // the expected diagnostic while asserting that analysis remains safe.
      spyOn(console, "debug");
      const program = loadFrameworkFixture();
      const torchHelper = program.functionsExported["torch_probability_sum"];

      expect(torchHelper).toBeDefined();
      expect(torchHelper.getArgDefs()[0].getType()).toEqual(ArgTag.NUMBER);
      expect(torchHelper.getArgDefs()[0].getDim()).toEqual(1);
      expect(torchHelper.getReturnType()?.type?.type).toEqual(ArgTag.NUMBER);
      // Pydantic request objects are not a supported fuzz-input shape yet;
      // the analyzer must report this endpoint as unsupported, not crash.
      expect(program.functionsExported["create_prediction"]).toBeUndefined();
      expect(program.unsupportedFunctions["create_prediction"]).toEqual(
        jasmine.objectContaining({ argument: "payload" })
      );
      expect(console.debug).toHaveBeenCalled();
    });
  });

  it("handles Python parameter conventions and default values", () => {
    const fn = ProgramFactory.fromSource(
      () => `def configure(
    user_id: int,
    /,
    label: str = "default",
    *weights: float,
    enabled: bool,
    **metadata: list[int],
) -> None:
    return None`,
      "python"
    ).functionsExported["configure"];
    const args = fn.getArgDefs();

    expect(args.map((arg) => arg.getName())).toEqual([
      "user_id",
      "label",
      "weights",
      "enabled",
      "metadata",
    ]);
    expect(args.map((arg) => arg.getType())).toEqual([
      ArgTag.NUMBER,
      ArgTag.STRING,
      ArgTag.NUMBER,
      ArgTag.BOOLEAN,
      ArgTag.NUMBER,
    ]);
    expect(args.map((arg) => arg.getDim())).toEqual([0, 0, 0, 0, 1]);
    expect(fn.isVoid()).toBeTrue();
  });

  it("keeps PEP 604 union members as function argument children", () => {
    const fn = ProgramFactory.fromSource(
      () => `def parse(value: int | str) -> int | str:
    return value`,
      "python"
    ).functionsExported["parse"];
    const value = fn.getArgDefs()[0];

    expect(value.getType()).toEqual(ArgTag.UNION);
    expect(value.getChildren().map((child) => child.getType())).toEqual([
      ArgTag.NUMBER,
      ArgTag.STRING,
    ]);
    expect(fn.getReturnType()?.type?.type).toEqual(ArgTag.UNION);
  });

  it("finds decorated functions without changing their signature", () => {
    // Decorators do not change the argument or return annotations seen by the
    // parser, even when the decorator itself cannot be resolved here.
    const functions = ProgramFactory.fromSource(
      () => `@trace
def decorated(value: int) -> str:
    return str(value)`,
      "python"
    ).functionsExported;

    expect(functions["decorated"].getArgDefs()[0].getType()).toEqual(
      ArgTag.NUMBER
    );
    expect(functions["decorated"].getReturnType()?.type?.type).toEqual(
      ArgTag.STRING
    );
  });

  it("finds typed async functions", () => {
    // The analyzer extracts the inner function definition from `async def`.
    const fn = ProgramFactory.fromSource(
      () => `async def fetch_name(url: str) -> str:
    return url`,
      "python"
    ).functionsExported["fetch_name"];

    expect(fn.getArgDefs()[0].getType()).toEqual(ArgTag.STRING);
    expect(fn.getReturnType()?.type?.type).toEqual(ArgTag.STRING);
  });

  it("ignores PEP 695 aliases declared inside a function", () => {
    // Local aliases are implementation details and must not become module
    // exports that other files can resolve.
    const types = ProgramFactory.fromSource(
      () => `type PublicId = int

def build() -> PublicId:
    type LocalLabel = str
    return 1`,
      "python"
    ).types;

    expect(types["PublicId"]).toBeDefined();
    expect(types["LocalLabel"]).toBeUndefined();
  });

  it("reports FastAPI dependency injection with an unresolved ORM type", () => {
    // `Depends(...)` is a default expression, while Session is the actual
    // annotation. Without importing the SQLAlchemy source, the function is reported as
    // unsupported instead of guessing an input shape.
    spyOn(console, "debug");
    const program = new InspectablePythonProgram(
      () => `from fastapi import Depends

def create_item(item_id: int, db: Session = Depends(get_db)) -> str:
    return str(item_id)`,
      "routes.py"
    );

    expect(program.functions["create_item"]).toBeUndefined();
    expect(program.unsupportedFunctions["create_item"]).toEqual(
      jasmine.objectContaining({ argument: "db" })
    );
  });

  it("Compare functional and class-based TypeDicts", () => {
    const program = new PythonProgram(
      () => `import from typing import Any, Literal, List, TypedDict

TypedDictFunc = TypedDict('FuzzTestResult', {
                           'input': List[Any], 'output': Any, 'exception': bool, 'timeout': bool})

class TypedDictClass(TypedDict):
    input: List[Any]
    output: Any
    exception: bool
    timeout: bool

def func(tdclass: TypedDictClass, tdFunc: TypedDictFunc):
    return
    `,
      "dummy.py"
    );

    expect(program.types["TypedDictClass"]).toEqual({
      module: "dummy.py",
      dims: 0,
      optional: false,
      isExported: true,
      type: {
        type: ArgTag.OBJECT,
        dims: 0,
        resolved: true,
        children: [
          {
            module: "dummy.py",
            dims: 1,
            optional: false,
            isExported: true,
            typeRefName: "Any",
            type: {
              dims: 0,
              type: ArgTag.NUMBER,
              children: [],
              resolved: true,
            },
            name: "input",
          },
          {
            module: "dummy.py",
            dims: 0,
            optional: false,
            isExported: true,
            typeRefName: "Any",
            type: {
              dims: 0,
              type: ArgTag.NUMBER,
              children: [],
              resolved: true,
            },
            name: "output",
          },
          {
            module: "dummy.py",
            dims: 0,
            optional: false,
            isExported: true,
            type: {
              dims: 0,
              type: ArgTag.BOOLEAN,
              children: [],
              resolved: true,
            },
            name: "exception",
          },
          {
            module: "dummy.py",
            dims: 0,
            optional: false,
            isExported: true,
            type: {
              dims: 0,
              type: ArgTag.BOOLEAN,
              children: [],
              resolved: true,
            },
            name: "timeout",
          },
        ],
      },
    });

    expect(program.types["TypedDictFunc"]).toEqual(
      program.types["TypedDictClass"]
    );
  });

  it("hypothesis @given primitives with options", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(
    trigger=st.text(min_size=1, max_size=8, alphabet="abc"),
    dep=st.text(min_size=1, max_size=8, alphabet="ABC"),
    trigger_val=st.integers(min_value=0, max_value=100)
)
def test_example(trigger, dep, trigger_val):
    pass
        `,
      "python"
    ).functionsExported["test_example"];

    const args = fn.getArgDefs();
    expect(args.length).toEqual(3);

    expect(args[0].getName()).toEqual("trigger");
    expect(args[0].getType()).toEqual(ArgTag.STRING);
    expect(args[0].getOptions().strLength).toEqual({ min: 1, max: 8 });
    expect(args[0].getOptions().strCharset).toEqual("abc");

    expect(args[1].getName()).toEqual("dep");
    expect(args[1].getType()).toEqual(ArgTag.STRING);
    expect(args[1].getOptions().strLength).toEqual({ min: 1, max: 8 });
    expect(args[1].getOptions().strCharset).toEqual("ABC");

    expect(args[2].getName()).toEqual("trigger_val");
    expect(args[2].getType()).toEqual(ArgTag.NUMBER);
    expect(args[2].getOptions().numInteger).toBeTrue();
    expect(args[2].getIntervals()).toEqual([{ min: 0, max: 100 }]);
  });

  it("hypothesis @given positional arguments", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(
    st.integers(2000, 2030),
    st.integers(1, 12)
)
def test_dates(year, month):
    pass
        `,
      "python"
    ).functionsExported["test_dates"];

    const args = fn.getArgDefs();
    expect(args[0].getIntervals()).toEqual([{ min: 2000, max: 2030 }]);
    expect(args[1].getIntervals()).toEqual([{ min: 1, max: 12 }]);
  });

  it("hypothesis @given negative numeric values", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(
    integer=st.integers(min_value=-10, max_value=200),
    decimal=st.floats(min_value=-1.5, max_value=2.5)
)
def test_bounds(integer, decimal):
    pass
        `,
      "python"
    ).functionsExported["test_bounds"];

    const args = fn.getArgDefs();
    expect(args[0].getIntervals()).toEqual([{ min: -10, max: 200 }]);
    expect(args[1].getIntervals()).toEqual([{ min: -1.5, max: 2.5 }]);
  });

  it("hypothesis @given nested lists and fixed_dictionaries", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(
    complex_data=st.lists(
        st.lists(
            st.fixed_dictionaries({
                'id': st.integers(min_value=1, max_value=10),
                'tags': st.lists(st.text())
            })
        )
    )
)
def test_nested(complex_data):
    pass
        `,
      "python"
    ).functionsExported["test_nested"];

    const arg = fn.getArgDefs()[0];
    expect(arg.getName()).toEqual("complex_data");
    // Outer list + inner list = 2 dimensions
    expect(arg.getDim()).toEqual(2);
    expect(arg.getType()).toEqual(ArgTag.OBJECT);

    const fields = arg.getChildren();
    expect(fields.map((f) => f.getName())).toEqual(["id", "tags"]);

    const idField = fields.find((f) => f.getName() === "id");
    expect(idField?.getType()).toEqual(ArgTag.NUMBER);
    expect(idField?.getIntervals()).toEqual([{ min: 1, max: 10 }]);

    const tagsField = fields.find((f) => f.getName() === "tags");
    expect(tagsField?.getType()).toEqual(ArgTag.STRING);
    expect(tagsField?.getDim()).toEqual(1); // st.lists(st.text()) nested inside dict
  });

  it("hypothesis @given sampled_from", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(
    status=st.sampled_from(["active", "pending", "closed"])
)
def test_sampled(status):
    pass
        `,
      "python"
    ).functionsExported["test_sampled"];

    const arg = fn.getArgDefs()[0];
    expect(arg.getType()).toEqual(ArgTag.UNION);
    expect(arg.getChildren().map((c) => c.getConstantValue())).toEqual([
      "active",
      "pending",
      "closed",
    ]);
    expect(
      arg.getChildren().every((c) => c.getType() === ArgTag.LITERAL)
    ).toBeTrue();
  });

  it("hypothesis @given sampled_from tuples", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(st.sampled_from([("input", "disabled")]))
def test_sampled_tuple(elem_attr):
    pass
        `,
      "python"
    ).functionsExported["test_sampled_tuple"];

    const arg = fn.getArgDefs()[0];
    expect(arg.getType()).toEqual(ArgTag.TUPLE);
    expect(arg.getChildren().map((child) => child.getConstantValue())).toEqual([
      "input",
      "disabled",
    ]);
  });

  it("hypothesis @given sampled_from dictionaries", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(st.sampled_from([{"mode": "disabled", "retry": 0}]))
def test_sampled_dictionary(config):
    pass
        `,
      "python"
    ).functionsExported["test_sampled_dictionary"];

    const arg = fn.getArgDefs()[0];
    expect(arg.getType()).toEqual(ArgTag.OBJECT);
    expect(arg.getChildren().map((child) => child.getName())).toEqual([
      "mode",
      "retry",
    ]);
    expect(arg.getChildren().map((child) => child.getConstantValue())).toEqual([
      "disabled",
      0,
    ]);
  });

  it("hypothesis @given fixed_dictionaries with optional keys", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(
    payload=st.fixed_dictionaries(
        mapping={'req_id': st.integers()},
        optional={'opt_tag': st.text()}
    )
)
def test_optional_dict(payload):
    pass
        `,
      "python"
    ).functionsExported["test_optional_dict"];

    const arg = fn.getArgDefs()[0];
    expect(arg.getType()).toEqual(ArgTag.OBJECT);
    const fields = arg.getChildren();

    const reqField = fields.find((f) => f.getName() === "req_id");
    const optField = fields.find((f) => f.getName() === "opt_tag");

    expect(reqField?.isOptional()).toBeFalse();
    expect(optField?.isOptional()).toBeTrue();
  });

  it("hypothesis @given takes precedence over native type annotations", () => {
    const fn = ProgramFactory.fromSource(
      () => `
@given(
    val=st.integers(min_value=50, max_value=60)
)
def test_precedence(val: float):
    pass
        `,
      "python"
    ).functionsExported["test_precedence"];

    const arg = fn.getArgDefs()[0];
    expect(arg.getType()).toEqual(ArgTag.NUMBER);
    expect(arg.getOptions().numInteger).toBeTrue();
    expect(arg.getIntervals()).toEqual([{ min: 50, max: 60 }]);
  });

  it("isVoid===true for functions lacking return statements", () => {
    const fns = ProgramFactory.fromSource(
      () => `
def no_return():
    x = 1
    y = 2
`,
      "python"
    ).functionsExported;

    expect(fns["no_return"].isVoid()).toBeTrue();
  });

  it("isVoid===true for functions with empty return statements", () => {
    const fns = ProgramFactory.fromSource(
      () => `
def bare_return():
    return
`,
      "python"
    ).functionsExported;

    expect(fns["bare_return"].isVoid()).toBeTrue();
  });

  it("isVoid===true for functions with only `return None`", () => {
    const fns = ProgramFactory.fromSource(
      () => `
def return_none():
    return None
`,
      "python"
    ).functionsExported;

    expect(fns["return_none"].isVoid()).toBeTrue();
  });

  it("isVoid===true for functions where all branches return no value", () => {
    const fns = ProgramFactory.fromSource(
      () => `
def multi_none_returns(cond: bool):
    if cond:
        return None
    else:
        return
`,
      "python"
    ).functionsExported;

    expect(fns["multi_none_returns"].isVoid()).toBeTrue();
  });

  it("isVoid===false for functions with return <value>", () => {
    const fns = ProgramFactory.fromSource(
      () => `
def returns_value():
    return 42
`,
      "python"
    ).functionsExported;

    expect(fns["returns_value"].isVoid()).toBeFalse();
  });

  it("isVoid===true for lambdas returning None", () => {
    const fns = ProgramFactory.fromSource(
      () => `x=5
lam_none = lambda: None
lam_val = lambda: x+1
`,
      "python"
    ).functionsExported;

    expect(fns["lam_none"].isVoid()).toBeTrue();
    expect(fns["lam_val"].isVoid()).toBeFalse();
  });
});
