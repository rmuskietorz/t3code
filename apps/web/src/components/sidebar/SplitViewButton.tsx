import { Columns2Icon, MinusIcon, XIcon } from "lucide-react";

import { readSplitViewHost, useSplitViewActive } from "../../splitViewHost";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const OPEN_SPLIT_VIEW_LABEL = "Open split view (Ctrl+Alt+S)";
export const MINIMIZE_SPLIT_PANE_LABEL = "Minimize this half to the tab bar";
export const CLOSE_SPLIT_PANE_LABEL = "Close this half of the split view";

function LegacyIconButton(props: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** The legacy sidebar's split view controls, shown only inside a shell that provides them. */
export function SplitViewButton() {
  const host = readSplitViewHost();
  const split = useSplitViewActive();
  if (host === null) return null;
  if (!split) {
    return (
      <LegacyIconButton label={OPEN_SPLIT_VIEW_LABEL} onClick={() => host.toggle()}>
        <Columns2Icon className="size-3.5" />
      </LegacyIconButton>
    );
  }
  return (
    <>
      <LegacyIconButton label={MINIMIZE_SPLIT_PANE_LABEL} onClick={() => host.minimizeThisPane()}>
        <MinusIcon className="size-3.5" />
      </LegacyIconButton>
      <LegacyIconButton label={CLOSE_SPLIT_PANE_LABEL} onClick={() => host.closeThisPane()}>
        <XIcon className="size-3.5" />
      </LegacyIconButton>
    </>
  );
}
