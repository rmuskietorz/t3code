import { describe, expect, it } from "vite-plus/test";

import { snapToWindowCenter, windowCenterWidth } from "./useResizableWidth";

describe("window center snapping", () => {
  const bounds = { minWidth: 360, maxWidth: 900 };

  it("puts the dragged edge on the window middle from the panel's fixed side", () => {
    expect(windowCenterWidth({ anchor: 1440, viewportWidth: 1440, edge: "left", ...bounds })).toBe(
      720,
    );
    // A panel that does not reach the window edge still lands its edge on the middle.
    expect(windowCenterWidth({ anchor: 1400, viewportWidth: 1441, edge: "left", ...bounds })).toBe(
      680,
    );
    expect(windowCenterWidth({ anchor: 0, viewportWidth: 1440, edge: "right", ...bounds })).toBe(
      720,
    );
  });

  it("does not snap when the middle is outside the width bounds", () => {
    expect(windowCenterWidth({ anchor: 600, viewportWidth: 600, edge: "left", ...bounds })).toBe(
      null,
    );
    expect(windowCenterWidth({ anchor: 2560, viewportWidth: 2560, edge: "left", ...bounds })).toBe(
      null,
    );
    expect(snapToWindowCenter(700, null)).toBe(700);
  });

  it("snaps only within the threshold", () => {
    expect(snapToWindowCenter(700, 720)).toBe(720);
    expect(snapToWindowCenter(740, 720)).toBe(720);
    expect(snapToWindowCenter(699, 720)).toBe(699);
    expect(snapToWindowCenter(741, 720)).toBe(741);
  });
});
