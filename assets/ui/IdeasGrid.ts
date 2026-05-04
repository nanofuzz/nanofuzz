import * as JSON5 from "json5";
import { htmlEscape } from "escape-goat";
import { JudgmentDiff } from "../../src/fuzzer/oracles/CompositeJudgmentDiff";
import { hide, isHidden, show } from "./Util";

// Ideas Grid
export class IdeasGrid {
  protected _ideas = new Map<Idea["type"], Map<string, Idea>>();
  protected _drawnYet = false;
  protected _htmlTab: HTMLElement;
  protected _htmlGrid: HTMLElement;

  constructor(htmlTab: HTMLElement, htmlGrid: HTMLElement) {
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
    if (ideas.length) {
      this._draw();
    }
  }

  public delete(idea: Idea): boolean {
    const deleted = this._ideas.get(idea.type)?.delete(idea.id) ?? false;
    if (deleted) {
      this._draw();
    }
    return deleted;
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

  protected _draw(): void {
    // tab on and off !!!!!!!!!!

    const cols = [
      { id: "expand", text: "" },
      { id: "desc", text: "idea" },
      {
        id: "impactGreens",
        text: "impactGreens",
        hspan: { cols: 3, text: "impact" },
      },
      { id: "impactReds", text: "impactReds" },
      { id: "impactSquares", text: "impactSquares" },
      {
        id: "adopt",
        text: "adopt suggestion",
        icon: "codicon-run",
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
          if ("hspan" in h && h.hspan.cols > 1) {
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
    tbody.replaceChildren();

    const ideas = this._getIdeas();
    const ideasCountElement = this._htmlTab.querySelector("#ideasCount");
    const ideasCountBadgeElement =
      this._htmlTab.querySelector("#ideasCountBadge");
    if (ideasCountElement && ideasCountBadgeElement) {
      ideasCountElement.innerHTML = ideas.length.toString();
      if (ideas.length) {
        show(ideasCountBadgeElement);
      }
    }
    const squareTitles = {
      green: `prospective failures detected`,
      red: `test suite contradictions`,
      gray: `confirmations of test suite judgments`,
    };

    /* body */
    ideas.forEach((i) => {
      /* summary row */
      const detailTr = document.createElement("tr");
      const tr = document.createElement("tr");
      tr.setAttribute("id", `idea-${i.type}-${i.id}`);
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
          case "adopt":
            td.innerHTML = `<span title="${c.text}"><span class="clickable codicon ${c.icon}"></span>`;
            // !!!!!!!!!! event handler
            break;
          case "reject":
            td.innerHTML = `<span title="${c.text}"><span class="clickable codicon ${c.icon}"></span>`;
            // !!!!!!!!!! event handler
            break;
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
      switch (i.type) {
        case "property.suggestion":
          td.innerHTML = /*html*/ `
            <div>Adding this property validator...
              <small><pre class="slightIndent">${htmlEscape(i.prop.src)}</pre></small>
            </div>
            ${
              exceptions.length === 0
                ? ""
                : /*html*/ `
              <div>...would throw ${exceptions.length} new exceptions (<span class="clickable">show</span>)...</div> <!-- !!!!!!!!!! -->`
            }
            <div>...would alter ${jj.length ? "these" : "no"} test judgments${jj.length ? ":" : "."}
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
          break;
      }

      /*
      ${typeof j.addlJudgments[i.prop.name] === "string" ? j.addlJudgments[i.prop.name] : / * html * / `<span title="${j.addlJudgments[i.prop.name].toString()}">exception</span>`}
      */

      detailTr.appendChild(td);
      tbody.appendChild(detailTr);
      // !!!!!!!!!! expanded row
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
