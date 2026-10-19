// @effect-diagnostics globalTimers:off -- The divider follows the cursor from Electron callbacks outside any Effect fiber.
import * as Electron from "electron";

import { activeRenderer, registerPane, setActivePane } from "./RendererContents.ts";

/**
 * One window shows the app once or as two independent halves. A half can be
 * minimized into a tab bar along the bottom and restored on either side. Every
 * half is a full app renderer, so each keeps its own native preview browser.
 */

export const SPLIT_TOGGLE_CHANNEL = "split:toggle";
export const SPLIT_OPEN_CHANNEL = "split:open";
export const SPLIT_CLOSE_CHANNEL = "split:close";
export const SPLIT_MINIMIZE_CHANNEL = "split:minimize";
export const SPLIT_OPEN_WINDOW_CHANNEL = "window:open";
export const SPLIT_STATE_CHANNEL = "split:state";
export const PANE_PROFILE_CHANNEL = "pane:profile";
export const PANE_PROFILE_INITIAL_CHANNEL = "pane:profile-initial";
export const PANE_TITLE_CHANNEL = "pane:title";
export const DIVIDER_START_CHANNEL = "divider:start";
export const DIVIDER_END_CHANNEL = "divider:end";
export const STRIP_TABS_CHANNEL = "strip:tabs";
export const STRIP_RESTORE_CHANNEL = "strip:restore";
export const STRIP_CLOSE_CHANNEL = "strip:close";

const DIVIDER_WIDTH = 6;
const MIN_PANE_WIDTH = 360;
const STRIP_HEIGHT = 30;
// A page with the sidebar but no composer, so a fresh half never opens a
// thread or draft that the other half already shows.
export const NEUTRAL_PATH = "/pull-requests";

export type PaneSide = "left" | "right";

export interface ParkedTabState {
  readonly path: string;
  readonly title: string;
  readonly side: PaneSide;
  readonly profile: string | null;
}

export interface SplitWindowState {
  bounds: Electron.Rectangle | null;
  maximized: boolean;
  split: boolean;
  ratio: number;
  leftPath: string | null;
  rightPath: string | null;
  leftProfile: string | null;
  rightProfile: string | null;
  parked: ParkedTabState[];
}

export function defaultSplitWindowState(): SplitWindowState {
  return {
    bounds: null,
    maximized: false,
    split: false,
    ratio: 0.5,
    leftPath: null,
    rightPath: null,
    leftProfile: null,
    rightProfile: null,
    parked: [],
  };
}

/** The in-app route of a renderer URL; the renderer uses hash routing. */
export function appPathOf(url: string, appOrigin: string): string | null {
  try {
    const parsed = new URL(url);
    // Node reports "null" as the origin of a custom scheme, so compare its parts.
    if (`${parsed.protocol}//${parsed.host}` !== appOrigin) return null;
    const path = parsed.hash.startsWith("#/") ? parsed.hash.slice(1) : "/";
    return path.startsWith("/pair") ? null : path;
  } catch {
    return null;
  }
}

/** Routes with a composer; the same one must not be open in both halves. */
export function composerKey(path: string | null): string | null {
  if (path === null) return null;
  const pathname = path.split(/[?#]/)[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] === "settings" || segments[0] === "projects") {
    return null;
  }
  return pathname;
}

function fallbackTitle(path: string): string {
  const [first, ...rest] = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  if (first === "pull-requests") return "Pull requests";
  if (first === "settings") return "Settings";
  if (first === "projects") return "Project";
  if (first === "draft") return "Draft";
  return rest.length === 1 ? "Thread" : "T3 Code";
}

interface PaneView extends Electron.WebContentsView {
  /** The sidebar profile the page keeps in sessionStorage, which dies with the view. */
  sidebarProfile: string | null;
  /** The thread title the page last reported, for its tab once minimized. */
  paneTitle: string | null;
}

interface ParkedTab {
  readonly id: number;
  readonly path: string;
  title: string;
  readonly side: PaneSide;
  /** A tab minimized in this run keeps its live view; one restored from disk gets a new one. */
  readonly view: PaneView | null;
  readonly profile: string | null;
}

export interface SplitViewOptions {
  readonly window: Electron.BrowserWindow;
  readonly state: SplitWindowState;
  readonly appOrigin: string;
  readonly background: string;
  readonly chromePreloadPath: string;
  /** A pane view with the app preload and the renderer wiring every app page needs. */
  readonly createPaneView: () => Electron.WebContentsView;
  readonly openWindow: (path: string) => void;
  readonly onStateChange: () => void;
}

const isShortcut = (input: Electron.Input, code: string) =>
  // Ctrl+Alt is AltGr on German layouts, which types nothing for S or N.
  input.type === "keyDown" && input.control && input.alt && !input.shift && input.code === code;

const paneViews = new Map<number, PaneView>();
const controllers = new Map<number, SplitView>();
let nextTabId = 1;

function destroyView(view: Electron.WebContentsView | null | undefined) {
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
}

export class SplitView {
  readonly state: SplitWindowState;
  private readonly options: SplitViewOptions;
  private leftView: PaneView;
  private rightView: PaneView | null = null;
  private dividerView: Electron.WebContentsView | null = null;
  private readonly stripView: Electron.WebContentsView;
  private dragTimer: ReturnType<typeof setInterval> | null = null;
  private parkedTabs: ParkedTab[];
  private closed = false;

  constructor(options: SplitViewOptions) {
    this.options = options;
    this.state = options.state;
    const { window } = options;
    // The state is saved while the window is set up, before any page loads,
    // so the view must carry its saved profile from the start.
    this.leftView = this.createPane(this.state.leftProfile);
    window.contentView.addChildView(this.leftView);
    this.parkedTabs = this.state.parked.map((tab) => ({ ...tab, id: nextTabId++, view: null }));
    this.stripView = this.createChrome(stripPage(options.background));
    this.stripView.webContents.on("did-finish-load", () => this.renderStrip());
    window.contentView.addChildView(this.stripView);
    this.layout();
    window.on("resize", () => this.layout());
    // The window's own page is only a backdrop; keyboard focus belongs to a half.
    window.on("focus", () => {
      const active = activeRenderer(window);
      if (active !== window.webContents && !active.isDestroyed()) active.focus();
    });
    window.on("closed", () => {
      this.closed = true;
      if (this.dragTimer !== null) clearInterval(this.dragTimer);
      this.dragTimer = null;
      controllers.delete(window.id);
      // Parked halves are not attached to the window, so each one is closed
      // here or its renderer leaks.
      for (const view of [
        this.leftView,
        this.rightView,
        this.dividerView,
        this.stripView,
        ...this.parkedTabs.map((tab) => tab.view),
      ]) {
        destroyView(view);
      }
    });
    controllers.set(window.id, this);
  }

  get leftContents(): Electron.WebContents {
    return this.leftView.webContents;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  ownsPane(contents: Electron.WebContents): boolean {
    return (
      this.leftView.webContents === contents ||
      this.rightView?.webContents === contents ||
      this.parkedTabs.some((tab) => tab.view?.webContents === contents)
    );
  }

  /** A pane reported something worth saving, such as its sidebar profile. */
  notifyChanged(): void {
    this.save();
  }

  /** Loads the saved halves; a split whose halves share a composer opens neutral on the right. */
  load(initialPath: string | null = null): void {
    const leftPath = initialPath ?? this.state.leftPath ?? "/";
    void this.leftView.webContents.loadURL(this.url(leftPath));
    this.focus(this.leftView);
    if (!this.state.split) return;
    const rightPath = this.state.rightPath;
    const sameComposer =
      rightPath !== null &&
      composerKey(rightPath) !== null &&
      composerKey(rightPath) === composerKey(leftPath);
    this.setSplit(true, sameComposer || rightPath === null ? NEUTRAL_PATH : rightPath);
  }

  /** Reads what lives in Electron rather than in this controller into the saved state. */
  captureState(): SplitWindowState {
    const { window } = this.options;
    if (!window.isDestroyed()) {
      this.state.bounds = window.getNormalBounds();
      this.state.maximized = window.isMaximized();
    }
    // Halves swap sides (closing the left one promotes the right), so paths
    // are read from whichever view sits there now. A pane on a page that must
    // not be restored keeps its last restorable path.
    for (const [view, key] of [
      [this.leftView, "leftPath"],
      [this.rightView, "rightPath"],
    ] as const) {
      if (!view || view.webContents.isDestroyed()) continue;
      const path = appPathOf(view.webContents.getURL(), this.options.appOrigin);
      if (path) this.state[key] = path;
    }
    // Like the paths, a missing right half keeps its last profile for reopening.
    this.state.leftProfile = this.leftView.sidebarProfile;
    if (this.rightView) this.state.rightProfile = this.rightView.sidebarProfile;
    return this.state;
  }

  private url(path: string): string {
    return `${this.options.appOrigin}/#${path.startsWith("/") ? path : `/${path}`}`;
  }

  private pathOf(view: Electron.WebContentsView): string | null {
    return appPathOf(view.webContents.getURL(), this.options.appOrigin);
  }

  private save(): void {
    if (!this.closed) this.options.onStateChange();
  }

  private createPane(initialProfile: string | null): PaneView {
    const view = this.options.createPaneView() as PaneView;
    view.sidebarProfile = initialProfile;
    view.paneTitle = null;
    const contents = view.webContents;
    // A destroyed view no longer has webContents, so the id is read up front.
    const id = contents.id;
    paneViews.set(id, view);
    contents.once("destroyed", () => paneViews.delete(id));
    registerPane(this.options.window, view);
    view.setBackgroundColor(this.options.background);
    contents.on("before-input-event", (event, input) => {
      if (this.closed) return;
      if (isShortcut(input, "KeyS")) {
        event.preventDefault();
        this.setSplit(!this.state.split);
      } else if (isShortcut(input, "KeyN")) {
        event.preventDefault();
        this.options.openWindow(NEUTRAL_PATH);
      }
    });
    const onNavigated = () => {
      if (this.closed || (view !== this.leftView && view !== this.rightView)) return;
      if (!this.resolveConflict(view)) this.save();
    };
    contents.on("did-navigate", onNavigated);
    contents.on("did-navigate-in-page", onNavigated);
    // A reload starts the page's preload over, so tell it again.
    contents.on("did-finish-load", () => contents.send(SPLIT_STATE_CHANNEL, this.state.split));
    return view;
  }

  private createChrome(html: string): Electron.WebContentsView {
    const view = new Electron.WebContentsView({
      webPreferences: {
        preload: this.options.chromePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    controllersByChrome.set(view.webContents.id, this);
    const id = view.webContents.id;
    view.webContents.once("destroyed", () => controllersByChrome.delete(id));
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return view;
  }

  private layout(): void {
    if (this.closed) return;
    const { width, height: contentHeight } = this.options.window.getContentBounds();
    const strip = this.parkedTabs.length > 0;
    const height = strip ? contentHeight - STRIP_HEIGHT : contentHeight;
    this.stripView.setBounds(
      strip
        ? { x: 0, y: height, width, height: STRIP_HEIGHT }
        : { x: 0, y: contentHeight, width, height: 0 },
    );
    if (!this.state.split || !this.rightView || !this.dividerView) {
      this.leftView.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    const leftWidth = Math.round(
      Math.min(
        Math.max(width * this.state.ratio, MIN_PANE_WIDTH),
        width - MIN_PANE_WIDTH - DIVIDER_WIDTH,
      ),
    );
    this.leftView.setBounds({ x: 0, y: 0, width: leftWidth, height });
    this.rightView.setBounds({
      x: leftWidth + DIVIDER_WIDTH,
      y: 0,
      width: width - leftWidth - DIVIDER_WIDTH,
      height,
    });
    // While dragging, the divider covers the window so the release lands on it.
    this.dividerView.setBounds(
      this.dragTimer === null
        ? { x: leftWidth, y: 0, width: DIVIDER_WIDTH, height }
        : { x: 0, y: 0, width, height },
    );
  }

  private broadcastSplitState(): void {
    for (const view of [this.leftView, this.rightView]) {
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.send(SPLIT_STATE_CHANNEL, this.state.split);
      }
    }
  }

  private focus(view: PaneView): void {
    view.webContents.focus();
    setActivePane(this.options.window, view.webContents);
  }

  private showInfo(message: string, detail: string): void {
    void Electron.dialog.showMessageBox(this.options.window, {
      type: "info",
      title: "T3 Code",
      message,
      detail,
    });
  }

  // Scoped to one window on purpose: the same thread open in two windows is
  // accepted, only two halves of one window may not share a composer.
  private resolveConflict(view: PaneView): boolean {
    const other = view === this.leftView ? this.rightView : this.leftView;
    if (!this.state.split || !other) return false;
    const key = composerKey(this.pathOf(view));
    if (key === null || key !== composerKey(this.pathOf(other))) return false;
    const history = view.webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
    else void view.webContents.loadURL(this.url(NEUTRAL_PATH));
    this.focus(other);
    this.showInfo(
      "This thread is already open in the other half.",
      "A thread opens in one half at a time, so two composers never write to it at once.",
    );
    return true;
  }

  /** Shows `view` as the right half, adding the divider. */
  private attachRight(view: PaneView): void {
    this.rightView = view;
    this.dividerView = this.createChrome(dividerPage());
    this.dividerView.setBackgroundColor("#00000000");
    this.options.window.contentView.addChildView(view);
    this.options.window.contentView.addChildView(this.dividerView);
    this.state.split = true;
    this.save();
    this.layout();
    this.broadcastSplitState();
    this.focus(view);
  }

  /** Takes the right half out of the window and returns its still-living view. */
  private detachRight(): PaneView | null {
    const view = this.rightView;
    if (!view) return null;
    // Remember where the half was, so reopening the split returns there.
    this.captureState();
    if (this.dragTimer !== null) clearInterval(this.dragTimer);
    this.dragTimer = null;
    this.options.window.contentView.removeChildView(view);
    if (this.dividerView) this.options.window.contentView.removeChildView(this.dividerView);
    destroyView(this.dividerView);
    this.rightView = null;
    this.dividerView = null;
    this.state.split = false;
    this.save();
    this.layout();
    this.broadcastSplitState();
    this.focus(this.leftView);
    return view;
  }

  /** Takes the left half out; the right half becomes the only one. */
  private detachLeft(): PaneView | null {
    const view = this.leftView;
    const promoted = this.detachRight();
    if (!promoted) return null;
    this.options.window.contentView.removeChildView(view);
    this.leftView = promoted;
    this.options.window.contentView.addChildView(promoted, 0);
    this.layout();
    this.broadcastSplitState();
    this.focus(promoted);
    return view;
  }

  setSplit(split: boolean, initialRightPath: string | null = null): void {
    if (!split) {
      destroyView(this.detachRight());
      return;
    }
    if (this.rightView) return;
    const candidate = initialRightPath ?? this.state.rightPath;
    const path =
      candidate && composerKey(candidate) !== composerKey(this.pathOf(this.leftView))
        ? candidate
        : NEUTRAL_PATH;
    const view = this.createPane(path === candidate ? this.state.rightProfile : null);
    this.attachRight(view);
    void view.webContents.loadURL(this.url(path));
  }

  private closePane(contents: Electron.WebContents): void {
    if (!this.rightView) return;
    destroyView(contents === this.rightView.webContents ? this.detachRight() : this.detachLeft());
  }

  private minimizePane(contents: Electron.WebContents): void {
    if (!this.rightView) return;
    if (contents === this.rightView.webContents) this.park(this.detachRight(), "right");
    else this.park(this.detachLeft(), "left");
  }

  /** Opens an in-app path in the half that did not ask for it. */
  private async openInOtherPane(sender: Electron.WebContents, path: string): Promise<void> {
    if (!this.rightView) {
      // A fresh right half, so only the left one can already show the thread.
      if (composerKey(this.pathOf(this.leftView)) === composerKey(path)) {
        await this.leftView.webContents.loadURL(this.url(NEUTRAL_PATH));
      }
      if (!this.closed) this.setSplit(true, path);
      return;
    }
    const fromLeft = sender === this.leftView.webContents;
    const source = fromLeft ? this.leftView : this.rightView;
    const target = fromLeft ? this.rightView : this.leftView;
    // Move the thread rather than trip the one-composer-per-thread check.
    if (composerKey(this.pathOf(source)) === composerKey(path)) {
      await source.webContents.loadURL(this.url(NEUTRAL_PATH));
    }
    if (this.closed || target.webContents.isDestroyed()) return;
    await target.webContents.loadURL(this.url(path));
    if (!target.webContents.isDestroyed()) this.focus(target);
  }

  private persistParked(): void {
    this.state.parked = this.parkedTabs.map(({ path, title, side, view, profile }) => ({
      path,
      title,
      side,
      profile: view?.sidebarProfile ?? profile,
    }));
    this.save();
  }

  private renderStrip(): void {
    if (this.stripView.webContents.isDestroyed()) return;
    this.stripView.webContents.send(
      STRIP_TABS_CHANNEL,
      this.parkedTabs.map(({ id, title, side }) => ({ id, title, side })),
    );
  }

  /** `side` is the half the view was minimized from, and the one it restores into. */
  private park(view: PaneView | null, side: PaneSide): void {
    if (!view) return;
    const path = this.pathOf(view) ?? NEUTRAL_PATH;
    this.parkedTabs.push({
      id: nextTabId++,
      path,
      title: view.paneTitle ?? fallbackTitle(path),
      side,
      view,
      profile: view.sidebarProfile,
    });
    this.persistParked();
    this.renderStrip();
    this.layout();
  }

  /** Puts `view` in the left half and returns the view it replaced, still alive. */
  private replaceLeft(view: PaneView): PaneView {
    const previous = this.leftView;
    this.options.window.contentView.removeChildView(previous);
    this.leftView = view;
    this.options.window.contentView.addChildView(view, 0);
    this.layout();
    this.broadcastSplitState();
    this.focus(view);
    return previous;
  }

  private restoreTab(id: number): void {
    const tab = this.parkedTabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    // Only the half that stays visible matters; the one swapped out is parked.
    const other = tab.side === "left" ? this.rightView : this.leftView;
    const key = composerKey(tab.path);
    if (other && key !== null && key === composerKey(this.pathOf(other))) {
      const otherSide = tab.side === "left" ? "right" : "left";
      this.focus(other);
      this.showInfo(
        `This thread is already open on the ${otherSide}.`,
        `Close or switch the ${otherSide} half first, then restore the tab.`,
      );
      return;
    }
    this.parkedTabs = this.parkedTabs.filter((candidate) => candidate !== tab);
    const view = tab.view ?? this.createPane(tab.profile);
    if (tab.side === "left") {
      // The left half always exists, so restoring into it is always a swap.
      this.park(this.replaceLeft(view), "left");
    } else {
      if (this.rightView) this.park(this.detachRight(), "right");
      this.attachRight(view);
    }
    if (!tab.view) {
      void view.webContents.loadURL(this.url(tab.path));
      // captureState skips a view that has not committed a URL yet, so a save
      // before the load finishes would otherwise keep the swapped-out page.
      this.state[tab.side === "left" ? "leftPath" : "rightPath"] = tab.path;
    }
    this.persistParked();
    this.renderStrip();
    this.layout();
  }

  private closeTab(id: number): void {
    const tab = this.parkedTabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    this.parkedTabs = this.parkedTabs.filter((candidate) => candidate !== tab);
    destroyView(tab.view);
    this.persistParked();
    this.renderStrip();
    this.layout();
  }

  private startDrag(): void {
    if (this.dragTimer !== null) return;
    this.dragTimer = setInterval(() => {
      const cursor = Electron.screen.getCursorScreenPoint();
      const bounds = this.options.window.getContentBounds();
      this.state.ratio = Math.min(Math.max((cursor.x - bounds.x) / bounds.width, 0), 1);
      this.layout();
    }, 16);
    this.layout();
  }

  private endDrag(): void {
    if (this.dragTimer !== null) clearInterval(this.dragTimer);
    this.dragTimer = null;
    this.layout();
    this.save();
  }

  /** @internal Routed by the IPC handlers below. */
  static handle(channel: string, sender: Electron.WebContents, args: readonly unknown[]): void {
    const pane = paneViews.get(sender.id);
    const owner = pane ? paneController(sender) : controllersByChrome.get(sender.id);
    if (!owner || owner.closed) return;
    const [value] = args;
    const isAppPath = typeof value === "string" && value.startsWith("/");
    switch (channel) {
      case SPLIT_TOGGLE_CHANNEL:
        return owner.setSplit(!owner.state.split);
      case SPLIT_CLOSE_CHANNEL:
        return owner.closePane(sender);
      case SPLIT_MINIMIZE_CHANNEL:
        return owner.minimizePane(sender);
      case SPLIT_OPEN_CHANNEL:
        if (isAppPath) void owner.openInOtherPane(sender, value);
        return;
      case SPLIT_OPEN_WINDOW_CHANNEL:
        // No cross-window composer check: one thread open in two windows is accepted.
        if (isAppPath) owner.options.openWindow(value);
        return;
      case DIVIDER_START_CHANNEL:
        return owner.startDrag();
      case DIVIDER_END_CHANNEL:
        return owner.endDrag();
      case STRIP_RESTORE_CHANNEL:
        return owner.restoreTab(Number(value));
      case STRIP_CLOSE_CHANNEL:
        return owner.closeTab(Number(value));
    }
  }
}

const controllersByChrome = new Map<number, SplitView>();

function paneController(contents: Electron.WebContents): SplitView | undefined {
  for (const controller of controllers.values()) {
    if (controller.ownsPane(contents)) return controller;
  }
  return undefined;
}

let ipcInstalled = false;

/** Routes split view messages to the window that owns the sender. Runs once per process. */
export function installSplitViewIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  for (const channel of [
    SPLIT_TOGGLE_CHANNEL,
    SPLIT_OPEN_CHANNEL,
    SPLIT_CLOSE_CHANNEL,
    SPLIT_MINIMIZE_CHANNEL,
    SPLIT_OPEN_WINDOW_CHANNEL,
    DIVIDER_START_CHANNEL,
    DIVIDER_END_CHANNEL,
    STRIP_RESTORE_CHANNEL,
    STRIP_CLOSE_CHANNEL,
  ]) {
    Electron.ipcMain.on(channel, (event, ...args) => SplitView.handle(channel, event.sender, args));
  }
  // Answered before the page's own scripts run, so it must be synchronous.
  Electron.ipcMain.on(PANE_PROFILE_INITIAL_CHANNEL, (event) => {
    event.returnValue = paneViews.get(event.sender.id)?.sidebarProfile ?? null;
  });
  Electron.ipcMain.on(PANE_PROFILE_CHANNEL, (event, value: unknown) => {
    const view = paneViews.get(event.sender.id);
    if (!view || typeof value !== "string") return;
    view.sidebarProfile = value;
    paneController(event.sender)?.notifyChanged();
  });
  Electron.ipcMain.on(PANE_TITLE_CHANNEL, (event, value: unknown) => {
    const view = paneViews.get(event.sender.id);
    if (!view) return;
    view.paneTitle = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  });
}

function dividerPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
#handle{position:absolute;inset:0 auto 0 0;width:${DIVIDER_WIDTH}px;cursor:col-resize;background:#2a2a2a}
#handle:hover{background:#1db1a3}
body.dragging,body.dragging #handle{cursor:col-resize}
body.dragging #handle{width:100%;background:transparent}
</style></head><body><div id="handle"></div><script>
const handle=document.getElementById("handle");let dragging=false;
handle.addEventListener("pointerdown",(event)=>{dragging=true;handle.setPointerCapture(event.pointerId);document.body.classList.add("dragging");window.splitChrome.dividerStart();});
const finish=()=>{if(!dragging)return;dragging=false;document.body.classList.remove("dragging");window.splitChrome.dividerEnd();};
handle.addEventListener("pointerup",finish);handle.addEventListener("pointercancel",finish);handle.addEventListener("lostpointercapture",finish);
</script></body></html>`;
}

function stripPage(background: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${background};overflow:hidden}
body{display:flex;align-items:center;gap:4px;padding:0 6px;border-top:1px solid #2a2a2a;font:12px system-ui;color:#bbb;box-sizing:border-box}
#label{color:#777;margin-right:4px;white-space:nowrap}
#tabs{display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none}
.group{color:#777;white-space:nowrap;flex:none;padding:0 2px}
.separator{width:1px;height:16px;background:#333;margin:0 4px;flex:none}
.tab{flex:none;display:flex;align-items:center;gap:6px;height:22px;max-width:260px;padding:0 4px 0 8px;border-radius:5px;background:#222;cursor:pointer;white-space:nowrap}
.tab:hover{background:#2c2c2c;color:#fff}
.title{overflow:hidden;text-overflow:ellipsis}
.close{border:0;background:transparent;color:#888;width:16px;height:16px;padding:0;border-radius:3px;cursor:pointer;font:11px/16px system-ui;flex:none}
.close:hover{background:#c0392b;color:#fff}
</style></head><body><span id="label">Minimized</span><div id="tabs"></div><script>
const container=document.getElementById("tabs");
const SIDES=[{side:"left",label:"Left"},{side:"right",label:"Right"}];
const renderTab=(tab)=>{const element=document.createElement("div");element.className="tab";
element.title=tab.title+" — click to show it as the "+tab.side+" half";
const title=document.createElement("span");title.className="title";title.textContent=tab.title;
const close=document.createElement("button");close.className="close";close.textContent="✕";close.title="Close for good";
close.addEventListener("click",(event)=>{event.stopPropagation();window.splitChrome.closeTab(tab.id);});
element.addEventListener("click",()=>window.splitChrome.restoreTab(tab.id));element.append(title,close);return element;};
window.splitChrome.onTabs((tabs)=>{const children=[];
for(const {side,label} of SIDES){const group=tabs.filter((tab)=>tab.side===side);if(group.length===0)continue;
if(children.length>0){const separator=document.createElement("span");separator.className="separator";children.push(separator);}
const heading=document.createElement("span");heading.className="group";heading.textContent=label;children.push(heading,...group.map(renderTab));}
container.replaceChildren(...children);});
</script></body></html>`;
}
