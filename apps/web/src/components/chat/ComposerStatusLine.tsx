import { Fragment, memo, type ReactNode } from "react";

import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";

/** A thin share-of-capacity bar, shared by the context and usage limit segments. */
export function StatusLineBar({
  percent,
  color,
}: {
  readonly percent: number;
  readonly color: string;
}) {
  return (
    <span aria-hidden className="relative h-1.5 w-12 overflow-hidden rounded-full bg-foreground/15">
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: color }}
      />
    </span>
  );
}

/**
 * One line at the bottom of the composer card, or of its model strip while resting, with what the next turn runs on: branch, context
 * use, then the provider's usage limits.
 */
export const ComposerStatusLine = memo(function ComposerStatusLine({
  branch,
  contextWindow,
  usageLimits,
  placement,
}: {
  readonly branch: string | null;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly usageLimits: ReactNode;
  readonly placement: "card" | "strip";
}) {
  const contextPercent = contextWindow?.usedPercentage ?? null;
  const segments: { readonly key: string; readonly node: ReactNode }[] = [];
  if (branch) {
    segments.push({
      key: "branch",
      node: <span className="min-w-0 truncate text-foreground/80">{branch}</span>,
    });
  }
  if (contextPercent !== null) {
    const rounded = Math.round(contextPercent);
    segments.push({
      key: "context",
      node: (
        <span
          className="flex shrink-0 items-center gap-1.5"
          aria-label={`Context window ${rounded}% used`}
        >
          <span>ctx</span>
          <StatusLineBar
            percent={contextPercent}
            color={contextPercent > 90 ? "var(--color-error)" : "var(--color-muted-foreground)"}
          />
          <span className="font-medium text-foreground">{rounded}%</span>
        </span>
      ),
    });
  }
  if (segments.length === 0 && !usageLimits) return null;
  return (
    <div
      data-composer-status-line={placement}
      className={cn(
        "flex min-w-0 items-center justify-center gap-2 text-muted-foreground text-xs whitespace-nowrap tabular-nums",
        placement === "card" ? "-mt-1 px-3 pb-1.5" : "px-1 pt-0.5",
      )}
    >
      {segments.map(({ key, node }, index) => (
        <Fragment key={key}>
          {index > 0 ? (
            <span aria-hidden className="shrink-0 text-muted-foreground/50">
              |
            </span>
          ) : null}
          {node}
        </Fragment>
      ))}
      {usageLimits ? (
        <>
          {segments.length > 0 ? (
            <span aria-hidden className="shrink-0 text-muted-foreground/50">
              |
            </span>
          ) : null}
          <span className="shrink-0">{usageLimits}</span>
        </>
      ) : null}
    </div>
  );
});
