import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeClaudeSignedOutMarker } from "./claudeSignedOut.ts";

const signedIn: ServerProvider = {
  driver: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  checkedAt: "2026-11-05T00:00:00Z",
  auth: { status: "authenticated", email: "dev@example.com" },
  models: [],
  skills: [],
  slashCommands: [],
};

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const paths = {
    markerPath: path.join(dir, "claude-signed-out-claudeAgent"),
    credentialsPath: path.join(dir, ".credentials.json"),
  };
  yield* fs.writeFileString(paths.credentialsPath, '{"claudeAiOauth":{"accessToken":"old"}}');
  return { fs, paths };
});

describe("Claude sign-out marker", () => {
  it.effect("reports a failed turn as signed out, also after a restart", () =>
    Effect.gen(function* () {
      const { paths } = yield* setup;
      const marker = yield* makeClaudeSignedOutMarker(paths);
      assert.strictEqual(yield* marker.markSignedOut, true);
      assert.strictEqual((yield* marker.applyTo(signedIn)).auth.status, "unauthenticated");

      const restarted = yield* makeClaudeSignedOutMarker(paths);
      const snapshot = yield* restarted.applyTo(signedIn);
      assert.strictEqual(snapshot.status, "error");
      assert.deepStrictEqual(snapshot.auth, { status: "unauthenticated" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("clears once the login file changes", () =>
    Effect.gen(function* () {
      const { fs, paths } = yield* setup;
      const marker = yield* makeClaudeSignedOutMarker(paths);
      yield* marker.markSignedOut;
      yield* fs.writeFileString(
        paths.credentialsPath,
        '{"claudeAiOauth":{"accessToken":"fresh-after-login"}}',
      );

      assert.deepStrictEqual(yield* marker.applyTo(signedIn), signedIn);
      assert.strictEqual(yield* fs.exists(paths.markerPath), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("clears when a turn authenticates again", () =>
    Effect.gen(function* () {
      const { fs, paths } = yield* setup;
      const marker = yield* makeClaudeSignedOutMarker(paths);
      yield* marker.markSignedOut;

      assert.strictEqual(yield* marker.markAuthenticated, true);
      assert.strictEqual(yield* marker.markAuthenticated, false);
      assert.deepStrictEqual(yield* marker.applyTo(signedIn), signedIn);
      assert.strictEqual(yield* fs.exists(paths.markerPath), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
