import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  buildThreadActionMenuItems,
  isAgentSessionImportThread,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  groupFilter: null,
  splitView: false,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  canReloadFromSession: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("offers filtering by the thread's project group next to the project filter", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      projectFilter: { label: "PimCore", isActive: false },
      groupFilter: { label: "Arbeit", isActive: false },
    });
    const projectIndex = items.findIndex((candidate) => candidate.id === "filter-by-project");
    expect(items[projectIndex + 1]).toMatchObject({
      id: "filter-by-group",
      label: "Filter by group Arbeit",
    });
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        groupFilter: { label: "Arbeit", isActive: true },
      }).find((item) => item.id === "filter-by-group"),
    ).toMatchObject({ label: "Show all projects" });
    expect(
      buildThreadActionMenuItems(baseState).some((item) => item.id === "filter-by-group"),
    ).toBe(false);
  });

  it("offers the split view only when a shell can show a second pane", () => {
    expect(
      buildThreadActionMenuItems(baseState).some((item) => item.id === "open-in-split-view"),
    ).toBe(false);
    const items = buildThreadActionMenuItems({ ...baseState, splitView: true });
    expect(items[0]).toMatchObject({ id: "open-in-split-view", label: "Open in split view" });
    expect(items[1]).toMatchObject({ id: "open-in-new-window", label: "Open in new window" });
  });

  it("offers reloading from the session only for capable imports, before archive", () => {
    const ids = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).map((item) => item.id);
    expect(ids(baseState)).not.toContain("reload-from-session");
    const reloadable = ids({ ...baseState, canReloadFromSession: true });
    expect(reloadable.indexOf("reload-from-session")).toBe(reloadable.indexOf("archive") - 1);
  });

  it("disables reloading from the session while running or without permission", () => {
    const reloadItem = (state: Partial<ThreadActionMenuState>) =>
      buildThreadActionMenuItems({ ...baseState, canReloadFromSession: true, ...state }).find(
        (item) => item.id === "reload-from-session",
      );
    expect(reloadItem({})?.disabled).toBe(false);
    expect(reloadItem({ isRunning: true })?.disabled).toBe(true);
    expect(reloadItem({ canOperate: false })?.disabled).toBe(true);
  });
});

describe("isAgentSessionImportThread", () => {
  it("recognizes threads the agent session importer created", () => {
    expect(isAgentSessionImportThread(ThreadId.make("import:claudeAgent:62b60885"))).toBe(true);
    expect(isAgentSessionImportThread(ThreadId.make("thread-started-in-t3"))).toBe(false);
  });
});
