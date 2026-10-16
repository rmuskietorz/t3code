import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SidebarCustomProjectGroup } from "@t3tools/contracts/settings";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useCustomProjectGroupActions } from "../../hooks/useCustomProjectGroups";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/** Sortable ids of group headers, kept apart from project keys in the same drag context. */
export const customProjectGroupDragId = (groupKey: string) => `custom-project-group:${groupKey}`;

export function CustomProjectGroupHeader({
  group,
  groupKey,
  projectCount,
  collapsed,
  onToggleCollapsed,
  sortable,
}: {
  /** `null` is the "Ungrouped" section. */
  group: SidebarCustomProjectGroup | null;
  groupKey: string;
  projectCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Whether the header takes part in drag and drop (manual project order only). */
  sortable: boolean;
}) {
  const actions = useCustomProjectGroupActions();
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isOver } =
    useSortable({
      id: customProjectGroupDragId(groupKey),
      // "Ungrouped" stays last but still accepts dropped projects.
      disabled: { draggable: !sortable || group === null, droppable: !sortable },
    });
  const label = group?.name ?? "Ungrouped";

  const openContextMenu = async (event: React.MouseEvent) => {
    if (group === null) return;
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        { id: "rename", label: "Rename group" },
        { id: "delete", label: "Delete group", icon: "trash", destructive: true },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "rename") setRenameDraft(group.name);
    if (clicked === "delete") void actions.deleteGroup(group.id);
  };

  const submitRename = () => {
    const name = renameDraft?.trim() ?? "";
    if (group !== null && name.length > 0) void actions.renameGroup(group.id, name);
    setRenameDraft(null);
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`mt-2 list-none rounded-md first:mt-0 ${
        isOver ? "ring-1 ring-inset ring-primary/40" : ""
      }`}
      data-testid="custom-project-group-header"
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
        onContextMenu={(event) => void openContextMenu(event)}
        {...(sortable && group !== null ? { ...attributes, ...listeners } : {})}
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
        <span className="flex-1 truncate">{label}</span>
        <span className="tabular-nums text-sidebar-muted-foreground/60">{projectCount}</span>
      </button>

      <Dialog
        open={renameDraft !== null}
        onOpenChange={(open) => {
          if (!open) setRenameDraft(null);
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename group</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Group name"
              value={renameDraft ?? ""}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitRename();
                }
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDraft(null)}>
              Cancel
            </Button>
            <Button onClick={submitRename}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </li>
  );
}
