import * as Schema from "effect/Schema";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { useResizeDrag } from "./useResizeDrag";

const WidthSchema = Schema.Finite;

/**
 * Custom property the host element must size itself from.
 */
export const RESIZABLE_WIDTH_PROPERTY = "--resizable-width";

export interface UseResizableWidthOptions {
  readonly storageKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly edge: "left" | "right";
  /** Let the dragged edge settle on the window's horizontal middle. */
  readonly snapToWindowCenter?: boolean;
}

const WINDOW_CENTER_SNAP_THRESHOLD_PX = 20;

/**
 * The width that puts the dragged edge on the window's middle, or null when
 * the bounds rule it out. `anchor` is the x of the host's fixed side.
 */
export function windowCenterWidth(input: {
  readonly anchor: number;
  readonly viewportWidth: number;
  readonly edge: "left" | "right";
  readonly minWidth: number;
  readonly maxWidth: number;
}): number | null {
  const center = input.viewportWidth / 2;
  const width = Math.round(input.edge === "left" ? input.anchor - center : center - input.anchor);
  return width >= input.minWidth && width <= input.maxWidth ? width : null;
}

export function snapToWindowCenter(width: number, centerWidth: number | null): number {
  return centerWidth !== null && Math.abs(width - centerWidth) <= WINDOW_CENTER_SNAP_THRESHOLD_PX
    ? centerWidth
    : width;
}

export interface ResizableWidthHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onDoubleClick?: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * Width is read on mount or storage-key changes and persisted on drag-end (not on every rAF tick
 * — would otherwise be ~60 writes/sec).
 */
export function useResizableWidth(options: UseResizableWidthOptions): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = options;
  const snapsToWindowCenter = options.snapToWindowCenter ?? false;

  const clamp = useCallback(
    (value: number): number => {
      if (!Number.isFinite(value)) return defaultWidth;
      return Math.max(minWidth, Math.min(maxWidth, value));
    },
    [defaultWidth, maxWidth, minWidth],
  );

  const readWidth = () => {
    if (typeof window === "undefined") return defaultWidth;
    try {
      const stored = getLocalStorageItem(storageKey, WidthSchema);
      return clamp(stored ?? defaultWidth);
    } catch (error) {
      console.error("Could not read persisted panel width.", error);
      return defaultWidth;
    }
  };
  const [widthState, setWidthState] = useState(() => ({ storageKey, width: readWidth() }));
  if (widthState.storageKey !== storageKey) {
    setWidthState({ storageKey, width: readWidth() });
  }

  const clampedWidth = clamp(widthState.width);
  const latestOptions = useRef({ clamp, storageKey, width: clampedWidth });
  useLayoutEffect(() => {
    latestOptions.current = { clamp, storageKey, width: clampedWidth };
  }, [clamp, clampedWidth, storageKey]);

  const commitWidth = (nextStorageKey: string, nextWidth: number) => {
    setWidthState({ storageKey: nextStorageKey, width: nextWidth });
    try {
      setLocalStorageItem(nextStorageKey, nextWidth, WidthSchema);
    } catch (error) {
      console.error("Could not persist panel width.", error);
    }
  };
  const centerWidthFor = (host: HTMLElement | null) => {
    if (!snapsToWindowCenter || !host) return null;
    const rect = host.getBoundingClientRect();
    return windowCenterWidth({
      anchor: edge === "left" ? rect.right : rect.left,
      viewportWidth: window.innerWidth,
      edge,
      minWidth,
      maxWidth,
    });
  };
  // The width a double-click centered from, so a second one goes back to it.
  const widthBeforeCenter = useRef<number | null>(null);

  const { refresh, ...dragHandlers } = useResizeDrag<HTMLElement>((event) => {
    const host = event.currentTarget.parentElement;
    const centerWidth = centerWidthFor(host);
    // A collapsible host animates width; live drag writes must not. The host
    // renders its own transition-duration, so override a property it leaves alone.
    host?.style.setProperty("transition-property", "none");
    return {
      width: clampedWidth,
      edge,
      resize(value) {
        const nextWidth = latestOptions.current.clamp(snapToWindowCenter(value, centerWidth));
        host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${nextWidth}px`);
        return nextWidth;
      },
      finish(finalWidth, moved) {
        if (moved) widthBeforeCenter.current = null;
        commitWidth(storageKey, finalWidth);
      },
      cleanup(committed) {
        host?.style.removeProperty("transition-property");
        // React skips the write when the rendered width did not change.
        if (!committed) {
          host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${latestOptions.current.width}px`);
        }
      },
    };
  }, storageKey);

  const handlers: ResizableWidthHandlers = snapsToWindowCenter
    ? {
        ...dragHandlers,
        onDoubleClick(event) {
          const centerWidth = centerWidthFor(event.currentTarget.parentElement);
          if (centerWidth === null) return;
          const current = latestOptions.current.width;
          if (current === centerWidth) {
            const previous = widthBeforeCenter.current ?? defaultWidth;
            widthBeforeCenter.current = null;
            commitWidth(storageKey, latestOptions.current.clamp(previous));
            return;
          }
          widthBeforeCenter.current = current;
          commitWidth(storageKey, centerWidth);
        },
      }
    : dragHandlers;

  // Bounds can change mid-drag (sidebar opens, window narrows) and the render
  // rewrites the committed width, so re-apply the live pointer position.
  useLayoutEffect(refresh, [clamp, clampedWidth, refresh]);

  return { width: clampedWidth, handlers };
}
