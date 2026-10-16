import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { agentSessionImportAll } from "../state/agentSessions";
import type { EnvironmentPresentation } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

/** Re-imports Claude and Codex sessions on every given environment that supports it. */
export function useAgentSessionReimport(environments: ReadonlyArray<EnvironmentPresentation>) {
  const [pending, setPending] = useState(false);
  const run = useAtomCommand(agentSessionImportAll);
  const supported = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          environment.serverConfig?.environment.capabilities.agentSessionImportAll === true,
      ),
    [environments],
  );
  const allowedIds = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          supported.flatMap((environment) =>
            get(agentSessionImportAll.permissionAtom(environment.environmentId))
              ? [environment.environmentId]
              : [],
          ),
        ),
      [supported],
    ),
  );

  const reimport = async () => {
    if (pending) return;
    setPending(true);
    try {
      const results = await Promise.all(
        supported
          .filter((environment) => allowedIds.includes(environment.environmentId))
          .map(async (environment) => {
            const result = await run({ environmentId: environment.environmentId, input: {} });
            if (result._tag === "Success") return result.value.createdCount;
            if (!isAtomCommandInterrupted(result)) {
              toastManager.add({
                type: "error",
                title: `Could not import sessions on ${environment.label}`,
                description: String(squashAtomCommandFailure(result)),
              });
            }
            return null;
          }),
      );
      const succeeded = results.filter((count) => count !== null);
      if (succeeded.length === 0) return;
      const created = succeeded.reduce((sum, count) => sum + count, 0);
      toastManager.add({
        type: "success",
        title:
          created === 0
            ? "No new sessions"
            : `Imported ${created} new ${created === 1 ? "session" : "sessions"}`,
      });
    } finally {
      setPending(false);
    }
  };

  return {
    supported: supported.length > 0,
    allowed: allowedIds.length > 0,
    pending,
    reimport,
  };
}
