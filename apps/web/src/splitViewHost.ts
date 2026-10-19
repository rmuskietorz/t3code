import { useSyncExternalStore } from "react";

/**
 * Hook for an embedding shell that shows two app panes side by side, such as
 * a desktop wrapper around this web app. Browsers and the official desktop
 * app do not provide it, so every split view control stays hidden there.
 * The shell proxies these calls across a process boundary, so call them with
 * plain values only, never with DOM events.
 */
export interface SplitViewHost {
  readonly toggle: () => void;
  /** Opens an in-app path in the other pane, splitting the window first if needed. */
  readonly openInOtherPane: (path: string) => void;
  /** Closes the pane this app runs in; the other pane takes the whole window. */
  readonly closeThisPane: () => void;
  /** Parks the pane this app runs in as a tab the shell can restore later. */
  readonly minimizeThisPane: () => void;
  /** Opens an in-app path in a new shell window. */
  readonly openInNewWindow: (path: string) => void;
  /**
   * Tells the shell which sidebar profile this pane shows. The pane keeps it in
   * sessionStorage, which the shell's pane dies with, so the shell saves it to
   * reopen the pane on it. Optional, because older shells lack it.
   */
  readonly reportSidebarProfile?: (key: string) => void;
  /** Tells the shell this pane's thread title, which labels the pane once minimized. Optional. */
  readonly reportPaneTitle?: (title: string | null) => void;
  readonly isSplit: () => boolean;
  readonly subscribe: (onChange: () => void) => () => void;
}

export function readSplitViewHost(): SplitViewHost | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { readonly t3SplitView?: SplitViewHost }).t3SplitView ?? null;
}

const noSubscription = () => () => {};

/** Whether the shell currently shows two panes; always false without one. */
export function useSplitViewActive(): boolean {
  const host = readSplitViewHost();
  return useSyncExternalStore(
    host?.subscribe ?? noSubscription,
    () => host?.isSplit() ?? false,
    () => false,
  );
}
