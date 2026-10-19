import { describe, expect, it } from "vite-plus/test";

import {
  archiveProjects,
  filterArchivedSidebarProjects,
  isSidebarProjectArchived,
  listArchivedProjects,
  unarchiveProjects,
} from "./archivedProjects";

const member = (environmentId: string, workspaceRoot: string) => ({
  physicalProjectKey: `${environmentId}:${workspaceRoot}`,
  workspaceRoot,
});

const pimcore = {
  displayName: "PimCore",
  memberProjects: [member("wsl", "/var/www/PimCore"), member("vps", "/srv/PimCore")],
};
const tankivo = {
  displayName: "Tankivo",
  memberProjects: [member("wsl", "/home/robmus/projects/mobile/Tankivo")],
};

describe("isSidebarProjectArchived", () => {
  it("needs every member archived, so a newly connected copy stays visible", () => {
    expect(isSidebarProjectArchived(pimcore.memberProjects, { "wsl:/var/www/PimCore": "t" })).toBe(
      false,
    );
    expect(
      isSidebarProjectArchived(pimcore.memberProjects, {
        "wsl:/var/www/PimCore": "t",
        "vps:/srv/PimCore": "t",
      }),
    ).toBe(true);
  });

  it("never treats a row without members as archived", () => {
    expect(isSidebarProjectArchived([], {})).toBe(false);
  });
});

describe("filterArchivedSidebarProjects", () => {
  it("drops only fully archived rows and keeps the order", () => {
    const archived = archiveProjects(
      {},
      pimcore.memberProjects.map((entry) => entry.physicalProjectKey),
      "2026-10-19T10:00:00.000Z",
    );
    expect(
      filterArchivedSidebarProjects(
        [tankivo, pimcore],
        (project) => project.memberProjects,
        archived,
      ),
    ).toEqual([tankivo]);
  });
});

describe("archiveProjects / unarchiveProjects", () => {
  it("keeps the first archive time and removes keys on unarchive", () => {
    const first = archiveProjects({}, ["wsl:/a"], "2026-10-01T00:00:00.000Z");
    const again = archiveProjects(first, ["wsl:/a", "wsl:/b"], "2026-10-19T00:00:00.000Z");
    expect(again).toEqual({
      "wsl:/a": "2026-10-01T00:00:00.000Z",
      "wsl:/b": "2026-10-19T00:00:00.000Z",
    });
    expect(unarchiveProjects(again, ["wsl:/a"])).toEqual({ "wsl:/b": "2026-10-19T00:00:00.000Z" });
    expect(first).toEqual({ "wsl:/a": "2026-10-01T00:00:00.000Z" });
  });
});

describe("listArchivedProjects", () => {
  it("lists archived rows, partly archived members, and keys of missing projects", () => {
    const entries = listArchivedProjects([pimcore, tankivo], {
      "wsl:/home/robmus/projects/mobile/Tankivo": "2026-10-10T00:00:00.000Z",
      "wsl:/var/www/PimCore": "2026-10-12T00:00:00.000Z",
      "offline:/srv/gone": "2026-10-15T00:00:00.000Z",
    });
    expect(entries).toEqual([
      {
        physicalProjectKeys: ["offline:/srv/gone"],
        name: null,
        path: "offline:/srv/gone",
        archivedAt: "2026-10-15T00:00:00.000Z",
      },
      {
        physicalProjectKeys: ["wsl:/var/www/PimCore"],
        name: "PimCore",
        path: "/var/www/PimCore",
        archivedAt: "2026-10-12T00:00:00.000Z",
      },
      {
        physicalProjectKeys: ["wsl:/home/robmus/projects/mobile/Tankivo"],
        name: "Tankivo",
        path: "/home/robmus/projects/mobile/Tankivo",
        archivedAt: "2026-10-10T00:00:00.000Z",
      },
    ]);
  });

  it("merges a fully archived row into one entry with its latest archive time", () => {
    const entries = listArchivedProjects([pimcore], {
      "wsl:/var/www/PimCore": "2026-10-01T00:00:00.000Z",
      "vps:/srv/PimCore": "2026-10-05T00:00:00.000Z",
    });
    expect(entries).toEqual([
      {
        physicalProjectKeys: ["wsl:/var/www/PimCore", "vps:/srv/PimCore"],
        name: "PimCore",
        path: "/var/www/PimCore",
        archivedAt: "2026-10-05T00:00:00.000Z",
      },
    ]);
  });
});
