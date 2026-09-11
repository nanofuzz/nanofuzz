import { IdeasPanelView } from "../../ui/IdeasPanelView";
import { hide, htmlEscape, isHidden, show, simpleToast } from "../../ui/Util";
import { AbstractIdeaData } from "./AbstractIdeaModel";

export abstract class AbstractIdeaView {
  protected _repBase: AbstractIdeaData;
  protected _iconClass = "codicon codicon-error";
  protected _inputNames: string[];
  protected _ideasPanel: IdeasPanelView;

  constructor(
    data: AbstractIdeaData,
    inputNames: string[],
    ideasPanel: IdeasPanelView
  ) {
    this._repBase = { ...data };
    this._inputNames = inputNames;
    this._ideasPanel = ideasPanel;
  }

  public get htmlId(): string {
    return `ideasPanel-${this._repBase.type}-${this._repBase.id}`.replaceAll(
      ".",
      "-"
    );
  }

  public draw(htmlGrid: HTMLElement): void {
    this.undraw(htmlGrid);
    const tbody = htmlGrid.querySelector("tbody");
    if (tbody === null) {
      throw new Error("Unable to find tbody for ideasgrid");
    }

    // Summary row (filled in below)
    const summaryRow = document.createElement("tr");
    summaryRow.id = `${this.htmlId}-summary`;
    summaryRow.classList.add("sticky", "lineBelow");
    tbody.appendChild(summaryRow);

    // Detail row (filled in below)
    const detailRow = document.createElement("tr");
    detailRow.id = `${this.htmlId}-detail`;
    detailRow.classList.add("hidden", "ideaDetail", "lineBelow");
    tbody.appendChild(detailRow);
    detailRow.appendChild(document.createElement("td")); // spacer cell
    const detailCell = document.createElement("td");
    detailCell.colSpan = 6;
    detailRow.appendChild(detailCell);

    // Summary Expander Cell
    const summaryColExpander = document.createElement("td");
    summaryRow.appendChild(summaryColExpander);
    this._drawSummaryExpandCell(detailRow, summaryColExpander);

    // Summary Description Cell
    const summaryColDesc = document.createElement("td");
    summaryRow.appendChild(summaryColDesc);
    this._drawSummaryDescCell(summaryColDesc);

    // Summary Greens Cell
    const summaryColGreens = document.createElement("td");
    summaryRow.appendChild(summaryColGreens);
    this._drawSummaryGreensCell(summaryColGreens);

    // Summary Reds Cell
    const summaryColReds = document.createElement("td");
    summaryRow.appendChild(summaryColReds);
    this._drawSummaryRedsCell(summaryColReds);

    // Summary Squares Cell
    const summaryColSquares = document.createElement("td");
    summaryRow.appendChild(summaryColSquares);
    this._drawSummarySquaresCell(summaryColSquares);

    // Summary Accept Cell
    const summaryColAccept = document.createElement("td");
    summaryColAccept.classList.add("colorColumn");
    summaryRow.appendChild(summaryColAccept);
    {
      const outerSpan = document.createElement("span");
      outerSpan.setAttribute("title", "Accept idea");
      const innerSpan = document.createElement("span");
      innerSpan.classList.add("clickable", "codicon", "codicon-add");
      outerSpan.appendChild(innerSpan);
      summaryColAccept.appendChild(outerSpan);
      innerSpan.addEventListener("click", () => {
        this._ideasPanel.acceptClicked(this._repBase.type, this._repBase.id);
        simpleToast("Idea accepted");
      });
    }

    // Summary Reject Cell
    const summaryColReject = document.createElement("td");
    summaryColReject.classList.add("colorColumn");
    summaryRow.appendChild(summaryColReject);
    {
      const outerSpan = document.createElement("span");
      outerSpan.setAttribute("title", "Reject idea");
      const innerSpan = document.createElement("span");
      innerSpan.classList.add("clickable", "codicon", "codicon-trash");
      outerSpan.appendChild(innerSpan);
      summaryColReject.appendChild(outerSpan);
      innerSpan.addEventListener("click", () => {
        this._ideasPanel.rejectClicked(this._repBase.type, this._repBase.id);
        simpleToast("Idea rejected");
      });
    }

    // Detail cell
    this._drawDetailCell(detailCell);
  }

  protected _drawDetailCell(_detailCell: HTMLTableCellElement) {
    // override
  }

  protected _drawSummarySquaresCell(_summaryColSquares: HTMLTableCellElement) {
    // override
  }

  protected _drawSummaryRedsCell(_summaryColReds: HTMLTableCellElement) {
    // override
  }

  protected _drawSummaryGreensCell(_summaryColGreens: HTMLTableCellElement) {
    // override
  }

  protected _drawSummaryDescCell(summaryColDesc: HTMLTableCellElement) {
    summaryColDesc.innerHTML = /*html*/ `
      <span class="flexBoxes">
        <div title="add property validator">
          <span class="${this._iconClass}"></span>
        </div>
        <div>
          <span class="editorFont">${htmlEscape(this._repBase.name)}</span>
        </div>
      </span>`;
  }

  protected _drawSummaryExpandCell(
    detailRow: HTMLTableRowElement,
    summaryColExpander: HTMLTableCellElement
  ) {
    const spanExpand = document.createElement("span");
    summaryColExpander.appendChild(spanExpand);
    spanExpand.classList.add("clickable", "codicon", "codicon-chevron-right");
    spanExpand.setAttribute("title", "expand");

    const spanCollapse = document.createElement("span");
    summaryColExpander.appendChild(spanCollapse);
    spanCollapse.classList.add(
      "clickable",
      "codicon",
      "codicon-chevron-down",
      "hidden"
    );
    spanCollapse.setAttribute("title", "collapse");

    [spanExpand, spanCollapse].forEach((span) => {
      span.addEventListener("click", () => {
        if (isHidden(spanCollapse)) {
          /* expand */
          show(spanCollapse);
          hide(spanExpand);
          show(detailRow);
        } else {
          /* collapse */
          hide(spanCollapse);
          show(spanExpand);
          hide(detailRow);
        }
      });
    });
  }

  public undraw(htmlGrid: HTMLElement): void {
    [
      htmlGrid.querySelector(`#${this.htmlId}-summary`),
      htmlGrid.querySelector(`#${this.htmlId}-detail`),
    ].forEach((e) => (e ? e.remove() : e)); // update DOM
  }
}
