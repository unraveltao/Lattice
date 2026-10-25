/**
 * 棂 / Lattice —— 组件调试面板
 *
 * # 为什么要有这一块
 *
 * 组件跑在沙箱 iframe 里，出问题时的两个基本问题 —— "它到底调没调桥""那句
 * `console.log` 打出来没有" —— 以前只能靠开 WebView2 的远程调试端口去看。
 * 而 vite dev 不转发组件窗口的 console（这条坑踩过一整轮），于是最常见的
 * 现象是：代码里写着日志，屏幕上什么都没有，分不清是没执行到还是被吞了。
 *
 * 这块面板把两路数据摆到明面上：桥的每次调用（方法名、耗时、错误码）和组件
 * 里每条 console 输出。数据来源是 `runtime/debug.ts` 的环形缓冲，这里只是视图。
 *
 * # 为什么是浮在底部的抽屉，不是第四栏
 *
 * 三栏已经是"库 / 画布 / 属性"，再加一栏画布就窄得不能看了 —— 而调试的时候
 * 恰恰最需要看画布。抽屉覆盖在画布下沿，开关都不改变画布的尺寸，也就不会
 * 触发桌面窗口那套"尺寸变了重铺壁纸"的连锁反应。
 *
 * # 冻住（Pause）
 *
 * 时钟组件每秒一跳，一秒一条记录。想看清某一行时它已经被顶走了 —— 所以给一个
 * 冻住按钮：停止接收新记录，画面定住，慢慢看。取消冻住时把缓冲里的全量补回来。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clear,
  filterRecords,
  snapshot,
  subscribe,
  summarize,
  type DebugKind,
  type DebugRecord,
} from "../runtime/debug";
import { Glyph, ICON } from "./icons";
import { useT } from "../runtime/i18n";

/** 面板过滤的三档 */
type Mode = "all" | DebugKind;

const MODES: { value: Mode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "call", label: "Bridge" },
  { value: "log", label: "Console" },
];

const KIND_LABEL: Record<DebugKind, string> = { call: "bridge", log: "console" };

/**
 * 时间戳只留时分秒加毫秒。
 *
 * 面板里相邻两条往往差几毫秒，"12:04:31" 看不出先后，`.042` 才看得出。
 */
function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

/** 耗时只保留一位小数：面板不是性能剖析器，`12.4ms` 和 `12.43ms` 一样有用 */
function millis(ms: number): string {
  if (ms < 0.1) return "<0.1ms";
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

interface DebugPanelProps {
  open: boolean;
  onClose: () => void;
}

export function DebugPanel({ open, onClose }: DebugPanelProps) {
  const t = useT();
  const [records, setRecords] = useState<readonly DebugRecord[]>(() => [...snapshot()]);
  const [mode, setMode] = useState<Mode>("all");
  const [query, setQuery] = useState("");
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [frozen, setFrozen] = useState(false);

  const listRef = useRef<HTMLOListElement>(null);
  /** 视图是否停在底部。用户往上翻看历史时不该被新记录拽回去 */
  const pinned = useRef(true);
  /** 订阅回调里读它，避免因为 frozen 变化反复退订重订 */
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  useEffect(() => {
    /*
     * 复制一份再 setState：总线里的数组是原地 push 的，引用永远不变，
     * 直接塞进来 React 会认为"没变化"而不重渲染。
     */
    const apply = (next: readonly DebugRecord[]) => {
      if (!frozenRef.current) setRecords([...next]);
    };
    apply(snapshot());
    return subscribe(apply);
  }, []);

  // 解冻时把冻住期间攒下的记录一次补回来
  useEffect(() => {
    if (!frozen) setRecords([...snapshot()]);
  }, [frozen]);

  /*
   * 面板关着的时候不订阅 —— 但缓冲还在总线里，打开时 `snapshot()` 能补齐
   * 打开之前发生的事（包括桌面窗口在更早时候发过来的）。
   */
  useEffect(() => {
    if (open) pinned.current = true;
  }, [open]);

  useEffect(() => {
    if (!open || !pinned.current) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [records, open]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    // 24px 的容差：滚动条自己会有半像素误差，卡得太死会一直"离开底部"
    pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  }, []);

  // 过滤和统计都是纯函数（在 runtime/debug.ts 里，tests/debug.html 钉着）：
  // 面板只负责画，别让"怎么算"和"怎么显示"缠在一起
  const stats = useMemo(() => summarize(records), [records]);
  const visible = useMemo(
    () => filterRecords(records, { mode, onlyFailures, query }),
    [records, mode, onlyFailures, query],
  );

  if (!open) return null;

  return (
    <section className="lattice-debug" aria-label={t("Widget debug panel")}>
      <header className="lattice-debug-head">
        <span className="lattice-debug-title">{t("Debug")}</span>
        <span className="lattice-debug-stats">
          <b>{stats.calls}</b> {t("bridge calls")} · <b>{stats.logs}</b> {t("console lines")}
          {stats.failures > 0 && (
            <>
              {" · "}
              <b className="is-bad">{stats.failures}</b> {t("failed")}
            </>
          )}
        </span>

        <div className="lattice-debug-modes" role="group" aria-label={t("Record type")}>
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`lattice-debug-mode${mode === item.value ? " is-active" : ""}`}
              onClick={() => setMode(item.value)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>

        <label className="lattice-debug-toggle">
          <input
            type="checkbox"
            checked={onlyFailures}
            onChange={(event) => setOnlyFailures(event.target.checked)}
          />
          {t("Failures only")}
        </label>

        <input
          className="lattice-input lattice-debug-search"
          type="search"
          value={query}
          placeholder={t("Filter by method, widget or text")}
          onChange={(event) => setQuery(event.target.value)}
        />

        <button
          type="button"
          className={`lattice-btn is-small${frozen ? " is-active" : ""}`}
          onClick={() => setFrozen((value) => !value)}
          title={
            frozen
              ? t("Resume — catch up with what arrived meanwhile")
              : t("Freeze the view so you can read a row")
          }
        >
          {frozen ? t("Resume") : t("Pause")}
        </button>
        <button type="button" className="lattice-btn is-small" onClick={() => clear()}>
          {t("Clear")}
        </button>
        <button
          type="button"
          className="lattice-icon-btn"
          onClick={onClose}
          title={t("Close (Ctrl+Shift+D)")}
          aria-label={t("Close debug panel")}
        >
          <Glyph d={ICON.close} size={14} />
        </button>
      </header>

      {visible.length === 0 ? (
        <p className="lattice-debug-empty">
          {records.length === 0
            ? t("Nothing yet. Bridge calls and console output from widgets show up here as they happen.")
            : t("No record matches the current filter.")}
        </p>
      ) : (
        <ol className="lattice-debug-list" ref={listRef} onScroll={onScroll}>
          {visible.map((record, index) => (
            <li
              key={`${record.at}-${index}`}
              className={`lattice-debug-row${record.ok ? "" : " is-bad"}`}
              title={`${record.instanceId}\n${record.name}${record.text ? `\n${record.text}` : ""}`}
            >
              <span className="lattice-debug-time">{stamp(record.at)}</span>
              <span className={`lattice-debug-kind is-${record.kind}`}>
                {t(KIND_LABEL[record.kind])}
              </span>
              <span className="lattice-debug-widget">{record.widgetId || "—"}</span>
              <span className="lattice-debug-name">{record.name}</span>
              <span className="lattice-debug-ms">
                {record.kind === "call" ? millis(record.ms) : ""}
              </span>
              <span className="lattice-debug-text">{record.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
