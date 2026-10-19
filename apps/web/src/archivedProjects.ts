import type { CustomProjectGroupMember } from "@t3tools/client-runtime/state/custom-project-groups";
import type { ClientSettings } from "@t3tools/contracts/settings";

export type ArchivedProjects = ClientSettings["sidebarArchivedProjects"];

/**
 * A sidebar row can merge projects from several environments; it only counts
 * as archived while every member is, so a newly connected copy stays visible.
 */
export function isSidebarProjectArchived(
  members: ReadonlyArray<Pick<CustomProjectGroupMember, "physicalProjectKey">>,
  archived: ArchivedProjects,
): boolean {
  return (
    members.length > 0 && members.every((member) => archived[member.physicalProjectKey] != null)
  );
}

export function filterArchivedSidebarProjects<Item>(
  items: ReadonlyArray<Item>,
  getMembers: (item: Item) => ReadonlyArray<Pick<CustomProjectGroupMember, "physicalProjectKey">>,
  archived: ArchivedProjects,
): ReadonlyArray<Item> {
  if (Object.keys(archived).length === 0) return items;
  return items.filter((item) => !isSidebarProjectArchived(getMembers(item), archived));
}

/** Keeps an earlier archive time so re-archiving a row does not reorder the settings list. */
export function archiveProjects(
  archived: ArchivedProjects,
  physicalProjectKeys: ReadonlyArray<string>,
  archivedAt: string,
): ArchivedProjects {
  const next = { ...archived };
  for (const key of physicalProjectKeys) next[key] ??= archivedAt;
  return next;
}

export function unarchiveProjects(
  archived: ArchivedProjects,
  physicalProjectKeys: ReadonlyArray<string>,
): ArchivedProjects {
  const next = { ...archived };
  for (const key of physicalProjectKeys) delete next[key];
  return next;
}

export interface ArchivedProjectEntry {
  readonly physicalProjectKeys: ReadonlyArray<string>;
  /** `null` when no connected environment currently has the project. */
  readonly name: string | null;
  readonly path: string;
  readonly archivedAt: string;
}

/**
 * Fully archived rows become one entry. Keys left over, from projects that are
 * not loaded or rows only partly archived, get an entry each so they can still
 * be unarchived. Most recently archived first.
 */
export function listArchivedProjects(
  projects: ReadonlyArray<{
    readonly displayName: string;
    readonly memberProjects: ReadonlyArray<CustomProjectGroupMember>;
  }>,
  archived: ArchivedProjects,
): ReadonlyArray<ArchivedProjectEntry> {
  const entries: ArchivedProjectEntry[] = [];
  const listed = new Set<string>();
  for (const project of projects) {
    if (!isSidebarProjectArchived(project.memberProjects, archived)) continue;
    const keys = project.memberProjects.map((member) => member.physicalProjectKey);
    for (const key of keys) listed.add(key);
    entries.push({
      physicalProjectKeys: keys,
      name: project.displayName,
      path: project.memberProjects[0]!.workspaceRoot,
      archivedAt: keys
        .map((key) => archived[key]!)
        .reduce((latest, value) => (value > latest ? value : latest)),
    });
  }
  const memberByKey = new Map(
    projects.flatMap((project) =>
      project.memberProjects.map((member) => [member.physicalProjectKey, { project, member }]),
    ),
  );
  for (const [key, archivedAt] of Object.entries(archived)) {
    if (listed.has(key)) continue;
    const known = memberByKey.get(key);
    entries.push({
      physicalProjectKeys: [key],
      name: known?.project.displayName ?? null,
      path: known?.member.workspaceRoot ?? key,
      archivedAt,
    });
  }
  return entries.toSorted((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}
