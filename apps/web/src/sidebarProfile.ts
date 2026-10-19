import {
  makeCustomProjectGroupResolver,
  UNGROUPED_CUSTOM_PROJECT_GROUP_ID,
  type CustomProjectGroupMember,
  type CustomProjectGroupSettings,
} from "@t3tools/client-runtime/state/custom-project-groups";
import type {
  SidebarCustomProjectGroup,
  SidebarCustomProjectGroupId,
} from "@t3tools/contracts/settings";
import { useMemo } from "react";
import { create } from "zustand";

import {
  useCustomProjectGroups,
  useCustomProjectGroupsEnabled,
} from "./hooks/useCustomProjectGroups";

export const ALL_SIDEBAR_PROFILE_KEY = "all";

// Session storage is per tab and per Electron pane, so each window keeps its
// own profile; the local copy only seeds windows that have none yet.
const SESSION_PROFILE_KEY = "t3code:sidebar-profile:v1";
const LAST_PROFILE_KEY = "t3code:sidebar-profile-last:v1";

export interface SidebarProfileOption {
  readonly key: string;
  readonly label: string;
}

/** A profile narrows the sidebar to one custom group, or to the Ungrouped bucket. */
export interface SidebarProfile extends SidebarProfileOption {
  /** `null` is the Ungrouped bucket. */
  readonly groupId: SidebarCustomProjectGroupId | null;
}

export function buildSidebarProfileOptions(input: {
  readonly enabled: boolean;
  readonly groups: ReadonlyArray<SidebarCustomProjectGroup>;
}): ReadonlyArray<SidebarProfileOption> | null {
  if (!input.enabled) return null;
  return [
    { key: ALL_SIDEBAR_PROFILE_KEY, label: "All projects" },
    ...input.groups.map((group) => ({ key: group.id, label: group.name })),
    { key: UNGROUPED_CUSTOM_PROJECT_GROUP_ID, label: "Ungrouped" },
  ];
}

/** `null` shows all projects, including when the stored group no longer exists. */
export function resolveSidebarProfile(input: {
  readonly key: string;
  readonly enabled: boolean;
  readonly groups: ReadonlyArray<SidebarCustomProjectGroup>;
}): SidebarProfile | null {
  if (!input.enabled) return null;
  if (input.key === UNGROUPED_CUSTOM_PROJECT_GROUP_ID) {
    return { key: input.key, label: "Ungrouped", groupId: null };
  }
  const group = input.groups.find((candidate) => candidate.id === input.key);
  return group ? { key: group.id, label: group.name, groupId: group.id } : null;
}

/** Uses the same resolver as the group sections, so a row shows in its section's profile. */
export function filterToSidebarProfile<Item>(
  items: ReadonlyArray<Item>,
  getMembers: (item: Item) => ReadonlyArray<CustomProjectGroupMember>,
  profile: SidebarProfile | null,
  settings: CustomProjectGroupSettings,
): ReadonlyArray<Item> {
  if (profile === null) return items;
  const resolver = makeCustomProjectGroupResolver(settings);
  return items.filter((item) => resolver.resolve(getMembers(item)) === profile.groupId);
}

type ProfileStorage = Pick<Storage, "getItem" | "setItem">;

export function readInitialSidebarProfileKey(
  session: ProfileStorage | null,
  local: ProfileStorage | null,
): string {
  return (
    session?.getItem(SESSION_PROFILE_KEY) ??
    local?.getItem(LAST_PROFILE_KEY) ??
    ALL_SIDEBAR_PROFILE_KEY
  );
}

function browserStorage(kind: "sessionStorage" | "localStorage"): ProfileStorage | null {
  try {
    return typeof window === "undefined" ? null : window[kind];
  } catch {
    // Blocked storage throws on access; the profile then lasts for this page only.
    return null;
  }
}

function writeProfileKey(storage: ProfileStorage | null, name: string, key: string) {
  try {
    storage?.setItem(name, key);
  } catch {
    // A full or blocked storage keeps the choice for this page only.
    return;
  }
}

interface SidebarProfileStore {
  readonly key: string;
  readonly setKey: (key: string) => void;
}

const useSidebarProfileStore = create<SidebarProfileStore>((set) => ({
  key: readInitialSidebarProfileKey(
    browserStorage("sessionStorage"),
    browserStorage("localStorage"),
  ),
  setKey: (key) => {
    writeProfileKey(browserStorage("sessionStorage"), SESSION_PROFILE_KEY, key);
    writeProfileKey(browserStorage("localStorage"), LAST_PROFILE_KEY, key);
    set({ key });
  },
}));

export function useSidebarProfile() {
  const enabled = useCustomProjectGroupsEnabled();
  const groups = useCustomProjectGroups();
  const key = useSidebarProfileStore((store) => store.key);
  const setProfileKey = useSidebarProfileStore((store) => store.setKey);
  return useMemo(
    () => ({
      profile: resolveSidebarProfile({ key, enabled, groups }),
      options: buildSidebarProfileOptions({ enabled, groups }),
      setProfileKey,
    }),
    [enabled, groups, key, setProfileKey],
  );
}
