import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { findExternalClaudeSessionOwner } from "./ClaudeSessionOwners.ts";

const SESSION_ID = "7d81b371-5291-4391-bc9c-197a6c5b99c5";
const SERVER_PID = 500;

/** A /proc stat line whose command name contains spaces and parentheses. */
const statLine = (pid: number, ppid: number, start: string) =>
  `${pid} (claude (cli) x) S ${ppid} ${Array.from({ length: 17 }, () => "0").join(" ")} ${start} 0`;

const setup = Effect.fn("setup")(function* (
  processes: ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly start: string }>,
  sessions: ReadonlyArray<Record<string, unknown>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-config-" });
  const procRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-proc-" });
  yield* fileSystem.makeDirectory(path.join(configDirPath, "sessions"));
  for (const session of sessions) {
    yield* fileSystem.writeFileString(
      path.join(configDirPath, "sessions", `${String(session.pid)}.json`),
      JSON.stringify(session),
    );
  }
  for (const process of processes) {
    yield* fileSystem.makeDirectory(path.join(procRoot, String(process.pid)));
    yield* fileSystem.writeFileString(
      path.join(procRoot, String(process.pid), "stat"),
      statLine(process.pid, process.ppid, process.start),
    );
  }
  return (sessionId = SESSION_ID) =>
    findExternalClaudeSessionOwner({
      configDirPath,
      sessionId,
      procRoot,
      selfPid: SERVER_PID,
    }).pipe(Effect.provideService(HostProcess.Platform, "linux"));
});

describe("findExternalClaudeSessionOwner", () => {
  it.effect("reports a live terminal session holding the conversation", () =>
    Effect.gen(function* () {
      const find = yield* setup(
        [{ pid: 266890, ppid: 4000, start: "391665" }],
        [{ pid: 266890, sessionId: SESSION_ID, procStart: "391665", name: "playwright-testing" }],
      );
      expect(yield* find()).toEqual(Option.some({ pid: 266890, name: "playwright-testing" }));
      expect(yield* find("another-session")).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores exited processes and reused pids", () =>
    Effect.gen(function* () {
      const find = yield* setup(
        [{ pid: 300, ppid: 1, start: "999" }],
        [
          { pid: 300, sessionId: SESSION_ID, procStart: "111" },
          { pid: 301, sessionId: SESSION_ID, procStart: "222" },
        ],
      );
      expect(yield* find()).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a Claude process this server started", () =>
    Effect.gen(function* () {
      const find = yield* setup(
        [
          { pid: 700, ppid: 600, start: "5" },
          { pid: 600, ppid: SERVER_PID, start: "4" },
        ],
        [{ pid: 700, sessionId: SESSION_ID, procStart: "5" }],
      );
      expect(yield* find()).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never reports an owner outside Linux", () =>
    findExternalClaudeSessionOwner({
      configDirPath: "/does/not/matter",
      sessionId: SESSION_ID,
    }).pipe(
      Effect.map((owner) => expect(owner).toEqual(Option.none())),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );
});
