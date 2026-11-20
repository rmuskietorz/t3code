import {
  TerminalCommandError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  type TerminalCwdError,
  type TerminalRunCommandInput,
  type TerminalRunCommandResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

// Matches the Claude CLI's default bash timeout, and keeps the result inside the 64k terminal
// context a message can carry.
const COMMAND_TIMEOUT = Duration.minutes(2);
const MAX_STREAM_BYTES = 30_000;
const TRUNCATED_MARKER = "\n[output truncated]";

function resolveCommandShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  command: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (platform === "win32") {
    return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", command] };
  }
  return { command: env.SHELL?.trim() || "/bin/sh", args: ["-c", command] };
}

export class TerminalCommandRunner extends Context.Service<
  TerminalCommandRunner,
  {
    readonly run: (
      input: TerminalRunCommandInput,
    ) => Effect.Effect<TerminalRunCommandResult, TerminalCwdError | TerminalCommandError>;
  }
>()("t3/terminal/CommandRunner/TerminalCommandRunner") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const assertDirectory = Effect.fn("TerminalCommandRunner.assertDirectory")(function* (
    cwd: string,
  ) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") return yield* new TerminalCwdNotDirectoryError({ cwd });
  });

  const run = Effect.fn("TerminalCommandRunner.run")(function* (input: TerminalRunCommandInput) {
    yield* assertDirectory(input.cwd);
    const platform = yield* HostProcess.Platform;
    const env = yield* HostProcess.Environment;
    const shell = resolveCommandShell(platform, env, input.command);
    const result = yield* processRunner
      .run({
        command: shell.command,
        args: shell.args,
        cwd: input.cwd,
        // Nothing reads a pager or colors from here, and stdin stays closed.
        env: { ...env, PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", TERM: "dumb" },
        timeout: COMMAND_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAX_STREAM_BYTES,
        outputMode: "truncate",
        truncatedMarker: TRUNCATED_MARKER,
      })
      .pipe(Effect.mapError((cause) => new TerminalCommandError({ cause })));
    return {
      output: [result.stdout, result.stderr]
        .map((text) => text.replace(/\s+$/, ""))
        .filter((text) => text.length > 0)
        .join("\n"),
      exitCode: result.code === null ? null : Number(result.code),
      timedOut: result.timedOut,
      truncated: result.stdoutTruncated || result.stderrTruncated,
    } satisfies TerminalRunCommandResult;
  });

  return TerminalCommandRunner.of({ run });
});

export const layer = Layer.effect(TerminalCommandRunner, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
