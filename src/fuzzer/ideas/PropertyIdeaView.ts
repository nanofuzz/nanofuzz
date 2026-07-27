import * as JSON5 from "json5";
import { AbstractIdeaView } from "./AbstractIdeaView";
import { PropertyIdeaData } from "./PropertyIdeaModel";
import { ColorSquareNames } from "../oracles/JudgmentDiff";
import { isError } from "../../Util";
import {
  getElementByIdOrThrow,
  htmlEscape,
  isHidden,
  judgmentToIcon,
  toggleHidden,
} from "../../ui/Util";
import { traceJudgment } from "../../ui/JudgmentTrace";
import { IdeasPanelView } from "../../ui/IdeasPanelView";

export class PropertyIdeaView extends AbstractIdeaView {
  protected _rep: PropertyIdeaData;

  constructor(
    data: PropertyIdeaData,
    inputNames: string[],
    ideasPanel: IdeasPanelView
  ) {
    super(data, inputNames, ideasPanel);
    this._rep = { ...data };
    this._iconClass = "codicon codicon-robot";
  }

  protected _drawSummarySquaresCell(summaryColSquares: HTMLTableCellElement) {
    super._drawSummarySquaresCell(summaryColSquares);
    summaryColSquares.innerHTML = /*html*/ `
      <span class="diffSummary">
        <div class="colorSquares">
          ${[0, 1, 2, 3, 4].map((s) => `<div title="${ColorSquareNames[this._rep.diff.summary.squares[s]]}" class="${this._rep.diff.summary.squares[s]}"></div>`).join("")}
        </div>
      </span>`;
  }

  protected _drawSummaryRedsCell(summaryColReds: HTMLTableCellElement) {
    super._drawSummaryRedsCell(summaryColReds);
    summaryColReds.innerHTML = /*html*/ `
      <span class="diffSummary"><span aria-label="Judgments changed: ${this._rep.diff.summary.reds} ${ColorSquareNames.red}" title="${ColorSquareNames.red}" class="reds">-${this._rep.diff.summary.reds}</span>`;
  }

  protected _drawSummaryGreensCell(summaryColGreens: HTMLTableCellElement) {
    super._drawSummaryGreensCell(summaryColGreens);
    summaryColGreens.innerHTML = /*html*/ `
      <span class="diffSummary"><span aria-label="Judgments changed: ${this._rep.diff.summary.greens} ${ColorSquareNames.green}" title="${ColorSquareNames.green}" class="greens">+${this._rep.diff.summary.greens}</span></span>`;
  }

  protected _drawSummaryDescCell(summaryColDesc: HTMLTableCellElement) {
    super._drawSummaryDescCell(summaryColDesc);
    if (this._rep.diff.detail.exceptions.length) {
      const flexBox = summaryColDesc.querySelector("span");
      if (flexBox === null) {
        throw new Error("Unable to location description Flexbox");
      }
      const exceptionDiv = document.createElement("div");
      exceptionDiv.innerHTML = /*html*/ `<span title="Threw ${this._rep.diff.detail.exceptions.length} exceptions for this set of tests" class="codicon codicon-warning"></span>`;
      flexBox.appendChild(exceptionDiv);
    }
  }

  protected _drawDetailCell(detailCell: HTMLTableCellElement) {
    super._drawDetailCell(detailCell);
    const toggleHandlers: { attachTo: string; target: string }[] = [];

    /* 
      Columns:
      (1) PUT input, 
      (2) the PUT output, 
      (3) judgment of the baseline test suite, 
      (4) judgment of the baseline test suite with the candidate assertion added, and 
      (5) an (i) button that provides an explanation of the change in judgment. 
      
      TODO: Above the grid is a set of filter controls, which hide or show prospective failures 
      (green), false passes and failures (red), and neutrals such as true passes and 
      failures (gray). The coloring and decoration of the fourth column corresponds to 
      that of the filter controls and that of the summary form.
    */
    const getExceptionMsg = (e: unknown) =>
      isError(e) ? `${e.name}: ${e.message}` : JSON5.stringify(e);
    const exceptions = this._rep.diff.detail.exceptions.map((e) => ({
      ...e,
      color: "red",
    }));
    const jj = [
      ...this._rep.diff.detail.prospectiveFailures.map((e) => ({
        ...e,
        color: "green",
      })),
      ...this._rep.diff.detail.falseFailures.map((e) => ({
        ...e,
        color: "red",
      })),
      ...this._rep.diff.detail.falsePasses.map((e) => ({
        ...e,
        color: "red",
      })),
    ];
    detailCell.innerHTML = /*html*/ `
      <div>Adding this property validator...
        <small>
          <pre class="code"><code class="typescript.html">${this._rep.src.join("\n")}</code></pre>
        </small>
      </div>
      ${
        exceptions.length === 0
          ? ""
          : /*html*/ `
        <div>...would throw ${exceptions.length} new exceptions (<a id="${this.htmlId}-detail-exceptionToggle" class="clickable">show</a>)...</div>
        <div id="${this.htmlId}-detail-exceptions" class="hidden">
          <table class="fuzzGrid">
            <thead> 
              <tr>
                <th>&nbsp;</th>
                ${this._inputNames.map((i) => /*html*/ `<th>input: ${htmlEscape(i)}</th>`).join("\n")}
                <th>output</th>
                <th>validator would throw exception</th>
              </tr>
            </thead>
            <tbody>
              ${exceptions
                .map(
                  (e) => /*html*/ `
              <tr>
                <td><span class="codicon codicon-warning" title="the validator threw an exception"></span></td>
                ${this._inputNames
                  .map((_name, i) =>
                    e.example.inWrapped[i].value === undefined
                      ? /*html*/ `<td class="editorFont noInput"><span>(no input)</span></td>`
                      : /*html*/ `<td class="editorFont"><span>${htmlEscape(JSON5.stringify(e.example.inWrapped[i].value))}</span></td>`
                  )
                  .join("\n")}
                <td class="editorFont"><span>${e.source.type === "mutation" ? /*html*/ `<span class="codicon codicon-bug inline" title="Mutated/buggy program test output">` : /*html*/ `<span class="codicon codicon-beaker inline" title="Actual program test output">`}</span></span><span> ${
                  e.example.timeout
                    ? "(timeout)"
                    : e.example.exception
                      ? "(exception)"
                      : htmlEscape(JSON5.stringify(e.example.outWrapped.value))
                }</span></td>
                <td class="editorFont">${htmlEscape(
                  getExceptionMsg(e.addlJudgments[this._rep.name].error)
                )}
                </td>
              </tr>`
                )
                .join("")}
            </tbody>              
          </table>
          <br />
        </div>`
      }
      <div>...would alter ${jj.length ? `these ${jj.length}` : "no"} test judgments${jj.length ? ":" : "."}
        <table class="fuzzGrid${jj.length ? "" : " hidden"}">
          <thead> 
            <tr>
              <th>
                <span class="diffSummary">
                  <div class="colorSquares">
                    <div class="gray"></div>
                  </div>
                </span>
              </th>
              ${this._inputNames.map((i) => /*html*/ `<th>input: ${htmlEscape(i)}</th>`).join("\n")}
              <th>output</th>
              <th>current judgment</th>
              <th>new judgment</td>
              <th>&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            ${jj
              .map(
                (j, jId) => /*html*/ `
            <tr>
              <td>
                <span class="diffSummary">
                  <div class="colorSquares">
                    <div class="${j.color}"></div>
                  </div>
                </span>
              </td>
              ${this._inputNames
                .map((_name, i) =>
                  j.example.inWrapped[i].value === undefined
                    ? /*html*/ `<td class="editorFont noInput"><span>(no input)</span></td>`
                    : /*html*/ `<td class="editorFont"><span>${htmlEscape(JSON5.stringify(j.example.inWrapped[i].value))}</span></td>`
                )
                .join("\n")}
              <td class="editorFont"><span>${j.source.type === "mutation" ? /*html*/ `<span class="codicon codicon-bug inline" title="Mutated/buggy program test output">` : /*html*/ `<span class="codicon codicon-beaker inline" title="Actual program test output">`}</span></span><span> ${
                j.example.timeout
                  ? "(timeout)"
                  : j.example.exception
                    ? "(exception)"
                    : htmlEscape(JSON5.stringify(j.example.outWrapped.value))
              }</td>
              <td class="editorFont removedLine">${judgmentToIcon(j.judgments.composite.judgment)} ${j.judgments.composite.judgment}</td>
              <td class="editorFont addedLine">${judgmentToIcon(j.rejudgment.judgment)} ${j.rejudgment.judgment}</td>
              <td class="colorColumn">
                <span>
                  <span id="${this.htmlId}-detail-jTraceToggle-${jId}" title="more info" class="clickable codicon codicon-info"></span>
                </span>
              </td>
            </tr>${toggleHandlers.push({ attachTo: `${this.htmlId}-detail-jTraceToggle-${jId}`, target: `${this.htmlId}-detail-jTraceDetail-${jId}` }) ? "" : ""}
            <tr id="${this.htmlId}-detail-jTraceDetail-${jId}" class="hidden">
                <td colspan="${this._inputNames.length + 2}"></td>
                <td class="topAlign">
                  <div class="editorFont judgmentTrace"><small>${traceJudgment(j.judgments.composite)}</small></div>
                </td>
                <td colspan="2" class="topAlign">
                  <div class="editorFont judgmentTrace"><small>${traceJudgment(j.rejudgment)}</small></div>
                </td>
            </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <div>&nbsp;</div>`;
    const exceptionToggleBtn = detailCell.querySelector(
      `#${this.htmlId}-detail-exceptionToggle`
    );
    const exceptionToggleTable = detailCell.querySelector(
      `#${this.htmlId}-detail-exceptions`
    );
    if (exceptionToggleBtn && exceptionToggleTable) {
      exceptionToggleBtn.addEventListener("click", () => {
        toggleHidden(exceptionToggleTable);
        exceptionToggleBtn.innerHTML = isHidden(exceptionToggleTable)
          ? "show"
          : "hide";
      });
    }

    // Attach event handlers to judgment diffs
    toggleHandlers.forEach((toggle) => {
      getElementByIdOrThrow(toggle.attachTo).addEventListener("click", () => {
        toggleHidden(getElementByIdOrThrow(toggle.target));
      });
    });
  }
}
