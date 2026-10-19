import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);
const transcriptPath = "/tmp/native-codex-thread.jsonl";

const importableOutcome: AgentSessionScanner.AgentSessionRecentThread = {
  _tag: "Importable",
  source: {
    provider: "codex",
    providerInstanceId,
    providerSessionId,
    filePath: transcriptPath,
    size: 100,
    mtimeMs: 2,
    device: 3,
    inode: 4,
    birthtimeMs: 1,
  },
  thread: {
    source: "codex",
    providerInstanceId,
    providerSessionId,
    title: "Imported thread",
    model: "gpt-5.4",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:01:00.000Z",
    messages: [
      { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
      { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
    ],
  },
};

type RecentThreadsOptions = Parameters<
  AgentSessionScanner.AgentSessionScanner["Service"]["recentThreads"]
>[2];

const makeImporterTest = (
  input: {
    readonly providerThreadOwner?: ThreadId;
    /** Whether T3 already ran turns on the imported thread. */
    readonly continuedInT3?: boolean;
  } = {},
) => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  const scanOptions: Array<{
    readonly quietPeriodMs: number | undefined;
    readonly excluded: Array<string>;
  }> = [];
  let refreshCount = 0;
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    refreshCandidates: Effect.sync(() => void (refreshCount += 1)),
    recentThreads: (_workspaceRoot, _completed, options: RecentThreadsOptions) => {
      const excluded = [...(options?.excludedTranscripts ?? [])];
      scanOptions.push({ quietPeriodMs: options?.quietPeriodMs, excluded });
      return excluded.some((key) => key.endsWith(transcriptPath))
        ? Stream.empty
        : Stream.succeed(importableOutcome);
    },
  });
  const layer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
          listShells: () =>
            Effect.succeed([{ id: projectId, workspaceRoot: "/workspace/project" } as never]),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                  runs: (input.continuedInT3 ?? true) ? [{ id: "run-1" }] : [],
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getProviderThreadOwner: () =>
            Effect.succeed(Option.fromUndefinedOr(input.providerThreadOwner)),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );
  return { layer, writes, upserts, recorded, scanOptions, refreshCount: () => refreshCount };
};

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const { layer, writes, upserts, recorded } = makeImporterTest();

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layer));
});

it.effect("refreshes an imported thread the terminal continued while T3 has not", () => {
  const { layer, writes } = makeImporterTest({ continuedInT3: false });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importRecentAgentThreads({ projectId });
    yield* importer.importRecentAgentThreads({ projectId });

    expect(writes).toHaveLength(2);
    const refresh = writes[1]!;
    expect(refresh.map((event) => event.type)).toEqual([
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
    ]);
    // Same messages under new event ids: the refresh updates rather than duplicates them.
    const updatedIds = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      events.flatMap((event) =>
        event.type === "message.updated" || event.type === "turn-item.updated"
          ? [event.payload.id]
          : [],
      );
    expect(updatedIds(refresh)).toEqual(updatedIds(writes[0]!));
    expect(new Set([...writes[0]!, ...refresh].map((event) => event.id)).size).toBe(
      writes[0]!.length + refresh.length,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("leaves a session alone when another thread already owns its provider thread", () => {
  const { layer, writes, recorded, scanOptions } = makeImporterTest({
    providerThreadOwner: ThreadId.make("thread-started-in-t3"),
  });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    yield* importer.importRecentAgentThreads({ projectId });

    expect(writes).toEqual([]);
    expect(recorded).toEqual([]);
    expect(scanOptions.map((options) => options.excluded)).toEqual([
      [],
      [`${providerInstanceId}\0${transcriptPath}`],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("re-imports every project and counts only the threads it created", () => {
  const { layer, writes, scanOptions, refreshCount } = makeImporterTest();

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importAllProjects({ quietPeriodMs: 600_000 })).toEqual({
      projectCount: 1,
      createdCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importAllProjects({ quietPeriodMs: 600_000 })).toEqual({
      projectCount: 1,
      createdCount: 0,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(refreshCount()).toBe(2);
    expect(scanOptions.map((options) => options.quietPeriodMs)).toEqual([600_000, 600_000]);
  }).pipe(Effect.provide(layer));
});
