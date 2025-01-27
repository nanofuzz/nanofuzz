export type ModelInputRanges = {
  type: string;
  minValue?: any;
  maxValue?: any;
  arrayLengths?: {
    minLength?: number;
    maxLength?: number;
  }[];
}[];
