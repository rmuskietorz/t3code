import type {
  ClientSettings,
  SidebarCustomProjectGroup,
  SidebarCustomProjectGroupId,
  SidebarCustomProjectGroupSortOrder,
  SidebarProjectSortOrder,
} from "@t3tools/contracts/settings";
import { isUncPath, isWindowsDrivePath } from "@t3tools/shared/path";

import { normalizeProjectPathForComparison } from "./projects.ts";

/**
 * Assignment value that keeps a project out of every group even when a path
 * rule matches it; stored group ids are random UUIDs, so it cannot collide.
 */
export const UNGROUPED_CUSTOM_PROJECT_GROUP_ID = "ungrouped";

export type CustomProjectGroupSettings = Pick<
  ClientSettings,
  "sidebarCustomProjectGroups" | "sidebarCustomProjectGroupAssignments"
>;

/** One project behind a sidebar row; a row can merge several across environments. */
export interface CustomProjectGroupMember {
  readonly physicalProjectKey: string;
  readonly workspaceRoot: string;
}

export interface CustomProjectGroupSection<Item> {
  /** `null` is the trailing "Ungrouped" section. */
  readonly group: SidebarCustomProjectGroup | null;
  readonly items: ReadonlyArray<Item>;
}

const isWindowsPath = (path: string) => isWindowsDrivePath(path) || isUncPath(path);

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a path rule into a matcher over normalized project paths. `*` stays
 * inside one path segment and `**` crosses segments. Rules normalize like
 * project paths, so Windows rules ignore case and slash direction while POSIX
 * rules stay case-sensitive.
 */
export function compileCustomProjectGroupPathRule(rule: string): (path: string) => boolean {
  const normalizedRule = normalizeProjectPathForComparison(rule);
  const windows = isWindowsPath(normalizedRule);
  const separator = windows ? "\\" : "/";
  const segment = windows ? "[^\\\\]" : "[^/]";
  let pattern = "";
  for (let index = 0; index < normalizedRule.length; index += 1) {
    const char = normalizedRule[index]!;
    if (char === "*" && normalizedRule[index + 1] === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += `${segment}*`;
    } else if (char === "?") {
      pattern += segment;
    } else {
      pattern += escapeRegExp(char);
    }
  }
  const regExp = new RegExp(`^${pattern}$`);
  // `/var/www/**` also covers `/var/www` itself.
  const coveredFolder = normalizedRule.endsWith(`${separator}**`)
    ? normalizedRule.slice(0, -(separator.length + 2))
    : null;
  return (path) => {
    const normalizedPath = normalizeProjectPathForComparison(path);
    if (isWindowsPath(normalizedPath) !== windows) return false;
    return regExp.test(normalizedPath) || normalizedPath === coveredFolder;
  };
}

export interface CustomProjectGroupResolver {
  readonly resolve: (
    members: ReadonlyArray<CustomProjectGroupMember>,
  ) => SidebarCustomProjectGroupId | null;
}

/**
 * The first member in the given order with a manual assignment decides, so a
 * row whose members were assigned to different groups still lands in exactly
 * one. Without one, the first group in sidebar order with a matching rule wins.
 */
export function makeCustomProjectGroupResolver(
  settings: CustomProjectGroupSettings,
): CustomProjectGroupResolver {
  const groupIds = new Set(settings.sidebarCustomProjectGroups.map((group) => group.id));
  const rules = settings.sidebarCustomProjectGroups.flatMap((group) =>
    group.pathRules.map((rule) => ({
      groupId: group.id,
      matches: compileCustomProjectGroupPathRule(rule),
    })),
  );
  return {
    resolve: (members) => {
      for (const member of members) {
        const assigned = settings.sidebarCustomProjectGroupAssignments[member.physicalProjectKey];
        if (assigned === UNGROUPED_CUSTOM_PROJECT_GROUP_ID) return null;
        if (assigned !== undefined && groupIds.has(assigned)) return assigned;
      }
      for (const rule of rules) {
        if (members.some((member) => rule.matches(member.workspaceRoot))) return rule.groupId;
      }
      return null;
    },
  };
}

/**
 * Splits already sorted rows into group sections without reordering them, so
 * repository grouping and manual order keep applying inside each group. Every
 * group gets a section, including empty ones that rows can be dropped into.
 */
export function partitionIntoCustomProjectGroups<Item>(
  items: ReadonlyArray<Item>,
  getMembers: (item: Item) => ReadonlyArray<CustomProjectGroupMember>,
  settings: CustomProjectGroupSettings,
): ReadonlyArray<CustomProjectGroupSection<Item>> {
  const resolver = makeCustomProjectGroupResolver(settings);
  const itemsByGroup = new Map<SidebarCustomProjectGroupId | null, Item[]>();
  for (const item of items) {
    const groupId = resolver.resolve(getMembers(item));
    const bucket = itemsByGroup.get(groupId);
    if (bucket) bucket.push(item);
    else itemsByGroup.set(groupId, [item]);
  }
  const seen = new Set<SidebarCustomProjectGroupId>();
  const sections: Array<CustomProjectGroupSection<Item>> = [];
  for (const group of settings.sidebarCustomProjectGroups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    sections.push({ group, items: itemsByGroup.get(group.id) ?? [] });
  }
  sections.push({ group: null, items: itemsByGroup.get(null) ?? [] });
  return sections;
}

export type CustomProjectGroupItemSortOrder = Exclude<
  SidebarCustomProjectGroupSortOrder,
  "inherit"
>;

/** The order a section's rows actually follow; "Ungrouped" always follows the global order. */
export function resolveCustomProjectGroupSortOrder(
  group: SidebarCustomProjectGroup | null,
  globalSortOrder: SidebarProjectSortOrder,
): SidebarProjectSortOrder | CustomProjectGroupItemSortOrder {
  const own = group?.projectSortOrder ?? "inherit";
  return own === "inherit" ? globalSortOrder : own;
}

/**
 * Re-sorts the rows of groups with their own sort order. Inheriting groups and
 * "Ungrouped" keep the globally sorted order they were partitioned in.
 */
export function sortCustomProjectGroupSections<Item>(
  sections: ReadonlyArray<CustomProjectGroupSection<Item>>,
  sortItems: (
    items: ReadonlyArray<Item>,
    sortOrder: CustomProjectGroupItemSortOrder,
  ) => ReadonlyArray<Item>,
): ReadonlyArray<CustomProjectGroupSection<Item>> {
  return sections.map((section) => {
    const sortOrder = section.group?.projectSortOrder ?? "inherit";
    return sortOrder === "inherit" || section.items.length < 2
      ? section
      : { group: section.group, items: sortItems(section.items, sortOrder) };
  });
}

/**
 * Assigns every member of a row; `null` returns the row to its path rules and
 * `UNGROUPED_CUSTOM_PROJECT_GROUP_ID` pins it to "Ungrouped".
 */
export function assignCustomProjectGroup(
  assignments: CustomProjectGroupSettings["sidebarCustomProjectGroupAssignments"],
  physicalProjectKeys: ReadonlyArray<string>,
  groupId: SidebarCustomProjectGroupId | null,
): CustomProjectGroupSettings["sidebarCustomProjectGroupAssignments"] {
  const next = { ...assignments };
  for (const key of physicalProjectKeys) {
    if (groupId === null) delete next[key];
    else next[key] = groupId;
  }
  return next;
}

/** Removes a group and the assignments that point at it. */
export function deleteCustomProjectGroup(
  settings: CustomProjectGroupSettings,
  groupId: SidebarCustomProjectGroupId,
): CustomProjectGroupSettings {
  return {
    sidebarCustomProjectGroups: settings.sidebarCustomProjectGroups.filter(
      (group) => group.id !== groupId,
    ),
    sidebarCustomProjectGroupAssignments: Object.fromEntries(
      Object.entries(settings.sidebarCustomProjectGroupAssignments).filter(
        ([, assigned]) => assigned !== groupId,
      ),
    ),
  };
}

/** Moves a group to the position of another, as a drag onto that group's header does. */
export function moveCustomProjectGroup(
  groups: ReadonlyArray<SidebarCustomProjectGroup>,
  groupId: SidebarCustomProjectGroupId,
  targetGroupId: SidebarCustomProjectGroupId,
): ReadonlyArray<SidebarCustomProjectGroup> {
  const from = groups.findIndex((group) => group.id === groupId);
  const to = groups.findIndex((group) => group.id === targetGroupId);
  if (from === -1 || to === -1 || from === to) return groups;
  const next = [...groups];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
