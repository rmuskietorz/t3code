import {
  partitionIntoCustomProjectGroups,
  sortCustomProjectGroupSections,
  UNGROUPED_CUSTOM_PROJECT_GROUP_ID,
  type CustomProjectGroupItemSortOrder,
  type CustomProjectGroupSettings,
} from "@t3tools/client-runtime/state/custom-project-groups";

import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";

/**
 * Sidebar project scope keys are logical project keys; a group scope uses its
 * own prefix so the cleanup that drops unknown project keys leaves it alone.
 */
const CUSTOM_GROUP_SCOPE_PREFIX = "group:";

export function customGroupScopeKey(groupKey: string): string {
  return `${CUSTOM_GROUP_SCOPE_PREFIX}${groupKey}`;
}

export function parseCustomGroupScopeKey(key: string | null): string | null {
  return key?.startsWith(CUSTOM_GROUP_SCOPE_PREFIX)
    ? key.slice(CUSTOM_GROUP_SCOPE_PREFIX.length)
    : null;
}

export interface CustomGroupScopeSection {
  readonly value: string;
  readonly label: string;
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
}

/** Only groups with projects, since filtering by an empty group would show nothing. */
export function buildCustomGroupScopeSections(
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>,
  settings: CustomProjectGroupSettings,
  sortGroupItems: (
    items: ReadonlyArray<SidebarProjectSnapshot>,
    sortOrder: CustomProjectGroupItemSortOrder,
  ) => ReadonlyArray<SidebarProjectSnapshot>,
): ReadonlyArray<CustomGroupScopeSection> {
  return sortCustomProjectGroupSections(
    partitionIntoCustomProjectGroups(projectGroups, (project) => project.memberProjects, settings),
    sortGroupItems,
  ).flatMap((section) =>
    section.items.length === 0
      ? []
      : [
          {
            value: customGroupScopeKey(section.group?.id ?? UNGROUPED_CUSTOM_PROJECT_GROUP_ID),
            label: section.group?.name ?? "Ungrouped",
            projects: section.items,
          },
        ],
  );
}

export interface SidebarProjectScopeItem {
  readonly value: string;
  readonly label: string;
  readonly kind: "all" | "group" | "project";
  /** The group heading a project item sits under. */
  readonly sectionValue: string | null;
}

export function buildSidebarProjectScopeItems(
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>,
  sections: ReadonlyArray<CustomGroupScopeSection> | null,
): ReadonlyArray<SidebarProjectScopeItem> {
  const all: SidebarProjectScopeItem = {
    value: "all",
    label: "All projects",
    kind: "all",
    sectionValue: null,
  };
  const projectItem = (project: SidebarProjectSnapshot, sectionValue: string | null) => ({
    value: project.projectKey,
    label: project.displayName,
    kind: "project" as const,
    sectionValue,
  });
  if (sections === null) {
    return [all, ...projectGroups.map((project) => projectItem(project, null))];
  }
  return [
    all,
    ...sections.flatMap((section) => [
      { value: section.value, label: section.label, kind: "group" as const, sectionValue: null },
      ...section.projects.map((project) => projectItem(project, section.value)),
    ]),
  ];
}

/**
 * Search keeps a group heading while anything under it matches, and a matching
 * heading keeps its whole group. "All projects" only shows without a query.
 */
export function filterGroupedSidebarProjectScopeItems(input: {
  readonly items: ReadonlyArray<SidebarProjectScopeItem>;
  readonly query: string;
  readonly matches: (item: SidebarProjectScopeItem, query: string) => boolean;
}): ReadonlyArray<SidebarProjectScopeItem> {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  const matchingGroups = new Set(
    input.items
      .filter((item) => item.kind === "group" && input.matches(item, query))
      .map((item) => item.value),
  );
  const keptProjects = input.items.filter(
    (item) =>
      item.kind === "project" &&
      ((item.sectionValue !== null && matchingGroups.has(item.sectionValue)) ||
        input.matches(item, query)),
  );
  const groupsWithProjects = new Set(keptProjects.map((item) => item.sectionValue));
  return input.items.filter((item) =>
    item.kind === "group"
      ? matchingGroups.has(item.value) || groupsWithProjects.has(item.value)
      : item.kind === "project" && keptProjects.includes(item),
  );
}

export type CustomGroupScopeResolution =
  | { readonly kind: "none" }
  | { readonly kind: "group"; readonly section: CustomGroupScopeSection }
  /** The stored group scope can no longer show anything, with the reason to tell the user. */
  | { readonly kind: "unavailable"; readonly message: string };

export function resolveCustomGroupScope(input: {
  readonly key: string | null;
  readonly sections: ReadonlyArray<CustomGroupScopeSection> | null;
  readonly settings: CustomProjectGroupSettings;
}): CustomGroupScopeResolution {
  const groupKey = parseCustomGroupScopeKey(input.key);
  if (groupKey === null) return { kind: "none" };
  if (input.sections === null) {
    return { kind: "unavailable", message: "Custom project groups are turned off." };
  }
  const section = input.sections.find((candidate) => candidate.value === input.key);
  if (section) return { kind: "group", section };
  if (groupKey === UNGROUPED_CUSTOM_PROJECT_GROUP_ID) {
    return { kind: "unavailable", message: "Every project now belongs to a group." };
  }
  const group = input.settings.sidebarCustomProjectGroups.find(
    (candidate) => candidate.id === groupKey,
  );
  return {
    kind: "unavailable",
    message: group ? `${group.name} has no projects.` : "The group was deleted.",
  };
}
