import * as JSON5 from "json5";
import { getElementByIdOrThrow, hide, show } from "./Util";
import { FuzzPanelMessageFromWebView } from "./FuzzPanelController";
import { WebviewApi } from "vscode-webview";
import { AbstractIdeaView } from "../fuzzer/ideas/AbstractIdeaView";
import { IdeaData } from "../fuzzer/ideas/Types";
import { IdeaViewFactory } from "../fuzzer/ideas/IdeaViewFactory";
import { AbstractIdeaData } from "../fuzzer/ideas/AbstractIdeaModel";

// Ideas Panel View
export class IdeasPanelView {
  protected static _instance: IdeasPanelView | undefined;

  protected _ideas = new Map<
    string,
    { view: AbstractIdeaView; data: IdeaData }
  >();
  protected _htmlTab: HTMLElement;
  protected _htmlGrid: HTMLElement;
  protected _inputNames: string[];
  protected _vscode: WebviewApi<unknown>;

  constructor(
    vscode: WebviewApi<unknown>,
    inputNames: string[],
    htmlTab: HTMLElement,
    htmlGrid: HTMLElement
  ) {
    this._vscode = vscode;
    this._inputNames = inputNames;
    this._htmlTab = htmlTab;
    this._htmlGrid = htmlGrid;

    this._draw();
  }

  // Internal Rep Management

  protected _getIdea(
    type: AbstractIdeaData["type"],
    id: AbstractIdeaData["id"]
  ): { view: AbstractIdeaView; data: IdeaData } | undefined {
    return this._ideas.get(`${type}.${id}`);
  }
  protected _getIdeas(): { view: AbstractIdeaView; data: IdeaData }[] {
    return Array.from(this._ideas)
      .map((i) => i[1])
      .sort((a, b) => b.data.priority - a.data.priority);
  }
  protected _setIdea(data: IdeaData, view: AbstractIdeaView): void {
    this._ideas.set(`${data.type}.${data.id}`, { data, view });
  }
  protected _deleteIdea(type: IdeaData["type"], id: IdeaData["id"]): boolean {
    return this._ideas.delete(`${type}.${id}`);
  }

  // Messages from back-end controller

  public update(ideas: IdeaData[]): void {
    if (ideas.length) {
      ideas.forEach((data) => {
        const view = IdeaViewFactory(data, this._inputNames, this);
        this._setIdea(data, view);
        if (this._isVisible(data)) {
          view.draw(this._htmlGrid);
        } else {
          view.undraw(this._htmlGrid);
        }
      });
      // sort and filter the view
      this._htmlGrid.querySelector("tbody")?.replaceChildren(
        ...this._getIdeas()
          .filter((i) => this._isVisible(i.data))
          .map((i) => [
            getElementByIdOrThrow(`${i.view.htmlId}-summary`),
            getElementByIdOrThrow(`${i.view.htmlId}-detail`),
          ])
          .flat()
      );
      this._updateBadge();
      this._updateEmptyRow();
    }
  }

  // Messages from front-end views

  public acceptClicked(
    type: AbstractIdeaData["type"],
    id: AbstractIdeaData["id"]
  ): void {
    const idea = this._getIdea(type, id);
    if (!idea) return;
    const message: FuzzPanelMessageFromWebView = {
      command: "idea.accept",
      ideaSerialized: JSON5.stringify(idea.data),
      idea: idea.data,
    };
    this._vscode.postMessage(message);
  }

  public rejectClicked(
    type: AbstractIdeaData["type"],
    id: AbstractIdeaData["id"]
  ): void {
    const idea = this._getIdea(type, id);
    if (!idea) return;
    const message: FuzzPanelMessageFromWebView = {
      command: "idea.reject",
      ideaSerialized: JSON5.stringify(idea.data),
      idea: idea.data,
    };
    this._vscode.postMessage(message);
  }

  // Internal functions

  protected _isVisible(i: IdeaData): boolean {
    return i.status === "proposed" && i.priority > 0;
  }

  protected _visibleCount(): number {
    return this._getIdeas().filter((i) => this._isVisible(i.data)).length;
  }

  protected _updateBadge(): void {
    const count = this._visibleCount();
    const ideasCountElement = this._htmlTab.querySelector("#ideasPanelCount");
    const ideasCountBadgeElement = this._htmlTab.querySelector(
      "#ideasPanelCountBadge"
    );
    if (ideasCountElement && ideasCountBadgeElement) {
      ideasCountElement.innerHTML = count.toString();
      (count ? show : hide)(ideasCountBadgeElement);
    } else {
      throw new Error(`Could not find badge elements`);
    }
  }

  protected _updateEmptyRow(): void {
    const tbody = this._htmlGrid.querySelector("tbody");
    if (!tbody) throw new Error("Cannot find idea grid tbody");

    let emptyRow = this._htmlGrid.querySelector(`#ideasPanel-empty`);
    if (!emptyRow) {
      emptyRow = document.createElement("tr");
      emptyRow.id = `ideasPanel-empty`;
      emptyRow.innerHTML = `<td colspan="7"><span>No new ideas to share right now</span></td>`;
      tbody.appendChild(emptyRow);
    }
    (this._visibleCount() ? hide : show)(emptyRow);
  }

  protected _draw(): void {
    const cols = [
      { id: "expand", text: "" },
      { id: "desc", text: "idea", hspan: { cols: 1, text: "idea" } },
      {
        id: "impactGreens",
        text: "impactGreens",
        hspan: { cols: 3, text: "impact" },
      },
      { id: "impactReds", text: "impactReds" },
      { id: "impactSquares", text: "impactSquares" },
      {
        id: "accept",
        text: "accept idea",
        icon: "codicon-add",
        hspan: { cols: 2, text: "actions" },
      },
      { id: "reject", text: "reject idea", icon: "codicon-trash" },
    ] as const;

    // Redraw the empty grid
    let spanning = 0;
    const thead = this._htmlGrid.querySelector("thead");
    if (!thead) throw new Error("Cannot find idea grid thead");

    const hRow = thead.appendChild(document.createElement("tr"));
    cols.forEach((h) => {
      if (spanning > 0) {
        spanning--;
      } else {
        const th = hRow.appendChild(document.createElement("th"));
        if ("hspan" in h && h.hspan.cols > 0) {
          spanning = h.hspan.cols - 1;
          th.colSpan = h.hspan.cols;
          th.innerText = h.hspan.text;
          th.classList.add("spanning");
        } else {
          if ("icon" in h) {
            th.innerHTML = `<span><span class="codicon ${h.icon}" title="${h.text}"></span></span>`;
            th.classList.add("colorColumn");
          } else {
            th.innerText = h.text;
          }
        }
      }
    });
    this._updateBadge();
    this._updateEmptyRow();
  }
}
