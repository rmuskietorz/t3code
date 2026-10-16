import { Columns2Icon, XIcon } from "lucide-react";

import { readSplitViewHost, useSplitViewActive } from "../../splitViewHost";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const OPEN_SPLIT_VIEW_LABEL = "Open split view (Ctrl+Alt+S)";
export const CLOSE_SPLIT_PANE_LABEL = "Close this half of the split view";

/** The legacy sidebar's split view control, shown only inside a shell that provides it. */
export function SplitViewButton() {
  const host = readSplitViewHost();
  const split = useSplitViewActive();
  if (host === null) return null;
  const label = split ? CLOSE_SPLIT_PANE_LABEL : OPEN_SPLIT_VIEW_LABEL;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={() => (split ? host.closeThisPane() : host.toggle())}
          />
        }
      >
        {split ? <XIcon className="size-3.5" /> : <Columns2Icon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
