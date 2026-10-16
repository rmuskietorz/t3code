import { describe, expect, it } from "vite-plus/test";

import {
  assignCustomProjectGroup,
  compileCustomProjectGroupPathRule,
  deleteCustomProjectGroup,
  makeCustomProjectGroupResolver,
  moveCustomProjectGroup,
  partitionIntoCustomProjectGroups,
  UNGROUPED_CUSTOM_PROJECT_GROUP_ID,
  type CustomProjectGroupSettings,
} from "./customProjectGroups.ts";

const work = { id: "work", name: "Work", pathRules: ["/var/www/*"] };
const personal = {
  id: "personal",
  name: "Personal",
  pathRules: ["/home/robmus/projects/**", "C:/Users/r.muskietorz/projects/**"],
};

const settings = (
  overrides: Partial<CustomProjectGroupSettings> = {},
): CustomProjectGroupSettings => ({
  sidebarCustomProjectGroups: [work, personal],
  sidebarCustomProjectGroupAssignments: {},
  ...overrides,
});

const member = (environmentId: string, workspaceRoot: string) => ({
  physicalProjectKey: `${environmentId}:${workspaceRoot}`,
  workspaceRoot,
});

describe("compileCustomProjectGroupPathRule", () => {
  it("keeps a single star inside one segment", () => {
    const matches = compileCustomProjectGroupPathRule("/var/www/*");
    expect(matches("/var/www/PimCore")).toBe(true);
    expect(matches("/var/www/PimCore/sub")).toBe(false);
    expect(matches("/var/www")).toBe(false);
  });

  it("lets a double star cross segments and cover the folder itself", () => {
    const matches = compileCustomProjectGroupPathRule("/home/robmus/projects/**");
    expect(matches("/home/robmus/projects/tools/t3code")).toBe(true);
    expect(matches("/home/robmus/projects")).toBe(true);
    expect(matches("/home/robmus/projects-old")).toBe(false);
  });

  it("matches Windows paths regardless of case and slash direction", () => {
    const matches = compileCustomProjectGroupPathRule("C:/Users/r.muskietorz/projects/**");
    expect(matches("C:\\Users\\r.muskietorz\\projects\\mobile\\Flowly")).toBe(true);
    expect(matches("c:\\users\\R.MUSKIETORZ\\Projects\\web")).toBe(true);
    expect(matches("/c/Users/r.muskietorz/projects/web")).toBe(false);
  });

  it("keeps POSIX rules case-sensitive and treats regex characters literally", () => {
    expect(compileCustomProjectGroupPathRule("/var/www/*")("/var/WWW/PimCore")).toBe(false);
    expect(compileCustomProjectGroupPathRule("/srv/a.b/*")("/srv/axb/site")).toBe(false);
    expect(compileCustomProjectGroupPathRule("/srv/site-?")("/srv/site-1")).toBe(true);
  });
});

describe("makeCustomProjectGroupResolver", () => {
  it("prefers a manual assignment over a matching path rule", () => {
    const resolver = makeCustomProjectGroupResolver(
      settings({ sidebarCustomProjectGroupAssignments: { "wsl:/var/www/PimCore": "personal" } }),
    );
    expect(resolver.resolve([member("wsl", "/var/www/PimCore")])).toBe("personal");
    expect(resolver.resolve([member("wsl", "/var/www/Tankivo")])).toBe("work");
  });

  it("keeps a project pinned to ungrouped even when a rule matches", () => {
    const resolver = makeCustomProjectGroupResolver(
      settings({
        sidebarCustomProjectGroupAssignments: {
          "wsl:/var/www/PimCore": UNGROUPED_CUSTOM_PROJECT_GROUP_ID,
        },
      }),
    );
    expect(resolver.resolve([member("wsl", "/var/www/PimCore")])).toBeNull();
  });

  it("uses the first matching group in sidebar order when rules overlap", () => {
    const resolver = makeCustomProjectGroupResolver(
      settings({
        sidebarCustomProjectGroups: [
          { ...personal, pathRules: ["/var/www/**"] },
          { ...work, pathRules: ["/var/www/*"] },
        ],
      }),
    );
    expect(resolver.resolve([member("wsl", "/var/www/PimCore")])).toBe("personal");
  });

  it("resolves a row with conflicting manual assignments by its first member", () => {
    const assignments = {
      "windows:C:\\Users\\r.muskietorz\\projects\\web\\shop": "personal",
      "wsl:/home/robmus/projects/web/shop": "work",
    };
    const resolver = makeCustomProjectGroupResolver(
      settings({ sidebarCustomProjectGroupAssignments: assignments }),
    );
    const windows = member("windows", "C:\\Users\\r.muskietorz\\projects\\web\\shop");
    const wsl = member("wsl", "/home/robmus/projects/web/shop");
    expect(resolver.resolve([windows, wsl])).toBe("personal");
    expect(resolver.resolve([wsl, windows])).toBe("work");
  });

  it("falls back to rules when an assignment names a deleted group", () => {
    const resolver = makeCustomProjectGroupResolver(
      settings({ sidebarCustomProjectGroupAssignments: { "wsl:/var/www/PimCore": "gone" } }),
    );
    expect(resolver.resolve([member("wsl", "/var/www/PimCore")])).toBe("work");
    expect(resolver.resolve([member("wsl", "/opt/tool")])).toBeNull();
  });
});

describe("partitionIntoCustomProjectGroups", () => {
  it("keeps the incoming order inside each group and puts ungrouped rows last", () => {
    const rows = [
      member("wsl", "/opt/tool"),
      member("wsl", "/home/robmus/projects/b"),
      member("wsl", "/var/www/PimCore"),
      member("wsl", "/home/robmus/projects/a"),
    ];
    const sections = partitionIntoCustomProjectGroups(rows, (row) => [row], settings());
    expect(
      sections.map((section) => [
        section.group?.id ?? null,
        section.items.map((row) => row.workspaceRoot),
      ]),
    ).toEqual([
      ["work", ["/var/www/PimCore"]],
      ["personal", ["/home/robmus/projects/b", "/home/robmus/projects/a"]],
      [null, ["/opt/tool"]],
    ]);
  });

  it("lists empty groups and ignores a duplicated group id", () => {
    const sections = partitionIntoCustomProjectGroups(
      [],
      () => [],
      settings({ sidebarCustomProjectGroups: [work, personal, { ...work, name: "Copy" }] }),
    );
    expect(sections.map((section) => section.group?.name ?? null)).toEqual([
      "Work",
      "Personal",
      null,
    ]);
  });
});

describe("group edits", () => {
  it("assigns every member of a row and clears them again", () => {
    const keys = ["windows:c:\\p\\shop", "wsl:/p/shop"];
    const assigned = assignCustomProjectGroup({ other: "work" }, keys, "personal");
    expect(assigned).toEqual({ other: "work", [keys[0]!]: "personal", [keys[1]!]: "personal" });
    expect(assignCustomProjectGroup(assigned, keys, null)).toEqual({ other: "work" });
  });

  it("deletes a group together with the assignments pointing at it", () => {
    expect(
      deleteCustomProjectGroup(
        settings({ sidebarCustomProjectGroupAssignments: { a: "work", b: "personal" } }),
        "work",
      ),
    ).toEqual({
      sidebarCustomProjectGroups: [personal],
      sidebarCustomProjectGroupAssignments: { b: "personal" },
    });
  });

  it("moves a group onto another group's position", () => {
    const third = { id: "third", name: "Third", pathRules: [] };
    const ids = (groups: ReadonlyArray<{ id: string }>) => groups.map((group) => group.id);
    expect(ids(moveCustomProjectGroup([work, personal, third], "third", "work"))).toEqual([
      "third",
      "work",
      "personal",
    ]);
    expect(ids(moveCustomProjectGroup([work, personal, third], "work", "third"))).toEqual([
      "personal",
      "third",
      "work",
    ]);
  });
});
