import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type AgentTaskPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

export interface AgentTasks {
  readonly steps: AgentTaskPlan["steps"];
  /** When the list's run ended, so a step left running stops counting; null while it still runs. */
  readonly stoppedAtMs: number | null;
}

/** The agent's latest todo list; a newer list replaces the older one. */
export function selectAgentTasks(projection: {
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "completedAt">>;
}): AgentTasks | null {
  const plan = projection.plans.findLast(
    (candidate): candidate is AgentTaskPlan =>
      candidate.kind === "todo_list" && candidate.status !== "superseded",
  );
  if (plan === undefined || plan.steps.length === 0) return null;
  const completedAt = projection.runs.find((run) => run.id === plan.runId)?.completedAt ?? null;
  return {
    steps: plan.steps,
    stoppedAtMs: completedAt === null ? null : DateTime.toEpochMillis(completedAt),
  };
}

/** Time spent on a step: final once completed, still counting while it runs, null before it starts. */
export function agentTaskStepElapsedMs(
  step: OrchestrationV2PlanStep,
  tasks: AgentTasks,
  nowMs: number,
): number | null {
  if (step.status === "completed") return step.durationMs ?? null;
  if (step.status === "pending" || step.durationAnchorAt === undefined) return null;
  const startedAtMs = Date.parse(step.durationAnchorAt);
  return Number.isFinite(startedAtMs)
    ? Math.max(0, (tasks.stoppedAtMs ?? nowMs) - startedAtMs)
    : null;
}

export interface AgentTaskSummary {
  readonly done: number;
  readonly total: number;
  readonly current: OrchestrationV2PlanStep | null;
  readonly elapsedMs: number;
  /** True while a step runs and its run has not ended, so the clock needs to tick. */
  readonly live: boolean;
}

export function summarizeAgentTasks(tasks: AgentTasks, nowMs: number): AgentTaskSummary {
  let done = 0;
  let elapsedMs = 0;
  for (const step of tasks.steps) {
    if (step.status === "completed") done += 1;
    elapsedMs += agentTaskStepElapsedMs(step, tasks, nowMs) ?? 0;
  }
  const running = tasks.steps.find((step) => step.status === "running") ?? null;
  return {
    done,
    total: tasks.steps.length,
    current: running ?? tasks.steps.find((step) => step.status === "pending") ?? null,
    elapsedMs,
    live: running !== null && tasks.stoppedAtMs === null,
  };
}

/** The composer strip stays while any step is open, across turns and restarts. */
export function agentTasksOpen(tasks: AgentTasks): boolean {
  return tasks.steps.some((step) => step.status !== "completed");
}
