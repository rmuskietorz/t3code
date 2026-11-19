import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/**
 * Claude's capability probe only proves that a token exists, so an expired or revoked login
 * still reports itself as signed in. A turn that fails authentication is the reliable signal.
 * The marker remembers it on disk, so a restarted server still reports the sign-out, until the
 * login file changes or a turn authenticates again.
 */
export const makeClaudeSignedOutMarker = Effect.fn("makeClaudeSignedOutMarker")(function* (input: {
  readonly markerPath: string;
  readonly credentialsPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  // macOS keeps the login in the keychain, so there the stamp never changes and only a
  // successful turn clears the marker.
  const credentialsStamp = fs.stat(input.credentialsPath).pipe(
    Effect.map(
      (info) => `${Option.getOrUndefined(info.mtime)?.getTime() ?? ""}:${String(info.size)}`,
    ),
    Effect.orElseSucceed(() => "missing"),
  );
  const stored = yield* fs.readFileString(input.markerPath).pipe(
    Effect.map((content) => content.trim()),
    Effect.orElseSucceed(() => undefined),
  );
  const markerRef = yield* Ref.make<string | undefined>(stored);

  const persist = (stamp: string | undefined) =>
    (stamp === undefined
      ? fs.remove(input.markerPath, { force: true })
      : fs.writeFileString(input.markerPath, stamp)
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not persist the Claude sign-out marker.", {
          markerPath: input.markerPath,
          cause,
        }),
      ),
    );

  /** Returns whether the marker changed, so callers only refresh on a transition. */
  const set = Effect.fn("ClaudeSignedOut.set")(function* (signedOut: boolean) {
    const next = signedOut ? yield* credentialsStamp : undefined;
    const previous = yield* Ref.getAndSet(markerRef, next);
    if (previous === next) return false;
    yield* persist(next);
    return (previous === undefined) !== (next === undefined);
  });

  const isSignedOut = Effect.gen(function* () {
    const marker = yield* Ref.get(markerRef);
    if (marker === undefined) return false;
    if (marker === (yield* credentialsStamp)) return true;
    yield* set(false);
    return false;
  });

  return {
    markSignedOut: set(true),
    markAuthenticated: set(false),
    applyTo: (snapshot: ServerProvider): Effect.Effect<ServerProvider> =>
      !snapshot.enabled || !snapshot.installed
        ? Effect.succeed(snapshot)
        : isSignedOut.pipe(
            Effect.map((signedOut) =>
              signedOut
                ? {
                    ...snapshot,
                    status: "error" as const,
                    auth: { status: "unauthenticated" as const },
                    message:
                      "Claude Code was signed out. Run `claude auth login` to sign in again.",
                  }
                : snapshot,
            ),
          ),
  };
});
