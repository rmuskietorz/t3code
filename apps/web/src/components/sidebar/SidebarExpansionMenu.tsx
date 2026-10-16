import { ChevronsDownUpIcon } from "lucide-react";

import type { SidebarBulkExpansionAction } from "../../sidebarBulkExpansion";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarExpansionMenu({
  showGroupActions,
  onAction,
}: {
  showGroupActions: boolean;
  onAction: (action: SidebarBulkExpansionAction) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost-muted" aria-label="Collapse or expand all" />
              }
            />
          }
        >
          <ChevronsDownUpIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Collapse or expand all</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuItem onClick={() => onAction("collapse-projects")}>Collapse all projects</MenuItem>
        <MenuItem onClick={() => onAction("expand-projects")}>Expand all projects</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => onAction("show-all-threads")}>Show all threads</MenuItem>
        <MenuItem onClick={() => onAction("show-fewer-threads")}>Show fewer threads</MenuItem>
        {showGroupActions ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onAction("collapse-groups")}>Collapse all groups</MenuItem>
            <MenuItem onClick={() => onAction("expand-groups")}>Expand all groups</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
