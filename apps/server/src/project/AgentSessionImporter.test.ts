import { expect, it } from "@effect/vitest";
import {
  AgentSessionReloadError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
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
    /** Status of that T3 run; a reload from the session marks it rolled back. */
    readonly runStatus?: string;
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
    readImportedTranscript: () => Effect.die("unused"),
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
                  runs:
                    (input.continuedInT3 ?? true)
                      ? [{ id: "run-1", status: input.runStatus ?? "completed" }]
                      : [],
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
        Layer.mock(EventStore.EventStoreV2)({
          latestSequence: () => Effect.sync(() => writes.flat().length),
          read: () =>
            Stream.fromIterable(
              writes
                .flat()
                .slice(-1)
                .map((event) => ({ sequence: 0, commandId: null, event })),
            ),
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
    // The second run re-ensures the row, which the repository ignores on conflict.
    const runtimeRow = expect.objectContaining({
      threadId,
      providerInstanceId,
      resumeCursor: { threadId: providerSessionId },
    });
    expect(upserts).toEqual([runtimeRow, runtimeRow]);
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

it.effect("does not write a refresh again when it landed but was never recorded", () => {
  const { layer, writes, upserts } = makeImporterTest({ continuedInT3: false });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    // The scanner keeps offering the unchanged transcript, as it does for a
    // thread carried over from another install without a runtime row.
    yield* importer.importRecentAgentThreads({ projectId });
    yield* importer.importRecentAgentThreads({ projectId });
    yield* importer.importRecentAgentThreads({ projectId });

    expect(writes).toHaveLength(2);
    expect(upserts).toHaveLength(3);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps refreshing from the terminal after a reload hid the T3 runs", () => {
  const { layer, writes } = makeImporterTest({ runStatus: "rolled_back" });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importRecentAgentThreads({ projectId });
    yield* importer.importRecentAgentThreads({ projectId });
    expect(writes).toHaveLength(2);
  }).pipe(Effect.provide(layer));
});

it.effect("stops refreshing once T3 ran a turn on the imported thread", () => {
  const { layer, writes } = makeImporterTest({ runStatus: "completed" });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importRecentAgentThreads({ projectId });
    yield* importer.importRecentAgentThreads({ projectId });
    expect(writes).toHaveLength(1);
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

const grownMessages = [
  ...importableOutcome.thread.messages,
  { role: "user" as const, text: "Continue in T3", createdAt: "2026-09-01T10:02:00.000Z" },
  { role: "assistant" as const, text: "Continued", createdAt: "2026-09-01T10:03:00.000Z" },
];

const makeReloadTest = (
  input: {
    readonly historyOrigin?: "v1_import" | "native";
    readonly runStatus?: string;
    readonly recorded?: boolean;
    readonly transcript?: AgentSessionScanner.AgentSessionTranscriptRead;
  } = {},
) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const recorded: Array<unknown> = [];
  const grownSource = { ...importableOutcome.source, size: 400, mtimeMs: 9 };
  const layer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AgentSessionScanner.AgentSessionScanner)({
          readImportedTranscript: () =>
            Effect.succeed(
              input.transcript ?? {
                _tag: "Read",
                thread: { ...importableOutcome.thread, messages: grownMessages },
                source: grownSource,
              },
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: threadId,
                projectId,
                historyOrigin: input.historyOrigin ?? "v1_import",
                activeProviderThreadId: "provider-thread-1",
                modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
                deletedAt: null,
              },
              runs: [{ id: "run-1", status: input.runStatus ?? "completed" }],
              providerThreads: [
                {
                  id: "provider-thread-1",
                  providerInstanceId,
                  status: "idle",
                  nativeThreadRef: {
                    driver: "codex",
                    nativeId: providerSessionId,
                    strength: "strong",
                  },
                },
              ],
            } as never),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              return [];
            }),
        }),
        Layer.mock(EventStore.EventStoreV2)({}),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          getByThreadId: () =>
            Effect.succeed(
              (input.recorded ?? true)
                ? Option.some({
                    runtimePayload: {
                      cwd: "/workspace/project",
                      importedTranscripts: [importableOutcome.source],
                    },
                  } as never)
                : Option.none(),
            ),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );
  return { layer, dispatched, writes, recorded, grownSource };
};

it.effect("reloads a thread continued in T3 from its session transcript", () => {
  const { layer, dispatched, writes, recorded, grownSource } = makeReloadTest();

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.reloadImportedThread({ threadId })).toEqual({ messageCount: 4 });

    expect(dispatched).toEqual([
      expect.objectContaining({ type: "thread.history.reload-from-native", threadId }),
    ]);
    expect(writes).toHaveLength(1);
    const messages = writes[0]!.flatMap((event) =>
      event.type === "message.updated" ? [event.payload] : [],
    );
    expect(messages.map((message) => message.text)).toEqual(grownMessages.map((m) => m.text));
    // Positional ids, so the reload overwrites the imported messages in place.
    expect(messages[0]?.id).toBe(`${threadId}:000000`);
    expect(writes[0]!.every((event) => event.id.includes(":rev:"))).toBe(true);
    expect(recorded).toEqual([{ threadId, source: grownSource }]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to reload threads it cannot rebuild from a session", () =>
  Effect.gen(function* () {
    const cases = [
      [{ historyOrigin: "native" as const }, "not-imported"],
      [{ runStatus: "running" }, "busy"],
      [{ runStatus: "queued" }, "busy"],
      [{ recorded: false }, "transcript-missing"],
      [{ transcript: { _tag: "Missing" as const } }, "transcript-missing"],
      [{ transcript: { _tag: "Unreadable" as const } }, "transcript-unreadable"],
    ] as const;
    for (const [options, reason] of cases) {
      const { layer, dispatched, writes } = makeReloadTest(options);
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          return yield* importer.reloadImportedThread({ threadId });
        }).pipe(Effect.provide(layer)),
      );
      expect(error).toBeInstanceOf(AgentSessionReloadError);
      expect(error.reason).toBe(reason);
      // Nothing is hidden or rewritten when the reload cannot finish.
      expect(dispatched).toEqual([]);
      expect(writes).toEqual([]);
    }
  }),
);
