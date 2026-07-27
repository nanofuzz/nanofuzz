import { FuzzValidatorInput } from "./imports3";

export type FuzzIoElement = {
  name: string; // name of element
  offset: number; // offset of element (0-based)
  value: any; // value of element
};

export type z = FuzzValidatorInput;
