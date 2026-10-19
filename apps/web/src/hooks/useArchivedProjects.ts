import { useMemo } from "react";

import { archiveProjects, unarchiveProjects, type ArchivedProjects } from "../archivedProjects";
import { getClientSettings, useClientSettings, useUpdateClientSettings } from "./useSettings";

export function useArchivedProjects(): ArchivedProjects {
  return useClientSettings((settings) => settings.sidebarArchivedProjects);
}

/** Each edit reads the latest settings so quick successive edits never apply to a stale copy. */
export function useArchivedProjectActions() {
  const updateSettings = useUpdateClientSettings();
  return useMemo(
    () => ({
      archive: (physicalProjectKeys: ReadonlyArray<string>) =>
        updateSettings({
          sidebarArchivedProjects: archiveProjects(
            getClientSettings().sidebarArchivedProjects,
            physicalProjectKeys,
            new Date().toISOString(),
          ),
        }),
      unarchive: (physicalProjectKeys: ReadonlyArray<string>) =>
        updateSettings({
          sidebarArchivedProjects: unarchiveProjects(
            getClientSettings().sidebarArchivedProjects,
            physicalProjectKeys,
          ),
        }),
    }),
    [updateSettings],
  );
}
