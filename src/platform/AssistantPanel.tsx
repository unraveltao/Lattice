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
 * 没配好之前显示设置，配好之后显示对话。设置里是**一列档**而不是一个表单：
 * 一个人可能同时留着公司中转站和本机 Ollama，切换不该要求重粘 key
 * （见 `docs/design/0002-model-profiles.md`）。齿轮随时能切回去 —— 换模型是常事。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WidgetRecord } from "../runtime/registry";
import {
  activateLlmProfile,
  cancelActiveTurn,
  listModels,
  localSurface,
  readLlmProfiles,
  remoteSurface,
  removeLlmProfile,
  runAssistantTurn,
  saveLlmKey,
  saveLlmProfile,
  type ApprovalRequest,
  type Approver,
  type AssistantSurface,
  type ProfileView,
  type ProfilesView,
} from "./assistant";
import { readHands, saveHands } from "./hands";
import { allTools, systemPrompt, type ChatMessage } from "../runtime/assistant";
import {
  HAND_GROUPS,
  HAND_LABELS,
  HAND_READY,
  HANDS_OFF,
  type HandGroup,
  type HandsSettings,
} from "../runtime/hands";
import {
  AUTH_SHAPES,
  PRESETS,
  historyChars,
  knownModel,
  type AuthShape,
  type Preset,
} from "../runtime/llm-models";
import { useT } from "../runtime/i18n";

/** 一条要显示的东西。模型的消息和工具的执行结果分开排，读起来才像"过程" */
type Entry =
  | { kind: "user"; text: string }
  /** `live` = 这一条还在长（流式增量正在往里追加），最后会被整条回复覆盖 */
  | { kind: "assistant"; text: string; live?: boolean }
  | { kind: "tool"; detail: string; ok: boolean; error?: string }
  | { kind: "error"; text: string };

const DEFAULT_TEMPERATURE = 0.6;

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

/** 鉴权形状的中文/英文标签。三种，和 Rust 的 `normalize_auth` 一一对应 */
function authLabel(auth: AuthShape): string {
  if (auth === "none") return "No key (local model)";
  if (auth === "api-key-header") return "api-key header";
  return "Bearer token";
}

export function AssistantPanel({ open, onClose, records, variant = "drawer" }: AssistantPanelProps) {
  /** 语言一变就重渲染 —— 面板和小窗共用同一套文案 */
  const t = useT();
  const [profiles, setProfiles] = useState<ProfilesView | null>(null);
  const [view, setView] = useState<"chat" | "setup">("chat");

  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ prompt: number; completion: number } | null>(null);

  // 设置态：正在编辑哪一档（null = 新建）
  const [editing, setEditing] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(true);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [auth, setAuth] = useState<AuthShape>("bearer");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [setupNote, setSetupNote] = useState<string | null>(null);

  /** 会话本身。**跨越多次编辑保留**：关掉面板再开，刚才聊的还在 */
  const messages = useRef<ChatMessage[]>([]);
  const stopFlag = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** 用户拨开的那几只手。读一次、拨一次存一次（和模型档同一份 JSON） */
  const [hands, setHands] = useState<HandsSettings>(HANDS_OFF);
  /**
   * 正在等用户点头的那一下。**不做成 toast**：它阻塞这一轮，
   * 用户不管它，模型就一直等着 —— 所以确认条必须贴在输入框上面，
   * 不能是一个会自己消失的提示
   */
  const [approval, setApproval] = useState<{ name: string; detail: string; group: HandGroup } | null>(
    null,
  );
  const approvalResolve = useRef<((allowed: boolean) => void) | null>(null);
  /** 「本轮都允许」——寿命只有一轮，`send` 开始时清空 */
  const alwaysThisTurn = useRef<Set<string>>(new Set());

  const surface = useMemo<AssistantSurface>(
    () => (records ? localSurface([...records.values()]) : remoteSurface()),
    [records],
  );

  // 收进 ref：`send` 的依赖里不放 surface，否则每次清单变化都会重建回调
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  /**
   * 审批回调：把"要问什么"变成界面上的一条确认条，等用户点。
   *
   * 三条要点：
   *   - **返回 Promise**：循环在 `await` 上停住，模型不会再往前走一步。
   *     这里如果"先执行再问"，就等于把危险动作变成事后通知
   *   - 「本轮都允许」按**工具名**记（不是按参数）：同一个 `shell.run` 允许一次
   *     之后，这一轮后续的目录读取、跑测试都不再打断用户；名字之外的粒度
   *     用户没法预测自己同意了什么
   *   - 停止 / 关面板也要 resolve(false)：不然 `busy` 会一直亮着
   */
  const approve = useCallback<Approver>((request: ApprovalRequest) => {
    if (alwaysThisTurn.current.has(request.name)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      approvalResolve.current = (allowed) => {
        approvalResolve.current = null;
        setApproval(null);
        resolve(allowed);
      };
      setApproval({ name: request.name, detail: request.detail, group: request.group });
    });
  }, []);

  const decide = useCallback((allowed: boolean) => {
    approvalResolve.current?.(allowed);
  }, []);

  const decideAlways = useCallback(() => {
    if (approval) alwaysThisTurn.current.add(approval.name);
    decide(true);
  }, [approval, decide]);

  const active = profiles?.profiles.find((item) => item.id === profiles.activeId) ?? null;
  const editingProfile = profiles?.profiles.find((item) => item.id === editing) ?? null;
  const editingId = editingProfile?.id ?? null;
  const info = knownModel(model);
  /** 最后一条还在长 = 字正在出来，这时候不该再显示「Thinking…」 */
  const lastEntry = entries[entries.length - 1];
  const streaming = lastEntry?.kind === "assistant" && lastEntry.live === true;

  /** 把一档灌进表单 */
  const fill = useCallback((profile: ProfileView) => {
    setEditing(profile.id);
    setIsNew(false);
    setLabel(profile.label);
    setBaseUrl(profile.baseUrl);
    setAuth(profile.auth);
    setModel(profile.model);
    setTemperature(profile.temperature ?? DEFAULT_TEMPERATURE);
    setModels(profile.models ?? []);
    setKey("");
    setConfirmRemove(null);
  }, []);

  /** 空表单 = 新建一档。给一个预设就把地址/鉴权/模型先填好 */
  const startNew = useCallback((preset?: Preset) => {
    setEditing(null);
    setIsNew(true);
    setLabel("");
    setBaseUrl(preset?.baseUrl ?? PRESETS[0].baseUrl);
    setAuth(preset?.auth ?? "bearer");
    setModel(preset?.model ?? "");
    setTemperature(DEFAULT_TEMPERATURE);
    setModels([]);
    setKey("");
    setConfirmRemove(null);
  }, []);

  // 打开时读一次档列表：`llm_profiles` 只回掩码，key 本身永远不进前端
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readLlmProfiles()
      .then((next) => {
        if (cancelled) return;
        setProfiles(next);
        const current = next.profiles.find((item) => item.id === next.activeId) ?? null;
        if (current) fill(current);
        else startNew();
        if (!current || !current.configured) setView("setup");
      })
      .catch((problem) => {
        if (!cancelled) setError(String(problem));
      });
    // 手是另一份配置（同一个文件，另一个命令）。读失败不该挡住对话 ——
    // 最坏情况是"这一轮没有手"，那本来就是默认状态
    void readHands()
      .then((next) => {
        if (!cancelled) setHands(next);
      })
      .catch(() => {
        // 保持全关
      });
    return () => {
      cancelled = true;
    };
  }, [open, fill, startNew]);

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
    // 「本轮都允许」的寿命只有一轮
    alwaysThisTurn.current.clear();
    const table = allTools("platform", hands);
    try {
      // 第一条永远是 system：桌面现状每次现拍，模型不该记着"上次的桌面"。
      // 快照可能是 IPC 往返（独立小窗那条路），所以先 await 再拼
      const snapshot = await host.snapshot();
      if (conversation[0]?.role === "system") conversation.shift();
      conversation.unshift({
        role: "system",
        content: systemPrompt(snapshot, { hands, tools: table }),
      });
      conversation.push({ role: "user", content: text });

      await runAssistantTurn({
        messages: conversation,
        surface: host,
        shouldStop: () => stopFlag.current,
        // 上下文小的模型带不动 60k 字的历史；超了不是慢，是 400
        maxChars: historyChars(knownModel(active?.model ?? "")),
        // 工具表、提示词、执行器三处用**同一份** hands：少一处就是"它调了一个
        // 提示里说它做不到的工具"那种鬼故事
        tools: table,
        hands,
        approve,
        onEvent: (event) => {
          if (event.type === "delta") {
            // 正在长的那一条：同一轮里后续的增量都往它后面接。
            // 增量事件一个接一个来（Rust 已经按 60ms / 24 字攒过批），
            // 所以这里一次 setState 对应屏幕上可见的一小段
            setEntries((list) => {
              const last = list[list.length - 1];
              if (last?.kind === "assistant" && last.live) {
                return [...list.slice(0, -1), { ...last, text: last.text + event.text }];
              }
              return [...list, { kind: "assistant", text: event.text, live: true }];
            });
          } else if (event.type === "text") {
            // 整条回复到了：用它覆盖那条还在长的，或者新加一条（没有流式增量时）
            setEntries((list) => {
              const last = list[list.length - 1];
              if (last?.kind === "assistant" && last.live) {
                return [...list.slice(0, -1), { kind: "assistant", text: event.text }];
              }
              return [...list, { kind: "assistant", text: event.text }];
            });
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
  }, [active?.model, approve, busy, draft, hands]);

  const persist = useCallback(async () => {
    setSaving(true);
    setSetupNote(null);
    setError(null);
    try {
      const saved = await saveLlmProfile({
        id: isNew ? undefined : editing ?? undefined,
        label,
        baseUrl,
        auth,
        model,
        temperature,
      });
      let next = saved.view;
      if (key.trim()) next = await saveLlmKey(saved.id, key);
      setProfiles(next);
      setKey("");
      const stored = next.profiles.find((item) => item.id === saved.id);
      if (stored) fill(stored);
      setSetupNote(
        stored?.configured
          ? t("Saved. This profile is ready to use.")
          : auth === "none"
            ? t("Saved. A local model needs no key.")
            : t("Saved, but there is no key yet — paste one and save again."),
      );
      if (stored?.configured) setView("chat");
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [auth, baseUrl, editing, fill, isNew, key, label, model, t, temperature]);

  const test = useCallback(async () => {
    setSaving(true);
    setSetupNote(null);
    setError(null);
    try {
      // 编辑已有的档时把 id 一起带上：没重新输入 key，就用存着的那一把（Rust 里读）
      const list = await listModels({
        profileId: isNew ? undefined : editing ?? undefined,
        baseUrl,
        auth,
        key: key.trim() || undefined,
      });
      setModels(list);
      setSetupNote(
        list.length
          ? t("Connected. {count} models are available — pick one below.", { count: list.length })
          : t("Connected, but this endpoint listed no models. Type the model name by hand."),
      );
      if (!model.trim() && list[0]) setModel(list[0]);
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [auth, baseUrl, editing, isNew, key, model, t]);

  const forget = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const next = await saveLlmKey(editing, "");
      setProfiles(next);
      const stored = next.profiles.find((item) => item.id === editing);
      if (stored) fill(stored);
      setSetupNote(t("Key removed from this machine."));
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [editing, fill, t]);

  const use = useCallback(async (id: string) => {
    try {
      const next = await activateLlmProfile(id);
      setProfiles(next);
      const stored = next.profiles.find((item) => item.id === id);
      if (stored) fill(stored);
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    }
  }, [fill]);

  const forgetProfile = useCallback(async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      const next = await removeLlmProfile(id);
      setProfiles(next);
      const current = next.profiles.find((item) => item.id === next.activeId) ?? null;
      if (current) fill(current);
      else startNew();
      setSetupNote(t("Profile deleted, along with its key."));
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSaving(false);
    }
  }, [fill, startNew, t]);

  const stop = useCallback(() => {
    stopFlag.current = true;
    // 光设标志只能打断"步与步之间"；字正在冒的时候得让 Rust 那头的读循环收手，
    // 命令正在跑的时候得把那个进程杀掉
    void cancelActiveTurn();
    // 正卡在确认条上：按停止等于拒绝，否则这一轮永远不结束
    approvalResolve.current?.(false);
  }, []);

  /** 拨一个开关并落盘。**先落盘再更新界面**：存失败时界面不该显示"已经开了" */
  const toggleHand = useCallback(
    async (group: HandGroup, on: boolean) => {
      const next = { ...hands, [group]: on };
      setHands(next);
      try {
        const saved = await saveHands(next);
        setHands(saved);
      } catch (problem) {
        setHands(hands);
        setError(String(problem instanceof Error ? problem.message : problem));
      }
    },
    [hands],
  );

  const turnAllOff = useCallback(async () => {
    // 「一键关掉」== 关掉并且当场叫停这一轮：用户按下它的时候，
    // 大概率正是看见某条命令不对
    const next = { ...HANDS_OFF, workspace: hands.workspace };
    setHands(next);
    stopFlag.current = true;
    void cancelActiveTurn();
    approvalResolve.current?.(false);
    try {
      const saved = await saveHands(next);
      setHands(saved);
    } catch (problem) {
      setError(String(problem instanceof Error ? problem.message : problem));
    }
  }, [hands.workspace]);

  const setWorkspace = useCallback(
    async (value: string) => {
      const next = { ...hands, workspace: value };
      setHands(next);
      try {
        const saved = await saveHands(next);
        setHands(saved);
      } catch (problem) {
        setError(String(problem instanceof Error ? problem.message : problem));
      }
    },
    [hands],
  );

  const header = useMemo(() => {
    if (!active) return t("Assistant · Not configured");
    if (!active.configured) return t("Assistant · Not configured");
    return t("Assistant · {model}", { model: active.model || active.label });
  }, [active, t]);

  if (!open) return null;

  const sourceNote =
    editingProfile?.keySource === "env"
      ? t("This key comes from the environment, not from this machine's settings.")
      : null;

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
          {/* 一列档：点一条就是编辑它，"Use" 才是切过去 */}
          <div className="lattice-profile-list">
            {profiles?.profiles.map((item) => (
              <div key={item.id} className={`lattice-profile-row${item.id === editing ? " is-editing" : ""}`}>
                <button type="button" className="lattice-profile-pick" onClick={() => fill(item)}>
                  <span className={`lattice-profile-dot${item.configured ? " is-on" : ""}`} />
                  <span className="lattice-profile-name">{item.label}</span>
                  <span className="lattice-profile-model">{item.model || t("no model yet")}</span>
                </button>
                {item.id === profiles.activeId ? (
                  <span className="lattice-profile-badge">{t("In use")}</span>
                ) : (
                  <button
                    type="button"
                    className="lattice-btn is-small"
                    onClick={() => void use(item.id)}
                    title={t("Make this the profile the assistant uses")}
                  >
                    {t("Use")}
                  </button>
                )}
              </div>
            ))}
            {!profiles?.profiles.length && <p className="lattice-assistant-hint">{t("No model profile yet.")}</p>}
            <button type="button" className="lattice-btn is-small" onClick={() => startNew()}>
              + {t("Add a model profile")}
            </button>
          </div>

          {isNew && (
            <div className="lattice-preset-row">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="lattice-preset-chip"
                  title={t(preset.hint)}
                  onClick={() => startNew(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}

          <label className="lattice-textfield">
            <span>{t("Name")}</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t("Leave empty to use the host name")}
              spellCheck={false}
            />
          </label>

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
            {t("Any OpenAI-compatible endpoint works. Plain http is only allowed for localhost.")}
          </p>

          <label className="lattice-textfield">
            <span>{t("How does this endpoint want the key?")}</span>
            <select value={auth} onChange={(event) => setAuth(event.target.value as AuthShape)}>
              {AUTH_SHAPES.map((shape) => (
                <option key={shape} value={shape}>
                  {t(authLabel(shape))}
                </option>
              ))}
            </select>
          </label>

          <label className="lattice-textfield">
            <span>{t("Model")}</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={PRESETS[0].model}
              list="lattice-llm-models"
              spellCheck={false}
            />
            <datalist id="lattice-llm-models">
              {[...new Set([...models, ...(editingProfile?.models ?? [])])].map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>

          {!info.tools && (
            <p className="lattice-assistant-hint is-warn">
              {t("This model cannot call tools — it can talk, but it cannot change the desktop.")}
            </p>
          )}

          {info.temperature && (
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
          )}

          {auth !== "none" && (
            <label className="lattice-textfield">
              <span>
                {editingProfile?.keyHint
                  ? t("API key (currently {hint})", { hint: editingProfile.keyHint })
                  : t("API key")}
              </span>
              <input
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={editingProfile?.keyHint ? t("Leave empty to keep the current key") : "sk-…"}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          )}

          {sourceNote && <p className="lattice-assistant-hint">{sourceNote}</p>}

          {/* 手：默认全关。打开一组等于允许它做一类事（0004 §5） */}
          <section className="lattice-hands">
            <header className="lattice-hands-head">
              <span>{t("What it may do")}</span>
              <button type="button" className="lattice-btn is-small" onClick={() => void turnAllOff()}>
                {t("Turn all off")}
              </button>
            </header>
            <p className="lattice-assistant-hint">
              {t("Nothing is on by default. Reading files and fetching pages run without asking; writing, commands and clicks always ask you first.")}
            </p>
            {HAND_GROUPS.map((group) => (
              <label
                key={group}
                className={`lattice-hand-row${HAND_READY[group] ? "" : " is-soon"}`}
              >
                <input
                  type="checkbox"
                  checked={hands[group]}
                  disabled={!HAND_READY[group]}
                  onChange={(event) => void toggleHand(group, event.target.checked)}
                />
                <span className="lattice-hand-copy">
                  <span className="lattice-hand-name">
                    {t(HAND_LABELS[group].label)}
                    {!HAND_READY[group] && (
                      <span className="lattice-hand-soon">{t("Coming in a later update")}</span>
                    )}
                  </span>
                  <span className="lattice-hand-hint">{t(HAND_LABELS[group].hint)}</span>
                </span>
              </label>
            ))}
            <label className="lattice-textfield">
              <span>{t("Workspace folder")}</span>
              <input
                value={hands.workspace}
                onChange={(event) => void setWorkspace(event.target.value)}
                placeholder="D:\\GitDev\\lattice"
                spellCheck={false}
              />
            </label>
            <p className="lattice-assistant-hint">
              {t("Relative paths and commands start here. Reading is not limited to this folder — only writing asks, and the prompt shows the full path.")}
            </p>
          </section>

          {error && <p className="lattice-modal-error">{error}</p>}
          {setupNote && <p className="lattice-assistant-hint">{setupNote}</p>}

          <footer className="lattice-assistant-foot">
            <button type="button" className="lattice-btn is-small" onClick={() => void test()} disabled={saving}>
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
            {auth !== "none" && editingProfile?.keyHint && (
              <button type="button" className="lattice-btn is-small" onClick={() => void forget()} disabled={saving}>
                {t("Forget key")}
              </button>
            )}
            {!isNew && editingId && (
              <button
                type="button"
                className={`lattice-btn is-small${confirmRemove === editingId ? " is-danger" : ""}`}
                onClick={() => {
                  if (confirmRemove === editingId) void forgetProfile(editingId);
                  else setConfirmRemove(editingId);
                }}
                disabled={saving}
              >
                {confirmRemove === editingId ? t("Delete it and its key?") : t("Delete profile")}
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
                <p
                  key={index}
                  className={`lattice-assistant-turn is-${entry.kind}${entry.kind === "assistant" && entry.live ? " is-live" : ""}`}
                >
                  {entry.text}
                </p>
              );
            })}
            {busy && !streaming && <p className="lattice-assistant-hint">{t("Thinking…")}</p>}
          </div>

          {approval && (
            <div className="lattice-assistant-approval" role="group" aria-label={t("Approve this action")}>
              <p className="lattice-assistant-approval-text">{approval.detail}</p>
              <div className="lattice-assistant-approval-buttons">
                <button type="button" className="lattice-btn is-small is-primary" onClick={() => decide(true)}>
                  {t("Allow")}
                </button>
                <button type="button" className="lattice-btn is-small" onClick={decideAlways}>
                  {t("Always this turn")}
                </button>
                <button type="button" className="lattice-btn is-small is-danger" onClick={() => decide(false)}>
                  {t("Deny")}
                </button>
              </div>
            </div>
          )}

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
                {active?.keySource === "env" ? ` · ${t("key from the environment")}` : ""}
              </span>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
