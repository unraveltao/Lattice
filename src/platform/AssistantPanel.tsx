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
  cancelActiveTurn,
  deleteSession,
  listSessions,
  loadSession,
  localSurface,
  readLlmProfiles,
  remoteSurface,
  runAssistantTurn,
  saveSession,
  type ApprovalRequest,
  type Approver,
  type AssistantSurface,
  type ProfilesView,
  type SessionMessage,
  type SessionSummary,
  type SessionUsage,
} from "./assistant";
import {
  discoverMcpTools,
  importSkill,
  readHands,
  readMcpServers,
  readMode,
  readSkills,
  removeSkill,
  saveHands,
  saveMcpServers,
  saveMode,
  saveSkills,
} from "./hands";
import {
  allTools,
  systemPrompt,
  type CatalogueHint,
  type ChatMessage,
  type ToolSpec,
} from "../runtime/assistant";
import {
  APPROVAL_LABELS,
  APPROVAL_MODES,
  HAND_GROUPS,
  HAND_LABELS,
  HAND_READY,
  DEFAULT_ASSISTANT_MODE,
  HANDS_OFF,
  effectiveHands,
  grantAllHands,
  modeIgnoresSwitches,
  mcpToolSpecs,
  normalizeApproval,
  splitCommandLine,
  type ApprovalMode,
  type AssistantMode,
  type HandGroup,
  type HandsSettings,
  type McpServer,
  type McpServerTools,
} from "../runtime/hands";
import { historyChars, knownModel } from "../runtime/llm-models";
import {
  SKILL_BODY_MAX,
  SKILL_MAX,
  SKILL_TOTAL_MAX,
  charCount,
  checkBudget,
  missingGroups,
  promptsOf,
  type SkillView,
} from "../runtime/skills";
import { useT } from "../runtime/i18n";
import {
  widgetToolSources,
  widgetToolSpecs,
  type WidgetToolSource,
} from "../runtime/widget-tools";
import { ModelProfiles } from "./ModelProfiles";
import { useLattice } from "./store";

/** 一条要显示的东西。模型的消息和工具的执行结果分开排，读起来才像"过程" */
type Entry =
  | { kind: "user"; text: string }
  /** `live` = 这一条还在长（流式增量正在往里追加），最后会被整条回复覆盖 */
  | { kind: "assistant"; text: string; live?: boolean }
  | { kind: "tool"; detail: string; ok: boolean; error?: string }
  | { kind: "error"; text: string };

/** 存下来的消息 → 面板的对话行。
 *
 * **工具那几行不重建**：chip 上那句话是当场按参数拼的（`describeToolCall`），
 * 文件里只有原始参数 —— 重建出来会是"另一种说法"，用户会以为它换了个做法。
 * 只还原 user / assistant 的正文，剩下的靠"这条是旧对话"这件事本身交代。 */
function entriesFromSession(messages: SessionMessage[]): Entry[] {
  const entries: Entry[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (!text) continue;
    entries.push({ kind: message.role, text });
  }
  return entries;
}

/** 会话文件里的消息 → 循环吃的形状。`content` 可能是 null（工具调用那条） */
function messagesFromSession(messages: SessionMessage[]): ChatMessage[] {
  return messages
    .filter((message) => typeof message.role === "string" && message.role)
    .map((message) => ({
      ...message,
      content: typeof message.content === "string" ? message.content : "",
    })) as ChatMessage[];
}

/**
 * 启动之后是否已经提示过「全部」模式。**进程级一个布尔就够**（主窗口抽屉与
 * 小窗各一份，各提示一次）。反复弹会把常驻模式条的意义抹掉 —— 用户学会无视它
 * 之后，真正需要的提示也一起被无视了
 */
let modeRemindedOnce = false;

export interface AssistantPanelProps {
  open: boolean;
  onClose: () => void;
  /**
   * 主窗口里的抽屉才给这份清单：它自己有画布，快照和动作都在本地跑。
   * 桌面上那个独立小窗不给 —— 它走 `remoteSurface()`，把活儿转给主窗口，
   * 因为布局的权威在那儿（见 `platform/assistant.ts` 的 `AssistantSurface`）。
   */
  records?: ReadonlyMap<string, WidgetRecord>;
  /**
   * 商店里还没装的那些（`{id, name}`）。**目录没加载就不传** —— 没读到目录时
   * 不提商店，模型就不会凭空推荐一个已经撤下的组件（0003 §4 的第二小段）。
   */
  catalogue?: CatalogueHint[];
  /** `window` = 独立小窗：铺满窗口、不要圆角和投影（那些由窗口壳负责） */
  variant?: "drawer" | "window";
}

/** 鉴权形状的中文/英文标签。三种，和 Rust 的 `normalize_auth` 一一对应 */

export function AssistantPanel({ open, onClose, records, catalogue, variant = "drawer" }: AssistantPanelProps) {
  /** 语言一变就重渲染 —— 面板和小窗共用同一套文案 */
  const t = useT();
  /**
   * 模型档只读一份**列表**：标题要显示"正在用哪个模型"。
   * 编辑那一摊（新建 / 测连接 / 存 key / 删档 / 切 active）全在 `ModelProfiles` 里，
   * 两个入口共用同一份实现 —— 见那边的文件头。
   */
  const [profiles, setProfiles] = useState<ProfilesView | null>(null);
  const [view, setView] = useState<"chat" | "setup">("chat");

  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ prompt: number; completion: number } | null>(null);

  /** 会话本身。**跨越多次编辑保留**：关掉面板再开，刚才聊的还在 */
  const messages = useRef<ChatMessage[]>([]);
  const stopFlag = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** 用户拨开的那几只手。读一次、拨一次存一次（和模型档同一份 JSON） */
  const [hands, setHands] = useState<HandsSettings>(HANDS_OFF);
  /**
   * 两个模式（0009）：内部 / 全部。**存盘**，每次开面板读一次。
   *
   * `effective` 也一起收下来：只读档压在「全部」上面时它是 false，模式条要照实
   * 说"被只读档压住"，而不是把模式偷偷显示成 internal
   */
  const [mode, setMode] = useState<AssistantMode>(DEFAULT_ASSISTANT_MODE);
  const [modeEffective, setModeEffective] = useState(true);
  /** 切到「全部」之前那一次确认。**只往提权的方向问**，切回来不问 */
  const [modeConfirm, setModeConfirm] = useState(false);
  /** 启动时就已经在「全部」模式：开面板提示一次（这是存盘的唯一代价） */
  const [modeReminder, setModeReminder] = useState(false);
  /**
   * 外部服务（MCP）：服务器列表 + 上一次发现的结果。
   * 两者都是**每次开面板重新读**（发现走内存缓存，重读不贵）
   */
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpFound, setMcpFound] = useState<McpServerTools[]>([]);
  const [mcpNote, setMcpNote] = useState<string | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  /** 新服务器那一行：stdio 填"命令 + 参数"，http 填 URL，用同一个输入框 */
  const [mcpDraft, setMcpDraft] = useState<{
    label: string;
    transport: McpServer["transport"];
    target: string;
  }>({ label: "", transport: "stdio", target: "" });
  /**
   * 技能包（0005）：目录里的清单 + 启用哪几份。
   *
   * **每次开面板重新读**：用户可能在资源管理器里删过一个目录，面板不该还画着它。
   * 正文跟着清单一起过来（渲染进程没有文件系统），提示词那一段直接用。
   */
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [skillsFolder, setSkillsFolder] = useState("");
  const [skillsNote, setSkillsNote] = useState<string | null>(null);
  const [skillsBusy, setSkillsBusy] = useState(false);
  /** 导入框：一个目录（里面有 SKILL.md）或一个 `.md` 的绝对路径 */
  const [skillPath, setSkillPath] = useState("");
  /** 要删的那一个：**两步确认**，删目录之后撤销不了 */
  const [skillRemoving, setSkillRemoving] = useState<string | null>(null);
  /**
   * 正在等用户点头的那一下。**不做成 toast**：它阻塞这一轮，
   * 用户不管它，模型就一直等着 —— 所以确认条必须贴在输入框上面，
   * 不能是一个会自己消失的提示
   */
  const [approval, setApproval] = useState<{
    name: string;
    detail: string;
    group: HandGroup | null;
  } | null>(
    null,
  );
  const approvalResolve = useRef<((allowed: boolean) => void) | null>(null);
  /** 「本轮都允许」——寿命只有一轮，`send` 开始时清空 */
  const alwaysThisTurn = useRef<Set<string>>(new Set());

  const surface = useMemo<AssistantSurface>(
    () => (records ? localSurface([...records.values()]) : remoteSurface()),
    [records],
  );

  /*
   * 数据平面：这一轮能调的组件工具。
   *
   * 三个条件全为真才进表（判据只在 `widgetToolSources` 里）：装上了、用户授了
   * `agent:tools`、清单里真声明了。**小窗那一份没有清单**（`records` 不传），
   * 于是它那一轮没有组件工具 —— 那是"执行者在主窗口"的延续，不是可以忽略的分叉，
   * 缺口记在 ROADMAP 里。
   */
  const placements = useLattice((state) => state.placements);
  const grants = useLattice((state) => state.grants);
  const installedIds = useLattice((state) => state.installedIds);
  const widgetSources = useMemo<WidgetToolSource[]>(
    () =>
      widgetToolSources(
        Array.from(records?.values() ?? []).flatMap((record) =>
          placements
            .filter((placement) => placement.widgetId === record.manifest.id)
            .map((placement) => ({
              instanceId: placement.instanceId,
              widgetId: record.manifest.id,
              // 用 id 当"哪一份"的说明：它稳定、不需要翻译，也不会因为两门语言
              // 各写一个名字而让模型看到两个不同的东西
              title: record.manifest.id,
              tools: record.manifest.agent.tools,
              installed: installedIds.includes(record.manifest.id),
              granted: (grants[record.manifest.id] ?? []).includes("agent:tools"),
            })),
        ),
      ),
    [records, placements, grants, installedIds],
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

  // —— 会话（0003 §4）：一份对话一个文件 ——
  //
  // 三样东西分得很清楚，混起来就出错：
  //   - `sessions` 是**列表**（只有摘要）。50 份对话的正文一次读进内存只为画个
  //     下拉框，那是白花几百毫秒；
  //   - `currentId` 是"现在这套消息属于哪一份文件"，`null` = 还没存过；
  //   - `usageTotal` 是**整份会话**的累计花销，和界面上那个"最后一轮"的数是两回事。
  /** 下拉框里那些对话，按最近改过的排 */
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** 界面上那个选中项（ref 是给回调用的一份，state 是给渲染用的一份） */
  const [currentId, setCurrentId] = useState<string | null>(null);
  const sessionId = useRef<string | null>(null);
  const usageTotal = useRef<SessionUsage>({ promptTokens: 0, completionTokens: 0 });
  /** 存不上 / 被截断时贴一行说明。**不是 `error`**：这一轮本身是好的 */
  const [sessionNote, setSessionNote] = useState<string | null>(null);

  const rememberSession = useCallback((id: string | null) => {
    sessionId.current = id;
    setCurrentId(id);
  }, []);

  const active = profiles?.profiles.find((item) => item.id === profiles.activeId) ?? null;
  /**
   * 这一轮真的开着的那几组。技能那一行靠它标"缺 Files" ——
   * **模式也参与**：全部模式下六组临时全开，那一行就不该再挂着"缺"
   */
  const groupsOn = useMemo<HandGroup[]>(() => {
    const effective = effectiveHands(hands, mode);
    return HAND_GROUPS.filter((group) => effective[group]);
  }, [hands, mode]);
  /** 最后一条还在长 = 字正在出来，这时候不该再显示「Thinking…」 */
  const lastEntry = entries[entries.length - 1];
  const streaming = lastEntry?.kind === "assistant" && lastEntry.live === true;

  // 打开时读一次档列表：`llm_profiles` 只回掩码，key 本身永远不进前端
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readLlmProfiles()
      .then((next) => {
        if (cancelled) return;
        setProfiles(next);
        const current = next.profiles.find((item) => item.id === next.activeId) ?? null;
        // 一档能用的都没有 → 直接把设置态打开。这里只判断"要不要开"，
        // 编辑那一摊（含自动开一张空表）归 `ModelProfiles` 管
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
    // 模式也是同一份配置里的字段（0009）。读不到 = 内部 —— 往安全那边倒
    void readMode()
      .then((view) => {
        if (cancelled) return;
        setMode(view.mode);
        setModeEffective(view.effective);
        // 存的就是「全部」：**启动之后第一次打开面板提示一次**。
        // 之后只靠常驻的那条模式条，不再打断用户
        if (!modeRemindedOnce) {
          modeRemindedOnce = true;
          if (modeIgnoresSwitches(view.mode)) setModeReminder(true);
        }
      })
      .catch(() => {
        // 保持内部
      });
    // 服务器列表也是同一类东西：读不到就当"一个都没配"。
    // **发现不在开机时做** —— 那要起进程，面板一打开就卡几秒不值得
    void readMcpServers()
      .then((list) => {
        if (!cancelled) setMcpServers(list);
      })
      .catch(() => {
        // 浏览器预览里没有这条命令
      });
    // 技能包（0005）：列表 + 启用清单一起回来。读不到 = 一份都没有（默认状态）
    void readSkills()
      .then((view) => {
        if (cancelled) return;
        setSkills(view.skills);
        setSkillsFolder(view.folder);
      })
      .catch(() => {
        // 浏览器预览里没有这条命令
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /**
   * 打开时读一次会话列表，并把最近那一份接着聊。
   *
   * 0003 §5 第一行就是这条要修的东西（"面板重开，前两天聊的没了"）。
   * **已经聊着的那一轮不许被覆盖**：抽屉关掉再打开时 `messages` 这个 ref 还在，
   * 那不是"新开一个面板"，把最近的会话盖上去等于把刚说的话吃掉。
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listSessions()
      .then(async (list) => {
        if (cancelled) return;
        setSessions(list);
        if (messages.current.length > 0) return;
        const latest = list.find((item) => !item.damaged);
        if (!latest) return;
        const full = await loadSession(latest.id);
        if (cancelled) return;
        rememberSession(full.id);
        messages.current = messagesFromSession(full.messages);
        usageTotal.current = full.usage;
        setEntries(entriesFromSession(full.messages));
      })
      .catch(() => {
        // 浏览器预览里没有这几条命令；坏文件也不该挡住面板打开
      });
    return () => {
      cancelled = true;
    };
  }, [open, rememberSession]);

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

  /**
   * 把这一套消息存回去。**存不上的时候不许把它变成 `error`** —— 那一轮已经
   * 答完了，丢的只是"下次还能看到"，报成错误会让用户以为请求失败了。
   */
  const persistSession = useCallback(
    async (conversation: ChatMessage[]) => {
      // 一条 user 都没有的不值得落盘（比如刚打开面板就关掉）
      if (!conversation.some((message) => message.role === "user")) return;
      try {
        const saved = await saveSession({
          id: sessionId.current ?? undefined,
          model: active?.model ?? "",
          profileId: profiles?.activeId || undefined,
          messages: conversation,
          usage: usageTotal.current,
        });
        rememberSession(saved.id);
        setSessionNote(
          saved.dropped > 0
            ? t("This chat was too long, so its oldest messages were dropped.")
            : null,
        );
        setSessions(await listSessions());
      } catch (problem) {
        setSessionNote(String(problem instanceof Error ? problem.message : problem));
      }
    },
    [active?.model, profiles?.activeId, rememberSession, t],
  );

  const startNewChat = useCallback(() => {
    if (busy) return;
    rememberSession(null);
    messages.current = [];
    usageTotal.current = { promptTokens: 0, completionTokens: 0 };
    setUsage(null);
    setEntries([]);
    setSessionNote(null);
    setError(null);
  }, [busy, rememberSession]);

  const openSession = useCallback(
    async (id: string) => {
      if (!id || busy) return;
      try {
        const full = await loadSession(id);
        rememberSession(full.id);
        messages.current = messagesFromSession(full.messages);
        usageTotal.current = full.usage;
        setEntries(entriesFromSession(full.messages));
        // 界面上那个数是"最后一轮"，不从文件里编一个出来
        setUsage(null);
        setSessionNote(
          full.truncated ? t("This chat was too long, so its oldest messages were dropped.") : null,
        );
        setError(null);
      } catch {
        setSessionNote(t("That chat could not be opened."));
      }
    },
    [busy, rememberSession, t],
  );

  /** 删掉现在这一份。**先清界面再删文件**：删失败时用户不该还看着一段"已删"的对话 */
  const removeCurrentSession = useCallback(async () => {
    const id = sessionId.current;
    if (busy) return;
    startNewChat();
    if (!id) return;
    try {
      await deleteSession(id);
      setSessions(await listSessions());
    } catch (problem) {
      setSessionNote(String(problem instanceof Error ? problem.message : problem));
    }
  }, [busy, startNewChat]);

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
    /* 外部服务的工具表是**动态的**：先问一次（走 Rust 的内存缓存），再合进表里。
     * 发现失败不该挡掉这一轮 —— 大不了这次没有外部工具，比整轮报错好 */
    /* 「全部」模式下六组**临时全开**（用户存的那一份不动）。这一份 `handsOn`
     * 是这一轮唯一的真相：工具表、提示词、执行器三处都用它 */
    const handsOn = effectiveHands(hands, mode);
    let extra: Record<string, ToolSpec> = {};
    if (handsOn.mcp) {
      try {
        extra = mcpToolSpecs(await discoverMcpTools(false));
      } catch {
        extra = {};
      }
    }
    const table = allTools("platform", handsOn, extra, widgetToolSpecs(widgetSources));
    try {
      // 第一条永远是 system：桌面现状每次现拍，模型不该记着"上次的桌面"。
      // 快照可能是 IPC 往返（独立小窗那条路），所以先 await 再拼
      const snapshot = await host.snapshot();
      if (conversation[0]?.role === "system") conversation.shift();
      conversation.unshift({
        role: "system",
        content: systemPrompt(snapshot, {
          hands: handsOn,
          tools: table,
          catalogue,
          // 技能包（0005）：启用了、且没读坏的那几份正文进提示词。
          // **只是文字** —— 技能不新增工具，做的事仍然要过一次审批
          skills: promptsOf(skills),
        }),
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
        hands: handsOn,
        mode,
        widgets: widgetSources,
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
            // 存进文件的是**整份会话**的累计：界面上那个数是"最后一轮"
            usageTotal.current = {
              promptTokens: usageTotal.current.promptTokens + event.promptTokens,
              completionTokens: usageTotal.current.completionTokens + event.completionTokens,
            };
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
      // 每一轮都存：用户下一句很可能就在关掉面板之后（0003 §5 第一行）
      void persistSession(conversation);
    }
  }, [active?.model, approve, busy, catalogue, draft, hands, mode, persistSession, skills, widgetSources]);


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

  /** 换审批档并落盘。和拨开关同一条规矩：先落盘再更新界面 */
  /* 切模式。往提权的方向（→ 全部）先弹一次确认，把四条硬线印在上面；
   * 往安全的方向（→ 内部）**不问** —— 拦着用户往回走没有道理 */
  const changeMode = useCallback(
    (next: AssistantMode) => {
      if (next === mode) return;
      if (modeIgnoresSwitches(next)) {
        setModeConfirm(true);
        return;
      }
      setMode(next);
      void saveMode(next)
        .then((view) => {
          setMode(view.mode);
          setModeEffective(view.effective);
        })
        .catch(() => {
          /* 存不上就退回原样：别把界面画成一个假的"已切回内部" */
          setMode(mode);
        });
    },
    [mode],
  );

  const confirmEverything = useCallback(() => {
    setModeConfirm(false);
    setModeReminder(false);
    setMode("everything");
    void saveMode("everything")
      .then((view) => {
        setMode(view.mode);
        setModeEffective(view.effective);
      })
      .catch(() => {
        setMode(mode);
      });
  }, [mode]);

  const setApprovalMode = useCallback(
    async (mode: ApprovalMode) => {
      const next = { ...hands, approvalMode: mode };
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
    // 大概率正是看见某条命令不对。
    // **审批档要留着**：它管的不只是手（`readonly` 连桌面动作都挡），
    // 借这一下把它松回 `ask` 等于"关手"顺手开了另一扇门
    const next = {
      ...HANDS_OFF,
      workspace: hands.workspace,
      approvalMode: normalizeApproval(hands.approvalMode),
    };
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
  }, [hands.workspace, hands.approvalMode]);

  /**
   * 「给 agent 权力」：六只手一次全开，其余一概不碰。
   *
   * **它写的是开关，不是模式**（0009）：模式管"要不要问"，开关管"能不能"。
   * 所以这一下既不改 `mode`、也不改 `approvalMode`（`readonly` 仍然优先）、
   * 更不动 `workspace` —— 用户按完还能逐组拨回去，面板上看得见自己开了什么。
   * 别图省事改走 `saveMode("everything")`：那等于顺手把"还问不问"也一起替他决定了。
   */
  const grantAll = useCallback(async () => {
    const next = grantAllHands(hands);
    setHands(next);
    try {
      const saved = await saveHands(next);
      setHands(saved);
    } catch (problem) {
      setHands(hands);
      setError(String(problem instanceof Error ? problem.message : problem));
    }
  }, [hands]);

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

  /**
   * 勾 / 取消一份技能。
   *
   * **上限在勾的这一刻判**（0005 §3）：4 份 / 每份 4 000 字 / 合计 8 000 字。
   * 超了就当场说清超了多少，开关回到原样 —— "看起来勾上了、其实没生效"是最糟的
   * 一种失败，用户会以为它已经在照这份做了。
   */
  const toggleSkill = useCallback(
    async (id: string, on: boolean) => {
      const next = skills.map((skill) => (skill.id === id ? { ...skill, enabled: on } : skill));
      const wanted = promptsOf(next);
      const budget = checkBudget(wanted);
      if (!budget.ok) {
        const tooLong = next.find(
          (skill) => skill.enabled && charCount(skill.body) > SKILL_BODY_MAX,
        );
        setSkillsNote(
          budget.reason === "count"
            ? t("At most {limit} skills can be on at once — turn one off first.", {
                limit: SKILL_MAX,
              })
            : budget.reason === "body"
              ? t("A skill's text is capped at {limit} characters — “{name}” has {total}.", {
                  limit: SKILL_BODY_MAX,
                  name: tooLong?.name ?? "",
                  total: budget.total,
                })
              : t("The skills you turn on share {limit} characters — these would be {total}.", {
                  limit: SKILL_TOTAL_MAX,
                  total: budget.total,
                }),
        );
        return;
      }
      const before = skills;
      setSkills(next);
      setSkillsBusy(true);
      setSkillsNote(null);
      try {
        const view = await saveSkills(wanted.map((skill) => skill.id));
        setSkills(view.skills);
      } catch (problem) {
        // 存不进去就退回原样：别把界面画成一个假的"已勾上"
        setSkills(before);
        setSkillsNote(String(problem instanceof Error ? problem.message : problem));
      } finally {
        setSkillsBusy(false);
      }
    },
    [skills, t],
  );

  /**
   * 导入一份技能：一个目录（里面有 `SKILL.md`）或一个 `.md` 文件。
   *
   * **导进来不等于启用**（0005 §4）：勾上才算"这一轮照它做"。是一句"有了"，
   * 不是一句"开始用"。
   */
  const addSkill = useCallback(async () => {
    const path = skillPath.trim();
    if (!path) return;
    setSkillsBusy(true);
    setSkillsNote(null);
    try {
      const view = await importSkill(path);
      setSkills(view.skills);
      setSkillsFolder(view.folder);
      setSkillPath("");
      setSkillsNote(t("Added. Turn it on when you want it used."));
    } catch (problem) {
      setSkillsNote(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSkillsBusy(false);
    }
  }, [skillPath, t]);

  /** 删一个技能目录（附带把它从启用清单里剔掉）。**目录删了就回不来** */
  const dropSkill = useCallback(async (id: string) => {
    setSkillRemoving(null);
    setSkillsBusy(true);
    setSkillsNote(null);
    try {
      const view = await removeSkill(id);
      setSkills(view.skills);
    } catch (problem) {
      setSkillsNote(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setSkillsBusy(false);
    }
  }, []);

  /**
   * 问一遍服务器要工具表。`refresh = true` 时才重问已经发现过的
   * （用户刚改完命令/URL，缓存里的那张表已经不代表这个服务器了）
   */
  const refreshMcp = useCallback(async (refresh: boolean) => {
    setMcpBusy(true);
    setMcpNote(null);
    try {
      const found = await discoverMcpTools(refresh);
      setMcpFound(found);
      const total = found.reduce((sum, server) => sum + (server.ok ? server.tools.length : 0), 0);
      setMcpNote(t("Found {count} tools.", { count: total }));
    } catch (problem) {
      setMcpNote(String(problem instanceof Error ? problem.message : problem));
    } finally {
      setMcpBusy(false);
    }
  }, [t]);

  /** 存整份列表。**存完清掉发现结果**：旧的那张表已经不代表这些服务器了 */
  const persistMcp = useCallback(
    async (next: McpServer[]) => {
      setMcpBusy(true);
      setMcpNote(null);
      try {
        const saved = await saveMcpServers(next);
        setMcpServers(saved);
        setMcpFound([]);
        setMcpNote(t("Saved. Refresh to see its tools."));
      } catch (problem) {
        setMcpNote(String(problem instanceof Error ? problem.message : problem));
      } finally {
        setMcpBusy(false);
      }
    },
    [t],
  );

  const addMcpServer = useCallback(() => {
    const target = mcpDraft.target.trim();
    if (!target) return;
    const next: McpServer =
      mcpDraft.transport === "http"
        ? {
            id: "",
            label: mcpDraft.label.trim(),
            transport: "http",
            command: "",
            args: [],
            url: target,
          }
        : (() => {
            const parts = splitCommandLine(target);
            return {
              id: "",
              label: mcpDraft.label.trim(),
              transport: "stdio" as const,
              command: parts[0] ?? "",
              args: parts.slice(1),
              url: "",
            };
          })();
    if (next.transport === "stdio" && !next.command) return;
    void persistMcp([...mcpServers, next]);
    setMcpDraft((draft) => ({ ...draft, label: "", target: "" }));
  }, [mcpDraft, mcpServers, persistMcp]);

  const removeMcpServer = useCallback(
    (id: string) => {
      void persistMcp(mcpServers.filter((server) => server.id !== id));
    },
    [mcpServers, persistMcp],
  );

  const header = useMemo(() => {
    if (!active) return t("Assistant · Not configured");
    if (!active.configured) return t("Assistant · Not configured");
    return t("Assistant · {model}", { model: active.model || active.label });
  }, [active, t]);

  if (!open) return null;

  return (
    <aside className={`lattice-assistant${variant === "window" ? " is-window" : ""}`} aria-label={t("Assistant")}>
      {/*
        小窗**不画这一行**。它外面已经有一条标题栏（`AssistantWindow` 的
        `.lattice-assistant-bar`：标题 + 底板/锁/模式/关闭四个按钮），这里再画一遍
        就是两行字、两个 ×，隔着 34px 各关一次；上面那行写 "ASSISTANT"，这行写
        "Assistant · 模型"，说的还是同一件事。齿轮挪进会话条（对话态那个 ⚙），
        所以只有设置态才留这一行做"返回"。

        抽屉没有外面那条 bar，这一行是它唯一的标题和关闭，照旧。
      */}
      {(variant === "drawer" || view === "setup") && (
        <header className="lattice-assistant-head">
          <span className="lattice-assistant-title">
            {variant === "window" ? t("Model settings") : header}
          </span>
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
            {/* 小窗的关闭在窗口标题栏上，这一行不再放第二个 */}
            {variant === "drawer" && (
              <button type="button" className="lattice-icon-btn" onClick={onClose} aria-label={t("Close")}>
                ×
              </button>
            )}
          </span>
        </header>
      )}

      {/* 常驻模式条（0009）：模式是存盘的，忘记自己还在「全部」是它唯一的价格。
          所以这条必须一直在看得见的地方 —— 用打断去兜是另一种烦 */}
      <div
        className="lattice-assistant-mode"
        data-on={modeIgnoresSwitches(mode) ? "1" : "0"}
        data-held={modeIgnoresSwitches(mode) && !modeEffective ? "1" : "0"}
        /* 内部模式下那段解释不占地方，改挂在这里：悬停能读到，但不用天天看。
           **这里必须说实话**（0009）：内部模式不是"六只手一只都不给"，
           而是"你拨了哪几组就有哪几组"，问不问另由审批档管 */
        title={
          modeIgnoresSwitches(mode)
            ? undefined
            : t("Manages Lattice, plus whichever hands you switch on. Approvals follow the mode you picked.")
        }
      >
        <span className="lattice-assistant-mode-name">
          {modeIgnoresSwitches(mode) ? t("Everything") : t("Internal")}
        </span>
        {/*
          那段解释**只在「全部」时写**。它是警告，警告要一直在、但不能占着
          三行常驻 —— 内部模式是默认态，模式名本身就说完了，多写一句的代价是
          400 宽的小窗里对话区少两行。0009 记的也是"一行"。
        */}
        {modeIgnoresSwitches(mode) && (
          <span className="lattice-assistant-mode-hint">
            {modeEffective
              ? t("Files, commands, the web, the screen, input and MCP servers. Approvals are not asked.")
              : t("Held back by read-only mode — nothing can be changed.")}
          </span>
        )}
        <button
          type="button"
          className="lattice-btn is-small"
          onClick={() => changeMode(modeIgnoresSwitches(mode) ? "internal" : "everything")}
        >
          {modeIgnoresSwitches(mode) ? t("Switch to internal") : t("Switch to everything")}
        </button>
      </div>

      {/* 存的就是「全部」：启动之后第一次开面板提示一次，之后靠上面那条 */}
      {modeReminder && (
        <div className="lattice-assistant-mode-note">
          <span>{t("This was already on when Lattice started.")}</span>
          <button type="button" className="lattice-btn is-small" onClick={() => setModeReminder(false)}>
            {t("Got it")}
          </button>
        </div>
      )}

      {/* 打开之前那一次确认：把四条硬线印在上面。**只往提权的方向问** */}
      {modeConfirm && (
        <div className="lattice-assistant-mode-confirm" role="alertdialog" aria-label={t("Switch to everything?")}>
          <span className="lattice-assistant-mode-confirm-title">{t("Switch to everything?")}</span>
          <ul>
            <li>{t("It reads and writes files anywhere, runs commands, fetches pages, screenshots, moves the mouse and calls MCP servers — without asking.")}</li>
            <li>{t("It still cannot install, uninstall or grant widgets.")}</li>
            <li>{t("Editing Lattice's own settings always asks.")}</li>
            <li>{t("Widgets cannot borrow it, and agent calls are unaffected.")}</li>
            <li>{t("The budget does not change: 24 steps, 5 minutes, 200k tokens.")}</li>
          </ul>
          <span className="lattice-assistant-mode-confirm-actions">
            <button type="button" className="lattice-btn is-small" onClick={confirmEverything}>
              {t("Switch to everything")}
            </button>
            <button type="button" className="lattice-btn is-small" onClick={() => setModeConfirm(false)}>
              {t("Cancel")}
            </button>
          </span>
        </div>
      )}

      {view === "setup" ? (
        <div className="lattice-assistant-body">
          {/*
            模型档那一整块（清单 + 编辑器）住在这里，和设置 → Models 是**同一个**
            组件：新建 / 测连接 / 存 key / 删档 / 切 active 有三百行状态，抄一份的
            代价不是多写一遍，而是以后每次改都要改两遍，而只有一处会被真的点到。
          */}
          <ModelProfiles variant="panel" onChange={setProfiles} onReady={() => setView("chat")} />

          {/* 手：默认全关。打开一组等于允许它做一类事（0004 §5） */}
          <section className="lattice-hands">
            <header className="lattice-hands-head">
              <span>{t("What it may do")}</span>
              {/* 一颗「给 agent 权力」+ 一颗「全关」。前者只在内部模式出现：
                  全部模式本来就六组全开，按钮在那儿点了也不会改变任何事。
                  **它拨的是开关**，审批档与工作目录一概不动 —— 用户按完还能
                  一组一组拨回去，面板上看得见自己开了什么（0009） */}
              <span className="lattice-assistant-actions">
                {!modeIgnoresSwitches(mode) && HAND_GROUPS.some((group) => !hands[group]) && (
                  <button type="button" className="lattice-btn is-small is-primary" onClick={() => void grantAll()}>
                    {t("Give the agent power")}
                  </button>
                )}
                <button type="button" className="lattice-btn is-small" onClick={() => void turnAllOff()}>
                  {t("Turn all off")}
                </button>
              </span>
            </header>
            {/*
              审批档放在组开关**上面**：它说的是"接上之后要不要点头"，
              先有它再看下面六组，读起来才对。三档不是三个开关 —— 同一时刻只有一档
              （0003 §3）
            */}
            <div className="lattice-approval-modes" role="group" aria-label={t("Approval")}>
              {APPROVAL_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`lattice-btn is-small${
                    normalizeApproval(hands.approvalMode) === mode ? " is-primary" : ""
                  }`}
                  aria-pressed={normalizeApproval(hands.approvalMode) === mode}
                  onClick={() => void setApprovalMode(mode)}
                >
                  {t(APPROVAL_LABELS[mode].label)}
                </button>
              ))}
            </div>
            <p className="lattice-assistant-hint">
              {t(APPROVAL_LABELS[normalizeApproval(hands.approvalMode)].hint)}
            </p>
            <p className="lattice-assistant-hint">
              {t("Nothing is on by default. A group has to be turned on before its tools exist at all.")}
            </p>
            {/* 模式和开关各管一件事（0009）：模式管"要不要问"，开关管"能不能"。
                这句必须写死在这儿 —— 内部模式曾经被描述成"一只都不给"，
                而代码一直是"照开关"，用户于是以为内部不能用工具 */}
            <p className="lattice-assistant-hint">
              {t("Internal mode gives the agent exactly the groups you switch on here. Everything mode switches them all on and stops asking.")}
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
              {t("Relative paths and commands start here. In the Ask mode, writing inside this folder does not ask again — writing outside it still does, and reading was never limited to it (change it and what asks changes).")}
            </p>
          </section>

          {/* 外部服务：服务器是用户自己配的，工具由服务器声明（0004 §6） */}
          <section className="lattice-mcp">
            <header className="lattice-hands-head">
              <span>{t("External services")}</span>
              <button
                type="button"
                className="lattice-btn is-small"
                onClick={() => void refreshMcp(true)}
                disabled={mcpBusy || !hands.mcp}
              >
                {mcpBusy ? t("Asking…") : t("Refresh tools")}
              </button>
            </header>
            <p className="lattice-assistant-hint">
              {t("An MCP server brings its own tools. Every call still asks you first, and a server runs with your own permissions — there is no sandbox.")}
            </p>
            {mcpServers.length > 0 && (
              <ul className="lattice-mcp-list">
                {mcpServers.map((server) => {
                  const found = mcpFound.find((item) => item.id === server.id);
                  return (
                    <li key={server.id} className="lattice-mcp-row">
                      <span className="lattice-mcp-name">
                        {server.label}
                        <span className="lattice-mcp-target">
                          {server.transport === "http"
                            ? server.url
                            : [server.command, ...server.args].join(" ")}
                        </span>
                        {found && (
                          <span className={`lattice-mcp-state${found.ok ? "" : " is-bad"}`}>
                            {found.ok ? t("{count} tools", { count: found.tools.length }) : found.error}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="lattice-btn is-small"
                        onClick={() => removeMcpServer(server.id)}
                        disabled={mcpBusy}
                      >
                        {t("Remove")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <label className="lattice-textfield">
              <span>{t("Name (optional)")}</span>
              <input
                value={mcpDraft.label}
                onChange={(event) =>
                  setMcpDraft((draft) => ({ ...draft, label: event.target.value }))
                }
                placeholder="filesystem"
                spellCheck={false}
              />
            </label>
            <label className="lattice-textfield">
              <span>
                {mcpDraft.transport === "http" ? t("Server URL") : t("Command and arguments")}
              </span>
              <input
                value={mcpDraft.target}
                onChange={(event) =>
                  setMcpDraft((draft) => ({ ...draft, target: event.target.value }))
                }
                placeholder={
                  mcpDraft.transport === "http"
                    ? "https://example.com/mcp"
                    : "npx -y @modelcontextprotocol/server-filesystem D:\\"
                }
                spellCheck={false}
              />
            </label>
            <div className="lattice-mcp-actions">
              <button
                type="button"
                className="lattice-btn is-small"
                onClick={() =>
                  setMcpDraft((draft) => ({
                    ...draft,
                    transport: draft.transport === "http" ? "stdio" : "http",
                  }))
                }
                disabled={mcpBusy}
              >
                {mcpDraft.transport === "http" ? t("Use a command instead") : t("Use a URL instead")}
              </button>
              <button
                type="button"
                className="lattice-btn is-small is-primary"
                onClick={addMcpServer}
                disabled={mcpBusy || !mcpDraft.target.trim()}
              >
                {t("Add server")}
              </button>
            </div>
            {mcpNote && <p className="lattice-assistant-hint">{mcpNote}</p>}
          </section>

          {/* 技能包（0005）：一份"怎么做"的说明书，不是权限。
              导入不等于启用，勾上才是"这一轮照它做" */}
          <section className="lattice-skills">
            <header className="lattice-hands-head">
              <span>{t("Skills")}</span>
              <span className="lattice-skills-count">
                {t("{on} of {max} on", {
                  on: skills.filter((skill) => skill.enabled && !skill.damaged).length,
                  max: SKILL_MAX,
                })}
              </span>
            </header>
            <p className="lattice-assistant-hint">
              {t(
                "A skill is a written procedure: when to use it, then the steps. Turning one on only adds those words to the prompt — it never adds a tool, and every step it asks for still asks you first.",
              )}
            </p>
            {skills.length === 0 && (
              <p className="lattice-assistant-hint">
                {t(
                  "No skills yet. Import one: a folder with a SKILL.md in it, or a single .md file.",
                )}
              </p>
            )}
            {skills.map((skill) => {
              const missing = missingGroups(skill, groupsOn);
              return (
                <div key={skill.id} className={`lattice-skill-row${skill.damaged ? " is-bad" : ""}`}>
                  <label className="lattice-skill-main">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={skillsBusy || skill.damaged}
                      onChange={(event) => void toggleSkill(skill.id, event.target.checked)}
                    />
                    <span className="lattice-hand-copy">
                      <span className="lattice-hand-name">
                        {skill.name}
                        {skill.damaged && (
                          <span className="lattice-hand-soon">{t("Cannot read it")}</span>
                        )}
                      </span>
                      <span className="lattice-hand-hint">
                        {skill.description ||
                          t("Its front matter has no description — write one so this line says what it is for.")}
                      </span>
                      <span className="lattice-skill-meta">
                        {t("{chars} characters", { chars: charCount(skill.body) })}
                        {missing.length > 0 &&
                          ` · ${t("needs {groups}", {
                            groups: missing.map((group) => t(HAND_LABELS[group].label)).join(", "),
                          })}`}
                      </span>
                    </span>
                  </label>
                  {skillRemoving === skill.id ? (
                    <span className="lattice-skill-confirm">
                      <span>{t("Delete its folder?")}</span>
                      <button
                        type="button"
                        className="lattice-btn is-small is-danger"
                        onClick={() => void dropSkill(skill.id)}
                      >
                        {t("Delete")}
                      </button>
                      <button
                        type="button"
                        className="lattice-btn is-small"
                        onClick={() => setSkillRemoving(null)}
                      >
                        {t("Cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="lattice-btn is-small"
                      onClick={() => setSkillRemoving(skill.id)}
                      disabled={skillsBusy}
                    >
                      {t("Remove")}
                    </button>
                  )}
                </div>
              );
            })}
            <label className="lattice-textfield">
              <span>{t("Skill folder or .md file")}</span>
              <input
                value={skillPath}
                onChange={(event) => setSkillPath(event.target.value)}
                placeholder="D:\\写作\\skills\\weekly"
                spellCheck={false}
              />
            </label>
            <div className="lattice-mcp-actions">
              <button
                type="button"
                className="lattice-btn is-small is-primary"
                onClick={() => void addSkill()}
                disabled={skillsBusy || !skillPath.trim()}
              >
                {t("Import")}
              </button>
            </div>
            {skillsNote && <p className="lattice-assistant-hint">{skillsNote}</p>}
            {skillsFolder && <p className="lattice-skills-folder">{skillsFolder}</p>}
          </section>

          {error && <p className="lattice-modal-error">{error}</p>}

          {/* 0003 §5 最后一行：会话明文落盘这件事必须在界面上说出来，不能假装没有 */}
          <p className="lattice-assistant-hint">
            {t(
              "Chats are saved on this machine as plain text — anything you paste in lands on disk. “Delete this chat” removes it.",
            )}
          </p>

        </div>
      ) : (
        <>
          {/*
            会话条：一个下拉 + 新建 + 删除。**没做成一个大列表** —— 面板宽度就
            300 多像素，一列会话会把对话挤到看不见；用户要的是"接着昨天那份聊"，
            不是管理 50 份文件
          */}
          <div className="lattice-assistant-chats">
            <select
              className="lattice-assistant-chat-select"
              aria-label={t("Chats")}
              value={currentId ?? ""}
              onChange={(event) => void openSession(event.target.value)}
              disabled={busy || sessions.length === 0}
            >
              <option value="">{t("New chat")}</option>
              {sessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.damaged ? t("Damaged chat") : item.title || t("New chat")}
                </option>
              ))}
            </select>
            {/* 「新建」用图标：下拉框里那一项已经写着 "New chat"，旁边再放一个同名字的
                按钮等于把同一句话说两遍，还吃掉 70px —— 320 宽的时候下拉框就没字了 */}
            <button
              type="button"
              className="lattice-icon-btn"
              onClick={startNewChat}
              disabled={busy}
              title={t("New chat")}
              aria-label={t("New chat")}
            >
              ＋
            </button>
            {/* 没有会话可删时**不渲染**，不是灰着 —— 灰按钮也在占位 */}
            {currentId && (
              <button
                type="button"
                className="lattice-btn is-small is-danger"
                onClick={() => void removeCurrentSession()}
                disabled={busy}
              >
                {t("Delete this chat")}
              </button>
            )}
            {/* 小窗没有面板头了，齿轮落到这一行 —— 它管的就是"这一份对话用哪个模型" */}
            {variant === "window" && (
              <button
                type="button"
                className="lattice-icon-btn"
                onClick={() => setView("setup")}
                title={t("Model settings")}
                aria-label={t("Assistant settings")}
              >
                ⚙
              </button>
            )}
          </div>
          {sessionNote && (
            <p className="lattice-assistant-hint lattice-assistant-note">{sessionNote}</p>
          )}
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
              {/* 元信息在左、按钮在右：按钮固定在右下角，用户按回车之前手就在那儿 */}
              <span className="lattice-assistant-meta">
                {usage ? `${usage.prompt} → ${usage.completion} tokens` : ""}
                {active?.keySource === "env" ? ` · ${t("key from the environment")}` : ""}
              </span>
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
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
