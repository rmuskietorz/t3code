import { describe, expect, it } from "vite-plus/test";

import {
  buildCustomGroupScopeSections,
  buildSidebarProjectScopeItems,
  customGroupScopeKey,
  filterGroupedSidebarProjectScopeItems,
  parseCustomGroupScopeKey,
  resolveCustomGroupScope,
} from "./sidebarCustomGroupScope";
import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";

const project = (projectKey: string, displayName: string, workspaceRoot: string) =>
  ({
    projectKey,
    displayName,
    memberProjects: [{ physicalProjectKey: `wsl:${workspaceRoot}`, workspaceRoot }],
  }) as unknown as SidebarProjectSnapshot;

const pimcore = project("pimcore", "PimCore", "/var/www/PimCore");
const tankivo = project("tankivo", "Tankivo", "/home/robmus/projects/mobile/Tankivo");
const scratch = project("scratch", "Scratch", "/tmp/scratch");

const settings = {
  sidebarCustomProjectGroups: [
    { id: "work", name: "Arbeit", pathRules: ["/var/www/*"] },
    { id: "private", name: "Privat", pathRules: ["/home/robmus/projects/**"] },
    { id: "empty", name: "Leer", pathRules: [] },
  ],
  sidebarCustomProjectGroupAssignments: {},
};

const sections = buildCustomGroupScopeSections([tankivo, pimcore, scratch], settings);
const items = buildSidebarProjectScopeItems([tankivo, pimcore, scratch], sections);
const matchesLabel = (item: { label: string }, query: string) =>
  item.label.toLowerCase().includes(query.toLowerCase());

describe("custom group scope keys", () => {
  it("round-trips group keys and ignores project keys", () => {
    expect(parseCustomGroupScopeKey(customGroupScopeKey("work"))).toBe("work");
    expect(parseCustomGroupScopeKey("github.com/owner/repo")).toBeNull();
    expect(parseCustomGroupScopeKey(null)).toBeNull();
  });
});

describe("buildSidebarProjectScopeItems", () => {
  it("lists non-empty groups as headings with their projects, ungrouped last", () => {
    expect(items.map((item) => [item.kind, item.label])).toEqual([
      ["all", "All projects"],
      ["group", "Arbeit"],
      ["project", "PimCore"],
      ["group", "Privat"],
      ["project", "Tankivo"],
      ["group", "Ungrouped"],
      ["project", "Scratch"],
    ]);
  });

  it("keeps the flat project list while groups are off", () => {
    expect(
      buildSidebarProjectScopeItems([tankivo, pimcore], null).map((item) => item.label),
    ).toEqual(["All projects", "Tankivo", "PimCore"]);
  });
});

describe("filterGroupedSidebarProjectScopeItems", () => {
  it("keeps a heading while one of its projects matches", () => {
    expect(
      filterGroupedSidebarProjectScopeItems({ items, query: "tank", matches: matchesLabel }).map(
        (item) => item.label,
      ),
    ).toEqual(["Privat", "Tankivo"]);
  });

  it("keeps a whole group when its heading matches", () => {
    expect(
      filterGroupedSidebarProjectScopeItems({ items, query: "arbeit", matches: matchesLabel }).map(
        (item) => item.label,
      ),
    ).toEqual(["Arbeit", "PimCore"]);
  });
});

describe("resolveCustomGroupScope", () => {
  it("resolves a group scope to its projects", () => {
    const resolution = resolveCustomGroupScope({
      key: customGroupScopeKey("work"),
      sections,
      settings,
    });
    expect(resolution.kind === "group" && resolution.section.projects).toEqual([pimcore]);
  });

  it("explains why a stored group scope can no longer apply", () => {
    const resolve = (key: string, groupsEnabled = true) =>
      resolveCustomGroupScope({ key, sections: groupsEnabled ? sections : null, settings });
    expect(resolve(customGroupScopeKey("empty"))).toEqual({
      kind: "unavailable",
      message: "Leer has no projects.",
    });
    expect(resolve(customGroupScopeKey("gone"))).toEqual({
      kind: "unavailable",
      message: "The group was deleted.",
    });
    expect(resolve(customGroupScopeKey("work"), false)).toEqual({
      kind: "unavailable",
      message: "Custom project groups are turned off.",
    });
  });

  it("leaves project scopes to the existing resolution", () => {
    expect(resolveCustomGroupScope({ key: "pimcore", sections, settings })).toEqual({
      kind: "none",
    });
  });
});
