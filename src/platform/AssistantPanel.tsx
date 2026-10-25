/**
 * 内置 assistant 的对话面板。
 *
 * # 为什么是抽屉，不是模态框
 *
 * 它**会真的改桌面**：说一句"把时钟挪到右上角"，画布上那张卡当场动。模态框
 * 底下盖着一层背板，用户看不见自己刚让它做了什么 —— 而那正是这个功能唯一
 * 值得信任的部分（每一步都能撤销）。所以做成右侧抽屉，画布露在外面。
 *
 * # 两副面孔
 *
 * 没配好之前显示设置（地址 / 模型 / key / 温度），配好之后显示对话。
 * 齿轮随时能切回去 —— 换模型是常事，不该让人重开面板。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WidgetRecord } from "../runtime/registry";
import {
  listModels,
  localSurface,
  readLlmStatus,
  remoteSurface,
  runAssistantTurn,
  saveLlmKey,
  saveLlmSettings,
  type AssistantSurface,
  type LlmStatus,
} from "./assistant";
import { systemPrompt, type ChatMessage } from "../runtime/assistant";
import { useT } from "../runtime/i18n";

/** 一条要显示的东西。模型的消息和工具的执行结果分开排，读起来才像"过程" */
type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; detail: string; ok: boolean; error?: string }
  | { kind: "error"; text: string };

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  temperature: 0.6,
};

export interface AssistantPanelProps {
  open: boolean;
  onClose: () => void;
  /**
   * 主窗口里的抽屉才给这份清单：它自己有画布，快照和动作都在本地跑。
   * 桌面上那个独立小窗不给 —— 它走 `remoteSurface()`，把活儿转给主窗口，
   * 因为布局的权威在那儿（见 `platform/assistant.ts` 的 `AssistantSurface`）。
   */
  records?: ReadonlyMap<string, WidgetRecord>;
  /** `window` = 独立小窗：铺满窗口、不要圆角和投影（那些由窗口壳负责） */
  variant?: "drawer" | "window";
}

export function AssistantPanel({ open, onClose, records, variant = "drawer" }: AssistantPanelProps) {
  /** 语言一变就重渲染 —— 面板和小窗共用同一套文案 */
  const t = useT();
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [view, setView] = useState<"chat" | "setup">("chat");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ prompt: number; completion: number } | null>(null);
  const [models, setModels] = useState<string[]>([]);

  // 设置表单。只在打开设置那一下从 status 灌一次，之后是用户说了算
  const [baseUrl, setBaseUrl] = useState(DEFAULTS.baseUrl);
  const [model, setModel] = useState(DEFAULTS.model);
  const [temperature, setTemperature] = useState(DEFAULTS.temperature);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [setupNote, setSetupNote] = useState<string | null>(null);

  /** 会话本身。**跨越多次编辑保留**：关掉面板再开，刚才聊的还在 */
  const messages = useRef<ChatMessage[]>([]);
  const stopFlag = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const surface = useMemo<AssistantSurface>(
    () => (records ? localSurface([...records.values()]) : remoteSurface()),
    [records],
  );

  // 收进 ref：`send` 的依赖里不放 surface，否则每次清单变化都会重建回调
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  const syncForm = useCallback((next: LlmStatus) => {
    setBaseUrl(next.baseUrl || DEFAULTS.baseUrl);
    setModel(next.model || DEFAULTS.model);
    setTemperature(next.temperature ?? DEFAULTS.temperature);
  }, []);

  // 打开时读一次状态：`llm_status` 只回掩码，key 本身永远不进前端
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readLlmStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        syncForm(next);
        if (!next.configured) setView("setup");
      })
      .catch((problem) => {
        if (!cancelled) setError(String(problem));
      });
    return () => {
      cancelled = true;
    };
  }, [open, syncForm]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open, view]);

  // 新内容自动滚到底
  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, busy]);

  // Esc 收起。和设置菜单一致：面板是"看一眼就走"的东西
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;

    setDraft("");
    setError(null);
    setEntries((list) => [...list, { kind: "user", text }]);

    const conversation = messages.current;
    const host = surfaceRef.current;
    setBusy(true);
    stopFlag.current = false;
    try {
      // 第一条永远是 system：桌面现状每次现拍，模型不该记着"上次的桌面"。
      // 快照可能是 IPC 往返（独立小窗那条路），所以先 await 再拼
      const snapshot = await host.snapshot();
      if (conversation[0]?.role === "system") conversation.shift();
      conversation.unshift({ role: "system", content: systemPrompt(snapshot) });
      conversation.push({ role: "user", content: text });

      await runAssistantTurn({
        messages: conversation,
        surface: host,
        shouldStop: () => stopFlag.current,
        onEvent: (event) => {
          if (event.type === "text") {
            setEntries((list) => [...list, { kind: "assistant", text: event.text }]);
          } else if (event.type === "tool") {
            setEntries((list) => [
              ...list,
              { kind: "tool", detail: event.detail, ok: event.ok, error: event.error },
            ]);
          } else {
            setUsage({ prompt: event.promptTokens, completion: event.completionTokens });
          }
        },
      });
    } catch (problem) {
      const message = String(problem instanceof Error ? problem.message : problem);
      setError(message);
      setEntries((list) => [...list, { kind: "error", text: message }]);
      // 这一轮算废了：把刚推进去的 user 撤掉，重试时不会出现两遍
      const last = conversation[conversation.length - 1];
      if (last?.role === "user" && last.content === text) conversation.pop();
    } finally {
      setBusy(false);
    }
  }, [busy, draft]);

  const persist = useCallback(async () => {
    setSaving(true);
    setSetupNote(null);
    setError(null);
    try {
      let next = await saveLlmSettings(baseUrl, model, temperature);
      if (key.trim()) next = await saveLlmKey(key);
      setStatus(next);
      setKey("");
      syncForm(next);
      setSetupNote(
        next.configured
          ? t("Saved. Model {model}, key {hint} ({source}).", {
              model: next.model,
              hint: next.keyHint,
              source: t(next.keySource === "env" ? "from the environment" : "stored on this machine"),
            })
          : t("Base URL and model saved, but there is no key yet — paste one and save again."),
      );
      if (next.configured) setView("chat");
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [baseUrl, key, model, syncForm, t, temperature]);

  const test = useCallback(async () => {
    setSaving(true);
    setSetupNote(null);
    setError(null);
    try {
      const list = await listModels(baseUrl, key.trim() || undefined);
      setModels(list);
      setSetupNote(
        t("Connected. This key can use {count} models: {list}", {
          count: list.length,
          list: `${list.slice(0, 4).join(", ")}${list.length > 4 ? "…" : ""}`,
        }),
      );
      if (!model.trim() && list[0]) setModel(list[0]);
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [baseUrl, key, model, t]);

  const forget = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await saveLlmKey("");
      setStatus(next);
      setSetupNote(t("Key removed from this machine."));
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [t]);

  const stop = useCallback(() => {
    stopFlag.current = true;
  }, []);

  const header = useMemo(() => {
    if (!status) return t("Assistant");
    if (!status.configured) return t("Assistant · Not configured");
    return t("Assistant · {model}", { model: status.model });
  }, [status, t]);

  if (!open) return null;

  return (
    <aside className={`lattice-assistant${variant === "window" ? " is-window" : ""}`} aria-label={t("Assistant")}>
      <header className="lattice-assistant-head">
        <span className="lattice-assistant-title">{header}</span>
        <span className="lattice-assistant-actions">
          <button
            type="button"
            className={`lattice-icon-btn${view === "setup" ? " is-active" : ""}`}
            onClick={() => setView(view === "setup" ? "chat" : "setup")}
            title={view === "setup" ? t("Back to chat") : t("Model settings")}
            aria-label={t("Assistant settings")}
          >
            {view === "setup" ? "←" : "⚙"}
          </button>
          <button type="button" className="lattice-icon-btn" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </span>
      </header>

      {view === "setup" ? (
        <div className="lattice-assistant-body">
          <label className="lattice-textfield">
            <span>{t("API base URL")}</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.deepseek.com/v1"
              spellCheck={false}
            />
          </label>
          <p className="lattice-assistant-hint">
            {t("OpenAI-compatible")} <code className="lattice-mono">/chat/completions</code>
            {t(". DeepSeek, OpenAI, Kimi and Qwen each use their own")} <code className="lattice-mono">/v1</code>
            {t("; a local model on this machine uses")}{" "}
            <code className="lattice-mono">http://127.0.0.1:11434/v1</code>{" "}
            {t("(plain http is only allowed for localhost).")}
          </p>

          <label className="lattice-textfield">
            <span>{t("Model")}</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={DEFAULTS.model}
              list="lattice-llm-models"
              spellCheck={false}
            />
            <datalist id="lattice-llm-models">
              {models.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>

          <label className="lattice-textfield">
            <span>
              {status?.keyHint
                ? t("API key (currently {hint})", { hint: status.keyHint })
                : "API key"}
            </span>
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={status?.keyHint ? t("Leave empty to keep the current key") : "sk-…"}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="lattice-textfield">
            <span>
              {t("Temperature {value} (lower is steadier; 0.4–0.8 works well for changing the desktop)", {
                value: temperature.toFixed(2),
              })}
            </span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={temperature}
              onChange={(event) => setTemperature(Number(event.target.value))}
            />
          </label>

          {error && <p className="lattice-modal-error">{error}</p>}
          {setupNote && <p className="lattice-assistant-hint">{setupNote}</p>}

          <footer className="lattice-assistant-foot">
            <button
              type="button"
              className="lattice-btn is-small"
              onClick={() => void test()}
              disabled={saving}
            >
              {t("Test connection")}
            </button>
            <button
              type="button"
              className="lattice-btn is-small is-primary"
              onClick={() => void persist()}
              disabled={saving}
            >
              {saving ? t("Saving…") : t("Save")}
            </button>
            {status?.keyHint && (
              <button type="button" className="lattice-btn is-small" onClick={() => void forget()}>
                {t("Forget key")}
              </button>
            )}
          </footer>
        </div>
      ) : (
        <>
          <div className="lattice-assistant-body" ref={bodyRef}>
            {entries.length === 0 && (
              <p className="lattice-assistant-hint">
                {t(
                  "Say something and it changes the desktop: “move the clock to the top right”, “switch to dark”, “the pet is too big, make it smaller”. Every step can be undone.",
                )}
              </p>
            )}
            {entries.map((entry, index) => {
              if (entry.kind === "tool") {
                return (
                  <p
                    key={index}
                    className={`lattice-assistant-chip${entry.ok ? "" : " is-failed"}`}
                    title={entry.error ?? undefined}
                  >
                    {entry.ok ? "✓" : "✕"} {entry.detail}
                    {entry.error ? ` — ${entry.error}` : ""}
                  </p>
                );
              }
              if (entry.kind === "error") {
                return (
                  <p key={index} className="lattice-assistant-error">
                    {entry.text}
                  </p>
                );
              }
              return (
                <p key={index} className={`lattice-assistant-turn is-${entry.kind}`}>
                  {entry.text}
                </p>
              );
            })}
            {busy && <p className="lattice-assistant-hint">{t("Thinking…")}</p>}
          </div>

          <div className="lattice-assistant-composer">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={t("Ask it to do something on the desktop (Enter to send, Shift+Enter for a new line)")}
              disabled={busy}
            />
            <div className="lattice-assistant-foot">
              {busy ? (
                <button type="button" className="lattice-btn is-small" onClick={stop}>
                  {t("Stop")}
                </button>
              ) : (
                <button
                  type="button"
                  className="lattice-btn is-small is-primary"
                  onClick={() => void send()}
                  disabled={!draft.trim()}
                >
                  {t("Send")}
                </button>
              )}
              <span className="lattice-assistant-meta">
                {usage ? `${usage.prompt} → ${usage.completion} tokens` : ""}
                {status?.keySource === "env" ? ` · ${t("key from the environment")}` : ""}
              </span>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
