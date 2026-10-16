import { ChevronsDownUpIcon } from "lucide-react";
import { Fragment, type ReactElement } from "react";

import type { SidebarBulkExpansionAction } from "../../sidebarBulkExpansion";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarExpansionMenuEntry {
  readonly action: SidebarBulkExpansionAction;
  readonly label: string;
}

/** Entries the menu and the command palette offer for each sidebar. */
export function sidebarExpansionMenuGroups(input: {
  readonly legacySidebar: boolean;
  readonly customProjectGroups: boolean;
}): ReadonlyArray<ReadonlyArray<SidebarExpansionMenuEntry>> {
  if (!input.legacySidebar) {
    return [
      [
        { action: "collapse-sections", label: "Collapse all sections" },
        { action: "expand-sections", label: "Expand all sections" },
      ],
    ];
  }
  return [
    [
      { action: "collapse-projects", label: "Collapse all projects" },
      { action: "expand-projects", label: "Expand all projects" },
    ],
    [
      { action: "show-all-threads", label: "Show all threads" },
      { action: "show-fewer-threads", label: "Show fewer threads" },
    ],
    ...(input.customProjectGroups
      ? [
          [
            { action: "collapse-groups", label: "Collapse all groups" },
            { action: "expand-groups", label: "Expand all groups" },
          ] as const,
        ]
      : []),
  ];
}

const LABEL = "Collapse or expand all";

export function SidebarExpansionMenu({
  groups,
  onAction,
  trigger,
}: {
  groups: ReadonlyArray<ReadonlyArray<SidebarExpansionMenuEntry>>;
  onAction: (action: SidebarBulkExpansionAction) => void;
  /** Replaces the legacy sidebar's small icon button, keeping the header's own button style. */
  trigger?: ReactElement;
}) {
  return (
    <Menu>
      {trigger ? (
        <MenuTrigger render={trigger}>
          <ChevronsDownUpIcon />
        </MenuTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<Button size="icon-xs" variant="ghost-muted" aria-label={LABEL} />}
              />
            }
          >
            <ChevronsDownUpIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">{LABEL}</TooltipPopup>
        </Tooltip>
      )}
      <MenuPopup align="end" side="bottom">
        {groups.map((entries, index) => (
          <Fragment key={entries[0]?.action ?? index}>
            {index > 0 ? <MenuSeparator /> : null}
            {entries.map((entry) => (
              <MenuItem key={entry.action} onClick={() => onAction(entry.action)}>
                {entry.label}
              </MenuItem>
            ))}
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
}
