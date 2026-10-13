import type { ArgDef } from "../fuzzer/analysis/ArgDef";
import * as ValueMapper from "../fuzzer/mappers/ValueMapper";
import {
  ArgOptions,
  ArgTag,
  ArgType,
  Interval,
  ProgramLanguage,
} from "../fuzzer/analysis/Types";
import { encodeEscapeSequences } from "../Util";

/**
 * Renders all top-level argument definition forms into an HTML string.
 *
 * @param argDefs Array of argument definitions
 * @param lang Language of the function under test
 * @param disabled Indicates whether controls should be disabled
 * @returns HTML string containing all argument definition forms
 */
export function renderArgDefForms(
  argDefs: ArgDefLike[],
  lang: ProgramLanguage,
  disabled = false
): string {
  const counter = { id: 0 };
  return argDefs
    .map((arg, i) =>
      argDefToHtmlForm(
        arg,
        counter,
        "",
        i === argDefs.length - 1 ? "" : ",",
        undefined,
        lang,
        disabled
      )
    )
    .join("");
} // fn: renderArgDefForms()

/**
 * Returns an HTML form representing an argument definition. The counter
 * is passed by reference so it can be unique across the entire tree of
 * arguments: objects can be nested arbitrarily.
 *
 * @param arg Argument definition to render
 * @param counter Counter internally incremented for each argument
 * @param beginSep Text to precede the argument (e.g., " | ")
 * @param endSep Text to follow the argument (e.g., ",")
 * @param parentTag The ArgTag of the parent container, if any
 * @param lang Language of the function under test
 * @param disabled Indicates whether controls should be disabled
 * @returns html string of the argument definition form
 */
export function argDefToHtmlForm(
  arg: ArgDefLike,
  counter: { id: number },
  beginSep: string,
  endSep: string,
  parentTag: ArgTag | undefined,
  lang: ProgramLanguage,
  disabled: boolean
): string {
  const id = counter.id++;
  const idBase = `argDef-${id}`;
  const argType = getArgType(arg);
  const argName = getArgName(arg);
  const disabledFlag = disabled ? " disabled " : "";
  const dimString = "[]".repeat(getArgDim(arg));
  const optionalString = getArgOptional(arg) ? "?" : "";
  const htmlEllipsis = `<span class="hidden argDef-ellipsis">...</span>`;
  const isArgArray = getArgDim(arg) > 0;

  let typeString: string;
  const argTypeRef = getArgTypeRef(arg);
  if (argTypeRef !== undefined) {
    typeString = htmlEscape(
      argTypeRef.substring(argTypeRef.lastIndexOf(".") + 1)
    );
  } else {
    typeString = htmlEscape(argType.toLowerCase());

    switch (argType) {
      case ArgTag.OBJECT:
        typeString = "Object";
        break;
      case ArgTag.DICTIONARY:
        typeString = "Dict";
        break;
      case ArgTag.SET:
        typeString = "Set";
        break;
      case ArgTag.LITERAL:
        if (isArgConstant(arg)) {
          const constantValue = getArgConstantValue(arg);
          typeString = htmlEscape(ValueMapper.toLang(lang, constantValue));
        }
        break;
      case ArgTag.BIGINT:
      case ArgTag.NUMBER:
      case ArgTag.STRING:
      case ArgTag.BOOLEAN:
      case ArgTag.UNION:
      case ArgTag.TUPLE:
      case ArgTag.UNRESOLVED:
      case ArgTag.BYTES:
        break;
    }
  }

  let html = /*html*/ `
    <!-- Argument Definition -->
    <div class="argDef" id="${idBase}">`;

  html += /*html*/ `
      <!-- Argument Name -->
      <div class="argDef-name">${beginSep}`;

  if (argName !== "unknown") {
    html += /*html*/ `
          <strong>${argName}</strong>${optionalString}: 
        `;
  }

  let sep: string;
  switch (argType) {
    case ArgTag.LITERAL:
      sep = endSep;
      break;
    case ArgTag.UNION:
      sep = ":";
      break;
    case ArgTag.SET:
    case ArgTag.OBJECT:
    case ArgTag.DICTIONARY:
      sep = ` = {` + htmlEllipsis;
      break;
    case ArgTag.TUPLE:
      sep = ` = [` + htmlEllipsis;
      break;
    case ArgTag.NUMBER:
    case ArgTag.STRING:
    case ArgTag.BOOLEAN:
    case ArgTag.UNRESOLVED:
    case ArgTag.BIGINT:
    case ArgTag.BYTES:
      sep = " = " + htmlEllipsis;
      break;
  }

  html += /*html*/ `
         ${typeString}${dimString}${sep}
      </div>`;

  // Give the option of suppressing generation of optional members
  if (
    parentTag === ArgTag.UNION ||
    (parentTag === ArgTag.OBJECT && getArgOptional(arg))
  ) {
    const noInput = isArgNoInput(arg);
    html += /*html*/ `
        <div class="isNoInput tooltipped tooltipped-nw" aria-label="Generate inputs of this type?">
          <vscode-checkbox id="${idBase}-isNoInput" ${disabledFlag} ${
            noInput ? "" : "checked"
          } current-checked="${noInput ? "false" : "true"}"></vscode-checkbox>
        </div>`;
  }

  html += /*html*/ `
      <!-- Argument isArray -->
      <div class="argDef-isArray argDef-isArray-${htmlEscape(
        isArgArray ? "true" : "false"
      )}" id="${idBase}-${
        isArgArray ? "true" : "false"
      }" style="padding-left: 1em;"></div>`;

  html += /*html*/ `
      <!-- Argument Type -->
      <div class="argDef-type argDef-type-${htmlEscape(
        argType
      )}" id="${idBase}-${argType}" style="padding-left: 1em;">
      <!-- Argument Options -->`;

  // Argument options
  switch (argType) {
    // Number-specific Options
    case ArgTag.NUMBER: {
      const interval = getArgIntervals(arg)[0] ?? { min: 0, max: 100 };
      const numInteger = getArgOptions(arg).numInteger ?? true;
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-min" name="${idBase}-min" value="${htmlEscape(
        Number(interval.min).toString()
      )}">Min value</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-max" name="${idBase}-max" value="${htmlEscape(
        Number(interval.max).toString()
      )}">Max value</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-radio-group style="display: inline-block;">
            <vscode-radio ${disabledFlag} id="${idBase}-numInteger" name="${idBase}-numInteger" ${
              numInteger ? " checked " : ""
            }>Integer</vscode-radio>
            <vscode-radio ${disabledFlag} id="${idBase}-numInteger" name="${idBase}-numInteger" ${
              !numInteger ? " checked " : ""
            }>Float</vscode-radio>
          </vscode-radio-group>`;
      break;
    }

    // BigInt-specific Options
    case ArgTag.BIGINT: {
      const interval = getArgIntervals(arg)[0] ?? { min: 0n, max: 100n };
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-bigIntMin" name="${idBase}-bigIntMin" value="${htmlEscape(
        bigIntOrThrow(interval.min).toString()
      )}">Min value</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-bigIntMax" name="${idBase}-bigIntMax" value="${htmlEscape(
        bigIntOrThrow(interval.max).toString()
      )}">Max value</vscode-text-field>`;
      break;
    }

    // String-specific Options
    case ArgTag.STRING: {
      const options = getArgOptions(arg);
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-minStrLen" name="${idBase}-min" value="${htmlEscape(
        (options.strLength?.min ?? 0).toString()
      )}">Min length</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-maxStrLen" name="${idBase}-max" value="${htmlEscape(
        (options.strLength?.max ?? 10).toString()
      )}">Max length</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-text-field size="10" ${disabledFlag} id="${idBase}-strCharset" name="${idBase}-strCharset" value="${htmlEscape(
        encodeEscapeSequences(options.strCharset ?? "")
      )}">Character set</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-text-field size="10" ${disabledFlag} id="${idBase}-strRegex" placeholder="(none)" name="${idBase}-strRegex" value="${htmlEscape(
        options.strRegex ?? ""
      )}">Regex</vscode-text-field>`;
      break;
    }

    // Bytes-specific Options
    case ArgTag.BYTES: {
      const options = getArgOptions(arg);
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-minByteLen" name="${idBase}-min" value="${htmlEscape(
        (options.byteLength?.min ?? 0).toString()
      )}">Min length</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-maxByteLen" name="${idBase}-max" value="${htmlEscape(
        (options.byteLength?.max ?? 4).toString()
      )}">Max length</vscode-text-field>`;
      break;
    }

    // Dictionary-specific Options
    case ArgTag.DICTIONARY: {
      const options = getArgOptions(arg);
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-minDictLen" name="${idBase}-min" value="${htmlEscape(
        (options.dictLength?.min ?? 0).toString()
      )}">Min entries</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-maxDictLen" name="${idBase}-max" value="${htmlEscape(
        (options.dictLength?.max ?? 4).toString()
      )}">Max entries</vscode-text-field>`;

      html += `<div>`;
      const children = getArgChildren(arg);
      if (children.length === 2) {
        html += argDefToHtmlForm(
          children[0],
          counter,
          "",
          "",
          argType,
          lang,
          disabled
        );
        html += argDefToHtmlForm(
          children[1],
          counter,
          "",
          "",
          argType,
          lang,
          disabled
        );
      }
      html += `</div>`;
      html += argDefArrayToHtmlForm(arg, idBase, disabled);
      break;
    }

    // Set-specific Options
    case ArgTag.SET: {
      const options = getArgOptions(arg);
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-minSetLen" name="${idBase}-min" value="${htmlEscape(
        (options.setLength?.min ?? 0).toString()
      )}">Min entries</vscode-text-field>`;
      html += " ";
      html += /*html*/ `<vscode-text-field size="3" ${disabledFlag} id="${idBase}-maxSetLen" name="${idBase}-max" value="${htmlEscape(
        (options.setLength?.max ?? 4).toString()
      )}">Max entries</vscode-text-field>`;

      html += `<div>`;
      const children = getArgChildren(arg);
      if (children.length >= 1) {
        html += argDefToHtmlForm(
          children[0],
          counter,
          "",
          "",
          argType,
          lang,
          disabled
        );
      }
      html += `</div>`;
      html += argDefArrayToHtmlForm(arg, idBase, disabled);
      break;
    }

    // Boolean-specific Options
    case ArgTag.BOOLEAN: {
      let intervals = getArgIntervals(arg);
      if (intervals.length === 0) {
        intervals = [{ min: false, max: true }];
      }
      html += /*html*/ `<vscode-radio-group>
            <!--<label slot="label">Values</label>-->
            <vscode-radio ${disabledFlag} id="${idBase}-trueFalse" name="${idBase}-trueFalse" ${
              intervals[0].min !== intervals[0].max ? " checked " : ""
            }>True and false</vscode-radio>
            <vscode-radio ${disabledFlag} id="${idBase}-trueOnly" name="${idBase}-trueOnly" ${
              intervals[0].min && intervals[0].max ? " checked " : ""
            }>True</vscode-radio>
            <vscode-radio ${disabledFlag} id="${idBase}-falseOnly" name="${idBase}-falseOnly" ${
              !intervals[0].min && !intervals[0].max ? " checked " : ""
            }>False</vscode-radio>
          </vscode-radio-group>`;
      break;
    }

    // Union-specific Options
    case ArgTag.UNION: {
      html += argDefArrayToHtmlForm(arg, idBase, disabled);
      html += `<div>`;
      getArgChildren(arg).forEach(
        (child) =>
          (html += argDefToHtmlForm(
            child,
            counter,
            " | ",
            "",
            argType,
            lang,
            disabled
          ))
      );
      html += `</div>`;
      break;
    }

    // Object-specific Options
    case ArgTag.OBJECT: {
      html += argDefArrayToHtmlForm(arg, idBase, disabled);
      html += `<div>`;
      const children = getArgChildren(arg);
      children.forEach(
        (child, i) =>
          (html += argDefToHtmlForm(
            child,
            counter,
            "",
            i === children.length - 1 ? "" : ",",
            argType,
            lang,
            disabled
          ))
      );
      html += `</div>`;
      break;
    }

    case ArgTag.LITERAL:
      break;

    // Tuple-specific Options
    case ArgTag.TUPLE: {
      html += argDefArrayToHtmlForm(arg, idBase, disabled);
      html += `<div>`;
      getArgChildren(arg).forEach(
        (child) =>
          (html += argDefToHtmlForm(
            child,
            counter,
            "",
            "",
            argType,
            lang,
            disabled
          ))
      );
      html += `</div>`;
      break;
    }

    case ArgTag.UNRESOLVED:
      throw new Error(
        `Cannot render an unresolved argument definition as an HTML form.`
      );
  }

  // For composite types: array settings were already output prior to children
  if (
    argType !== ArgTag.OBJECT &&
    argType !== ArgTag.UNION &&
    argType !== ArgTag.TUPLE &&
    argType !== ArgTag.DICTIONARY &&
    argType !== ArgTag.SET
  ) {
    html += argDefArrayToHtmlForm(arg, idBase, disabled);
  }

  html += `</div>`;
  // For container types: output end character ("}" or "]") here
  if (
    argType === ArgTag.OBJECT ||
    argType === ArgTag.TUPLE ||
    argType === ArgTag.DICTIONARY ||
    argType === ArgTag.SET
  ) {
    const closeChar = argType === ArgTag.TUPLE ? "]" : "}";
    html += /*html*/ `<div class="argDef-preClose"></div><div class="argDef-close">${closeChar}${endSep}</div>`;
  }
  html += `</div>`;

  return html;
} // fn: argDefToHtmlForm()

/**
 * Returns an HTML form representing an array argument definition.
 *
 * @param arg Argument definition to render as an array
 * @param idBase The arg id base of the parent argument form
 * @param disabled Indicates whether controls are disabled
 * @returns html string representing an argument's array form
 */
export function argDefArrayToHtmlForm(
  arg: ArgDefLike,
  idBase: string,
  disabled: boolean
): string {
  let html = "";
  const argOptions = getArgOptions(arg);
  const disabledFlag = disabled ? " disabled " : "";
  const dims = getArgDim(arg);

  // Array dimensions
  for (let dim = 0; dim < dims; dim++) {
    const arrayBase = `${idBase}-array-${dim}`;
    const arrayDimOptions = argOptions.dimLength ?? [];
    const minValue =
      arrayDimOptions.length > dim
        ? arrayDimOptions[dim].min
        : (argOptions.dftDimLength?.min ?? 0);
    const maxValue =
      arrayDimOptions.length > dim
        ? arrayDimOptions[dim].max
        : (argOptions.dftDimLength?.max ?? 4);

    html += /*html*/ `<div class="argDef-array">
          <vscode-text-field size="3" ${disabledFlag} id="${arrayBase}-min" name="${arrayBase}-min" value="${htmlEscape(
            minValue.toString()
          )}">Array${"[]".repeat(dim + 1)}: Min 
          </vscode-text-field>
          <vscode-text-field size="3" ${disabledFlag} id="${arrayBase}-max" name="${arrayBase}-max" value="${htmlEscape(
            maxValue.toString()
          )}">Max length
          </vscode-text-field>
          ${
            dim === 0
              ? /*html*/ `
                <span class="tooltipped tooltipped-n" aria-label="Fill array with unique values?">
                  <vscode-checkbox ${disabledFlag} id="${arrayBase}-unique" ${
                    argOptions.dimsUnique === true ? "checked" : ""
                  } current-checked="${
                    argOptions.dimsUnique === true ? "true" : "false"
                  }">
                    Unique?
                  </vscode-checkbox>
                </span>`
              : ""
          }
        </div>`;
  }

  return html;
} // fn: argDefArrayToHtmlForm()

// ============================================================================
// Helper Functions & Types
// ============================================================================

export type ArgDefData = {
  name: string;
  offset: number;
  type: ArgTag;
  dims: number;
  optional?: boolean;
  intervals?: Interval<ArgType>[];
  options?: ArgOptions;
  children?: ArgDefData[];
  typeRef?: string;
  typeRefDims?: number;
};

export type ArgDefLike = ArgDef | ArgDefData;

function isArgDefInstance(arg: ArgDefLike): arg is ArgDef {
  return typeof (arg as ArgDef).getName === "function";
} // fn: isArgDefInstance()

function getArgType(arg: ArgDefLike): ArgTag {
  return isArgDefInstance(arg) ? arg.getType() : arg.type;
} // fn: getArgType()

function getArgName(arg: ArgDefLike): string {
  return isArgDefInstance(arg) ? arg.getName() : arg.name;
} // fn: getArgName()

function getArgDim(arg: ArgDefLike): number {
  return isArgDefInstance(arg) ? arg.getDim() : arg.dims;
} // fn: getArgDim()

function getArgOptional(arg: ArgDefLike): boolean {
  return isArgDefInstance(arg) ? arg.isOptional() : (arg.optional ?? false);
} // fn: getArgOptional()

function getArgTypeRef(arg: ArgDefLike): string | undefined {
  return isArgDefInstance(arg) ? arg.getTypeRef() : arg.typeRef;
} // fn: getArgTypeRef()

function getArgIntervals(arg: ArgDefLike): Interval<ArgType>[] {
  return isArgDefInstance(arg) ? arg.getIntervals() : (arg.intervals ?? []);
} // fn: getArgIntervals()

function getArgOptions(arg: ArgDefLike): ArgOptions {
  return isArgDefInstance(arg)
    ? arg.getOptions()
    : (arg.options ?? ({} as ArgOptions));
} // fn: getArgOptions()

function getArgChildren(arg: ArgDefLike): ArgDefLike[] {
  return isArgDefInstance(arg) ? arg.getChildren() : (arg.children ?? []);
} // fn: getArgChildren()

function isArgConstant(arg: ArgDefLike): boolean {
  if (isArgDefInstance(arg)) return arg.isConstant();
  const intervals = getArgIntervals(arg);
  const type = getArgType(arg);
  return (
    (type === ArgTag.LITERAL && intervals.length === 0) ||
    (intervals.length === 1 && intervals[0].min === intervals[0].max)
  );
} // fn: isArgConstant()

function getArgConstantValue(arg: ArgDefLike): ArgType | undefined {
  if (isArgDefInstance(arg)) return arg.getConstantValue();
  const intervals = getArgIntervals(arg);
  if (intervals.length === 0) return undefined;
  return intervals[0].min;
} // fn: getArgConstantValue()

function isArgNoInput(arg: ArgDefLike): boolean {
  if (isArgDefInstance(arg)) return arg.isNoInput();
  const options = getArgOptions(arg);
  return options.isNoInput ?? false;
} // fn: isArgNoInput()

function bigIntOrThrow(value: ArgType | undefined): bigint {
  if (typeof value !== "bigint") {
    throw new Error(
      `Invalid interval bound for bigint type: ${JSON.stringify(String(value))}`
    );
  }
  return value;
} // fn: bigIntOrThrow()

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
} // fn: htmlEscape()
