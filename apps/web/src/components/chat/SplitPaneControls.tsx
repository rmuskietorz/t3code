import { Columns2Icon, MinusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { readSplitViewHost, useSplitViewActive } from "../../splitViewHost";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function PaneButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={props.label}
            onClick={props.onClick}
            className="shrink-0 [-webkit-app-region:no-drag]"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Split view controls for the pane this app runs in, at the end of the title
 * bar controls. Rendered only inside a shell that provides the split view.
 */
export function SplitPaneControls() {
  const host = readSplitViewHost();
  const split = useSplitViewActive();
  if (host === null) return null;
  return (
    <>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      {split ? (
        <>
          <PaneButton
            label="Minimize this half to the tab bar"
            onClick={() => host.minimizeThisPane()}
          >
            <MinusIcon className="size-4" />
          </PaneButton>
          <PaneButton label="Close this half" onClick={() => host.closeThisPane()}>
            <XIcon className="size-4" />
          </PaneButton>
        </>
      ) : (
        <PaneButton label="Open split view (Ctrl+Alt+S)" onClick={() => host.toggle()}>
          <Columns2Icon className="size-4" />
        </PaneButton>
      )}
    </>
  );
}
