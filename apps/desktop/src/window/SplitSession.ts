// @effect-diagnostics nodeBuiltinImport:off -- The session is written synchronously from Electron's quit and session-end events, which do not wait for a fiber.
// @effect-diagnostics globalTimers:off -- The debounce runs in Electron window callbacks outside any Effect fiber.
// @effect-diagnostics globalDate:off -- Closing times are wall-clock stamps taken in Electron window callbacks.
import * as NodeFS from "node:fs";

import { defaultSplitWindowState, type SplitView, type SplitWindowState } from "./SplitView.ts";

/**
 * The open windows and their halves, saved so a restart brings them all back.
 * Closing the windows one after another to leave the app must restore all of
 * them, so a window closed shortly before the last one stays in the session;
 * one closed long before is dropped, like in a browser.
 */
const RECENTLY_CLOSED_MS = 2 * 60_000;
const SAVE_DEBOUNCE_MS = 300;

interface SavedSession {
  readonly version: 1;
  readonly windows: readonly SplitWindowState[];
  readonly focusedIndex: number;
}

export interface RestoredSession {
  readonly windows: readonly SplitWindowState[];
  readonly focusedIndex: number;
}

export class SplitSession {
  private readonly filePath: string;
  private readonly warn: (message: string, cause: unknown) => void;
  private readonly info: (message: string, details: Record<string, unknown>) => void;
  /** Open windows, oldest first; this order is the saved order. */
  private readonly open: SplitView[] = [];
  private recentlyClosed: { readonly state: SplitWindowState; readonly closedAt: number }[] = [];
  private lastFocused: SplitView | null = null;
  /** Once the app is going away, closing windows must no longer shrink the saved set. */
  private quitting = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    filePath: string,
    warn: (message: string, cause: unknown) => void,
    info: (message: string, details: Record<string, unknown>) => void = () => {},
  ) {
    this.filePath = filePath;
    this.warn = warn;
    this.info = info;
  }

  read(): RestoredSession {
    let saved: Partial<SavedSession>;
    try {
      saved = JSON.parse(NodeFS.readFileSync(this.filePath, "utf8")) as Partial<SavedSession>;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warn("ignoring unreadable split session", cause);
      }
      return { windows: [], focusedIndex: 0 };
    }
    const windows = Array.isArray(saved.windows) ? saved.windows : [];
    return {
      windows: windows
        .filter((entry) => entry !== null && typeof entry === "object")
        .map((entry) => ({ ...defaultSplitWindowState(), ...entry })),
      focusedIndex: Number.isInteger(saved.focusedIndex) ? (saved.focusedIndex ?? 0) : 0,
    };
  }

  add(view: SplitView, window: Electron.BrowserWindow): void {
    this.open.push(view);
    const save = () => this.save();
    window.on("resized", save);
    window.on("moved", save);
    window.on("maximize", save);
    window.on("unmaximize", save);
    window.on("focus", () => {
      this.lastFocused = view;
      this.save();
    });
    // Log-off and shutdown close every window; they must all come back.
    window.on("query-session-end", () => this.write());
    window.on("session-end", () => this.freeze());
    window.on("close", () => {
      if (this.open.filter((other) => !other.isClosed).length === 1) {
        // The last window closing ends the app, so it stays in the saved set.
        this.freeze();
      } else if (!this.quitting) {
        // The views are gone by "closed", so the state is read now.
        this.recentlyClosed.push({
          state: structuredClone(view.captureState()),
          closedAt: Date.now(),
        });
      }
    });
    window.on("closed", () => {
      this.open.splice(this.open.indexOf(view), 1);
      if (this.lastFocused === view) this.lastFocused = null;
      if (!this.quitting) this.write();
    });
  }

  /** Debounced on every change, because a Windows shutdown may end the process without before-quit. */
  save(): void {
    if (this.quitting) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.write(), SAVE_DEBOUNCE_MS);
  }

  /** Writes the session as it is now and keeps it from changing while windows close. */
  freeze(): void {
    if (this.quitting) return;
    this.write({ withRecentlyClosed: true });
    this.quitting = true;
  }

  private write({ withRecentlyClosed = false } = {}): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const open = this.open.filter((view) => !view.isClosed);
    // Never replace a saved session with nothing; that only happens while the
    // last window is being torn down.
    if (open.length === 0) return;
    const since = Date.now() - RECENTLY_CLOSED_MS;
    const closed = withRecentlyClosed
      ? this.recentlyClosed.filter((entry) => entry.closedAt >= since).map((entry) => entry.state)
      : [];
    const session: SavedSession = {
      version: 1,
      windows: [...closed, ...open.map((view) => view.captureState())],
      focusedIndex: closed.length + Math.max(open.indexOf(this.lastFocused ?? open[0]!), 0),
    };
    try {
      NodeFS.writeFileSync(this.filePath, JSON.stringify(session, null, 2));
      this.info("split session saved", {
        open: open.length,
        recentlyClosed: closed.length,
        quitting: withRecentlyClosed,
      });
    } catch (cause) {
      this.warn("could not save the split session", cause);
    }
  }
}
