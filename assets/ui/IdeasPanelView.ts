import * as JSON5 from "json5";
import { htmlEscape } from "escape-goat";
import { JudgmentDiff } from "../../src/fuzzer/oracles/CompositeJudgmentDiff";
import { hide, isHidden, show, simpleToast, toggleHidden } from "./Util";
import { FuzzPanelMessageFromWebView } from "../../src/ui/FuzzPanel";
import { WebviewApi } from "vscode-webview";
import { isError } from "../../src/Util";

// Ideas Grid
export class IdeasPanelView {
  protected _ideas = new Map<Idea["type"], Map<string, Idea>>();
  protected _drawnYet = false;
  protected _htmlTab: HTMLElement;
  protected _htmlGrid: HTMLElement;
  protected _vscode: WebviewApi<unknown>;

  constructor(
    vscode: WebviewApi<unknown>,
    htmlTab: HTMLElement,
    htmlGrid: HTMLElement
  ) {
    this._vscode = vscode;
    this._htmlGrid = htmlGrid;
    this._htmlTab = htmlTab;
    this._draw();
  }

  public add(ideas: Idea[]): void {
    for (const idea of ideas) {
      (
        this._ideas.get(idea.type) ??
        this._ideas.set(idea.type, new Map<string, Idea>()).get(idea.type)!
      ).set(idea.id, idea);
    }
    this._draw();
  }

  public delete(type: Idea["type"], id: Idea["id"]): boolean {
    const deleted = this._ideas.get(type)?.delete(id) ?? false;
    if (deleted) {
      [
        this._htmlGrid.querySelector(
          `#idea-${type}-${id}-summary`.replaceAll(".", "-")
        ),
        this._htmlGrid.querySelector(
          `#idea-${type}-${id}-detail`.replaceAll(".", "-")
        ),
      ].forEach((e) => (e ? e.remove() : e)); // update DOM
      const ideas = this._getIdeas();
      this._updateBadge(ideas.length);
      const emptyRow = this._htmlGrid.querySelector(`#idea-empty`);
      if (emptyRow) {
        (ideas.length ? hide : show)(emptyRow);
      }
    }
    return deleted;
  }

  public accept(type: Idea["type"], id: Idea["id"]): boolean {
    const idea = this._ideas.get(type)?.get(id);
    if (!idea) return false;
    switch (idea.type) {
      case "property.suggestion": {
        const message: FuzzPanelMessageFromWebView = {
          command: "validator.add",
          prop: { ...idea.prop },
        };
        this._vscode.postMessage(message);
      }
    }
    this.delete(type, id);
    return true;
  }

  public reject(type: Idea["type"], id: Idea["id"]): boolean {
    return this.delete(type, id);
  }

  public deleteAllOfType(ideaType: Idea["type"]): boolean {
    const deleted = this._ideas.delete(ideaType);
    if (deleted) {
      this._draw();
    }
    return deleted;
  }

  protected _getIdeas(): Idea[] {
    const ideas: Idea[] = [];
    // flatten & filter
    this._ideas.forEach((t) => {
      console.debug(`${t.size} subideas`); // !!!!!!!!!!!
      ideas.push(
        ...Array.from(t.values()) /*!!!!!!!!!!.filter((i) => i.priority > 0)*/
      );
    });
    console.debug(`${ideas.length} total ideas`); // !!!!!!!!!!!
    // sort
    return ideas.sort((a, b) => b.priority - a.priority);
  }

  protected _updateBadge(count: number): void {
    const ideasCountElement = this._htmlTab.querySelector("#ideasCount");
    const ideasCountBadgeElement =
      this._htmlTab.querySelector("#ideasCountBadge");
    if (ideasCountElement && ideasCountBadgeElement) {
      ideasCountElement.innerHTML = count.toString();
      (count ? show : hide)(ideasCountBadgeElement);
    }
  }

  protected _draw(): void {
    // tab on and off !!!!!!!!!!

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
      { id: "reject", text: "reject suggestion", icon: "codicon-trash" },
    ] as const;

    // Redraw the grid
    let spanning = 0;
    if (!this._drawnYet) {
      /* header row */
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
    }

    const tbody = this._htmlGrid.querySelector("tbody");
    if (!tbody) throw new Error("Cannot find idea grid tbody");

    const ideas = this._getIdeas();
    this._updateBadge(ideas.length);

    // empty row
    const emptyRow = document.createElement("tr");
    emptyRow.id = `idea-empty`;
    emptyRow.innerHTML = `<td colspan="${cols.length}"><span>No new ideas have been suggested</td>`;
    (ideas.length ? hide : show)(emptyRow);

    tbody.replaceChildren(emptyRow);

    const squareTitles = {
      green: `prospective failures detected`,
      red: `test suite contradictions`,
      gray: `confirmations of test suite judgments`,
    };

    /* body */
    ideas.forEach((i) => {
      /* summary row */
      const detailTr = document.createElement("tr");
      detailTr.id = `idea-${i.type}-${i.id}-detail`.replaceAll(".", "-");
      const tr = document.createElement("tr");
      tr.id = `idea-${i.type}-${i.id}-summary`.replaceAll(".", "-");
      tr.classList.add("sticky", "lineBelow");
      cols.forEach((c) => {
        const td = document.createElement("td");
        if ("icon" in c) {
          td.classList.add("colorColumn");
        }
        switch (c.id) {
          case "expand": {
            const spanExpand = document.createElement("span");
            td.appendChild(spanExpand);
            spanExpand.classList.add(
              "clickable",
              "codicon",
              "codicon-chevron-right"
            );
            spanExpand.setAttribute("title", "expand");

            const spanCollapse = document.createElement("span");
            td.appendChild(spanCollapse);
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
                  show(detailTr);
                } else {
                  /* collapse */
                  hide(spanCollapse);
                  show(spanExpand);
                  hide(detailTr);
                }
              });
            });
            break;
          }
          case "desc":
            switch (i.type) {
              case "property.suggestion": {
                td.innerHTML = /*html*/ `
                  <span class="flexBoxes">
                    <div title="add property validator">
                      <span class="codicon codicon-add"></span>
                      <span class="codicon codicon-robot"></span>
                    </div>
                    <div>
                      <span class="editorFont">${htmlEscape(i.prop.name)}</span>
                    </div>
                    ${
                      i.diff.detail.exceptions.length
                        ? /*html*/ `<div>
                            <span title="Threw ${i.diff.detail.exceptions.length} exceptions for this set of tests" class="codicon codicon-warning"></span>
                          </div>`
                        : ""
                    }
                  </span>`;
                break;
              }
            }
            break;
          case "impactGreens":
            td.innerHTML = /*html*/ `
              <span class="diffSummary"><span aria-label="Judgments changed: ${i.diff.summary.greens} ${squareTitles.green}" title="${squareTitles.green}" class="greens">+${i.diff.summary.greens}</span></span>`;
            break;
          case "impactReds":
            td.innerHTML = /*html*/ `
              <span class="diffSummary"><span aria-label="Judgments changed: ${i.diff.summary.reds} ${squareTitles.red}" title="${squareTitles.red}" class="reds">-${i.diff.summary.reds}</span>`;
            break;
          case "impactSquares":
            td.innerHTML = /*html*/ `
              <span class="diffSummary">
                <div class="colorSquares">
                  ${[0, 1, 2, 3, 4].map((s) => `<div title="${squareTitles[i.diff.summary.squares[s]]}" class="${i.diff.summary.squares[s]}"></div>`).join("")}
                </div>
              </span>`;
            break;
          case "accept": {
            const outerSpan = document.createElement("span");
            outerSpan.setAttribute("title", c.text);
            const innerSpan = document.createElement("span");
            innerSpan.classList.add("clickable", "codicon", c.icon);
            outerSpan.appendChild(innerSpan);
            td.appendChild(outerSpan);
            innerSpan.addEventListener("click", () => {
              console.debug(`Accepting ${i.type} ${i.id}`); // !!!!!!!!!!
              this.accept(i.type, i.id);
              simpleToast("Idea accepted");
            });
            break;
          }
          case "reject": {
            const outerSpan = document.createElement("span");
            outerSpan.setAttribute("title", c.text);
            const innerSpan = document.createElement("span");
            innerSpan.classList.add("clickable", "codicon", c.icon);
            outerSpan.appendChild(innerSpan);
            td.appendChild(outerSpan);
            innerSpan.addEventListener("click", () => {
              console.debug(`Rejecting ${i.type} ${i.id}`); // !!!!!!!!!!
              this.reject(i.type, i.id);
              simpleToast("Idea rejected");
            });
            break;
          }
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);

      /* Detail row */
      detailTr.classList.add("hidden", "ideaDetail", "lineBelow");
      detailTr.appendChild(document.createElement("td")); // spacer cell

      /* 
        Columns:
        (1) PUT input, 
        (2) the PUT output, 
        (3) judgment of the baseline test suite, 
        (4) judgment of the baseline test suite with the candidate assertion added, and 
        (5) an (i) button that provides an explanation of the change in judgment. 
        
        Above the grid is a set of filter controls, which hide or show prospective failures 
        (green), false passes and failures (red), and neutrals such as true passes and 
        failures (gray). The coloring and decoration of the fourth column corresponds to 
        that of the filter controls and that of the summary form.
      */
      const td = document.createElement("td");
      td.colSpan = cols.length - 1;

      switch (i.type) {
        case "property.suggestion": {
          const getExceptionMsg = (e: unknown) =>
            isError(e) ? [e.name, e.message] : [JSON5.stringify(e)];
          const exceptions = i.diff.detail.exceptions.map((e) => ({
            ...e,
            color: "red",
          }));
          const jj = [
            ...i.diff.detail.prospectiveFailures.map((e) => ({
              ...e,
              color: "green",
            })),
            ...i.diff.detail.falseFailures.map((e) => ({
              ...e,
              color: "red",
            })),
            ...i.diff.detail.falsePasses.map((e) => ({
              ...e,
              color: "red",
            })),
          ];

          td.innerHTML = /*html*/ `
            <div>Adding this property validator...
              <small><pre class="slightIndent">${htmlEscape(i.prop.src)}</pre></small>
            </div>
            ${
              exceptions.length === 0
                ? ""
                : /*html*/ `
              <div>...would throw ${exceptions.length} new exceptions (<a id="${`idea-${i.type}-${i.id}-detail-exceptionToggle`.replaceAll(".", "-")}" class="clickable">show</a>)...</div>
              <div id="${`idea-${i.type}-${i.id}-detail-exceptions`.replaceAll(".", "-")}" class="hidden">
                <table class="fuzzGrid">
                  <thead> 
                    <tr>
                      <th>&nbsp;</th>
                      <th>inputs</th>
                      <th>validator threw exception</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${exceptions
                      .map(
                        (e) => /*html*/ `
                    <tr>
                      <td><span class="codicon codicon-warn"></span></td>
                      <td class="editorFont">${htmlEscape(JSON5.stringify(e.example.in))}</td>
                      <td class="editorFont">${getExceptionMsg(
                        e.addlJudgments[i.prop.name]
                      )
                        .map((e) => htmlEscape(e))
                        .join("<br />")}
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
                    <th>inputs</th>
                    <th>output</th>
                    <th>current judgment</th>
                    <th>new judgment</td>
                    <th>&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  ${jj
                    .map(
                      (j) => /*html*/ `
                  <tr>
                    <td>
                      <span class="diffSummary">
                        <div class="colorSquares">
                          <div class="${j.color}"></div>
                        </div>
                      </span>
                    </td>
                    <td class="editorFont">${htmlEscape(JSON5.stringify(j.example.in))}</td>
                    <td class="editorFont">${htmlEscape(j.example.out === undefined ? "undefined" : JSON5.stringify(j.example.out))}</td>
                    <td class="editorFont removedLine">${j.judgments.composite}</td>
                    <td class="editorFont addedLine">${j.rejudgment}</td>
                    <td><span><span title="more info" class="clickable codicon codicon-info"><!-- event handler !!!!!!!!!! --></span></span></td>
                  </tr>`
                    )
                    .join("")}
                </tbody>
              </table>

              <div></div>
            </div>`;
          const exceptionToggleBtn = td.querySelector(
            `#idea-${i.type}-${i.id}-detail-exceptionToggle`.replaceAll(
              ".",
              "-"
            )
          );
          const exceptionToggleTable = td.querySelector(
            `#idea-${i.type}-${i.id}-detail-exceptions`.replaceAll(".", "-")
          );
          if (exceptionToggleBtn && exceptionToggleTable) {
            exceptionToggleBtn.addEventListener("click", () => {
              toggleHidden(exceptionToggleTable);
              exceptionToggleBtn.innerHTML = isHidden(exceptionToggleTable)
                ? "show"
                : "hide";
            });
          }
          break;
        }
      }

      detailTr.appendChild(td);
      tbody.appendChild(detailTr);
    });

    // flattem, sort, and filter the ideas

    this._drawnYet = true;
    // !!!!!!!!!! this isn't really right b/c we need to handle to
    // condition where the user has the tab open (e.g., we need to
    // select another tab)
    (this._ideas.size > 0 ? show : hide)(this._htmlTab);
    (this._ideas.size > 0 ? show : hide)(this._htmlGrid);
  }
}

type Idea = {
  type: "property.suggestion";
  id: string;
  priority: number;
  prop: {
    name: string;
    src: string;
  };
  diff: JudgmentDiff;
  /* !!!!!!!!!!
  combos: {
    props: string[];
    diff: JudgmentDiff;
  };
  */
};
