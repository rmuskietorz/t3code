import { Columns2Icon } from "lucide-react";

import { readSplitViewHost } from "../../splitViewHost";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const SPLIT_VIEW_BUTTON_LABEL = "Toggle split view (Ctrl+Alt+S)";

/** The legacy sidebar's split view toggle, shown only inside a shell that provides it. */
export function SplitViewButton() {
  const host = readSplitViewHost();
  if (host === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={SPLIT_VIEW_BUTTON_LABEL}
            onClick={() => host.toggle()}
          />
        }
      >
        <Columns2Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="right">{SPLIT_VIEW_BUTTON_LABEL}</TooltipPopup>
    </Tooltip>
  );
}
