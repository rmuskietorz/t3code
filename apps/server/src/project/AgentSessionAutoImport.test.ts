import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionAutoImport from "./AgentSessionAutoImport.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";

const makeWorkerTest = (input: {
  readonly intervalMinutes: number;
  readonly opportunistic: { value: boolean };
}) => {
  const runs: Array<{ readonly quietPeriodMs: number }> = [];
  const layer = AgentSessionAutoImport.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AgentSessionImporter.AgentSessionImporter)({
          importAllProjects: (options) =>
            Effect.sync(() => {
              runs.push(options);
              return { projectCount: 1, createdCount: 0, skippedCount: 0 };
            }),
        }),
        ServerSettings.layerTest({
          agentSessionAutoImportIntervalMinutes: input.intervalMinutes,
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunOpportunisticWork: Effect.sync(() => input.opportunistic.value),
        }),
      ),
    ),
  );
  return { layer, runs };
};

const advanceMinutes = (minutes: number) =>
  TestClock.adjust(`${minutes} minutes`).pipe(Effect.andThen(Effect.yieldNow));

it.effect("imports at startup and again once the interval has passed", () => {
  const { layer, runs } = makeWorkerTest({ intervalMinutes: 10, opportunistic: { value: true } });
  return Effect.gen(function* () {
    yield* Effect.yieldNow;
    expect(runs).toHaveLength(1);
    yield* advanceMinutes(9);
    expect(runs).toHaveLength(1);
    yield* advanceMinutes(1);
    expect(runs).toEqual([{ quietPeriodMs: 10 * 60_000 }, { quietPeriodMs: 10 * 60_000 }]);
  }).pipe(Effect.provide(layer));
});

it.effect("waits for a foreground client before a periodic run", () => {
  const opportunistic = { value: false };
  const { layer, runs } = makeWorkerTest({ intervalMinutes: 10, opportunistic });
  return Effect.gen(function* () {
    yield* advanceMinutes(30);
    expect(runs).toHaveLength(1);
    opportunistic.value = true;
    yield* advanceMinutes(1);
    expect(runs).toHaveLength(2);
  }).pipe(Effect.provide(layer));
});

it.effect("never runs while the interval is zero", () => {
  const { layer, runs } = makeWorkerTest({ intervalMinutes: 0, opportunistic: { value: true } });
  return Effect.gen(function* () {
    yield* advanceMinutes(120);
    expect(runs).toEqual([]);
  }).pipe(Effect.provide(layer));
});
