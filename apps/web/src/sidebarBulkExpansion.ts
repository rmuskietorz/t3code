import { useEffect } from "react";

export type SidebarBulkExpansionAction =
  | "collapse-projects"
  | "expand-projects"
  | "show-all-threads"
  | "show-fewer-threads"
  | "collapse-groups"
  | "expand-groups"
  | "collapse-sections"
  | "expand-sections";

const handlers = new Set<(action: SidebarBulkExpansionAction) => void>();

/**
 * Lets the command palette reach the mounted legacy sidebar, which owns the
 * project rows these actions need; with no sidebar mounted it does nothing.
 */
export function requestSidebarBulkExpansion(action: SidebarBulkExpansionAction): void {
  for (const handler of handlers) handler(action);
}

export function useSidebarBulkExpansionHandler(
  handler: (action: SidebarBulkExpansionAction) => void,
): void {
  useEffect(() => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }, [handler]);
}
