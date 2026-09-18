import { IdeasPanelView } from "../../ui/IdeasPanelView";
import { AbstractIdeaView } from "./AbstractIdeaView";
import { PropertyIdeaView } from "./PropertyIdeaView";
import { IdeaData } from "./Types";

export function IdeaViewFactory(
  ideaData: IdeaData,
  inputNames: string[],
  ideasPanel: IdeasPanelView
): AbstractIdeaView {
  switch (ideaData.type) {
    case "idea.property":
      return new PropertyIdeaView(ideaData, inputNames, ideasPanel);
  }
}
