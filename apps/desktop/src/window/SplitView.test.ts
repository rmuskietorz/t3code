import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { appPathOf, composerKey } from "./SplitView.ts";

const origin = "t3code-fork://app";

describe("appPathOf", () => {
  it("reads the route from the renderer's hash", () => {
    expect(appPathOf(`${origin}/#/env-1/thread-1`, origin)).toBe("/env-1/thread-1");
    expect(appPathOf(`${origin}/#/settings/general?tab=1`, origin)).toBe("/settings/general?tab=1");
    expect(appPathOf(`${origin}/`, origin)).toBe("/");
  });

  it("never restores pairing or pages from another origin", () => {
    expect(appPathOf(`${origin}/#/pair?host=x`, origin)).toBeNull();
    expect(appPathOf("https://example.com/#/env-1/thread-1", origin)).toBeNull();
    expect(appPathOf("not a url", origin)).toBeNull();
  });
});

describe("composerKey", () => {
  it("identifies thread and draft routes, which carry a composer", () => {
    expect(composerKey("/env-1/thread-1")).toBe("/env-1/thread-1");
    expect(composerKey("/env-1/thread-1?panel=diff")).toBe("/env-1/thread-1");
    expect(composerKey("/draft/abc")).toBe("/draft/abc");
  });

  it("leaves routes without a composer free to open in both halves", () => {
    expect(composerKey("/settings/general")).toBeNull();
    expect(composerKey("/projects/abc")).toBeNull();
    expect(composerKey("/pull-requests")).toBeNull();
    expect(composerKey("/")).toBeNull();
    expect(composerKey(null)).toBeNull();
  });
});
