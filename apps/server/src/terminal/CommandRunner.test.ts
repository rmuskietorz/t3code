import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CommandRunner from "./CommandRunner.ts";

// The runner shells out to `$SHELL -c`; the POSIX commands below pin the platform it picks.
const posix = Layer.succeed(HostProcess.Platform, "linux");
const layer = CommandRunner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(posix),
);

describe("TerminalCommandRunner", () => {
  it.effect("runs in the given folder and reports output and exit code", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(dir, "a.txt"), "");
      const runner = yield* CommandRunner.TerminalCommandRunner;

      const result = yield* runner.run({ cwd: dir, command: "ls; echo oops >&2; exit 3" });

      assert.deepStrictEqual(result, {
        output: "a.txt\noops",
        exitCode: 3,
        timedOut: false,
        truncated: false,
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects a folder that no longer exists", () =>
    Effect.gen(function* () {
      const runner = yield* CommandRunner.TerminalCommandRunner;
      const error = yield* runner
        .run({ cwd: "/definitely/not/here", command: "true" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "TerminalCwdNotFoundError");
    }).pipe(Effect.provide(layer)),
  );
});
