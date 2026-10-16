/**
 * Hook for an embedding shell that shows two app panes side by side, such as
 * a desktop wrapper around this web app. Browsers and the official desktop
 * app do not provide it, so every split view control stays hidden there.
 */
export interface SplitViewHost {
  readonly toggle: () => void;
  /** Opens an in-app path in the other pane, splitting the window first if needed. */
  readonly openInOtherPane: (path: string) => void;
}

export function readSplitViewHost(): SplitViewHost | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { readonly t3SplitView?: SplitViewHost }).t3SplitView ?? null;
}
