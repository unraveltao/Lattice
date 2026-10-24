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
          ? `已保存。模型 ${next.model}，key ${next.keyHint}（${next.keySource === "env" ? "来自环境变量" : "存在本机"}）。`
          : "地址和模型存下了，但还没有 key —— 粘贴一把再保存。",
      );
      if (next.configured) setView("chat");
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [baseUrl, key, model, syncForm, temperature]);

  const test = useCallback(async () => {
    setSaving(true);
    setSetupNote(null);
    setError(null);
    try {
      const list = await listModels(baseUrl, key.trim() || undefined);
      setModels(list);
      setSetupNote(
        `连上了，这把 key 能用 ${list.length} 个模型：${list.slice(0, 4).join("、")}${list.length > 4 ? "…" : ""}`,
      );
      if (!model.trim() && list[0]) setModel(list[0]);
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [baseUrl, key, model]);

  const forget = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await saveLlmKey("");
      setStatus(next);
      setSetupNote("key 已从本机删掉。");
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, []);

  const stop = useCallback(() => {
    stopFlag.current = true;
  }, []);

  const header = useMemo(() => {
    if (!status) return "Assistant";
    if (!status.configured) return "Assistant · 未配置";
    return `Assistant · ${status.model}`;
  }, [status]);

  if (!open) return null;

  return (
    <aside className={`lattice-assistant${variant === "window" ? " is-window" : ""}`} aria-label="Assistant">
      <header className="lattice-assistant-head">
        <span className="lattice-assistant-title">{header}</span>
        <span className="lattice-assistant-actions">
          <button
            type="button"
            className={`lattice-icon-btn${view === "setup" ? " is-active" : ""}`}
            onClick={() => setView(view === "setup" ? "chat" : "setup")}
            title={view === "setup" ? "回到对话" : "模型设置"}
            aria-label="Assistant settings"
          >
            {view === "setup" ? "←" : "⚙"}
          </button>
          <button type="button" className="lattice-icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </span>
      </header>

      {view === "setup" ? (
        <div className="lattice-assistant-body">
          <label className="lattice-textfield">
            <span>接口地址</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.deepseek.com/v1"
              spellCheck={false}
            />
          </label>
          <p className="lattice-assistant-hint">
            OpenAI 兼容的 <code className="lattice-mono">/chat/completions</code>。DeepSeek、OpenAI、
            Kimi、Qwen 都填各自的 <code className="lattice-mono">/v1</code>；本地模型填{" "}
            <code className="lattice-mono">http://127.0.0.1:11434/v1</code>（明文 http 只允许本机）。
          </p>

          <label className="lattice-textfield">
            <span>模型</span>
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
            <span>API key{status?.keyHint ? `（现在是 ${status.keyHint}）` : ""}</span>
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={status?.keyHint ? "留空 = 不改" : "sk-…"}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="lattice-textfield">
            <span>温度 {temperature.toFixed(2)}（越低越稳，改桌面建议 0.4–0.8）</span>
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
              测试连接
            </button>
            <button
              type="button"
              className="lattice-btn is-small is-primary"
              onClick={() => void persist()}
              disabled={saving}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {status?.keyHint && (
              <button type="button" className="lattice-btn is-small" onClick={() => void forget()}>
                删掉 key
              </button>
            )}
          </footer>
        </div>
      ) : (
        <>
          <div className="lattice-assistant-body" ref={bodyRef}>
            {entries.length === 0 && (
              <p className="lattice-assistant-hint">
                说一句它就能改桌面：「把时钟挪到右上角」「换成深色」「桌宠太大了，调小一点」。每一步都能撤销。
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
            {busy && <p className="lattice-assistant-hint">…在想</p>}
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
              placeholder="让桌面上发生点什么事（Enter 发送，Shift+Enter 换行）"
              disabled={busy}
            />
            <div className="lattice-assistant-foot">
              {busy ? (
                <button type="button" className="lattice-btn is-small" onClick={stop}>
                  停下
                </button>
              ) : (
                <button
                  type="button"
                  className="lattice-btn is-small is-primary"
                  onClick={() => void send()}
                  disabled={!draft.trim()}
                >
                  发送
                </button>
              )}
              <span className="lattice-assistant-meta">
                {usage ? `${usage.prompt} → ${usage.completion} tokens` : ""}
                {status?.keySource === "env" ? " · key 来自环境变量" : ""}
              </span>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
