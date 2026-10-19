import { describe, expect, it } from "vite-plus/test";

import {
  buildCustomProjectGroupContextMenuItems,
  parseCustomProjectGroupSortMenuId,
} from "./customProjectGroupSort";

describe("custom project group sort menu", () => {
  it("checks the group's current order and names the inherited global order", () => {
    const items = buildCustomProjectGroupContextMenuItems(
      { id: "work", name: "Work", pathRules: [], projectSortOrder: "name" },
      "manual",
    );
    const submenu = items.find((item) => item.label === "Sort projects")?.children ?? [];
    expect(submenu.map((item) => [item.label, item.checked === true])).toEqual([
      ["Sidebar default (Manual)", false],
      ["Manual", false],
      ["Name", true],
      ["Recent activity", false],
    ]);
    expect(submenu.map((item) => parseCustomProjectGroupSortMenuId(item.id))).toEqual([
      "inherit",
      "manual",
      "name",
      "updated_at",
    ]);
  });

  it("treats a group without a stored order as inheriting", () => {
    const items = buildCustomProjectGroupContextMenuItems(
      { id: "work", name: "Work", pathRules: [] },
      "updated_at",
    );
    const checked = items.flatMap((item) => item.children ?? []).find((item) => item.checked);
    expect(checked?.label).toBe("Sidebar default (Last user message)");
  });

  it("ignores ids that are not sort choices", () => {
    expect(parseCustomProjectGroupSortMenuId("rename")).toBeNull();
    expect(parseCustomProjectGroupSortMenuId("sort-projects:submenu")).toBeNull();
    expect(parseCustomProjectGroupSortMenuId(null)).toBeNull();
  });
});
