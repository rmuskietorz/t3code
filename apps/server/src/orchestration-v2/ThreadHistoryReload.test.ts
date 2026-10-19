import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-history-reload" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

/** An agent session import: a strong native ref plus one imported message without a run. */
const createImportedThread = (threadId: ThreadId, historyOrigin: "v1_import" | "native") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:history-reload"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:provider-thread`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-session", strength: "strong" },
        nativeConversationHeadRef: { driver, nativeId: "native-turn", strength: "weak" },
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:imported`),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: now,
      payload: { ...thread, historyOrigin, activeProviderThreadId: providerThreadId },
    });
    const messageId = MessageId.make(`${threadId}:000000`);
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:imported-item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:${threadId}:000000`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        messageId,
        inputIntent: "turn_start",
        text: "Imported question",
        attachments: [],
      },
    });
  });

const send = (threadId: ThreadId, text: string) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

const completeLatestRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* projections.apply({
      id: EventId.make(`event:${run.id}:completed`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });
  });

const reload = (threadId: ThreadId, commandId: string) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.history.reload-from-native",
      commandId: CommandId.make(commandId),
      threadId,
    }),
  );

it.effect("hides T3 runs without touching the provider, and the next turn still resumes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("import:codex:reload");
    yield* createImportedThread(threadId, "v1_import");
    yield* send(threadId, "first");
    yield* completeLatestRun(threadId);

    yield* reload(threadId, "reload-1");

    const reloaded = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      reloaded.runs.map((run) => run.status),
      ["rolled_back"],
    );
    const providerThread = reloaded.providerThreads[0]!;
    assert.deepEqual(providerThread.nativeThreadRef, {
      driver,
      nativeId: "native-session",
      strength: "strong",
    });
    assert.isNull(providerThread.nativeConversationHeadRef);
    const effects = yield* sql<{ readonly id: string }>`
      SELECT effect_id AS id FROM orchestration_v2_effect_outbox WHERE command_id = 'reload-1'
    `;
    assert.deepEqual(effects, []);

    // No completed run remains, so only the native resume keeps the legacy handoff away.
    yield* send(threadId, "second");
    const continued = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(continued.contextHandoffs, []);
    assert.deepEqual(continued.providerThreads[0]?.handoffIds, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to reload a thread with a live run or one that is not a session import", () =>
  Effect.gen(function* () {
    const busy = ThreadId.make("import:codex:busy");
    yield* createImportedThread(busy, "v1_import");
    yield* send(busy, "running");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(reload(busy, "reload-busy"))));

    const native = ThreadId.make("thread:native");
    yield* createImportedThread(native, "native");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(reload(native, "reload-native"))));
  }).pipe(Effect.provide(layerTest)),
);
