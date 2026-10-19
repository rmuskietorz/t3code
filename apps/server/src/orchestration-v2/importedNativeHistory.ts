import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
} from "@t3tools/contracts";

/**
 * Agent session imports bind their provider thread to the CLI conversation
 * they came from (a strong native ref), so that conversation already holds
 * the imported history. Continuing it with the same provider must resume it
 * natively: a context handoff would repeat the history, and opening a new
 * session under the existing id makes the CLI exit. Older T3 imports carry
 * no native ref and keep the handoff.
 */
export function importedNativeHistoryResumes(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly providerThread:
    | Pick<OrchestrationV2ProviderThread, "nativeThreadRef" | "providerInstanceId">
    | null
    | undefined;
  readonly providerInstanceId: ProviderInstanceId;
}): boolean {
  return (
    input.historyOrigin === "v1_import" &&
    input.providerThread?.nativeThreadRef?.strength === "strong" &&
    input.providerThread.providerInstanceId === input.providerInstanceId
  );
}
