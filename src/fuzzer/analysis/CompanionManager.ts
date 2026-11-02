import { AbstractProgram } from "./AbstractProgram";
import { FunctionDef } from "./FunctionDef";
import { FunctionRef, ProgramLanguage } from "./Types";

/**
 * Manages companion functions (validators, transformers, and generators)
 * across supported programming languages.
 *
 * Provides language-aware naming conventions, target function resolution,
 * program-level discovery, and name synthesis / disambiguation.
 */
export class CompanionManager {
  /**
   * Returns true if the function name indicates a validator; false, otherwise.
   *
   * @param name Function name to check
   * @param lang Language of the source program
   * @returns true if the function is a validator
   */
  public static isValidator(name: string, lang: ProgramLanguage): boolean {
    return this.getValidatorTarget(name, lang) !== undefined;
  } // fn: isValidator()

  /**
   * Returns true if the function name indicates an input transformer; false, otherwise.
   *
   * @param name Function name to check
   * @param lang Language of the source program
   * @returns true if the function is an input transformer
   */
  public static isTransformer(name: string, lang: ProgramLanguage): boolean {
    return this.getTransformerTarget(name, lang) !== undefined;
  } // fn: isTransformer()

  /**
   * Returns true if the function name indicates a user input generator; false, otherwise.
   *
   * @param name Function name to check
   * @param lang Language of the source program
   * @returns true if the function is a user generator
   */
  public static isUserGenerator(name: string, lang: ProgramLanguage): boolean {
    return this.getUserGeneratorTarget(name, lang) !== undefined;
  } // fn: isUserGenerator()

  /**
   * Returns true if the function name indicates a companion function of the given kind.
   *
   * @param name Function name to check
   * @param kind Companion kind
   * @param lang Language of the source program
   * @returns true if the function is a companion of the given kind
   */
  public static isCompanion(
    name: string,
    kind: CompanionKind,
    lang: ProgramLanguage
  ): boolean {
    return this.getTarget(name, kind, lang) !== undefined;
  } // fn: isCompanion()

  /**
   * Returns the target function name for a validator, or undefined if not a validator.
   *
   * @param name Function name to check
   * @param lang Language of the source program
   * @returns Target function name or undefined
   */
  public static getValidatorTarget(
    name: string,
    lang: ProgramLanguage
  ): string | undefined {
    return this.getTarget(name, "validator", lang);
  } // fn: getValidatorTarget()

  /**
   * Returns the target function name for a transformer, or undefined if not a transformer.
   *
   * @param name Function name to check
   * @param lang Language of the source program
   * @returns Target function name or undefined
   */
  public static getTransformerTarget(
    name: string,
    lang: ProgramLanguage
  ): string | undefined {
    return this.getTarget(name, "transformer", lang);
  } // fn: getTransformerTarget()

  /**
   * Returns the target function name for a user generator, or undefined if not a user generator.
   *
   * @param name Function name to check
   * @param lang Language of the source program
   * @returns Target function name or undefined
   */
  public static getUserGeneratorTarget(
    name: string,
    lang: ProgramLanguage
  ): string | undefined {
    return this.getTarget(name, "generator", lang);
  } // fn: getUserGeneratorTarget()

  /**
   * Resolves the target function name and optional numeric index for a companion function.
   *
   * @param name Function name
   * @param kind Companion kind
   * @param lang Language of the source program
   * @returns Match details or undefined
   */
  public static matchCompanion(
    name: string,
    kind: CompanionKind,
    lang: ProgramLanguage
  ): CompanionMatch | undefined {
    if (kind === "generator") {
      if (
        name.endsWith("InputGenerator") ||
        name.endsWith("_input_generator")
      ) {
        return undefined;
      }
    }

    const rule = getRule(kind, lang);
    for (const pattern of rule.patterns) {
      const match = name.match(pattern);
      if (match && match.groups) {
        const target = match.groups.target;
        if (target && target.length > 0) {
          const rawIdx = match.groups.idx;
          const index = rawIdx !== undefined ? Number(rawIdx) : undefined;
          return { target, index };
        }
      }
    }
    return undefined;
  } // fn: matchCompanion()

  /**
   * Returns the target function name for a given companion function, or undefined.
   *
   * @param name Function name
   * @param kind Companion kind
   * @param lang Language of the source program
   * @returns Target function name or undefined
   */
  public static getTarget(
    name: string,
    kind: CompanionKind,
    lang: ProgramLanguage
  ): string | undefined {
    return this.matchCompanion(name, kind, lang)?.target;
  } // fn: getTarget()

  /**
   * Returns a list of validator FunctionRefs found within the program
   * associated with a FunctionDef.
   *
   * @param program The program to search
   * @param fnUnderTest The function under test
   * @returns An array of validator FunctionRefs
   */
  public static getValidators(
    program: AbstractProgram,
    fnUnderTest: FunctionDef
  ): FunctionRef[] {
    const fnUnderTestName = fnUnderTest.getName();
    return Object.values(program.functions)
      .filter(
        (fn) =>
          fn.isValidator() &&
          this.getValidatorTarget(fn.getName(), program.lang) ===
            fnUnderTestName
      )
      .map((fn) => fn.getRef());
  } // fn: getValidators()

  /**
   * Returns a list of input transformer functions for the function under test.
   *
   * @param program The program to search
   * @param fnUnderTest The function under test
   * @returns An array of transformer FunctionRefs
   */
  public static getTransformers(
    program: AbstractProgram,
    fnUnderTest: FunctionDef
  ): FunctionRef[] {
    const fnUnderTestName = fnUnderTest.getName();
    return Object.values(program.functions)
      .filter(
        (fn) =>
          fn.isTransformer() &&
          this.getTransformerTarget(fn.getName(), program.lang) ===
            fnUnderTestName
      )
      .map((fn) => fn.getRef());
  } // fn: getTransformers()

  /**
   * Returns a list of user-provided input generator functions for the function under test.
   *
   * @param program The program to search
   * @param fnUnderTest The function under test
   * @returns An array of user generator FunctionRefs
   */
  public static getUserGenerators(
    program: AbstractProgram,
    fnUnderTest: FunctionDef
  ): FunctionRef[] {
    const fnUnderTestName = fnUnderTest.getName();
    const lang = program.lang;

    const isUserGen = (name: string, isExported: boolean) =>
      isExported &&
      name !== fnUnderTestName &&
      this.isUserGenerator(name, lang) &&
      this.getUserGeneratorTarget(name, lang) === fnUnderTestName;

    const fromSupported = Object.values(program.functions)
      .filter((fn) => isUserGen(fn.getName(), fn.isExported()))
      .map((fn) => fn.getRef());

    const fromUnsupported = Object.values(program.functionsNotSupported)
      .filter(
        (entry): entry is { reason: string; function: FunctionRef } =>
          "function" in entry && entry.function !== undefined
      )
      .map((entry) => entry.function)
      .filter((fnRef) => isUserGen(fnRef.name, fnRef.isExported));

    return [...fromSupported, ...fromUnsupported];
  } // fn: getUserGenerators()

  /**
   * Formats a companion function name for a target function.
   *
   * @param targetName Name of the target function under test
   * @param kind Companion kind
   * @param lang Target programming language
   * @param index Numeric index (0 for unindexed base name, >= 1 for numbered variant)
   * @returns Formatted companion function name
   */
  public static formatName(
    targetName: string,
    kind: CompanionKind,
    lang: ProgramLanguage,
    index: number = 0
  ): string {
    const rule = getRule(kind, lang);
    if (index === 0) {
      return `${targetName}${rule.canonicalSuffix}`;
    }
    return `${targetName}${rule.canonicalSuffix}${rule.indexDelimiter}${index}`;
  } // fn: formatName()

  /**
   * Finds the next available index for a companion function given existing function names.
   *
   * @param existingFnNames Array of function names in the source module
   * @param targetName Target function name
   * @param kind Companion kind
   * @param lang Target programming language
   * @returns Next available index (0 if base name is free, >= 1 if base name is taken)
   */
  public static getNextAvailableIndex(
    existingFnNames: string[],
    targetName: string,
    kind: CompanionKind,
    lang: ProgramLanguage
  ): number {
    let maxIndex = -1;

    for (const name of existingFnNames) {
      const match = this.matchCompanion(name, kind, lang);
      if (match && match.target === targetName) {
        const idx = match.index ?? 0;
        maxIndex = Math.max(maxIndex, idx);
      }
    }

    return maxIndex >= 0 ? maxIndex + 1 : 0;
  } // fn: getNextAvailableIndex()

  /**
   * Returns the next available companion function name avoiding collisions with existing functions.
   *
   * @param existingFnNames Array of function names in the source module
   * @param targetName Target function name
   * @param kind Companion kind
   * @param lang Target programming language
   * @returns Disambiguated function name
   */
  public static getNextAvailableName(
    existingFnNames: string[],
    targetName: string,
    kind: CompanionKind,
    lang: ProgramLanguage
  ): string {
    const index = this.getNextAvailableIndex(
      existingFnNames,
      targetName,
      kind,
      lang
    );
    return this.formatName(targetName, kind, lang, index);
  } // fn: getNextAvailableName()
}

export type CompanionKind = "validator" | "transformer" | "generator";

export interface CompanionMatch {
  target: string;
  index?: number;
}

interface NamingRule {
  readonly canonicalSuffix: string;
  readonly indexDelimiter: string;
  readonly patterns: readonly RegExp[];
}

const VALIDATOR_PATTERNS = [
  /^(?<target>.+?)_validator(?:_(?<idx>\d+))?$/,
  /^(?<target>.+?)Validator(?<idx>\d+)?$/,
] as const;

const TRANSFORMER_PATTERNS = [
  /^(?<target>.+?)_transformer(?:_(?<idx>\d+))?$/,
  /^(?<target>.+?)Transformer(?<idx>\d+)?$/,
] as const;

const GENERATOR_PATTERNS = [
  /^(?<target>.+?)_generator(?:_(?<idx>\d+))?$/,
  /^(?<target>.+?)Generator(?<idx>\d+)?$/,
] as const;

const RULES: Record<
  ProgramLanguage | "*",
  Record<CompanionKind, NamingRule>
> = {
  typescript: {
    validator: {
      canonicalSuffix: "Validator",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Validator(?<idx>\d+)?$/,
        /^(?<target>.+?)_validator(?:_(?<idx>\d+))?$/,
      ],
    },
    transformer: {
      canonicalSuffix: "Transformer",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Transformer(?<idx>\d+)?$/,
        /^(?<target>.+?)_transformer(?:_(?<idx>\d+))?$/,
      ],
    },
    generator: {
      canonicalSuffix: "Generator",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Generator(?<idx>\d+)?$/,
        /^(?<target>.+?)_generator(?:_(?<idx>\d+))?$/,
      ],
    },
  },
  rust: {
    validator: {
      canonicalSuffix: "_validator",
      indexDelimiter: "_",
      patterns: VALIDATOR_PATTERNS,
    },
    transformer: {
      canonicalSuffix: "_transformer",
      indexDelimiter: "_",
      patterns: TRANSFORMER_PATTERNS,
    },
    generator: {
      canonicalSuffix: "_generator",
      indexDelimiter: "_",
      patterns: GENERATOR_PATTERNS,
    },
  },
  python: {
    validator: {
      canonicalSuffix: "_validator",
      indexDelimiter: "_",
      patterns: VALIDATOR_PATTERNS,
    },
    transformer: {
      canonicalSuffix: "_transformer",
      indexDelimiter: "_",
      patterns: TRANSFORMER_PATTERNS,
    },
    generator: {
      canonicalSuffix: "_generator",
      indexDelimiter: "_",
      patterns: GENERATOR_PATTERNS,
    },
  },
  oxcaml: {
    validator: {
      canonicalSuffix: "_validator",
      indexDelimiter: "_",
      patterns: VALIDATOR_PATTERNS,
    },
    transformer: {
      canonicalSuffix: "_transformer",
      indexDelimiter: "_",
      patterns: TRANSFORMER_PATTERNS,
    },
    generator: {
      canonicalSuffix: "_generator",
      indexDelimiter: "_",
      patterns: GENERATOR_PATTERNS,
    },
  },
  java: {
    validator: {
      canonicalSuffix: "Validator",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Validator(?<idx>\d+)?$/,
        /^(?<target>.+?)_validator(?:_(?<idx>\d+))?$/,
      ],
    },
    transformer: {
      canonicalSuffix: "Transformer",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Transformer(?<idx>\d+)?$/,
        /^(?<target>.+?)_transformer(?:_(?<idx>\d+))?$/,
      ],
    },
    generator: {
      canonicalSuffix: "Generator",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Generator(?<idx>\d+)?$/,
        /^(?<target>.+?)_generator(?:_(?<idx>\d+))?$/,
      ],
    },
  },
  go: {
    validator: {
      canonicalSuffix: "Validator",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Validator(?<idx>\d+)?$/,
        /^(?<target>.+?)_validator(?:_(?<idx>\d+))?$/,
      ],
    },
    transformer: {
      canonicalSuffix: "Transformer",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Transformer(?<idx>\d+)?$/,
        /^(?<target>.+?)_transformer(?:_(?<idx>\d+))?$/,
      ],
    },
    generator: {
      canonicalSuffix: "Generator",
      indexDelimiter: "",
      patterns: [
        /^(?<target>.+?)Generator(?<idx>\d+)?$/,
        /^(?<target>.+?)_generator(?:_(?<idx>\d+))?$/,
      ],
    },
  },
  "*": {
    validator: {
      canonicalSuffix: "Validator",
      indexDelimiter: "",
      patterns: VALIDATOR_PATTERNS,
    },
    transformer: {
      canonicalSuffix: "Transformer",
      indexDelimiter: "",
      patterns: TRANSFORMER_PATTERNS,
    },
    generator: {
      canonicalSuffix: "Generator",
      indexDelimiter: "",
      patterns: GENERATOR_PATTERNS,
    },
  },
};

function getRule(kind: CompanionKind, lang: ProgramLanguage): NamingRule {
  const langRules = RULES[lang] ?? RULES.typescript;
  return langRules[kind];
} // fn: getRule()
