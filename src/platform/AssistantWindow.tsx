/**
 * assistant 桌面小窗：一条标题栏 + 那个面板。
 *
 * 这里**没有画布、没有 store**。它只做三件事：给面板一块地方、让窗口能拖、
 * 把主题对齐主窗口。
 *
 * 为什么没有 store 很重要：布局的权威在主窗口那份 `useLattice` 里，小窗再
 * 水合一份就成了"两套真相"（改文件的人和改内存的人各说各话）。所以工具调用
 * 走 `remoteSurface()` 转给主窗口，`state.json` 只有一个写手。
 */

import { useCallback, useEffect, useState } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { AssistantPanel } from "./AssistantPanel";
import { isTauri } from "../runtime/registry";
import { setLanguage, useT } from "../runtime/i18n";

export function AssistantWindow() {
  const t = useT();
  const [ready, setReady] = useState(false);
  const close = useCallback(() => {
    void invoke("assistant_window_hide");
  }, []);

  /* 主题跟主窗口：`state.json` 里那一份是唯一真源，小窗开局读一次就够了 ——
   * 用户在小窗开着的时候改主题，往往是它自己改的（那就该一起变） */
  useEffect(() => {
    void invoke<string | null>("state_read")
      .then((raw) => {
        if (!raw) return;
        const state = JSON.parse(raw) as { theme?: string; language?: string };
        /* 语言同理：小窗不加载 store，这档偏好只能从磁盘上这一份拿；
         * 之后的变化走 `lattice:language` 广播（见下面那个 effect） */
        setLanguage(state.language === "zh" || state.language === "en" ? state.language : "system");
        const theme = state.theme;
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

  /* 拖标题栏。`startDragging` 会一直占着直到松手，所以位置在那之后存一次 */
  const startDrag = useCallback(() => {
    void getCurrentWindow()
      .startDragging()
      .then(() => invoke("assistant_window_save_pos"))
      .catch(() => {
        /* 拖不动不影响用，窗口还能用 Ctrl+K 唤回来 */
      });
  }, []);

  return (
    <div className="lattice-assistant-window">
      <header className="lattice-assistant-bar" onPointerDown={startDrag}>
        <span className="lattice-assistant-bar-dot" aria-hidden="true" />
        <span className="lattice-assistant-bar-title">{t("Assistant")}</span>
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
      {ready && <AssistantPanel open onClose={close} variant="window" />}
    </div>
  );
}
