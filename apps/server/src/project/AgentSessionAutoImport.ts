import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";

/**
 * A later run never adds messages to a thread it already imported, so a
 * periodic run leaves a session alone until it has been idle this long.
 */
export const AUTO_IMPORT_QUIET_PERIOD = Duration.minutes(10);
/** Checking every minute lets a changed interval apply without a restart. */
const TICK = Duration.minutes(1);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;

    const intervalMs = settingsService.getSettings.pipe(
      Effect.map((settings) =>
        Duration.toMillis(Duration.minutes(settings.agentSessionAutoImportIntervalMinutes)),
      ),
      Effect.orElseSucceed(() => 0),
    );
    const run = importer
      .importAllProjects({ quietPeriodMs: Duration.toMillis(AUTO_IMPORT_QUIET_PERIOD) })
      .pipe(
        Effect.tap((result) =>
          result.createdCount > 0
            ? Effect.logInfo("Imported new agent sessions", result)
            : Effect.void,
        ),
        Effect.ignoreCause({ log: true }),
      );

    yield* forkParked(
      Effect.gen(function* () {
        let lastRunAt = yield* Clock.currentTimeMillis;
        // The startup run skips the background policy: no client has connected yet.
        if ((yield* intervalMs) > 0) yield* run;
        return yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(TICK);
            const interval = yield* intervalMs;
            const now = yield* Clock.currentTimeMillis;
            if (interval === 0 || now - lastRunAt < interval) return;
            if (!(yield* backgroundPolicy.shouldRunOpportunisticWork)) return;
            lastRunAt = now;
            yield* run;
          }),
        );
      }),
    );
  }),
);
