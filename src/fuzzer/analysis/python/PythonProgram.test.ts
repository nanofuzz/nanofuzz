import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";
import { PythonProgram } from "./PythonProgram";

class InspectablePythonProgram extends PythonProgram {
  public get unsupportedFunctions() {
    return this._functions.unsupported;
  }
}

describe("fuzzer/analysis/python/PythonProgram:", () => {
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
    expect(args[0].getTypeAnnotation()).toEqual("a");
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
    expect(types["Pair"].type?.children.map((child) => child.type?.type)).toEqual([
      ArgTag.STRING,
      ArgTag.NUMBER,
    ]);
    expect(types["Result"].type?.children.map((child) => child.type?.type)).toEqual([
      ArgTag.NUMBER,
      ArgTag.STRING,
    ]);
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
    expect(types["Row"].type?.children[1].type?.children.map((child) => child.type?.type)).toEqual([
      ArgTag.STRING,
      ArgTag.BOOLEAN,
    ]);
    expect(types["MixedColumn"].type).toEqual(
      jasmine.objectContaining({ type: ArgTag.UNION, dims: 1 })
    );
    expect(
      types["MixedColumn"].type?.children.map((child) => child.type?.type)
    ).toEqual([ArgTag.NUMBER, ArgTag.STRING]);
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
      jasmine.objectContaining({ local: "torch", imported: "*", default: false })
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
});
