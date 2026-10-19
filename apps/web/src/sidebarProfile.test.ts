import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarProfileOptions,
  filterToSidebarProfile,
  readInitialSidebarProfileKey,
  resolveSidebarProfile,
} from "./sidebarProfile";

const groups = [
  { id: "work", name: "Arbeit", pathRules: ["/var/www/*"] },
  { id: "private", name: "Privat", pathRules: ["/home/robmus/projects/**"] },
];

const project = (name: string, workspaceRoot: string) => ({
  name,
  members: [{ physicalProjectKey: `wsl:${workspaceRoot}`, workspaceRoot }],
});
const pimcore = project("pimcore", "/var/www/PimCore");
const tankivo = project("tankivo", "/home/robmus/projects/mobile/Tankivo");
const scratch = project("scratch", "/tmp/scratch");
const projects = [pimcore, tankivo, scratch];

const settings = {
  sidebarCustomProjectGroups: groups,
  sidebarCustomProjectGroupAssignments: { "wsl:/tmp/scratch": "work" },
};

const storage = (entries: Record<string, string>) => ({
  getItem: (name: string) => entries[name] ?? null,
  setItem: () => undefined,
});

describe("resolveSidebarProfile", () => {
  it("resolves a group and the Ungrouped bucket", () => {
    expect(resolveSidebarProfile({ key: "work", enabled: true, groups })).toEqual({
      key: "work",
      label: "Arbeit",
      groupId: "work",
    });
    expect(resolveSidebarProfile({ key: "ungrouped", enabled: true, groups })).toEqual({
      key: "ungrouped",
      label: "Ungrouped",
      groupId: null,
    });
  });

  it("falls back to all projects for all, deleted groups, and disabled groups", () => {
    expect(resolveSidebarProfile({ key: "all", enabled: true, groups })).toBeNull();
    expect(resolveSidebarProfile({ key: "deleted", enabled: true, groups })).toBeNull();
    expect(resolveSidebarProfile({ key: "work", enabled: false, groups })).toBeNull();
    expect(resolveSidebarProfile({ key: "ungrouped", enabled: false, groups })).toBeNull();
  });
});

describe("buildSidebarProfileOptions", () => {
  it("lists all projects, each group, and Ungrouped only while groups are on", () => {
    expect(buildSidebarProfileOptions({ enabled: true, groups })).toEqual([
      { key: "all", label: "All projects" },
      { key: "work", label: "Arbeit" },
      { key: "private", label: "Privat" },
      { key: "ungrouped", label: "Ungrouped" },
    ]);
    expect(buildSidebarProfileOptions({ enabled: false, groups })).toBeNull();
  });
});

describe("filterToSidebarProfile", () => {
  const filter = (key: string) =>
    filterToSidebarProfile(
      projects,
      (item) => item.members,
      resolveSidebarProfile({ key, enabled: true, groups }),
      settings,
    ).map((item) => item.name);

  it("keeps rows whose group matches, with manual assignments beating path rules", () => {
    expect(filter("work")).toEqual(["pimcore", "scratch"]);
    expect(filter("private")).toEqual(["tankivo"]);
  });

  it("keeps everything without a profile and nothing grouped for Ungrouped", () => {
    expect(filter("all")).toEqual(["pimcore", "tankivo", "scratch"]);
    expect(
      filterToSidebarProfile(
        projects,
        (item) => item.members,
        resolveSidebarProfile({ key: "ungrouped", enabled: true, groups }),
        { ...settings, sidebarCustomProjectGroupAssignments: {} },
      ).map((item) => item.name),
    ).toEqual(["scratch"]);
  });
});

describe("readInitialSidebarProfileKey", () => {
  it("prefers this window's profile, then the last one chosen anywhere", () => {
    expect(
      readInitialSidebarProfileKey(
        storage({ "t3code:sidebar-profile:v1": "work" }),
        storage({ "t3code:sidebar-profile-last:v1": "private" }),
      ),
    ).toBe("work");
    expect(
      readInitialSidebarProfileKey(
        storage({}),
        storage({ "t3code:sidebar-profile-last:v1": "private" }),
      ),
    ).toBe("private");
    expect(readInitialSidebarProfileKey(null, null)).toBe("all");
  });
});
