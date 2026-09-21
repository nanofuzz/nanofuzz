import { ArgDef } from "./ArgDef";
import { ArgTag } from "./Types";

/**
 * Estimates character footprints and token sizes for ArgDef specifications
 * in minified JSON response payloads.
 */
export class ArgDefTokenEstimator {
  /**
   * Estimates average JSON response token size for a list of parameter specifications
   * formatted as top-level JSON object members `{ "param1": val1, "param2": val2, ... }`.
   */
  public static estimateTokensPerInput(specs: ArgDef[]): number {
    const activeSpecs = specs.filter((arg) => !arg.isNoInput());
    const totalArgChars =
      activeSpecs.reduce((sum, arg) => {
        const argKeyChars = arg.getName().length + 3; // "paramName":
        const argValChars = ArgDefTokenEstimator.estimateArgValueChars(arg);
        return sum + argKeyChars + argValChars;
      }, 0) + Math.max(0, activeSpecs.length - 1);

    const totalInputChars = 2 + totalArgChars; // 2 for top-level braces {}
    // Discrete sample token quantization offset: expected ceiling E[ceil(C/4)] = C/4 + 0.26
    const estimatedTokens = totalInputChars / 4.0 + 0.26;
    // BPE tokenizers require at least 3 tokens for any minified JSON object payload `{"k": v}`
    return Math.max(3.0, estimatedTokens);
  }

  /**
   * Estimates average JSON response character length for an argument value,
   * accounting for inner and outer array dimensions (`dimLength`).
   */
  public static estimateArgValueChars(arg: ArgDef): number {
    const dimOptions = arg.getOptions()?.dimLength;
    const dims = arg.getDim();

    if (dims > 0 && dimOptions && dimOptions.length > 0) {
      const innermostDim = dimOptions[dimOptions.length - 1];
      let chars =
        innermostDim && innermostDim.max === 0
          ? 2
          : ArgDefTokenEstimator.estimateBaseArgChars(arg);

      // Work from innermost dimension (dims-1) up to outermost dimension (0)
      for (let k = Math.min(dims, dimOptions.length) - 1; k >= 0; k--) {
        const dim = dimOptions[k];
        chars = ArgDefTokenEstimator.calculateDimExpectedChars(dim, chars);
      }
      if (dims >= 2 && (!innermostDim || innermostDim.max > 0)) {
        chars += (dims - 1) * 0.75; // Additional structural baseline for nested array dimensions
      }
      return chars;
    }
    return ArgDefTokenEstimator.estimateBaseArgChars(arg);
  }

  /**
   * Calculates the exact expected JSON character length for an array dimension
   * over discrete integer lengths in [dim.min, dim.max].
   */
  public static calculateDimExpectedChars(
    dim: { min: number; max: number },
    innerChars: number
  ): number {
    const minLen = Math.max(0, Math.ceil(dim.min));
    const maxLen = Math.max(minLen, Math.floor(dim.max));
    const numLengths = maxLen - minLen + 1;

    let totalCharsSum = 0;
    for (let len = minLen; len <= maxLen; len++) {
      if (len === 0) {
        totalCharsSum += 2; // []
      } else {
        totalCharsSum += 2 + len * innerChars + (len - 1); // [elem1, elem2, ...]
      }
    }
    return totalCharsSum / numLengths;
  }

  /**
   * Estimates average JSON response character length for a single 0-dimensional argument value.
   */
  public static estimateBaseArgChars(arg: ArgDef): number {
    switch (arg.getType()) {
      case ArgTag.BIGINT: {
        // Neither JSON nor JSON Schema can represent a bigint, so the AI
        // generator sends one as a prefixed decimal string:
        // "<NANOFUZZ_BIGINT><digits>". A spec in AiInputGenerator.test.ts
        // pins the prefix length so this estimate cannot drift.
        const placeholderChars = 2 + 37; // 2 quotes + NANOFUZZ_BIGINT prefix
        const intervals = arg.getIntervals();
        if (intervals && intervals.length > 0) {
          const firstInt = intervals[0];
          const minLen =
            typeof firstInt.min === "bigint" ? String(firstInt.min).length : 1;
          const maxLen =
            typeof firstInt.max === "bigint" ? String(firstInt.max).length : 3;
          return placeholderChars + (minLen + maxLen) / 2;
        }
        return placeholderChars + 2; // digits of the default [0n, 100n] range
      }

      case ArgTag.NUMBER: {
        const numOpts = arg.getOptions();
        if (!numOpts.numInteger) {
          return 15; // Floating point numbers format with fractional digits (e.g. 42.18953048591823)
        }
        const intervals = arg.getIntervals();
        if (intervals && intervals.length > 0) {
          const firstInt = intervals[0];
          const minNum = typeof firstInt.min === "number" ? firstInt.min : 0;
          const maxNum = typeof firstInt.max === "number" ? firstInt.max : 100;
          const minLen = String(Math.floor(minNum)).length;
          const maxLen = String(Math.ceil(maxNum)).length;
          return (minLen + maxLen) / 2;
        }
        return arg.getDim() >= 3 ? 4.5 : 4; // Multi-dimensional 3D+ number arrays average higher digit footprints
      }

      case ArgTag.BOOLEAN:
        return 4.5; // avg of "true" (4) and "false" (5)

      case ArgTag.STRING: {
        const strOptions = arg.getOptions();
        const strLength =
          strOptions?.strLength ?? ArgDef.getDefaultOptions().strLength;
        const avgLen = (strLength.min + strLength.max) / 2;
        const charSet = Array.from(strOptions?.strCharset ?? "");
        const escapableCount = charSet.filter(
          (c) => c === '"' || c === "\\"
        ).length;
        const escapeProb =
          charSet.length > 0 ? escapableCount / charSet.length : 0.021;
        const escapeFactor = 1 + escapeProb;
        return 2 + avgLen * escapeFactor; // 2 for "" quotes
      }

      case ArgTag.LITERAL: {
        const intervals = arg.getIntervals();
        if (
          intervals &&
          intervals.length > 0 &&
          intervals[0].min !== undefined &&
          intervals[0].min !== null
        ) {
          return JSON.stringify(intervals[0].min).length;
        }
        return 3; // e.g. "x" in JSON is 3 chars ("x")
      }

      case ArgTag.BYTES: {
        const byteLength =
          arg.getOptions()?.byteLength ?? ArgDef.getDefaultOptions().byteLength;
        return ArgDefTokenEstimator.calculateDimExpectedChars(byteLength, 2.57); // avg 2.57 digits per byte value 0..255
      }

      case ArgTag.OBJECT: {
        const children = arg.getChildren();
        if (children && children.length > 0) {
          const activeChildren = children.filter((child) => !child.isNoInput());
          if (activeChildren.length === 0) {
            return 2; // {}
          }
          const expectedPropsChars = activeChildren.reduce((sum, child) => {
            const keyChars = child.getName().length + 3; // "key":
            const valChars = ArgDefTokenEstimator.estimateArgValueChars(child);
            const propChars = keyChars + valChars;
            const prob = child.isOptional() ? 0.5 : 1.0;
            return sum + propChars * prob;
          }, 0);
          const expectedPropCount = activeChildren.reduce(
            (sum, child) => sum + (child.isOptional() ? 0.5 : 1.0),
            0
          );
          const expectedCommaChars = Math.max(0, expectedPropCount - 1);
          return 2 + expectedPropsChars + expectedCommaChars; // braces {}
        }
        return 20; // Default unstructured object e.g. {"prop1":"val1"}
      }

      case ArgTag.TUPLE: {
        const children = arg.getChildren();
        if (children && children.length > 0) {
          const activeChildren = children.filter((child) => !child.isNoInput());
          if (activeChildren.length === 0) {
            return 2; // []
          }
          const childrenChars =
            activeChildren.reduce((sum, child) => {
              return sum + ArgDefTokenEstimator.estimateArgValueChars(child);
            }, 0) + Math.max(0, activeChildren.length - 1);
          return 2 + childrenChars; // brackets []
        }
        return 2;
      }

      case ArgTag.DICTIONARY: {
        const children = arg.getChildren();
        const dictLength =
          arg.getOptions()?.dictLength ?? ArgDef.getDefaultOptions().dictLength;
        if (dictLength.max === 0) {
          return 2; // {}
        }
        let entryChars = 10;
        if (children && children.length >= 2) {
          const keyType = children[0].getType();
          let keyChars: number;
          if (keyType === ArgTag.NUMBER) {
            keyChars = 3.5; // "0", "1", "2" -> 1.5 digits + 2 quotes
          } else {
            keyChars = ArgDefTokenEstimator.estimateArgValueChars(children[0]);
            if (keyType !== ArgTag.STRING) {
              keyChars += 2; // Quotes required for dictionary keys in JSON object format
            }
          }
          const valChars = ArgDefTokenEstimator.estimateArgValueChars(
            children[1]
          );
          entryChars = keyChars + valChars + 1; // "key":val
        }
        return ArgDefTokenEstimator.calculateDimExpectedChars(
          dictLength,
          entryChars
        ); // braces {}
      }

      case ArgTag.SET: {
        const children = arg.getChildren();
        const setLength =
          arg.getOptions()?.setLength ?? ArgDef.getDefaultOptions().setLength;
        let elemChars = 5;
        if (children && children.length > 0) {
          elemChars = ArgDefTokenEstimator.estimateArgValueChars(children[0]);
        }
        return ArgDefTokenEstimator.calculateDimExpectedChars(
          setLength,
          elemChars
        ); // brackets []
      }

      case ArgTag.UNION: {
        const children = arg
          .getChildren()
          .filter((child) => !child.isNoInput());
        if (children.length > 0) {
          const totalUnionChars = children.reduce(
            (sum, child) =>
              sum + ArgDefTokenEstimator.estimateArgValueChars(child),
            0
          );
          return totalUnionChars / children.length;
        }
        return 5;
      }

      case ArgTag.UNRESOLVED:
      default:
        return 5;
    }
  }
}
