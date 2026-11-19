import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type AgentSessionSource,
  type ServerSettingsError,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  MessageId,
  RunId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: AgentSessionSource = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      omittedMessageCount: 0,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
    worktree: null as { path: string; branch: string | null } | null,
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

const PI_MODEL_SELECTION = { instanceId: ProviderInstanceId.make("pi"), model: "default" };

// Pi threads are owned by their session file path, not the session UUID.
const nativeId = ({ source }: ReturnType<typeof candidate>) =>
  source.provider === "pi" ? source.filePath : source.providerSessionId;

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const nativeThreadId = nativeId(source);
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, nativeThreadId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
  getAdapter?: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape["get"],
  threadCommands?: ThreadCommandExecutor.ThreadCommandExecutor["Service"],
  settings: Layer.Layer<
    ServerSettings.ServerSettingsService,
    ServerSettingsError
  > = ServerSettings.layerTest(),
  realScan?: {
    readonly workspaceRoot: string;
    readonly scanner: AgentSessionScanner.AgentSessionScanner["Service"];
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          settings,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          realScan === undefined
            ? Layer.mock(AgentSessionScanner.AgentSessionScanner)({
                recentThreads: () => Stream.fromIterable(candidates),
              })
            : Layer.succeed(AgentSessionScanner.AgentSessionScanner, realScan.scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Project",
                workspaceRoot: realScan?.workspaceRoot ?? "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)(
            getAdapter === undefined ? {} : { get: getAdapter },
          ),
          Layer.succeed(
            ThreadCommandExecutor.ThreadCommandExecutor,
            threadCommands ?? (yield* ThreadCommandExecutor.make),
          ),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return {
    run: importer.importRecentAgentThreads({ projectId }),
    importNativeHistory: importer.importNativeHistory,
    published,
  };
});

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const ownedPi = candidate(PI_MODEL_SELECTION, "owned-pi", "pi");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
        yield* seedOwner(ownedPi),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      unowned.thread.omittedMessageCount = 1;
      unowned.worktree = { path: "/workspace/project/.claude/worktrees/feat", branch: "feat" };
      const unownedPi = candidate(PI_MODEL_SELECTION, "unowned-pi", "pi");
      const importer = yield* makeImporter([
        active,
        archived,
        deleted,
        ownedPi,
        otherInstance,
        unowned,
        unownedPi,
      ]);

      expect(yield* importer.run).toEqual({ importedCount: 3, skippedCount: 0 });
      for (const source of [active, archived, deleted, ownedPi]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned), importId(unownedPi)]));
      for (const source of [otherInstance, unowned, unownedPi]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "turnItems",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        const notices = records.turnItems.filter((item) => item.type === "system_notice");
        if (source === unowned) {
          expect(records.turnItems[0]).toBe(notices[0]);
          expect(notices).toMatchObject([
            {
              ordinal: 1,
              runId: null,
              message: expect.stringContaining("1 earlier message was not imported"),
            },
          ]);
        } else {
          expect(notices).toEqual([]);
        }
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.worktreePath).toBe(source.worktree?.path ?? null);
        expect(records.thread.branch).toBe(source.worktree?.branch ?? null);
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "claudeAgent"
              ? { threadId, resume: source.source.providerSessionId }
              : { threadId: nativeId(source) },
          runtimePayload: {
            cwd: source.worktree?.path ?? "/workspace/project",
            importedTranscripts: [source.source],
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("tolerates a missing transcript owner but propagates failed ownership reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ownership-read");
    const threadId = importId(source);
    yield* runtimes.upsert({
      threadId: ThreadId.make("missing-owner"),
      providerName: "codex",
      providerInstanceId: source.source.providerInstanceId,
      adapterKey: "codex",
      runtimeMode: "full-access",
      status: "stopped",
      lastSeenAt: timestamp,
      resumeCursor: null,
      runtimePayload: { importedTranscripts: [source.source] },
    });
    yield* runtimes.recordImportedTranscript({
      threadId: ThreadId.make("missing-owner"),
      source: source.source,
    });
    const importer = yield* makeImporter([source]);
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });

    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${threadId}`;
    expect(yield* Effect.flip(importer.run)).toMatchObject({
      _tag: "AgentSessionScanError",
      operation: "read-projects",
      cause: {
        _tag: "OrchestratorProjectionError",
        threadId,
        cause: { _tag: "ProjectionStoreReadError" },
      },
    });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("counts only new threads when re-importing cached and recovered transcripts", () =>
  Effect.gen(function* () {
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const cached = candidate(
      CLAUDE_MODEL_SELECTION,
      "020e7f00-dce6-406b-8ec6-ed90498945d6",
      "claudeAgent",
    );
    const recovered = candidate(CODEX_MODEL_SELECTION, "recovered");
    const initial = yield* makeImporter([cached, recovered]);
    expect(yield* initial.run).toEqual({ importedCount: 2, skippedCount: 0 });
    const before = yield* events.read({ threadId: importId(recovered) }).pipe(Stream.runCollect);
    // The file changed on disk but still holds the imported messages.
    recovered.source.size += 100;
    recovered.source.mtimeMs += 1;
    const duplicate = { ...recovered.source, filePath: "/tmp/duplicate.jsonl" };
    const fresh = candidate(CODEX_MODEL_SELECTION, "fresh");
    const repeated = yield* makeImporter([
      { _tag: "AlreadyImported", source: cached.source },
      recovered,
      { _tag: "Duplicate", source: duplicate },
      fresh,
      { _tag: "Skipped" },
    ]);

    expect(yield* repeated.run).toEqual({ importedCount: 1, skippedCount: 1 });
    expect(yield* events.read({ threadId: importId(recovered) }).pipe(Stream.runCollect)).toEqual(
      before,
    );
    expect(
      new Set(
        repeated.published.flatMap((stored) => ("event" in stored ? [stored.event.threadId] : [])),
      ),
    ).toEqual(new Set([importId(fresh)]));
    expect(
      Option.getOrThrow(yield* runtimes.getByThreadId({ threadId: importId(recovered) })),
    ).toMatchObject({
      runtimePayload: { importedTranscripts: [recovered.source, duplicate] },
    });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("refreshes a partially imported thread from its continued transcript", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const original = candidate(CODEX_MODEL_SELECTION, "partial-retry");
    const threadId = importId(original);
    const importer = yield* makeImporter([original]);
    yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
    yield* sql`DROP TRIGGER fail_runtime`;
    expect(yield* runtimes.list()).toEqual([]);
    const continued = candidate(CODEX_MODEL_SELECTION, original.source.providerSessionId);
    continued.source.size = 200;
    continued.source.mtimeMs = 3;
    continued.thread.messages.push(
      { role: "user", text: "Continue outside T3", createdAt: timestamp },
      { role: "assistant", text: "Native continuation", createdAt: timestamp },
    );
    // No T3 run continued the thread, so it takes the new messages before the transcript is recorded.
    expect(yield* (yield* makeImporter([continued])).run).toEqual({
      importedCount: 0,
      skippedCount: 0,
    });
    expect(yield* runtimes.list()).toHaveLength(1);
    expect(
      (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
        (message) => message.text,
      ),
    ).toEqual(["Fix it", "Fixed", "Continue outside T3", "Native continuation"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("does not record a changed transcript as imported without its new messages", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const first = candidate(
      CLAUDE_MODEL_SELECTION,
      "6f1c2a7e-3b4d-4e5f-9a8b-1c2d3e4f5a6b",
      "claudeAgent",
    );
    const threadId = importId(first);
    expect(yield* (yield* makeImporter([first])).run).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    const continued = candidate(
      CLAUDE_MODEL_SELECTION,
      first.source.providerSessionId,
      "claudeAgent",
    );
    continued.source.size = 200;
    continued.source.mtimeMs = 3;
    continued.thread.messages.push(
      { role: "user", text: "Continue", createdAt: timestamp },
      { role: "assistant", text: "Continued", createdAt: timestamp },
    );
    yield* (yield* makeImporter([continued])).run;

    const recorded = AgentSessionScanner.decodeImportedTranscriptPayload(
      Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimePayload,
    ).pipe(Option.getOrThrow).importedTranscripts;
    const texts = (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
      (message) => message.text,
    );
    expect({
      recordsChangedTranscript: recorded?.some((source) => source.size === 200) ?? false,
      showsNewMessages: texts.includes("Continued"),
    }).not.toEqual({ recordsChangedTranscript: true, showsNewMessages: false });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "copies native session history into the imported thread once, retrying a failed read",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const source = candidate(CODEX_MODEL_SELECTION, "native-history");
      const threadId = yield* seedOwner(source);
      const resolved: Array<ProviderInstanceId> = [];
      const opened: Array<ProviderAdapter.ProviderAdapterV2OpenSessionInput> = [];
      let closed = false;
      let failRead = true;
      const replayed = (role: "user" | "assistant", text: string) => ({
        createdBy: role === "user" ? ("user" as const) : ("agent" as const),
        creationSource: "provider" as const,
        id: MessageId.make(`replayed:${text}`),
        threadId,
        runId: null,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      });
      const adapter = {
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              opened.push(input);
              return {
                readThreadSnapshot: ({ providerThread }) =>
                  failRead
                    ? Effect.fail(
                        new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                          driver: providerThread.driver,
                          providerThreadId: providerThread.id,
                        }),
                      )
                    : Effect.succeed({
                        providerThread,
                        providerTurns: [],
                        runtimeRequests: [],
                        reasoningMessageIds: [MessageId.make("replayed:Check the build log")],
                        messages: [
                          replayed("user", "Fix the build"),
                          replayed("assistant", "Check the build log"),
                          replayed("assistant", "Fixed it"),
                          replayed("assistant", " "),
                        ],
                      }),
              } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">;
            }),
            () =>
              Effect.sync(() => {
                closed = true;
              }),
          ),
      } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
      const importer = yield* makeImporter([], Effect.void, (instanceId) =>
        Effect.sync(() => {
          resolved.push(instanceId);
          return adapter;
        }),
      );

      const importHistory = importer.importNativeHistory({
        threadId,
        workspaceRoot: "/workspace/project",
      });

      expect((yield* Effect.flip(importHistory))._tag).toBe(
        "ProviderAdapterReadThreadSnapshotError",
      );
      expect(closed).toBe(true);
      expect(
        (yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin,
      ).toBeUndefined();

      failRead = false;
      expect(yield* importHistory).toBe(3);
      expect(resolved).toEqual([
        CODEX_MODEL_SELECTION.instanceId,
        CODEX_MODEL_SELECTION.instanceId,
      ]);
      expect(opened[1]).toMatchObject({
        threadId,
        initialNativeThreadId: source.source.providerSessionId,
        runtimePolicy: { cwd: "/workspace/project" },
      });
      // Forks keep run-less history only for this origin.
      expect((yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin).toBe(
        "v1_import",
      );
      expect(yield* importHistory).toBe(0);
      expect(opened).toHaveLength(2);
      const page = yield* projections.getTimelinePage(threadId, { view: "activity", limit: 10 });
      expect(
        page.items.map(({ item }) => [
          item.type,
          item.runId,
          "text" in item ? item.text : undefined,
        ]),
      ).toEqual([
        ["user_message", null, "Fix the build"],
        ["reasoning", null, "Check the build log"],
        ["assistant_message", null, "Fixed it"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("releases the ACP import lock when a native session never answers", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
    const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, "native-history-hang"));
    const opened = yield* Deferred.make<void>();
    let closed = false;
    // An agent that only resumes sessions and never answers its first session/resume.
    const adapter = {
      openSession: () =>
        Effect.suspend(() => {
          if (!closed) {
            return Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            ).pipe(
              Effect.andThen(Deferred.succeed(opened, undefined)),
              Effect.andThen(Effect.never),
            );
          }
          return Effect.succeed({
            readThreadSnapshot: ({ providerThread }) =>
              Effect.succeed({
                providerThread,
                providerTurns: [],
                runtimeRequests: [],
                messages: [
                  {
                    createdBy: "user",
                    creationSource: "provider",
                    id: MessageId.make("replayed:hang"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: "user",
                    text: "Fix the build",
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              }),
          } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">);
        }),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
    const importer = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
    const importHistory = coordinator.withSessionMutation(
      importer.importNativeHistory({ threadId, workspaceRoot: "/workspace/project" }),
    );

    const importing = yield* importHistory.pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(opened);
    // Any other ACP import or delete waits for the same lock.
    const next = yield* coordinator
      .withSessionMutation(Effect.succeed("next"))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("2 minutes");

    expect((yield* Fiber.join(importing))._tag).toBe("TimeoutError");
    expect(closed).toBe(true);
    expect(yield* Fiber.join(next)).toBe("next");
    expect(
      (yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin,
    ).toBeUndefined();
    expect(yield* importHistory).toBe(1);
    expect((yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin).toBe(
      "v1_import",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(persistence, AcpRegistryRuntimeCoordinator.layer)),
  ),
);

/**
 * Runs a thread command that read the thread before the history load ended and
 * writes once the importer is about to commit, as an unserialized write would.
 */
const importDuringCommand = Effect.fn(function* (
  name: string,
  command: (thread: OrchestrationV2AppThread) => ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, name));
  const lock = yield* ThreadCommandExecutor.make;
  const loaded = yield* Deferred.make<void>();
  const importerCommitting = yield* Deferred.make<void>();
  const commandWritten = yield* Deferred.make<void>();
  const committing = Deferred.succeed(importerCommitting, undefined);
  const adapter = {
    openSession: () =>
      Effect.succeed({
        readThreadSnapshot: ({ providerThread }) =>
          Deferred.await(loaded).pipe(
            Effect.as({
              providerThread,
              providerTurns: [],
              runtimeRequests: [],
              messages: [
                {
                  createdBy: "user" as const,
                  creationSource: "provider" as const,
                  id: MessageId.make(`replayed:${name}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  role: "user" as const,
                  text: "Fix the build",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }),
          ),
      } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">),
  } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  const importer = yield* makeImporter(
    [],
    committing.pipe(Effect.andThen(Deferred.await(commandWritten))),
    () => Effect.succeed(adapter),
    {
      ...lock,
      withLock: (key, effect) => committing.pipe(Effect.andThen(lock.withLock(key, effect))),
    },
  );
  const commanding = yield* Effect.forkScoped(
    lock.withLock(
      threadId,
      Effect.gen(function* () {
        const { thread } = yield* projections.getThreadRecords(threadId, []);
        yield* Deferred.succeed(loaded, undefined);
        yield* Deferred.await(importerCommitting);
        yield* sink.write({ events: command(thread) });
        yield* Deferred.succeed(commandWritten, undefined);
      }),
    ),
  );
  const imported = yield* importer.importNativeHistory({
    threadId,
    workspaceRoot: "/workspace/project",
  });
  yield* Fiber.join(commanding);
  const records = yield* projections.getThreadRecords(threadId, ["runs"]);
  const page = yield* projections.getTimelinePage(threadId, { view: "messages", limit: 10 });
  return { imported, thread: records.thread, runs: records.runs, items: page.items };
});

it.effect("keeps a thread edit made while the native history loads", () =>
  Effect.gen(function* () {
    const result = yield* importDuringCommand("renamed-during-load", (thread) => [
      {
        id: EventId.make(`${thread.id}:renamed`),
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: now,
        payload: { ...thread, title: "Renamed" },
      },
    ]);
    expect(result.imported).toBe(1);
    expect(result.thread.title).toBe("Renamed");
    expect(result.thread.historyOrigin).toBe("v1_import");
    expect(result.items).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("skips the native history when a run starts while it loads", () =>
  Effect.gen(function* () {
    const result = yield* importDuringCommand("run-during-load", (thread) => [
      {
        id: EventId.make(`${thread.id}:run`),
        type: "run.updated",
        threadId: thread.id,
        occurredAt: now,
        payload: {
          id: RunId.make(`${thread.id}:run`),
          threadId: thread.id,
          ordinal: 1,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`${thread.id}:prompt`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "queued",
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ]);
    expect(result.imported).toBe(0);
    expect(result.runs).toHaveLength(1);
    expect(result.thread.historyOrigin).toBeUndefined();
    expect(result.items).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("imports under a policy ceiling in the project's default, kept under the ceiling", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ceiling");
    const threadId = importId(source);
    const importer = yield* makeImporter(
      [source],
      Effect.void,
      undefined,
      undefined,
      ServerSettings.layerTest(
        { defaultRuntimeMode: "full-access" },
        {
          organization: "Example Corp",
          lockedSettings: [],
          limits: { maxRuntimeMode: "auto-accept-edits" },
        },
      ),
    );
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    expect((yield* projections.getThread(threadId)).runtimeMode).toBe("auto-accept-edits");
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimeMode).toBe(
      "auto-accept-edits",
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("repeated imports reach linked-worktree sessions behind the scan budget", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-worktree-budget-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const worktreeGitDir = path.join(repo, ".git", "worktrees", "feature");
    yield* fs.makeDirectory(worktreeGitDir, { recursive: true });
    yield* fs.makeDirectory(worktree);
    yield* fs.writeFileString(path.join(repo, ".git", "config"), "[core]\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const claudeHome = path.join(root, "claude");
    const codexHome = path.join(root, "codex");
    const sessions = path.join(codexHome, "sessions", "2026", "09", "01");
    yield* fs.makeDirectory(sessions, { recursive: true });
    const nowMs = DateTime.toEpochMillis(now);
    yield* TestClock.setTime(nowMs);
    // One more session than the 100-transcript scan budget, all run in the linked worktree.
    for (let index = 0; index < 101; index++) {
      const file = path.join(sessions, `rollout-${String(index).padStart(3, "0")}.jsonl`);
      const records = [
        { type: "session_meta", payload: { id: `session-${index}`, cwd: worktree } },
        { type: "event_msg", payload: { type: "user_message", message: `Request ${index}` } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done" }],
          },
        },
      ];
      yield* fs.writeFileString(
        file,
        records.map((record) => JSON.stringify(record) + "\n").join(""),
      );
      const modifiedAtSeconds = nowMs / 1000 - (index + 1);
      yield* fs.utimes(file, modifiedAtSeconds, modifiedAtSeconds);
    }

    const scannerContext = yield* Layer.build(
      AgentSessionScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(claudeHome, { prefix: "t3-import-budget-config-" }),
            ServerSettings.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: claudeHome },
                },
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome },
                },
                // Keeps the default Pi instance off the developer's real ~/.pi.
                [ProviderInstanceId.make("pi")]: {
                  driver: ProviderDriverKind.make("pi"),
                  enabled: false,
                  config: {},
                },
              },
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
            Layer.succeed(
              ProviderSessionRuntime.ProviderSessionRuntimeRepository,
              yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            ),
          ),
        ),
      ),
    );
    const importer = yield* makeImporter([], Effect.void, undefined, undefined, undefined, {
      workspaceRoot: repo,
      scanner: Context.get(scannerContext, AgentSessionScanner.AgentSessionScanner),
    });

    expect(yield* importer.run).toEqual({ importedCount: 100, skippedCount: 1 });
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    const oldest = yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) =>
        projections.getThread(ThreadId.make("import:codex:session-100")),
      ),
    );
    expect(oldest.worktreePath).toBe(worktree);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

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
    omittedMessageCount: 0,
    messages: [
      { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
      { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
    ],
  },
  worktree: null,
};

// Importer dependencies these mock-based tests never reach.
const layerUnusedImporterDependencies = Layer.mergeAll(
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
  ServerSettings.layerTest(),
);

type RecentThreadsOptions = Parameters<
  AgentSessionScanner.AgentSessionScanner["Service"]["recentThreads"]
>[2];

const makeImporterTest = (
  input: {
    /** Another thread owns the session, so the import's ownership-guarded write commits nothing. */
    readonly providerThreadOwned?: boolean;
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
            Effect.succeedSome({ id: projectId, workspaceRoot: "/workspace/project" } as never),
          listShells: () =>
            Effect.succeed([{ id: projectId, workspaceRoot: "/workspace/project" } as never]),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                  // The transcript has grown past what the thread shows.
                  messages: [{ role: "user", text: "Fix it" }],
                  runs:
                    (input.continuedInT3 ?? true)
                      ? [{ id: "run-1", status: input.runStatus ?? "completed" }]
                      : [],
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (write) =>
            Effect.sync(() => {
              if (write.unlessNativeThreadOwned !== undefined && input.providerThreadOwned) {
                return [];
              }
              writes.push(write.events);
              imported = true;
              return write.events.map((event, sequence) => ({
                sequence,
                commandId: null,
                event,
              })) as never;
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
        layerUnusedImporterDependencies,
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
      importedCount: 0,
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
    providerThreadOwned: true,
  });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 0,
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
        layerUnusedImporterDependencies,
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
      expect(error).toMatchObject({ _tag: "AgentSessionReloadError", reason });
      // Nothing is hidden or rewritten when the reload cannot finish.
      expect(dispatched).toEqual([]);
      expect(writes).toEqual([]);
    }
  }),
);
