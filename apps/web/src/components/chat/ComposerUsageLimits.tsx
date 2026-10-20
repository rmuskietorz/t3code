import type { EnvironmentId, UsageLimitsReport } from "@t3tools/contracts";
import {
  formatDuration,
  formatResetsIn,
  limitsNotice,
  resetMillis,
  type UsageLimitsIndicator,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { memo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor, LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import { StatusLineBar } from "./ComposerStatusLine";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (!account.instanceId) return account.label;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const label = accountLabel(account);
  return (
    <>
      {label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel="Toggle account label visibility"
          revealTooltip="Click to reveal account"
          hideTooltip="Click to hide account"
          className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
        />
      ) : (
        label
      )}
      {account.plan ? ` · ${account.plan}` : null}
    </>
  );
}

export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  onDismiss: () => void,
): ComposerBannerStackItem {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 && first ? first : null;
  const summary = single ? (
    <AccountSummary account={single} />
  ) : (
    `${report.accounts.length} accounts`
  );
  return {
    id,
    variant: "info",
    priority: "notice",
    icon: <GaugeIcon />,
    title: "Usage limits",
    description: summary,
    dismissLabel: "Dismiss usage limits",
    onDismiss,
    children: <UsageLimitsBannerBody report={report} environmentId={environmentId} />,
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
}) {
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
        {report.accounts.map((account) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const notice = limitsNotice(account.limits);
          const externalUsage = account.limits.externalUsage;
          return (
            <div key={account.id} className="flex min-w-0 flex-col gap-1">
              {report.accounts.length > 1 ? (
                <span className="truncate text-xs text-muted-foreground">
                  <AccountSummary account={account} />
                </span>
              ) : null}
              {notice ? (
                <span className="text-xs text-muted-foreground">{notice}</span>
              ) : (
                <LimitWindows
                  compact
                  driver={account.driver}
                  windows={account.limits.windows}
                  now={now}
                />
              )}
              {externalUsage ? (
                <Button
                  size="sm"
                  variant="link"
                  className="self-start"
                  onClick={() => void ensureLocalApi().shell.openExternal(externalUsage.url)}
                >
                  Manage usage
                </Button>
              ) : null}
              {resetCreditInput && account.limits.resetCredits ? (
                <ResetCredits
                  environmentId={environmentId}
                  input={resetCreditInput}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </div>
          );
        })}
        {report.notices.map((notice) => (
          <span key={notice} className="text-xs text-muted-foreground">
            {notice}
          </span>
        ))}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}

function UsageLimitsIndicatorDetails({
  indicator,
  now,
}: {
  readonly indicator: UsageLimitsIndicator;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  return (
    <div className="flex flex-col gap-1">
      {indicator.windows.map(({ window, usedPercent }) => {
        const resetsIn = formatResetsIn(window, now);
        return (
          <span key={window.id} className="flex flex-col tabular-nums">
            <span className="text-foreground">
              {window.label}: {usedPercent}% used
            </span>
            {window.resetsAt ? (
              <span className="text-muted-foreground">
                Resets {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
                {resetsIn ? ` · ${resetsIn}` : ""}
              </span>
            ) : null}
          </span>
        );
      })}
      {indicator.stale ? (
        <span className="text-muted-foreground">Last check is out of date.</span>
      ) : null}
    </div>
  );
}

/** The usage limits segment of the composer status line: label, used bar, used share and time to reset per window. */
export const ComposerUsageLimitsIndicator = memo(function ComposerUsageLimitsIndicator({
  indicator,
  open,
  onToggle,
}: {
  readonly indicator: UsageLimitsIndicator;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  // Countdowns follow the shared minute clock instead of a timer of their own.
  const now = Date.parse(`${useNowMinute()}Z`);
  const color = barColor(indicator.driver);
  const summary = indicator.windows
    .map(({ window, usedPercent }) => `${window.label} ${usedPercent}% used`)
    .join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={`Usage limits: ${summary}`}
            aria-expanded={open}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onToggle}
          />
        }
      >
        <span
          className={cn(
            "flex items-center gap-2 whitespace-nowrap tabular-nums",
            indicator.stale && "opacity-50",
          )}
        >
          {indicator.windows.map(({ window, shortLabel, usedPercent }, index) => {
            const resetsAt = resetMillis(window);
            return (
              <span key={window.id} className="flex items-center gap-1.5">
                {index > 0 ? <span aria-hidden>·</span> : null}
                <span>{shortLabel}</span>
                <StatusLineBar percent={usedPercent} color={color} />
                <span className="font-medium text-foreground">{usedPercent}%</span>
                {resetsAt !== null && resetsAt > now ? (
                  <span className="hidden sm:inline">{formatDuration(resetsAt - now)}</span>
                ) : null}
              </span>
            );
          })}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <UsageLimitsIndicatorDetails indicator={indicator} now={now} />
      </TooltipPopup>
    </Tooltip>
  );
});
