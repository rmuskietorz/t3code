import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Claude Code records every running CLI in `<config dir>/sessions/<pid>.json`.
 * Entries outlive crashed processes and pids get reused, so an entry only
 * counts while `/proc/<pid>` exists with the start time the entry recorded.
 */
const ClaudeSessionRecord = Schema.Struct({
  pid: Schema.Number,
  sessionId: Schema.String,
  procStart: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
const decodeClaudeSessionRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeSessionRecord),
);

export interface ClaudeSessionOwner {
  readonly pid: number;
  readonly name: string | null;
}

export class ClaudeSessionInUseElsewhereError extends Schema.TaggedError<ClaudeSessionInUseElsewhereError>()(
  "ClaudeSessionInUseElsewhereError",
  {
    pid: Schema.Number,
    sessionName: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    const name = this.sessionName === null ? "" : ` "${this.sessionName}"`;
    return `This conversation is still open in another Claude Code session${name} (PID ${this.pid}), probably in a terminal. Close it there with /exit and send again, or start a new thread.`;
  }
}

/** Fields after the parenthesized command name, which may itself contain spaces. */
const readProcStat = (fileSystem: FileSystem.FileSystem, procRoot: string, pid: number) =>
  fileSystem.readFileString(`${procRoot}/${pid}/stat`).pipe(
    Effect.map((stat) => Option.some(stat.slice(stat.lastIndexOf(")") + 2).split(" "))),
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()),
  );

/**
 * Finds a live Claude Code process, other than one this server started, that
 * holds `sessionId`. Resuming the conversation there and here at once would
 * interleave two writers in one transcript. Only Linux exposes `/proc`, so
 * other platforms never report an owner.
 */
export const findExternalClaudeSessionOwner = Effect.fn("findExternalClaudeSessionOwner")(
  function* (input: {
    readonly configDirPath: string;
    readonly sessionId: string;
    readonly procRoot?: string;
    readonly selfPid?: number;
  }): Effect.fn.Return<
    Option.Option<ClaudeSessionOwner>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    if ((yield* HostProcess.Platform) !== "linux") return Option.none();
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const procRoot = input.procRoot ?? "/proc";
    const selfPid = input.selfPid ?? process.pid;
    const sessionsDir = path.join(input.configDirPath, "sessions");
    const entries = yield* fileSystem
      .readDirectory(sessionsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = decodeClaudeSessionRecord(
        yield* fileSystem
          .readFileString(path.join(sessionsDir, entry))
          .pipe(Effect.orElseSucceed(() => "")),
      );
      if (Option.isNone(record) || record.value.sessionId !== input.sessionId) continue;
      const stat = yield* readProcStat(fileSystem, procRoot, record.value.pid);
      // Field 22 of /proc/<pid>/stat (index 19 after the name) is the start time.
      if (
        Option.isNone(stat) ||
        (record.value.procStart !== undefined && stat.value[19] !== record.value.procStart)
      ) {
        continue;
      }
      // A CLI this server spawned for the same thread is not a conflict.
      let ancestor = Number(stat.value[1]);
      let startedHere = false;
      for (let depth = 0; depth < 64 && ancestor > 1; depth += 1) {
        if (ancestor === selfPid) {
          startedHere = true;
          break;
        }
        const parentStat = yield* readProcStat(fileSystem, procRoot, ancestor);
        if (Option.isNone(parentStat)) break;
        ancestor = Number(parentStat.value[1]);
      }
      if (!startedHere) {
        return Option.some({ pid: record.value.pid, name: record.value.name ?? null });
      }
    }
    return Option.none();
  },
);
