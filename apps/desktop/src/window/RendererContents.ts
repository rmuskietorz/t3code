import * as Electron from "electron";

/**
 * A split window shows the app in several pane views instead of its own
 * webContents. Code that talks to "the app" in a window asks here for the pane
 * that should hear it; a window without panes is its own renderer.
 */
interface WindowRenderers {
  readonly panes: Set<Electron.WebContents>;
  /** The pane the user last focused, which menu actions and prompts target. */
  active: Electron.WebContents | null;
}

const byWindow = new WeakMap<Electron.BrowserWindow, WindowRenderers>();
// Views are not owned by their window in Electron's sense, so
// BrowserWindow.fromWebContents cannot find it for a pane.
const ownerById = new Map<number, Electron.BrowserWindow>();
const viewById = new Map<number, Electron.WebContentsView>();

export function registerPane(window: Electron.BrowserWindow, view: Electron.WebContentsView): void {
  const contents = view.webContents;
  let renderers = byWindow.get(window);
  if (!renderers) {
    renderers = { panes: new Set(), active: null };
    byWindow.set(window, renderers);
  }
  const entry = renderers;
  entry.panes.add(contents);
  entry.active ??= contents;
  const id = contents.id;
  ownerById.set(id, window);
  viewById.set(id, view);
  contents.on("focus", () => {
    entry.active = contents;
  });
  contents.once("destroyed", () => {
    entry.panes.delete(contents);
    ownerById.delete(id);
    viewById.delete(id);
    if (entry.active === contents) entry.active = entry.panes.values().next().value ?? null;
  });
}

export function setActivePane(
  window: Electron.BrowserWindow,
  contents: Electron.WebContents,
): void {
  const renderers = byWindow.get(window);
  if (renderers?.panes.has(contents)) renderers.active = contents;
}

/** The renderer that speaks for the app in `window`. */
export function activeRenderer(window: Electron.BrowserWindow): Electron.WebContents {
  const active = byWindow.get(window)?.active;
  return active && !active.isDestroyed() ? active : window.webContents;
}

/** Every live app renderer in `window`, so broadcasts reach each pane. */
export function allRenderers(window: Electron.BrowserWindow): readonly Electron.WebContents[] {
  const panes = [...(byWindow.get(window)?.panes ?? [])].filter((pane) => !pane.isDestroyed());
  return panes.length > 0 ? panes : [window.webContents];
}

/**
 * The app window whose own page or pane has this webContents id, so IPC can
 * trust a renderer in any split window, not only the main one.
 */
export function appWindowOfRendererId(
  id: number,
  main: Electron.BrowserWindow | null,
): Electron.BrowserWindow | null {
  const owner = ownerById.get(id);
  if (owner && !owner.isDestroyed()) return owner;
  return main?.webContents.id === id ? main : null;
}

/** Whether `contents` is a pane of any window. */
export function isPane(contents: Electron.WebContents): boolean {
  return ownerById.has(contents.id);
}

/** A pane by webContents id, as IPC events identify their sender. */
export function paneById(id: number): Electron.WebContents | null {
  const contents = viewById.get(id)?.webContents;
  return contents && !contents.isDestroyed() ? contents : null;
}

export function windowOfContents(contents: Electron.WebContents): Electron.BrowserWindow | null {
  const owner = ownerById.get(contents.id);
  if (owner && !owner.isDestroyed()) return owner;
  return Electron.BrowserWindow.fromWebContents(contents);
}

/**
 * Where a renderer's viewport starts inside its window. Renderers report menu
 * and capture positions in viewport coordinates, and a right half starts past
 * the left one.
 */
export function viewportOffset(contents: Electron.WebContents): { x: number; y: number } {
  const bounds = viewById.get(contents.id)?.getBounds();
  return bounds ? { x: bounds.x, y: bounds.y } : { x: 0, y: 0 };
}
