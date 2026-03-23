import { ArgType } from "../fuzzer/Fuzzer";

/** !!!!!! */
export type ModelArgOverrides =
  | ModelArgOverridesNumber
  | ModelArgOverridesBoolean
  | ModelArgOverridesString
  | ModelArgOverridesObject
  | ModelArgOverridesLiteral
  | ModelArgOverridesUnion;
export type ModelArgOverridesBase = {
  type: string;
  name?: string;
  typeName?: string;
  arrayDimensions: { minLength: number; maxLength: number }[];
};
export type ModelArgOverridesNumber = ModelArgOverridesBase & {
  number: {
    minValue: number;
    maxValue: number;
    onlyIntegers: boolean;
  };
};
export type ModelArgOverridesBoolean = ModelArgOverridesBase & {
  boolean: {
    minValue: boolean;
    maxValue: boolean;
  };
};
export type ModelArgOverridesString = ModelArgOverridesBase & {
  string: {
    minLength: number;
    maxLength: number;
    charSet: string;
  };
};
export type ModelArgOverridesObject = ModelArgOverridesBase & {
  children: ModelArgOverrides[];
};
export type ModelArgOverridesLiteral = ModelArgOverridesBase & {
  literalValue: ArgType | undefined;
};
export type ModelArgOverridesUnion = ModelArgOverridesBase & {
  children: ModelArgOverrides[];
};
