import {
  NodeId,
  PlanId,
  RunId,
  ThreadId,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { agentTasksOpen, selectAgentTasks, summarizeAgentTasks } from "./agentTasks.logic";

const runId = RunId.make("run-1");
const startedAt = Date.parse("2026-11-24T10:00:00.000Z");

const todoList = (
  id: string,
  status: OrchestrationV2PlanArtifact["status"],
  steps: ReadonlyArray<OrchestrationV2PlanStep>,
): OrchestrationV2PlanArtifact => ({
  id: PlanId.make(id),
  threadId: ThreadId.make("thread-1"),
  runId,
  nodeId: NodeId.make(`node-${id}`),
  kind: "todo_list",
  status,
  steps,
});

const steps: ReadonlyArray<OrchestrationV2PlanStep> = [
  { id: "a", text: "Explore", status: "completed", durationMs: 40_000 },
  {
    id: "b",
    text: "Implement",
    status: "running",
    durationAnchorAt: new Date(startedAt).toISOString(),
  },
  { id: "c", text: "Verify", status: "pending" },
];

describe("agent tasks", () => {
  it("counts a running step until its run ends, and stays open until every step is done", () => {
    const now = startedAt + 90_000;
    const live = selectAgentTasks({
      plans: [
        todoList("old", "superseded", [{ id: "x", text: "Old", status: "pending" }]),
        todoList("current", "active", steps),
      ],
      runs: [{ id: runId, completedAt: null }],
    });
    expect(live?.steps.map((step) => step.id)).toEqual(["a", "b", "c"]);
    expect(live && summarizeAgentTasks(live, now)).toMatchObject({
      done: 1,
      total: 3,
      current: { id: "b" },
      elapsedMs: 130_000,
      live: true,
    });
    expect(live && agentTasksOpen(live)).toBe(true);

    const stopped = selectAgentTasks({
      plans: [todoList("current", "active", steps)],
      runs: [{ id: runId, completedAt: DateTime.makeUnsafe(startedAt + 30_000) }],
    });
    expect(stopped && summarizeAgentTasks(stopped, now)).toMatchObject({
      elapsedMs: 70_000,
      live: false,
    });
    expect(stopped && agentTasksOpen(stopped)).toBe(true);
    expect(
      agentTasksOpen({
        steps: steps.map((step) => ({ ...step, status: "completed" })),
        stoppedAtMs: null,
      }),
    ).toBe(false);
  });
});
