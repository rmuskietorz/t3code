import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionReloadError,
  AgentSessionScanError,
  AgentSessionSource,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportAllResult,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionReloadInput,
  type AgentSessionReloadResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { importedNativeHistoryResumes } from "../orchestration-v2/importedNativeHistory.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function foreignTranscriptKey(source: AgentSessionImportSource): string {
  return `${source.providerInstanceId}\0${source.filePath}`;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
  /** Distinguishes the events of a later refresh, which update the same messages. */
  readonly revision?: string;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const eventSuffix = input.revision === undefined ? suffix : `${suffix}:rev:${input.revision}`;
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${eventSuffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${eventSuffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  // Runs share one lock so a manual and a periodic import never write the same session twice.
  const importLock = yield* Semaphore.make(1);
  // Transcripts whose session already belongs to a thread this importer must not
  // touch, such as one T3 started itself. A transcript file never changes its
  // session, so the scanner can skip these without reading them again.
  const foreignTranscripts = new Set<string>();

  const importProject = Effect.fn("AgentSessionImporter.importProject")(function* (
    project: { readonly id: ProjectId; readonly workspaceRoot: string },
    quietPeriodMs: number,
  ) {
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources, {
      quietPeriodMs,
      excludedTranscripts: foreignTranscripts,
    });
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let createdCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          // recordImportedTranscript only updates an existing row, so without
          // one a re-import never sees the transcript as already imported.
          const ensureRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== project.id) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: project.id,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            // The conversation went on outside T3. Until a T3 run continues the
            // thread, its history still mirrors the transcript, so show what was added.
            // A reload from the session hides earlier T3 runs and restores that state.
            const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
            const revision = `${source.size}-${source.mtimeMs}`;
            // A refresh that landed without being recorded ends the thread's
            // events; writing its event ids again would fail the whole import.
            const latest = yield* eventStore.latestSequence({ threadId });
            const [lastEvent] = yield* Stream.runCollect(
              eventStore.read({ threadId, afterSequence: latest - 1, limit: 1 }),
            );
            const alreadyRefreshed = lastEvent?.event.id.endsWith(`:rev:${revision}`) ?? false;
            if (!alreadyRefreshed && runs.every((run) => run.status === "rolled_back")) {
              yield* eventSink.write({
                events: thread.messages.flatMap((message, index) =>
                  messageEvents({ threadId, index, message, revision }),
                ),
              });
            }
            yield* ensureRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return "updated" as const;
          }

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          // Native and imported threads derive the same provider thread id from the
          // session, so writing one here would take over a thread T3 is running.
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            nativeThreadId: thread.providerSessionId,
          });
          if (Option.isSome(yield* projections.getProviderThreadOwner(providerThreadId))) {
            foreignTranscripts.add(foreignTranscriptKey(source));
            return "foreign" as const;
          }
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: project.id,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: thread.providerSessionId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          yield* ensureRuntime;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return "created" as const;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (
                    cause._tag === "AgentSessionThreadModifiedError" ||
                    cause._tag === "AgentSessionThreadProjectConflictError"
                  ) {
                    foreignTranscripts.add(foreignTranscriptKey(source));
                  }
                }),
              ),
              Effect.as("failed" as const),
            ),
          ),
        );
        if (imported === "created" || imported === "updated") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          if (imported === "created") createdCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, createdCount, skippedCount };
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const { importedCount, skippedCount } = yield* importProject(project, 0).pipe(
      importLock.withPermits(1),
    );
    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  /**
   * Imports new sessions into every existing project. `quietPeriodMs` keeps a
   * periodic run from freezing a session that is still being written, since a
   * later run never adds messages to a thread it already imported.
   */
  const importAllProjects = Effect.fn("AgentSessionImporter.importAllProjects")(
    function* (options: { readonly quietPeriodMs: number }) {
      yield* scanner.refreshCandidates;
      const shells = yield* projects
        .listShells()
        .pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        );
      let createdCount = 0;
      let skippedCount = 0;
      for (const shell of shells) {
        const result = yield* importProject(shell, options.quietPeriodMs).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not re-import agent sessions for a project", {
              projectId: shell.id,
              cause,
            }).pipe(Effect.as({ createdCount: 0, skippedCount: 0 })),
          ),
        );
        createdCount += result.createdCount;
        skippedCount += result.skippedCount;
      }
      return {
        projectCount: shells.length,
        createdCount,
        skippedCount,
      } satisfies AgentSessionImportAllResult;
    },
  );

  const reloadImportedThread = Effect.fn("AgentSessionImporter.reloadImportedThread")(function* (
    input: AgentSessionReloadInput,
  ) {
    const { threadId } = input;
    const fail = (reason: AgentSessionReloadError["reason"]) =>
      Effect.fail(new AgentSessionReloadError({ threadId, reason }));
    const failed = (cause: unknown) =>
      new AgentSessionReloadError({ threadId, reason: "failed", cause });

    const records = yield* Effect.option(
      orchestrator.getThreadRecords(threadId, ["runs", "providerThreads"]),
    );
    if (Option.isNone(records)) return yield* fail("not-imported");
    const { thread, runs, providerThreads } = records.value;
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    const nativeId = providerThread?.nativeThreadRef?.nativeId;
    if (
      thread.deletedAt !== null ||
      nativeId == null ||
      !importedNativeHistoryResumes({
        historyOrigin: thread.historyOrigin,
        providerThread,
        providerInstanceId: thread.modelSelection.instanceId,
      })
    ) {
      return yield* fail("not-imported");
    }
    const settled = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
    if (providerThread?.status === "active" || runs.some((run) => !settled.has(run.status))) {
      return yield* fail("busy");
    }

    const runtime = yield* runtimes.getByThreadId({ threadId }).pipe(Effect.mapError(failed));
    const recorded = Option.flatMap(runtime, (row) =>
      Option.flatMap(decodeImportedTranscriptPayload(row.runtimePayload), (payload) =>
        Option.fromUndefinedOr(
          payload.importedTranscripts?.findLast(
            (source) =>
              source.providerSessionId === nativeId &&
              source.providerInstanceId === thread.modelSelection.instanceId,
          ),
        ),
      ),
    );
    if (Option.isNone(recorded)) return yield* fail("transcript-missing");
    // Read before hiding anything, so a transcript that is gone leaves the thread as it was.
    const transcript = yield* scanner.readImportedTranscript(recorded.value);
    if (transcript._tag === "Missing") return yield* fail("transcript-missing");
    if (transcript._tag === "Unreadable") return yield* fail("transcript-unreadable");

    const now = DateTime.toEpochMillis(yield* DateTime.now);
    // Reloading the same transcript twice must still write new events.
    const revision = `${transcript.source.size}-${transcript.source.mtimeMs}-reload-${now}`;
    yield* orchestrator
      .dispatch({
        type: "thread.history.reload-from-native",
        commandId: CommandId.make(`${IMPORT_EVENT_PREFIX}:reload:${threadId}:${revision}`),
        threadId,
      })
      .pipe(Effect.mapError(failed));
    // Message ids are positional, so a transcript that got shorter leaves its
    // former tail visible; v2 has no event that removes a message. Transcripts
    // only grow in practice, so this stays a known limitation.
    yield* eventSink
      .write({
        events: transcript.thread.messages.flatMap((message, index) =>
          messageEvents({ threadId, index, message, revision }),
        ),
      })
      .pipe(Effect.mapError(failed));
    yield* runtimes
      .recordImportedTranscript({ threadId, source: transcript.source })
      .pipe(Effect.mapError(failed));
    return {
      messageCount: transcript.thread.messages.length,
    } satisfies AgentSessionReloadResult;
  });

  return {
    reloadImportedThread: (input: AgentSessionReloadInput) =>
      reloadImportedThread(input).pipe(importLock.withPermits(1)),
    importRecentAgentThreads,
    importAllProjects: (options: { readonly quietPeriodMs: number }) =>
      importAllProjects(options).pipe(importLock.withPermits(1)),
  };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
