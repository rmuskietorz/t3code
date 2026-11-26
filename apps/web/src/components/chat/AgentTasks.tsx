import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleDotIcon,
  CircleIcon,
  PanelRightIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadProjection } from "../../state/entities";
import { Button } from "../ui/button";
import {
  type AgentTasks,
  agentTaskStepElapsedMs,
  agentTasksOpen,
  selectAgentTasks,
  summarizeAgentTasks,
} from "./agentTasks.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

function useAgentTasks(threadRef: ScopedThreadRef | null): AgentTasks | null {
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  return projection === null ? null : selectAgentTasks(projection);
}

/** Renders with the current second only while a step is counting, so a settled list never ticks. */
function WithClock(props: {
  readonly tasks: AgentTasks;
  readonly children: (nowMs: number) => ReactNode;
}) {
  return summarizeAgentTasks(props.tasks, 0).live ? (
    <TickingClock>{props.children}</TickingClock>
  ) : (
    props.children(props.tasks.stoppedAtMs ?? 0)
  );
}

function TickingClock(props: { readonly children: (nowMs: number) => ReactNode }) {
  return props.children(useNowSecond());
}

function StepIcon({ status }: { readonly status: AgentTasks["steps"][number]["status"] }) {
  if (status === "completed") return <CheckIcon className="size-3.5 text-success" aria-hidden />;
  if (status === "running") return <CircleDotIcon className="size-3.5 text-primary" aria-hidden />;
  return <CircleIcon className="size-3.5 text-muted-foreground/60" aria-hidden />;
}

const STEP_STATUS_LABEL = {
  completed: "Done",
  running: "In progress",
  pending: "Pending",
} as const;

function AgentTaskSteps({ tasks, nowMs }: { readonly tasks: AgentTasks; readonly nowMs: number }) {
  return (
    <ol className="flex flex-col gap-0.5">
      {tasks.steps.map((step) => {
        const elapsedMs = agentTaskStepElapsedMs(step, tasks, nowMs);
        return (
          <li
            key={step.id}
            className="flex min-w-0 items-start gap-2 px-2.5 py-1 text-xs"
            aria-label={`${STEP_STATUS_LABEL[step.status]}: ${step.text}`}
          >
            <span className="flex h-4 shrink-0 items-center">
              <StepIcon status={step.status} />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words",
                step.status === "completed" && "text-muted-foreground",
                step.status === "running" && "font-medium text-foreground",
              )}
            >
              {step.text}
            </span>
            {elapsedMs === null ? null : (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatDuration(elapsedMs)}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SummaryText({ tasks, nowMs }: { readonly tasks: AgentTasks; readonly nowMs: number }) {
  const summary = summarizeAgentTasks(tasks, nowMs);
  return (
    <>
      <span className="shrink-0 font-medium text-foreground">
        Tasks {summary.done}/{summary.total}
      </span>
      {summary.current ? (
        <span className="min-w-0 truncate text-muted-foreground">{summary.current.text}</span>
      ) : null}
      <span className="ms-auto shrink-0 tabular-nums text-muted-foreground">
        {formatDuration(summary.elapsedMs)}
      </span>
    </>
  );
}

/** The agent's open todo list above the composer, while its turn works through it. */
export function AgentTasksStrip({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  const tasks = useAgentTasks(threadRef);
  const [expanded, setExpanded] = useState(false);
  if (threadRef === null || tasks === null || !agentTasksOpen(tasks)) return null;
  return (
    <WithClock tasks={tasks}>
      {(nowMs) => (
        <div className="border-b border-border/65 px-2 py-1">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-xs hover:bg-accent"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronDownIcon
                className={cn("size-3.5 shrink-0 text-muted-foreground", !expanded && "-rotate-90")}
                aria-hidden
              />
              <SummaryText tasks={tasks} nowMs={nowMs} />
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open tasks in side panel"
              title="Open tasks in side panel"
              onClick={() => useRightPanelStore.getState().open(threadRef, "tasks")}
            >
              <PanelRightIcon aria-hidden />
            </Button>
          </div>
          {expanded ? (
            <div className="max-h-48 overflow-y-auto pb-1">
              <AgentTaskSteps tasks={tasks} nowMs={nowMs} />
            </div>
          ) : null}
        </div>
      )}
    </WithClock>
  );
}

function AgentTasksEmpty() {
  return (
    <p className="px-2.5 py-1 text-xs text-muted-foreground">
      The agent has not written a todo list in this thread yet.
    </p>
  );
}

/** The right panel's Tasks tab. */
export function AgentTasksPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const tasks = useAgentTasks(threadRef);
  return (
    <div className="h-full overflow-y-auto p-2">
      {tasks === null ? (
        <AgentTasksEmpty />
      ) : (
        <WithClock tasks={tasks}>
          {(nowMs) => (
            <>
              <div className="mb-1 flex min-h-8 min-w-0 items-center gap-2 px-2.5 text-xs">
                <SummaryText tasks={tasks} nowMs={nowMs} />
              </div>
              <AgentTaskSteps tasks={tasks} nowMs={nowMs} />
            </>
          )}
        </WithClock>
      )}
    </div>
  );
}

/** The Tasks section of the thread details card; hidden until the agent writes a list. */
export function ThreadDetailsTasks({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const tasks = useAgentTasks(threadRef);
  if (tasks === null) return null;
  return (
    <WithClock tasks={tasks}>
      {(nowMs) => {
        const summary = summarizeAgentTasks(tasks, nowMs);
        return (
          <ThreadDetailsSection
            headingId="thread-details-tasks-heading"
            title={`Tasks · ${summary.done}/${summary.total} · ${formatDuration(summary.elapsedMs)}`}
            actions={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Open tasks in side panel"
                title="Open tasks in side panel"
                onClick={() => useRightPanelStore.getState().open(threadRef, "tasks")}
              >
                <PanelRightIcon aria-hidden />
              </Button>
            }
          >
            <div className="max-h-56 overflow-y-auto">
              <AgentTaskSteps tasks={tasks} nowMs={nowMs} />
            </div>
          </ThreadDetailsSection>
        );
      }}
    </WithClock>
  );
}
