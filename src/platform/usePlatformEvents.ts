import { useEffect, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../runtime/registry";
import { DEBUG_EVENT, ingest } from "../runtime/debug";
import type { DesktopRect, Placement } from "./store";
import type { WidgetLayer } from "../runtime/manifest";

export interface CrashEvent {
  instanceId: string;
  kind: "render" | "gpu" | "browser" | "unresponsive" | "other";
  gaveUp: boolean;
}

/** 桌面窗口自己的调试记录要尽早订阅，避免启动时组件日志先于主界面到达。 */
export function useDebugEvents(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let dispose: (() => void) | undefined;
    let disposed = false;

    void listen<unknown>(DEBUG_EVENT, (event) => ingest(event.payload))
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch(() => {
        /* 事件通道不可用就当没有桌面窗口 —— 画布记录照常工作 */
      });

    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);
}

interface RectEvent {
  instanceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PinnedEvent {
  instanceId: string;
  pinned: boolean;
}

interface LayerEvent {
  instanceId: string;
  layer: WidgetLayer;
}

interface InstanceEvent {
  instanceId: string;
}

interface PlatformEventHandlers {
  refresh: () => void;
  setDesktopRect: (instanceId: string, rect: DesktopRect) => void;
  updatePlacement: (
    instanceId: string,
    patch: Partial<Omit<Placement, "instanceId" | "widgetId">>,
  ) => void;
  removePlacement: (instanceId: string) => void;
  suppressWindow: (instanceId: string) => void;
  setPaused: (paused: boolean) => void;
  setCrash: Dispatch<SetStateAction<CrashEvent | null>>;
}

export function usePlatformEvents({
  refresh,
  setDesktopRect,
  updatePlacement,
  removePlacement,
  suppressWindow,
  setPaused,
  setCrash,
}: PlatformEventHandlers): void {
  useEffect(() => {
    if (!isTauri()) return;
    const disposers: Array<() => void> = [];
    let disposed = false;

    const bind = <T,>(name: string, handler: (payload: T) => void) => {
      void listen<T>(name, (event) => handler(event.payload)).then((unlisten) => {
        if (disposed) unlisten();
        else disposers.push(unlisten);
      });
    };

    bind<RectEvent>("lattice:widget-rect", (payload) => {
      setDesktopRect(payload.instanceId, {
        x: payload.x,
        y: payload.y,
        w: payload.w,
        h: payload.h,
      });
    });
    bind<PinnedEvent>("lattice:widget-pinned", (payload) => {
      updatePlacement(payload.instanceId, { pinned: payload.pinned });
    });
    bind<LayerEvent>("lattice:widget-layer", (payload) => {
      updatePlacement(payload.instanceId, { layer: payload.layer });
    });
    bind<InstanceEvent>("lattice:widget-close", (payload) => {
      removePlacement(payload.instanceId);
    });
    bind<InstanceEvent>("lattice:widget-suppressed", (payload) => {
      suppressWindow(payload.instanceId);
    });
    bind<{ files: string[] }>("lattice:widgets-changed", () => {
      void refresh();
    });
    bind<{ paused: boolean }>("lattice:paused", (payload) => setPaused(payload.paused));
    bind<CrashEvent>("lattice:widget-crashed", (payload) => {
      if (payload.gaveUp) setCrash(payload);
    });

    return () => {
      disposed = true;
      for (const dispose of disposers) dispose();
    };
  }, [refresh, removePlacement, setCrash, setDesktopRect, setPaused, suppressWindow, updatePlacement]);
}
