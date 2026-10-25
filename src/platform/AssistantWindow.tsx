/**
 * assistant 桌面窗口的壳（`0002` / `0007`）：一条标题栏 + 那块面板 + 底板。
 *
 * 这里**没有画布、没有 store**。它只做五件事：给面板一块地方、让窗口能拖、
 * 把主题与底板对齐、拖边缩放、把模式/锁/尺寸落到 Rust 上一次。
 *
 * 为什么没有 store 很重要：布局的权威在主窗口那份 `useLattice` 里，小窗再
 * 水合一份就成了"两套真相"。所以工具调用走 `remoteSurface()` 转给主窗口，
 * `state.json` 只有一个写手。**窗口自己的状态走另一份文件**
 * （`assistant-window.json` v2），Rust 是它的唯一真源：每次改都拿返回值覆盖
 * 本地那份，不在页面里另攒一个权威。
 *
 * # 底板为什么和组件走同一条代码路径
 *
 * 用户要的是"背景跟其他组件一样可以调节"。所以这里**不另写一套**：三层
 * （canvas 壁纸 / veil 底色 / 内容）、令牌表、合成色与明暗判定全部来自
 * `runtime/appearance.ts`，和 `widgetHost.ts` 是同一份。出厂外观
 * （`auto / 1 / 0`）下一个令牌都不改 —— 默认样子必须一像素不差（不变量 6）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { AssistantPanel } from "./AssistantPanel";
import { isTauri } from "../runtime/registry";
import { setLanguage, useT } from "../runtime/i18n";
import {
  APPEARANCE_TOKENS,
  MAX_BLUR,
  TINT_DARK,
  TINT_LIGHT,
  appearanceTokenValues,
  isDarkTint,
  isPlainAppearance,
  luminance,
  normalizeAppearance,
  themeSurfaceRgb,
  tintRgb,
  type Appearance,
} from "../runtime/appearance";
import {
  migrateAssistantWindow,
  type AssistantWindowState,
  type AssistantWorkArea,
} from "../runtime/assistant-window";

/** 磨砂要按 `2 × 半径` 外扩截图，和宿主页同一个值 */
const WALLPAPER_PAD = MAX_BLUR * 2;

/**
 * 底板的明暗**只有一个开关**（用户 2026-10-25 指的那颗）。
 *
 * 原来这里是三颗药丸（跟随主题 / 深 / 浅），在 224px 的板子里挤成
 * "Dar k" / "Ligh t" 两行 —— 三个状态里真正要用的是两个方向，第三个
 * （跟随主题）本来就是出厂值：不去动它，它就一直是跟随主题。
 * 所以开关只表达**方向**：亮着 = 深色底，灭着 = 浅色底。
 * `auto` 在界面上的位置由当前主题决定（跟着主题走时，主题是深的就是深色）。
 */

/** 标题栏那颗锁。**不用 emoji**：🔒 是彩色的、粗细和基线都跟旁边那几颗
 * 几何字形不是一套，一进标题栏就跳出来（用户原话"格格不入"） */
function LockIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <rect
        x="3"
        y="6.2"
        width="8"
        height="5.6"
        rx="1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d={open ? "M5 6.2V4.6a2 2 0 0 1 4 0" : "M5 6.2V4.6a2 2 0 0 1 4 0v1.6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7" cy="9" r="0.75" fill="currentColor" />
    </svg>
  );
}

/** 当前屏（逻辑像素）。窗口还没跟 Rust 对上时先用这一份算默认落点 */
function screenWorkArea(): AssistantWorkArea {
  return {
    left: 0,
    top: 0,
    width: window.screen?.availWidth || window.innerWidth || 1280,
    height: window.screen?.availHeight || window.innerHeight || 800,
  };
}

export function AssistantWindow() {
  const t = useT();
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<AssistantWindowState>(() =>
    migrateAssistantWindow(undefined, screenWorkArea()),
  );
  const [boardOpen, setBoardOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const veilRef = useRef<HTMLDivElement | null>(null);
  /** 壁纸平均色。没有它就是"还没截到"，此时 veil 不显示（宁可露出主题底色） */
  const [wallpaperAvg, setWallpaperAvg] = useState<[number, number, number] | null>(null);
  const captureSeq = useRef(0);

  const close = useCallback(() => {
    void invoke("assistant_window_hide");
  }, []);

  /* 主题跟主窗口：`state.json` 里那一份是唯一真源，小窗开局读一次就够了 */
  useEffect(() => {
    void invoke<string | null>("state_read")
      .then((raw) => {
        if (!raw) return;
        const disk = JSON.parse(raw) as { theme?: string; language?: string };
        setLanguage(disk.language === "zh" || disk.language === "en" ? disk.language : "system");
        const theme = disk.theme;
        if (theme === "light" || theme === "dark") {
          document.documentElement.dataset.theme = theme;
        } else if (theme === "system") {
          const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          document.documentElement.dataset.theme = dark ? "dark" : "light";
        }
      })
      .catch(() => {
        /* 读不出来就用默认深色，不至于因为这个开不了面板 */
      })
      .finally(() => setReady(true));
  }, []);

  /* 窗口自己的状态：Rust 是唯一真源。**读不到就退回出厂**（命令还没接线时
   * 也会走到这里）—— 面板必须能开，不能不响 */
  useEffect(() => {
    void invoke<AssistantWindowState>("assistant_window_state")
      .then((disk) => setState(migrateAssistantWindow(disk, screenWorkArea())))
      .catch(() => {
        /* 未接线 / 文件读不到：留在出厂状态，标题栏照常能用 */
      });
  }, []);

  /* 主窗口切了语言：和 `lattice:theme` 同一套广播，小窗不加载 store 只能这样收到 */
  useEffect(() => {
    if (!isTauri()) return;
    let dispose: (() => void) | undefined;
    let disposed = false;

    void listen<string>("lattice:language", (event) => {
      setLanguage(event.payload === "zh" ? "zh" : "en");
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch(() => {
        /* 事件通道不可用就停在开局读到的那个语言上 */
      });

    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  /* 主题一变（设置里切明暗），合成色与令牌要重算 —— 底板跟着明暗翻。
   * 用一个 tick 而不是把 theme 塞进 state：主题的权威在 `data-theme` 上，
   * 这里只是"它变了，重算一遍" */
  const [themeTick, bumpTheme] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => bumpTheme((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  const appearance = state.appearance;
  /* 主题的权威在 `data-theme` 上（`themeTick` 是它变化的信号）。`auto` 这一档
   * 落在哪一边要看它 —— 跟着主题走时，主题是深的就是深色底 */
  const darkTint = isDarkTint(
    appearance.tint,
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  /* 壁纸：只有真的要磨砂 / 要透出底色时才截（出厂外观一次都不截） */
  const capture = useCallback(async () => {
    if (!canvasRef.current) return;
    if (isPlainAppearance(appearance)) return;
    const token = ++captureSeq.current;
    try {
      const buffer = await invoke<ArrayBuffer>("widget_wallpaper", { pad: WALLPAPER_PAD });
      if (token !== captureSeq.current) return;
      const view = new DataView(buffer);
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      const pixels = new Uint8ClampedArray(buffer, 8, width * height * 4);
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context || width === 0 || height === 0) return;
      canvas.width = width;
      canvas.height = height;
      context.putImageData(new ImageData(pixels, width, height), 0, 0);
      captureSeq.current = token;

      // 平均色：每隔一段取一个像素就够（只要"大概是什么颜色"）
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      const step = Math.max(4, Math.floor((width * height) / 4000) * 4);
      for (let index = 0; index + 3 < pixels.length; index += step) {
        r += pixels[index];
        g += pixels[index + 1];
        b += pixels[index + 2];
        count += 1;
      }
      if (count > 0) setWallpaperAvg([r / count, g / count, b / count]);
    } catch {
      /* 截不到就当没有壁纸：veil 不显示，退回主题底色 */
      setWallpaperAvg(null);
    }
  }, [appearance]);

  useEffect(() => {
    void capture();
  }, [capture]);

  /* 窗口尺寸变了（拖手柄 / 拖边 / 换了缩放）要重截一张：canvas 铺的是
   * `innerWidth + pad × 2`，图不重截就会在边上露出一块旧的。
   * 松手之前系统会连发几十次 `resize`，所以攒 200ms 只截最后一拍 */
  useEffect(() => {
    if (isPlainAppearance(appearance)) return;
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void capture(), 200);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [appearance, capture]);

  /* 三层：canvas（壁纸）→ veil（底色）→ 内容。令牌一起重算 */
  useEffect(() => {
    const root = document.documentElement;
    const plain = isPlainAppearance(appearance);
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const tint = normalizedTintRgb(appearance.tint, theme);
    const behind = wallpaperAvg ?? themeSurfaceRgb();
    const composite: [number, number, number] = [
      tint[0] * appearance.alpha + behind[0] * (1 - appearance.alpha),
      tint[1] * appearance.alpha + behind[1] * (1 - appearance.alpha),
      tint[2] * appearance.alpha + behind[2] * (1 - appearance.alpha),
    ];
    const light = luminance(composite) > 0.55;

    if (plain) {
      for (const token of APPEARANCE_TOKENS) root.style.removeProperty(token);
    } else {
      for (const [token, value] of Object.entries(appearanceTokenValues(composite, light))) {
        root.style.setProperty(token, value);
      }
    }

    const veil = veilRef.current;
    const canvas = canvasRef.current;
    const ready = wallpaperAvg !== null && !plain;
    if (veil) {
      veil.style.display = ready ? "block" : "none";
      veil.style.background = `rgba(${Math.round(tint[0])}, ${Math.round(tint[1])}, ${Math.round(
        tint[2],
      )}, ${appearance.alpha})`;
    }
    if (canvas) {
      canvas.style.display = plain ? "none" : "block";
      canvas.style.filter = `blur(${appearance.blur}px)`;
      canvas.style.opacity = ready ? "1" : "0";
      /* 截图比窗口大一圈（`2 × 半径` 的外扩），所以整张图往左上挪一个 pad，
       * 再按 CSS 像素铺开 —— 和宿主页同一套尺寸算法，别另算一套 */
      canvas.style.width = `${window.innerWidth + WALLPAPER_PAD * 2}px`;
      canvas.style.height = `${window.innerHeight + WALLPAPER_PAD * 2}px`;
      canvas.style.left = `${-WALLPAPER_PAD}px`;
      canvas.style.top = `${-WALLPAPER_PAD}px`;
    }
  }, [appearance, wallpaperAvg, themeTick]);

  /* 拖动标题栏**不走 JS**：标题栏带 `data-tauri-drag-region`，由 Tauri 自己在
   * mousedown 上起拖。三条理由：
   *   1. 走 JS 那条路要先过一次 IPC（`startDragging`），而拖动是"按下就跟着走"
   *      的手感 —— 任何一次往返抖动都会被用户当成"拖不动"
   *   2. 位置不再由页面存：Rust 监听 `Moved` / `Resized`，合并到最后一拍再写盘
   *      （`schedule_save`），页面不需要在松手时补一次 IPC
   *   3. 锁上时属性不渲染，拖不动这件事只有**一个**判据（这里不写 `if locked`）
   */

  const patch = useCallback((next: Partial<AssistantWindowState>) => {
    setState((before) => ({ ...before, ...next }));
  }, []);

  /** 改底板：先存 Rust（它归一化），拿返回值覆盖本地 */
  const saveAppearance = useCallback(
    (next: Appearance) => {
      const normalized = normalizeAppearance(next);
      patch({ appearance: normalized });
      void invoke<AssistantWindowState>("assistant_window_appearance", { appearance: normalized })
        .then((disk) => setState((before) => ({ ...before, ...disk })))
        .catch(() => {
          /* 未接线：本地照常生效，下一次打开会回到出厂 */
        });
    },
    [patch],
  );

  const toggleLocked = useCallback(() => {
    const next = !state.locked;
    patch({ locked: next });
    void invoke<AssistantWindowState>("assistant_window_locked", { locked: next })
      .then((disk) => setState((before) => ({ ...before, ...disk })))
      .catch(() => {
        /* 未接线：本地生效 */
      });
  }, [patch, state.locked]);

  /* 拖边缩放**交给系统**（`startResizeDragging`），不在页面里逐帧 `setSize`。
   * 上一版就是逐帧 `setSize`，真机上的表现是"拖了等于没拖"，原因很清楚：
   * 手柄贴在右 / 下边缘，光标往想要的方向挪 1px 就已经在客户区之外，而
   * `pointermove` 只在客户区内派发 —— 第一帧还没到，缩放就断了。
   * 换成系统那条路的好处一次拿全：OS 自己在缩放（光标形状、多屏、吸附都不用
   * 我们管）、不产生 IPC 往返、尺寸的权威仍然在 Rust（它监听 `Resized`，
   * 合并到最后一拍再写盘，见 `assistant_window.rs::schedule_save`）。
   * 三个手柄（右 / 下 / 右下）：够用，也不至于把手柄画得到处都是 */
  const startResize = useCallback(
    (direction: "East" | "South" | "SouthEast") => (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.locked) return;
      void getCurrentWindow()
        .startResizeDragging(direction)
        .catch(() => {
          /* 没这份权限 / 平台不支持：手柄退化成装饰，别把界面卡住 */
        });
    },
    [state.locked],
  );

  const modeLabel = useMemo(
    () => (state.mode === "desktop" ? t("On the desktop") : t("Floating window")),
    [state.mode, t],
  );

  return (
    <div className="lattice-assistant-window" data-mode={state.mode} data-locked={state.locked ? "1" : "0"}>
      {/* 底板三层的前两层。出厂外观下两张都不显示（不变量 6） */}
      <canvas ref={canvasRef} className="lattice-assistant-canvas" aria-hidden="true" />
      <div ref={veilRef} className="lattice-assistant-veil" aria-hidden="true" />

      <header
        className="lattice-assistant-bar"
        /* 锁上时**不渲染**这个属性 = 拖不动；解锁时它是整条标题栏的拖动手柄。
         * Tauri 只认"事件目标那一层"有没有这个属性，所以标题栏里的字要
         * `pointer-events: none`（见 assistant-window.css），否则点在字上不生效 */
        data-tauri-drag-region={state.locked ? undefined : "true"}
        title={state.locked ? t("Unlock to move") : t("Drag to move")}
      >
        <span className="lattice-assistant-bar-dot" aria-hidden="true" />
        <span className="lattice-assistant-bar-title">{t("Assistant")}</span>
        <span className="lattice-assistant-bar-mode">{modeLabel}</span>

        <button
          type="button"
          className="lattice-assistant-bar-btn"
          data-on={boardOpen ? "1" : "0"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setBoardOpen((open) => !open)}
          title={t("Backdrop")}
          aria-label={t("Backdrop")}
        >
          ◐
        </button>
        <button
          type="button"
          className="lattice-assistant-bar-btn"
          data-on={state.locked ? "1" : "0"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleLocked}
          title={state.locked ? t("Unlock") : t("Lock position and size")}
          aria-label={state.locked ? t("Unlock") : t("Lock position and size")}
        >
          <LockIcon open={!state.locked} />
        </button>
        {/*
          这里原来还有一颗「浮窗 ↔ 贴桌面」的按钮（`▢` / `▤`）。删掉了
          （2026-10-25，用户："那个放大窗口是没用的，可以删除了"）：它长在
          最大化该在的位置、也长得像最大化，按下去却是把窗口换一层 ——
          一个按钮最糟的错就是"看着像另一件事"。
          `state.mode` 仍然照 `assistant-window.json` 读、仍然决定窗口的层级
          （`data-mode` + 标题栏那颗药丸），只是**界面上不再有入口**。
          要把它加回来，先换个不像最大化的样子 —— 底板面板里一行开关就够。
        */}
        <button
          type="button"
          className="lattice-assistant-bar-btn"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={close}
          title={t("Hide (Ctrl+K brings it back)")}
          aria-label={t("Hide assistant")}
        >
          ×
        </button>
      </header>

      {boardOpen && (
        <div className="lattice-assistant-board" onPointerDown={(event) => event.stopPropagation()}>
          <div className="lattice-assistant-board-row">
            <span className="lattice-assistant-board-label">{t("Tint")}</span>
            <span className="lattice-assistant-board-value">{darkTint ? t("Dark") : t("Light")}</span>
            {/* 一个开关管明暗。**不要去动它就是跟随主题** —— 出厂值本来如此，
                所以开关只需要表达"往深还是往浅"，不必为第三档再摆一颗 */}
            <button
              type="button"
              role="switch"
              aria-checked={darkTint}
              aria-label={t("Tint")}
              className="lattice-assistant-switch"
              data-on={darkTint ? "1" : "0"}
              onClick={() =>
                saveAppearance({ ...appearance, tint: darkTint ? TINT_LIGHT : TINT_DARK })
              }
            >
              <span className="lattice-assistant-switch-knob" aria-hidden="true" />
            </button>
          </div>
          <label className="lattice-assistant-board-row">
            <span className="lattice-assistant-board-label">{t("Dim")}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={appearance.alpha}
              onChange={(event) => saveAppearance({ ...appearance, alpha: Number(event.target.value) })}
            />
          </label>
          <label className="lattice-assistant-board-row">
            <span className="lattice-assistant-board-label">{t("Blur")}</span>
            <input
              type="range"
              min={0}
              max={MAX_BLUR}
              step={1}
              value={appearance.blur}
              onChange={(event) => saveAppearance({ ...appearance, blur: Number(event.target.value) })}
            />
          </label>
        </div>
      )}

      {ready && <AssistantPanel open onClose={close} variant="window" />}

      {/* 自绘手柄：锁上时一个都不挂处理器（锁是**一处判据**，不是两处） */}
      {!state.locked && (
        <>
          <div className="lattice-assistant-grip" data-axis="x" onPointerDown={startResize("East")} />
          <div className="lattice-assistant-grip" data-axis="y" onPointerDown={startResize("South")} />
          <div className="lattice-assistant-grip" data-axis="xy" onPointerDown={startResize("SouthEast")} />
        </>
      )}
    </div>
  );
}

/** `auto` = 当前主题的那个 surface（和组件宿主页同一条） */
function normalizedTintRgb(tint: string, theme: string): [number, number, number] {
  if (tint === "auto") return themeSurfaceRgb();
  return tintRgb(tint) ?? (theme === "light" ? [251, 250, 248] : [23, 23, 29]);
}
