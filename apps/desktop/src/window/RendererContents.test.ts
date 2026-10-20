import * as NodeEvents from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => null } }));

import { appWindowOfRendererId, registerPane } from "./RendererContents.ts";

let nextId = 100;
const fakeWindow = () =>
  ({
    webContents: { id: nextId++ },
    isDestroyed: () => false,
  }) as unknown as Electron.BrowserWindow;
const fakePane = () => {
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    id: nextId++,
    isDestroyed: () => false,
  });
  return {
    view: { webContents: contents } as unknown as Electron.WebContentsView,
    contents,
  };
};

describe("appWindowOfRendererId", () => {
  it("trusts a split view half of a window other than the main one", () => {
    const main = fakeWindow();
    const other = fakeWindow();
    const pane = fakePane();
    registerPane(other, pane.view);
    expect(appWindowOfRendererId(pane.contents.id, main)).toBe(other);
    expect(appWindowOfRendererId(pane.contents.id, null)).toBe(other);
  });

  it("trusts the main window's own page and nothing unregistered", () => {
    const main = fakeWindow();
    expect(appWindowOfRendererId(main.webContents.id, main)).toBe(main);
    expect(appWindowOfRendererId(nextId++, main)).toBeNull();
  });

  it("stops trusting a pane once it is destroyed", () => {
    const window = fakeWindow();
    const pane = fakePane();
    registerPane(window, pane.view);
    pane.contents.emit("destroyed");
    expect(appWindowOfRendererId(pane.contents.id, null)).toBeNull();
  });
});
