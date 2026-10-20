// @effect-diagnostics nodeBuiltinImport:off -- Exercises SplitSession, which writes its file synchronously with node:fs.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { SplitSession } from "./SplitSession.ts";
import { defaultSplitWindowState, type SplitView } from "./SplitView.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "split-session-"));
  directories.push(directory);
  const file = NodePath.join(directory, "split-session.json");
  const session = new SplitSession(file, (message, cause) => {
    throw new Error(`${message}: ${String(cause)}`);
  });
  const open = (leftPath: string) => {
    const window = new NodeEvents.EventEmitter() as unknown as Electron.BrowserWindow;
    let closed = false;
    const view = {
      get isClosed() {
        return closed;
      },
      captureState: () => ({ ...defaultSplitWindowState(), leftPath }),
    } as unknown as SplitView;
    session.add(view, window);
    const emitter = window as unknown as NodeEvents.EventEmitter;
    return {
      close: () => {
        emitter.emit("close");
        closed = true;
        emitter.emit("closed");
      },
      destroy: () => {
        closed = true;
        emitter.emit("closed");
      },
    };
  };
  const saved = () =>
    (
      JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
        windows: { leftPath: string }[];
      }
    ).windows.map((window) => window.leftPath);
  return { session, open, saved };
}

describe("SplitSession", () => {
  it("keeps a window closed shortly before the app ends", () => {
    const { open, saved } = fixture();
    const first = open("/first");
    const second = open("/second");
    first.close();
    expect(saved()).toEqual(["/first", "/second"]);
    second.close();
    expect(saved()).toEqual(["/first", "/second"]);
  });

  it("keeps windows destroyed without a close event", () => {
    const { open, saved } = fixture();
    const first = open("/first");
    open("/second");
    first.destroy();
    expect(saved()).toEqual(["/first", "/second"]);
  });

  it("drops a closed window once it is no longer recent", () => {
    vi.useFakeTimers();
    try {
      const { open, saved } = fixture();
      const first = open("/first");
      open("/second");
      first.close();
      vi.advanceTimersByTime(3 * 60_000);
      expect(saved()).toEqual(["/second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every open window when the app quits", () => {
    const { session, open, saved } = fixture();
    const first = open("/first");
    const second = open("/second");
    session.freeze();
    first.close();
    second.close();
    expect(saved()).toEqual(["/first", "/second"]);
  });
});
