import {
  assignCustomProjectGroup,
  deleteCustomProjectGroup,
  moveCustomProjectGroup,
} from "@t3tools/client-runtime/state/custom-project-groups";
import type {
  SidebarCustomProjectGroup,
  SidebarCustomProjectGroupId,
  SidebarCustomProjectGroupSortOrder,
} from "@t3tools/contracts/settings";
import { useMemo } from "react";

import { randomUUID } from "~/lib/utils";

import { getClientSettings, useClientSettings, useUpdateClientSettings } from "./useSettings";

export function useCustomProjectGroupsEnabled(): boolean {
  return useClientSettings((settings) => settings.sidebarCustomProjectGroupsEnabled);
}

export function useCustomProjectGroups(): ReadonlyArray<SidebarCustomProjectGroup> {
  return useClientSettings((settings) => settings.sidebarCustomProjectGroups);
}

/**
 * Group edits shared by the sidebar, settings, and command palette. Each edit
 * reads the latest settings so quick successive edits never apply to a stale copy.
 */
export function useCustomProjectGroupActions() {
  const updateSettings = useUpdateClientSettings();
  return useMemo(() => {
    const groups = () => getClientSettings().sidebarCustomProjectGroups;
    const updateGroup = (
      groupId: SidebarCustomProjectGroupId,
      update: (group: SidebarCustomProjectGroup) => SidebarCustomProjectGroup,
    ) =>
      updateSettings({
        sidebarCustomProjectGroups: groups().map((group) =>
          group.id === groupId ? update(group) : group,
        ),
      });
    return {
      createGroup: (name: string): SidebarCustomProjectGroupId => {
        const id = randomUUID();
        void updateSettings({
          sidebarCustomProjectGroups: [...groups(), { id, name, pathRules: [] }],
        });
        return id;
      },
      renameGroup: (groupId: SidebarCustomProjectGroupId, name: string) =>
        updateGroup(groupId, (group) => ({ ...group, name })),
      setPathRules: (groupId: SidebarCustomProjectGroupId, pathRules: ReadonlyArray<string>) =>
        updateGroup(groupId, (group) => ({ ...group, pathRules })),
      setProjectSortOrder: (
        groupId: SidebarCustomProjectGroupId,
        projectSortOrder: SidebarCustomProjectGroupSortOrder,
      ) => updateGroup(groupId, (group) => ({ ...group, projectSortOrder })),
      deleteGroup: (groupId: SidebarCustomProjectGroupId) =>
        updateSettings(deleteCustomProjectGroup(getClientSettings(), groupId)),
      moveGroup: (
        groupId: SidebarCustomProjectGroupId,
        targetGroupId: SidebarCustomProjectGroupId,
      ) =>
        updateSettings({
          sidebarCustomProjectGroups: moveCustomProjectGroup(groups(), groupId, targetGroupId),
        }),
      moveGroupBy: (groupId: SidebarCustomProjectGroupId, offset: -1 | 1) => {
        const current = groups();
        const target = current[current.findIndex((group) => group.id === groupId) + offset];
        if (!target) return;
        void updateSettings({
          sidebarCustomProjectGroups: moveCustomProjectGroup(current, groupId, target.id),
        });
      },
      assignProjects: (
        physicalProjectKeys: ReadonlyArray<string>,
        groupId: SidebarCustomProjectGroupId | null,
      ) =>
        updateSettings({
          sidebarCustomProjectGroupAssignments: assignCustomProjectGroup(
            getClientSettings().sidebarCustomProjectGroupAssignments,
            physicalProjectKeys,
            groupId,
          ),
        }),
    };
  }, [updateSettings]);
}
