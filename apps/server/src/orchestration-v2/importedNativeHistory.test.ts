import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { importedNativeHistoryResumes } from "./importedNativeHistory.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const importedThread = {
  nativeThreadRef: { driver: "claudeAgent", nativeId: "62b60885", strength: "strong" },
  providerInstanceId: claude,
} as const;

it("resumes an agent session import with the provider it came from", () => {
  assert.isTrue(
    importedNativeHistoryResumes({
      historyOrigin: "v1_import",
      providerThread: importedThread as never,
      providerInstanceId: claude,
    }),
  );
});

it("keeps the handoff for other providers, older imports, and native threads", () => {
  assert.isFalse(
    importedNativeHistoryResumes({
      historyOrigin: "v1_import",
      providerThread: importedThread as never,
      providerInstanceId: codex,
    }),
  );
  assert.isFalse(
    importedNativeHistoryResumes({
      historyOrigin: "v1_import",
      providerThread: { nativeThreadRef: null, providerInstanceId: claude },
      providerInstanceId: claude,
    }),
  );
  assert.isFalse(
    importedNativeHistoryResumes({
      historyOrigin: "native",
      providerThread: importedThread as never,
      providerInstanceId: claude,
    }),
  );
  assert.isFalse(
    importedNativeHistoryResumes({
      historyOrigin: "v1_import",
      providerThread: undefined,
      providerInstanceId: claude,
    }),
  );
});
