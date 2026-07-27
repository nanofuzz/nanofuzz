import * as JSON5 from "json5";
import {
  AbstractIdeaModel,
  IdeaBasis,
} from "../fuzzer/ideas/AbstractIdeaModel";
import { PropertyIdeaModel } from "../fuzzer/ideas/PropertyIdeaModel";
import { IdeaData } from "../fuzzer/ideas/Types";
import { FuzzPanelMessageToWebView } from "./FuzzPanel";

export class IdeasPanelController {
  protected _ideas: AbstractIdeaModel[] = [];
  protected _basis: IdeaBasis;

  constructor(basis: IdeaBasis) {
    this._basis = basis;

    // !!!!!!!!!! use a factory or something here
    PropertyIdeaModel.propose(basis, (i: AbstractIdeaModel) => {
      this.propose(i);
    });
  }

  public propose(i: AbstractIdeaModel): void {
    this._ideas.push(i);
    const message: FuzzPanelMessageToWebView = {
      command: "ideas.updated",
      ideasSerialized: JSON5.stringify([i.data]),
      ideas: [i.data],
    };
    this._basis.webview.postMessage(message);
  }

  public accept(i: AbstractIdeaModel | IdeaData): void {
    const ideasToAccept = this._ideas.filter(
      (idea) => idea.type === i.type && idea.id === i.id
    );
    ideasToAccept.forEach((i) => i.accept());
    const ideasAccepted = ideasToAccept.map((i) => i.data);
    const message: FuzzPanelMessageToWebView = {
      command: "ideas.updated",
      ideasSerialized: JSON5.stringify(ideasAccepted),
      ideas: ideasAccepted,
    };
    this._basis.webview.postMessage(message);
  }

  public reject(i: AbstractIdeaModel | IdeaData): void {
    const ideasToReject = this._ideas.filter(
      (idea) => idea.type === i.type && idea.id === i.id
    );
    ideasToReject.forEach((i) => i.reject());
    const ideasRejected = ideasToReject.map((i) => i.data);
    const message: FuzzPanelMessageToWebView = {
      command: "ideas.updated",
      ideasSerialized: JSON5.stringify(ideasRejected),
      ideas: ideasRejected,
    };
    this._basis.webview.postMessage(message);
  }

  // !!!!!!!!!! also need to check for new properties
  public refresh(): void {
    this._ideas.filter((i) => i.isProposed).forEach((i) => i.refresh());
    const ideasRefreshed = this._ideas
      .filter((i) => i.isProposed)
      .map((i) => i.data);
    console.debug(`Sending refresh/update message to front-end`); // !!!!!!!!!!
    const message: FuzzPanelMessageToWebView = {
      command: "ideas.updated",
      ideasSerialized: JSON5.stringify(ideasRefreshed),
      ideas: ideasRefreshed,
    };
    this._basis.webview.postMessage(message);
  }
}
