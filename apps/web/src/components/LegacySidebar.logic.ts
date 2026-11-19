// Helpers only the fork-kept legacy sidebar uses. Upstream deleted them together
// with LegacySidebar.tsx, so they live here instead of in the shared modules.
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  getThreadSortTimestamp,
  toSortableTimestamp,
  type ThreadSortInput,
} from "@t3tools/client-runtime/state/thread-sort";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarProjectSortOrder } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import * as React from "react";

import { desktopLocalBackendId } from "../connection/desktopLocal";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { isTerminalFocused, subscribeToTerminalFocusChanges } from "../lib/terminalFocus";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS, type ThreadStatusPill } from "./Sidebar.logic";

export const ORCHESTRATION_OPERATE_DENIED_MESSAGE =
  "This connection cannot change threads or projects.";

const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;

export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT = 6;
const SIDEBAR_THREAD_PREVIEW_COUNT_KEY = "t3code:legacy-sidebar-thread-preview-count:v1";
const SidebarThreadPreviewCountSchema = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCountSchema.Type;

/** Upstream dropped the client setting, so the legacy sidebar keeps its own per-browser value. */
export function useSidebarThreadPreviewCount() {
  return useLocalStorage<SidebarThreadPreviewCount, number>(
    SIDEBAR_THREAD_PREVIEW_COUNT_KEY,
    DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
    SidebarThreadPreviewCountSchema,
  );
}

export function useIsMobile(): boolean {
  return useMediaQuery("max-md");
}

export function isWslConnectionTarget(target: ConnectionTarget): boolean {
  return desktopLocalBackendId(target)?.startsWith("wsl:") === true;
}

export function useTerminalFocus(): boolean {
  return React.useSyncExternalStore(
    subscribeToTerminalFocusChanges,
    isTerminalFocused,
    () => false,
  );
}

export function deriveProjectGroupingOverrideKey(
  project: Parameters<typeof derivePhysicalProjectKey>[0],
): string {
  return derivePhysicalProjectKey(project);
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  "Guest Request": 4,
  Failed: 3.5,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;
  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }
  return highestPriorityStatus;
}

interface SidebarProject {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }
  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends { readonly projectId: string } & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }
  // A project's timestamp walks all of its threads, so compute it once per project.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(
        project,
        threadsByProjectId.get(project.id) ?? [],
        sortOrder,
      ),
    }))
    .toSorted((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return (
        byTimestamp ||
        left.project.title.localeCompare(right.project.title) ||
        left.project.id.localeCompare(right.project.id)
      );
    })
    .map(({ project }) => project);
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const isVisibleRef = React.useRef(false);
  const timeoutRef = React.useRef<number | null>(null);

  React.useEffect(
    // Cancels a pending show when the sidebar unmounts mid-delay.
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    if (!shouldShow) {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (isVisibleRef.current) {
        isVisibleRef.current = false;
        setShowThreadJumpHints(false);
      }
      return;
    }
    if (isVisibleRef.current || timeoutRef.current !== null) return;
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      isVisibleRef.current = true;
      setShowThreadJumpHints(true);
    }, THREAD_JUMP_HINT_SHOW_DELAY_MS);
  }, []);

  return { showThreadJumpHints, updateThreadJumpHintsVisibility };
}
