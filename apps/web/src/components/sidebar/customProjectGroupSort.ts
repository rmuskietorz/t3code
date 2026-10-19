import type { ContextMenuItem } from "@t3tools/contracts";
import {
  SidebarCustomProjectGroupSortOrder,
  type SidebarCustomProjectGroup,
  type SidebarProjectSortOrder,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

export const SIDEBAR_PROJECT_SORT_ORDER_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};

export function customProjectGroupSortOrderOptions(
  globalSortOrder: SidebarProjectSortOrder,
): ReadonlyArray<{ readonly value: SidebarCustomProjectGroupSortOrder; readonly label: string }> {
  return [
    {
      value: "inherit",
      label: `Sidebar default (${SIDEBAR_PROJECT_SORT_ORDER_LABELS[globalSortOrder]})`,
    },
    { value: "manual", label: "Manual" },
    { value: "name", label: "Name" },
    { value: "updated_at", label: "Recent activity" },
  ];
}

const SORT_MENU_ID_PREFIX = "sort-projects:";
const isSortOrder = Schema.is(SidebarCustomProjectGroupSortOrder);

export function buildCustomProjectGroupContextMenuItems(
  group: SidebarCustomProjectGroup,
  globalSortOrder: SidebarProjectSortOrder,
): ContextMenuItem<string>[] {
  const current = group.projectSortOrder ?? "inherit";
  return [
    { id: "rename", label: "Rename group" },
    {
      id: `${SORT_MENU_ID_PREFIX}submenu`,
      label: "Sort projects",
      children: customProjectGroupSortOrderOptions(globalSortOrder).map((option) => ({
        id: `${SORT_MENU_ID_PREFIX}${option.value}`,
        label: option.label,
        ...(option.value === current ? { checked: true } : {}),
      })),
    },
    { id: "delete", label: "Delete group", icon: "trash", destructive: true },
  ];
}

export function parseCustomProjectGroupSortMenuId(
  id: string | null,
): SidebarCustomProjectGroupSortOrder | null {
  if (!id?.startsWith(SORT_MENU_ID_PREFIX)) return null;
  const value = id.slice(SORT_MENU_ID_PREFIX.length);
  return isSortOrder(value) ? value : null;
}
