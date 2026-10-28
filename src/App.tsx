/**
 * 棂 / Lattice —— 平台外壳
 *
 * 布局：顶栏（产品 / 主题 / 网格 / 刷新） + 三栏（组件库 · 画布 · 属性）。
 * 这里只做编排，业务都在 platform/ 与 runtime/ 里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Canvas, type CanvasFocus } from "./platform/Canvas";
import { startAgentBridge, type AgentReply, type AgentRequest } from "./platform/agent";
import { runWidgetTurn } from "./platform/assistant";
import { normalizeAskMessages, parseAskMessages, MAX_PERSONA } from "./runtime/assistant";
import { AssistantPanel } from "./platform/AssistantPanel";
import { DictationButton } from "./platform/DictationButton";
import { DebugPanel } from "./platform/DebugPanel";
import { InspectorPanel } from "./platform/InspectorPanel";
import { LibraryPanel, type InstallNotice } from "./platform/LibraryPanel";
import { OverviewPanel } from "./platform/OverviewPanel";
import { ReportDialog, type ReportTarget } from "./platform/ReportDialog";
import { SearchOverlay } from "./platform/SearchOverlay";
import type { StoreBinding } from "./platform/CatalogueSection";
import {
  backupInfo,
  installCataloguePackage,
  loadCatalogues,
  reportWidget,
  rollbackWidget,
  type BackupInfo,
  type CatalogueSnapshot,
} from "./platform/catalogue";
import {
  addedPermissions,
  isBlockedKey,
  isDemoPublisherKey,
  keyFingerprint,
  sourceLabel,
  type CatalogueEntry,
  type CataloguePackage,
  type MergeConflict,
  type SourceSnapshot,
} from "./runtime/catalogue";
import { buildSpecs, closeDesktop, minimizeMain, syncDesktop } from "./platform/desktop";
import { buildSearchTargets, hopFor, type SearchTarget } from "./runtime/global-search";
import { Glyph, ICON, ThemeGlyph } from "./platform/icons";
import { SettingsMenu, type SettingsSection } from "./platform/SettingsMenu";
import { instanceIdFor, nextFreeSlot, useLattice, type ThemeMode } from "./platform/store";
import { permissionLabel } from "./runtime/manifest";
import { isTauri, loadRegistry, type WidgetLoadError, type WidgetRecord } from "./runtime/registry";
import { DEBUG_EVENT, ingest } from "./runtime/debug";
import { lang, setLanguage, subscribe, t, useT, watchSystemLanguage } from "./runtime/i18n";
import { pickText } from "./runtime/widget-text";
import type { Permission, WidgetLayer } from "./runtime/manifest";

/** 顶栏那颗按钮的循环顺序：浅色 → 深色 → 跟随系统 → 浅色 */
const THEME_CYCLE: ThemeMode[] = ["light", "dark", "system"];
const THEME_LABEL: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

function nextTheme(current: ThemeMode): ThemeMode {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
}

/**
 * 给 IPC 调用加一道超时。
 *
 * 平时用不上，但一旦 invoke 的响应丢了（实测过：主窗口闲置一段时间后
 * 走 IPC 自定义协议的 fetch 会 `Failed to fetch`，退到 postMessage 之后
 * 长命令的响应就再也不回来了），`desktopBusy` 会永远停在 true ——
 * 那颗按钮从此是灰的，用户除了重启没别的办法。
 *
 * 超时只是让界面能恢复，不代表 Rust 那边真的停了：所以超时之后不要
 * 立刻再发一次同步，先让人看见报错。
 *
 * `label` 传进来之前已经是当前语言的译文；整句在这里拼 —— 它要出现在
 * 组件库的"加载失败"列表里，是用户能看到的字。t() 在**调用那一刻**读语言，
 * 所以超时发生时的语言和拼出来的那句是一致的。
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(t("{label} did not answer within {seconds}s", { label, seconds: ms / 1000 }))),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 桌面窗口回传的事件载荷 */
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

/**
 * 组件目录里有文件变了（`watch.rs` 发过来的）。
 *
 * 载荷里带的是相对路径，但主窗口只用它当"有事发生了"的信号 —— 它要重读的
 * 是清单，而清单可能被改的就是任意一个文件。真正按路径过滤的是宿主页那边
 * （只有自己那份文件变了才重载），见 `widgetHost.ts`。
 */
interface WidgetsChangedEvent {
  files: string[];
}

/** 渲染进程整个挂掉（`crash.rs`）。`gaveUp` 为真表示自动重载已经放弃了 */
interface CrashEvent {
  instanceId: string;
  kind: "render" | "gpu" | "browser" | "unresponsive" | "other";
  gaveUp: boolean;
}

export default function App() {
  const t = useT();
  const [widgets, setWidgets] = useState<WidgetRecord[]>([]);
  const [errors, setErrors] = useState<WidgetLoadError[]>([]);
  const [loading, setLoading] = useState(true);

  /*
   * agent 端点（见 platform/agent.ts）。
   *
   * 用 ref 而不是把 widgets 塞进依赖数组：订阅只该建一次。清单每变一次就
   * 重订的话，中间那段空窗里来的请求会全部超时 —— 而"装一个组件"恰好是
   * agent 最常触发的动作之一。
   */
  const widgetsRef = useRef<WidgetRecord[]>([]);
  widgetsRef.current = widgets;

  /*
   * 组件借平台的手（`assistant.ask`，权限 `desktop:control`）。
   *
   * **唯一**接这条请求的地方：画布里的实例和桌面窗口里的实例都转发到主窗口 ——
   * 布局的权威在主窗口的 store 里，`state.json` 只是它的副本（两份真相的坑见
   * `platform/agent.ts` 的模块注释）。工具表裁掉 `placement.remove`
   * （`toolsFor("widget")`），并且同一时刻只接一条：一个组件刷屏不该变成
   * "模型在后台连轴转、账单自己长"。
   */
  const askBusy = useRef(false);
  const askFromWidget = useCallback(
    async (request: AgentRequest, records: WidgetRecord[]): Promise<AgentReply> => {
      const args = (request.args ?? {}) as { messages?: unknown; widgetId?: unknown; persona?: unknown };
      const normalized = normalizeAskMessages(parseAskMessages(args.messages));
      if (!normalized.ok) return { ok: false, code: "bad_args", error: normalized.error };
      if (askBusy.current) return { ok: false, code: "internal", error: "a turn is already running" };

      askBusy.current = true;
      try {
        const widgetId = typeof args.widgetId === "string" ? args.widgetId : "";
        const record = records.find((item) => item.manifest.id === widgetId);
        const name = (record ? pickText(record.manifest.name) : "") || widgetId || "a widget";
        const personaText = (
          typeof args.persona === "string" ? args.persona : (normalized.value.persona?.text ?? "")
        )
          .trim()
          .slice(0, MAX_PERSONA);

        const outcome = await runWidgetTurn({
          messages: normalized.value.messages,
          persona: personaText ? { name, text: personaText } : null,
          records,
        });
        return { ok: true, result: outcome };
      } catch (error) {
        return {
          ok: false,
          code: "internal",
          error: String(error instanceof Error ? error.message : error),
        };
      } finally {
        askBusy.current = false;
      }
    },
    [],
  );

  useEffect(
    () => startAgentBridge(() => widgetsRef.current, { ask: askFromWidget }),
    [askFromWidget],
  );

  const placements = useLattice((state) => state.placements);
  const addPlacement = useLattice((state) => state.addPlacement);
  const installedIds = useLattice((state) => state.installedIds);
  const installWidget = useLattice((state) => state.installWidget);
  const uninstallWidget = useLattice((state) => state.uninstallWidget);
  const theme = useLattice((state) => state.theme);
  const setTheme = useLattice((state) => state.setTheme);
  const language = useLattice((state) => state.language);
  const grants = useLattice((state) => state.grants);
  const desktopMode = useLattice((state) => state.desktopMode);
  const setDesktopMode = useLattice((state) => state.setDesktopMode);
  const desktopRects = useLattice((state) => state.desktopRects);
  const configs = useLattice((state) => state.configs);
  const libraryOpen = useLattice((state) => state.libraryOpen);
  const inspectorOpen = useLattice((state) => state.inspectorOpen);
  const setPanelOpen = useLattice((state) => state.setPanelOpen);
  const setDesktopRect = useLattice((state) => state.setDesktopRect);
  const updatePlacement = useLattice((state) => state.updatePlacement);
  const removePlacement = useLattice((state) => state.removePlacement);
  const lastClosed = useLattice((state) => state.lastClosed);
  const restoreLastClosed = useLattice((state) => state.restoreLastClosed);
  const dismissLastClosed = useLattice((state) => state.dismissLastClosed);
  const trash = useLattice((state) => state.trash);
  const restoreTrashed = useLattice((state) => state.restoreTrashed);
  const deleteTrashed = useLattice((state) => state.deleteTrashed);
  const emptyTrash = useLattice((state) => state.emptyTrash);
  const setPaused = useLattice((state) => state.setPaused);
  const suppressWindow = useLattice((state) => state.suppressWindow);
  const [desktopBusy, setDesktopBusy] = useState(false);
  /** 安装结果提示：成功会自己消失，失败留着让人看清 */
  const [notice, setNotice] = useState<InstallNotice | null>(null);
  /**
   * 崩溃后放弃自动恢复的那个组件。
   *
   * 只有 `gaveUp` 的才记 —— 前三次崩溃由 Rust 静默重载，每次都弹一条提示
   * 等于把"偶发一次 GPU 进程重启"变成骚扰。连着崩三次说明这个组件真的坏了，
   * 那时才值得占用户一行屏幕。
   */
  const [crash, setCrash] = useState<CrashEvent | null>(null);
  /** 调试面板。不落盘：它是"看一眼就走"的工具，下次启动不必自动弹出来 */
  const [debugOpen, setDebugOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);

  /**
   * 开 / 关 assistant。
   *
   * 桌面应用里它是一个**独立窗口**（`assistant_window_toggle`）—— 主窗口收起
   * 之后它还得能用。浏览器里没有窗口可开，退回抽屉：那种情况下 `isTauri()`
   * 是 false，`npm run dev` 里还能看见这块界面长什么样。
   */
  const toggleAssistant = useCallback(() => {
    if (!isTauri()) {
      setAssistantOpen((value) => !value);
      return;
    }
    void invoke<boolean>("assistant_window_toggle")
      .then((open) => setAssistantOpen(open))
      .catch((error) => {
        // 窗口建不出来时别把功能吞掉：落在抽屉里，至少还能聊
        console.error("failed to toggle the assistant window", error);
        setAssistantOpen((value) => !value);
      });
  }, []);

  /**
   * 把设置打开到"Widgets"那一页 —— 首次引导里"加一个源"的那颗按钮。
   *
   * 源列表只有一个家（`SettingsMenu.tsx`），所以这里不复制一份编辑器，只做"送去"。
   * `nonce` 每次自增：点一次、关掉、再点一次，两次都得把面板重新打开。
   */
  const [settingsAt, setSettingsAt] = useState<{ section: SettingsSection; nonce: number } | null>(
    null,
  );
  const openSourceList = useCallback(() => {
    setSettingsAt((prev) => ({ section: "widgets", nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /*
   * 组件目录（商店）。
   *
   * 目录本身**不落盘**：它是一份随时可能变的外部 JSON，缓存一份只会让
   * "为什么这里还是旧版本"变成要查的事。读一次几百毫秒，界面上有刷新按钮。
   * 用户配置（从哪儿读）落在 store 里。
   */
  const sources = useLattice((state) => state.sources);
  /* 首次引导卡上那句 `Got it` 记住了没有（0011）。判据在 `runtime/onboarding.ts` */
  const onboarded = useLattice((state) => state.onboarded);
  const dismissOnboarding = useLattice((state) => state.dismissOnboarding);
  const trustedKeys = useLattice((state) => state.trustedKeys);
  const trustKey = useLattice((state) => state.trustKey);
  const blockedKeys = useLattice((state) => state.blockedKeys);
  const blockKey = useLattice((state) => state.blockKey);
  const unblockKey = useLattice((state) => state.unblockKey);
  const ratings = useLattice((state) => state.ratings);
  const rateWidget = useLattice((state) => state.rateWidget);
  const permissionReviews = useLattice((state) => state.permissionReviews);
  const flagPermissionReview = useLattice((state) => state.flagPermissionReview);
  const resolvePermissionReview = useLattice((state) => state.resolvePermissionReview);
  const grant = useLattice((state) => state.grant);
  const [catalogue, setCatalogue] = useState<CatalogueSnapshot | null>(null);
  /** 每源的读况与"同一个 id 被两个源提供"的冲突，只给商店里的那几行用 */
  const [catalogueSources, setCatalogueSources] = useState<SourceSnapshot[]>([]);
  const [catalogueConflicts, setCatalogueConflicts] = useState<MergeConflict[]>([]);
  const [catalogueBusy, setCatalogueBusy] = useState(false);
  const [catalogueBusyId, setCatalogueBusyId] = useState<string | null>(null);
  /** 每个组件有没有可回滚的上一版。磁盘状态，只在刷新清单时重读 */
  const [backups, setBackups] = useState<Record<string, BackupInfo | null>>({});
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [reportSaving, setReportSaving] = useState(false);
  const [reportResult, setReportResult] = useState<{ path: string } | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  /*
   * 全局搜索（第一层）浮层开着没有。
   *
   * 不落盘：它是"按一下、看一眼、走人"的东西，下次启动不该自动弹出来。
   * 和调试面板、assistant 抽屉同一个判据。
   */
  const [searchOpen, setSearchOpen] = useState(false);
  /**
   * 画布总览（只读）开着没有。
   *
   * 和搜索浮层同一个判据：不落盘、"看一眼就走"的东西，下次启动不该自己弹出来。
   * 两者互斥（下面开一个就关另一个）：同时叠两层浮层，Esc 到底关哪一层没有答案。
   */
  const [overviewOpen, setOverviewOpen] = useState(false);
  /**
   * 从搜索跳过去之后，画布要滚到的那一份；以及组件库要翻到的那一个。
   *
   * 两个都是"送一次"的信号，带 `nonce` 让同一个目标连点两次也能再触发
   * （见 `CanvasFocus` 与 `LibraryPanel` 的 `reveal`）。放在这里而不是各自的
   * 组件里：跳转的**判据**（画布上有就定位、没有就翻库）只该在一处。
   */
  const [canvasFocus, setCanvasFocus] = useState<CanvasFocus | null>(null);
  const [libraryReveal, setLibraryReveal] = useState<{ widgetId: string; nonce: number } | null>(
    null,
  );

  /*
   * 桌面窗口发来的调试记录。
   *
   * 画布上那些实例的记录本来就在本进程里（`WidgetFrame` 直接写总线），这里
   * 收的是**桌面窗口**那一份 —— 两个 webview 各自跑一套桥，只能靠事件汇合。
   *
   * 订阅放在这里而不是面板里：面板关着的时候也得收，不然打开面板只看得到
   * 打开之后发生的事，而"组件刚启动时那几下调用"恰恰是最想看的。
   */
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

  // Ctrl+Shift+D 开关面板。组件窗口里的日志常常是"看一眼就走"，鼠标去顶栏太远
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "d") return;
      event.preventDefault();
      setDebugOpen((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /*
   * Ctrl+K 开关 assistant。
   *
   * 不用 Ctrl+Space（输入法会吃掉）、不用 Ctrl+/（编辑器里太常见）。Ctrl+K 是
   * 聊天框的肌肉记忆，而这台机器上它没有被别的东西占用。
   *
   * 桌面上那个独立小窗优先：它能在主窗口收起来之后继续用（"一边干别的、
   * 一边让它改桌面"才是这东西的用途）。浏览器里没有窗口可开，退回抽屉预览。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      void toggleAssistant();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleAssistant]);

  /*
   * Ctrl+Shift+O 开画布总览。
   *
   * O 是 "overview"，也和 Ctrl+Shift+F / Ctrl+Shift+D 同一个修饰键组合。它和
   * 搜索互斥：打开一个就关掉另一个，免得 Esc 该关哪一层没有答案。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "o") return;
      event.preventDefault();
      setOverviewOpen((value) => !value);
      setSearchOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /*
   * Ctrl+Shift+F 开全局搜索。
   *
   * 用 F 而不是 Ctrl+F：Ctrl+F 在 webview 里是"找这一页里的字"，而这里找的是
   * 组件和商店条目 —— 两件事，抢同一个键会让"我就想找页面上这个词"落空。
   * 也刻意**不带 Shift 的 Ctrl+F 留给浏览器**（预览里还能用原生查找）。
   *
   * 和 Ctrl+Shift+D 同一个修饰键组合，用户不用记两套。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setSearchOpen((value) => !value);
      setOverviewOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (notice?.kind !== "ok") return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 撤销条只活 8 秒。按 `at` 重置计时：连删两个组件时，第二条要重新给满时间
  useEffect(() => {
    if (!lastClosed) return;
    const timer = setTimeout(() => dismissLastClosed(), 8000);
    return () => clearTimeout(timer);
  }, [lastClosed, dismissLastClosed]);

  const records = useMemo(() => new Map(widgets.map((item) => [item.manifest.id, item])), [widgets]);

  /**
   * 崩溃提示里要写的那个名字。
   *
   * 从 instanceId 反查 placement 再查清单 —— 事件里只有 instanceId，而用户
   * 认得的是"便签"这两个字，不是 `lattice.note@a1b2`。
   */
  const crashName = useMemo(() => {
    if (!crash) return "";
    const widgetId = placements.find((item) => item.instanceId === crash.instanceId)?.widgetId;
    return (widgetId ? pickText(records.get(widgetId)?.manifest.name) : "") || widgetId || crash.instanceId;
  }, [crash, placements, records]);

  /**
   * 已启用的组件 id。
   * 用户目录里的包由磁盘状态决定（装上去就是装上了），
   * 随应用分发的包必须经过显式安装 —— 平台开箱是空白的。
   */
  const installedSet = useMemo(() => {
    const set = new Set<string>();
    for (const record of widgets) {
      if (record.source === "user" || installedIds.includes(record.manifest.id)) {
        set.add(record.manifest.id);
      }
    }
    return set;
  }, [widgets, installedIds]);

  /**
   * 给 assistant 的"商店里还能装这个"那一段（0003 §4）。
   *
   * **只给还没装的**：已装的那些在快照里带着说明，再列一遍会让它以为"同一个
   * 组件还能再装一份"。目录没读到就是空数组 —— 宁可这一段不出现，也不要让它
   * 推荐一个已经被撤下的组件（`MAX_CATALOGUE_ITEMS` 与"还有 N 个"由
   * `runtime/assistant.ts` 那一头管，这里不截）。
   */
  const shopHints = useMemo(() => {
    const entries = catalogue?.catalogue?.entries ?? [];
    return entries
      .filter((entry) => !installedSet.has(entry.id))
      .map((entry) => ({ id: entry.id, name: pickText(entry.name) }));
  }, [catalogue, installedSet]);

  /*
   * 全局搜索的那张表：已装的、能装的、商店里的，合成一列。
   *
   * 合成规则（同一个 id 只出一条、已装优先、顺带报商店新版本）在
   * `runtime/global-search.ts` 里，有断言页钉着。这里只负责把三份输入递进去 ——
   * `installedSet` 和组件库用的是同一个判据，否则"搜索说已装、面板说没装"。
   */
  const searchTargets = useMemo(
    () =>
      buildSearchTargets({
        records: widgets,
        installedIds: installedSet,
        placements,
        entries: catalogue?.catalogue?.entries ?? [],
      }),
    [widgets, installedSet, placements, catalogue],
  );

  /**
   * 选中一条搜索结果之后去哪儿。
   *
   * 判据（哪种结果去画布、多份摆放时选哪一份）在 `runtime/global-search.ts::hopFor`
   * 里，断言页钉着 —— 那是搜索语义的一部分，不该埋在这个组件里。这里只负责把
   * 结果翻译成两个"送一次"的信号：
   *
   *   - `canvas`：滚到那张卡（`CanvasFocus`），选中 + 闪一圈。
   *   - `library`：翻组件库，搜索词设成那个 id（`reveal`）。装了的、能装的、
   *     商店里的都走这一条 —— 对用户是同一件事："去那一屏找它"。
   *
   * 两个信号都带 `nonce`：同一个目标连搜两次，`instanceId` / `widgetId` 一模一样，
   * 没有它下游的 effect 不会重跑。
   */
  const pickSearchTarget = useCallback(
    (target: SearchTarget) => {
      setSearchOpen(false);
      const hop = hopFor(target, placements);
      if (hop.kind === "canvas") {
        setCanvasFocus((prev) => ({ instanceId: hop.instanceId, nonce: (prev?.nonce ?? 0) + 1 }));
        return;
      }
      setPanelOpen("library", true);
      setLibraryReveal((prev) => ({ widgetId: hop.widgetId, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [placements, setPanelOpen],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await loadRegistry();
      setWidgets(snapshot.widgets);
      setErrors(snapshot.errors);
    } catch (error) {
      setErrors([{ dir: "(registry)", message: String(error) }]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 崩溃之后手动再试一次。
   *
   * 先把提示条收掉再发命令：这条提示说的是"已经不打算再重载了"，点完
   * 之后它就不再成立 —— 留着它，用户会以为没点着。
   *
   * 注意 Rust 那边的崩溃计数不会因为这一次重置：如果它加载起来立刻又崩，
   * 会直接落到"放弃"那一支，而不是再给三次机会。这是对的 —— 连着崩三次
   * 之后手动重试仍然崩，说明文件本身有问题，多试几次只是多闪几下白屏。
   */
  const retryCrash = useCallback(async () => {
    if (!crash) return;
    const target = crash.instanceId;
    setCrash(null);
    try {
      await invoke("widget_reload", { instanceId: target });
    } catch (error) {
      setNotice({ kind: "error", text: t("Could not reload the widget: {error}", { error: String(error) }) });
    }
  }, [crash, t]);

  /*
   * 暂停状态在 Rust 那边（托盘菜单是主入口），这里补一次初始值。
   *
   * 正常情况下 `lattice:paused` 事件已经把状态送过来了，但主窗口被藏起来
   * 一段时间之后重新打开，事件早就过去了 —— 不补这一句，设置里那个开关
   * 会显示"没暂停"，而桌面上的组件其实全藏着。
   */
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<boolean>("widgets_paused")
      .then(setPaused)
      .catch(() => {});
  }, [setPaused]);

  /**
   * 桌面窗口 → 主窗口的回传通道。
   *
   * 组件窗口是独立 webview，改不了这里的 store。用户在桌面上拖了、缩了、
   * 锁了、换层级了，都由 Rust 转成事件送回来，在这里落到状态里。
   */
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
    /*
     * 组件自己把窗口关了（`lattice.pet` 右键就是这条，见 `runner.rs::widget_close`）。
     *
     * placement 不动 —— 那是用户摆好的布局；只把"这一份已经没有窗口"记下来，
     * 画布拿它决定要不要挂活的那一份（`canvasNeedsLiveFrame`）。少了这一条，
     * 桌面模式下这个组件会变成一张说"它在桌面上跑"的静态卡，而桌面上什么都没有。
     */
    bind<InstanceEvent>("lattice:widget-suppressed", (payload) => {
      suppressWindow(payload.instanceId);
    });
    // 组件目录里有人动了文件（编辑器存盘、手工拷进去、脚本生成）。
    // 重读一遍清单：新增的包要出现在组件库里，删掉的要消失，
    // 改了 manifest 的尺寸/权限要跟着变
    bind<WidgetsChangedEvent>("lattice:widgets-changed", () => {
      void refresh();
    });
    // 托盘菜单也能暂停/恢复，主窗口得跟着变 —— 否则设置里那个开关是死的
    bind<{ paused: boolean }>("lattice:paused", (payload) => {
      setPaused(payload.paused);
    });
    // 崩溃已经自动重载的不打扰用户（只有连着崩才值得说一句）
    bind<CrashEvent>("lattice:widget-crashed", (payload) => {
      if (payload.gaveUp) setCrash(payload);
    });

    return () => {
      disposed = true;
      for (const dispose of disposers) dispose();
    };
  }, [refresh, removePlacement, setDesktopRect, setPaused, suppressWindow, updatePlacement]);

  // 主题落到 <html data-theme>，CSS 变量与组件都从这里取色
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved: "light" | "dark" =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      root.dataset.theme = resolved;
      // 桌面上的组件窗口是独立 webview，得广播过去才会跟着换色
      if (isTauri()) void invoke("widget_set_theme", { theme: resolved }).catch(() => {});
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  /*
   * 语言的唯一开关在这里。
   *
   * 落盘的一直是"偏好"（`system` / `zh` / `en`），生效的那一个是 i18n 模块
   * 算出来的 —— 和主题同一套分工：store 存偏好，模块把它变成结果，界面只
   * 认结果。`watchSystemLanguage` 只在偏好是 `system` 时起作用。
   */
  useEffect(() => {
    setLanguage(language);
  }, [language]);

  useEffect(() => watchSystemLanguage(), []);

  /*
   * 桌面上的组件窗口是独立 webview，不加载 store，读不到这档偏好 —— 所以和
   * 主题一样广播一条。只影响平台自己写的字（窗饰提示、"组件坏了"那张卡片）：
   * 组件自己的文案是作者写的，不跟着翻。
   *
   * 挂在订阅上而不是写进上面那个 effect：偏好是"跟随系统"时，系统语言变了
   * 并不会改 React 状态，`watchSystemLanguage` 改的是 i18n 内部那一档。
   */
  useEffect(
    () =>
      subscribe(() => {
        if (isTauri()) void invoke("widget_set_language", { lang: lang() }).catch(() => {});
      }),
    [],
  );

  /**
   * 启动时把组件放回桌面。
   *
   * 上次退出时是运行态（`desktopMode` 已持久化），而且用户没关掉
   * "Restore widgets on launch"，就在这里把窗口重建一遍。
   *
   * 三个前提缺一不可：
   *   - 状态已水合（否则 placements 还是空的，同步会把窗口全关掉）
   *   - 清单已读到（records 为空时 buildSpecs 会跳过所有实例）
   *   - 画布上真有组件
   *
   * 刻意**不**最小化主窗口：开机就把窗口藏起来，用户会以为应用没打开。
   * 画布和桌面组件同时在场，什么时候收主窗口交给用户。
   */
  useEffect(() => {
    if (!isTauri()) return;
    if (records.size === 0) return;

    const restore = () => {
      const state = useLattice.getState();
      if (!state.desktopMode) return;
      if (!state.restoreOnLaunch || state.placements.length === 0) {
        // 用户关掉了自动恢复：这一轮就当设计态，别让按钮一直写着 "Bring back"
        setDesktopMode(false);
        return;
      }
      void withTimeout(
        syncDesktop(
          buildSpecs(state.placements, records, state.grants, state.desktopRects, state.configs),
        ),
        20000,
        t("Restoring desktop widgets"),
      ).catch((error) => {
        setErrors((prev) => [...prev, { dir: "(restore)", message: String(error) }]);
      });
    };

    if (useLattice.persist.hasHydrated()) {
      restore();
      return;
    }
    return useLattice.persist.onFinishHydration(restore);
  }, [records, setDesktopMode]);

  const addWidget = useCallback(
    (record: WidgetRecord) => {
      if (!installedSet.has(record.manifest.id)) return;
      const { w, h } = record.manifest.size;
      const slot = nextFreeSlot(useLattice.getState().placements, w, h);
      addPlacement({
        instanceId: instanceIdFor(record.manifest.id),
        widgetId: record.manifest.id,
        x: slot.x,
        y: slot.y,
        w,
        h,
        layer: record.manifest.layer,
        clickThrough: false,
        pinned: false,
      });
    },
    [addPlacement, installedSet],
  );

  const install = useCallback(
    (record: WidgetRecord) => {
      installWidget(record.manifest.id);
    },
    [installWidget],
  );

  const installPack = useCallback(
    (records: WidgetRecord[]) => {
      for (const record of records) installWidget(record.manifest.id);
    },
    [installWidget],
  );

  /*
   * 读一次目录。
   *
   * 失败不抛给调用方：目录挂了不该让整个界面报错，那一段自己会画成
   * "读不到 + 重试"，上面两段（已安装 / 可安装）照常工作。
   *
   * 多源（0010）：并发取、逐源兜底，合并成一份给商店，另留一份"每源读况"
   * 给那几行状态 —— 一个源挂了只让它自己那行变红。
   */
  const refreshCatalogue = useCallback(async () => {
    setCatalogueBusy(true);
    try {
      const view = await loadCatalogues(sources);
      setCatalogue(view.snapshot);
      setCatalogueSources(view.sources);
      setCatalogueConflicts(view.conflicts);
    } finally {
      setCatalogueBusy(false);
    }
  }, [sources]);

  useEffect(() => {
    void refreshCatalogue();
  }, [refreshCatalogue]);

  /*
   * 每个组件有没有可回滚的上一版。
   *
   * 这是磁盘状态，只在清单变化时重读 —— 装完 / 回滚完都会走 `refresh()`，
   * 所以这里跟着 `installedSet` 变就够了。
   */
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const ids = [...installedSet];
    void Promise.all(ids.map(async (id) => [id, await backupInfo(id)] as const)).then((pairs) => {
      if (!alive) return;
      setBackups(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [installedSet]);

  /**
   * 从目录装 / 更新。
   *
   * 两道确认都在这里落地，缺一条界面上的警告就只是一行字：
   *
   * - `acceptNewKey` 是"用户已经在卡片上确认过换人了"。没有它的时候，一旦本地
   *   钉住的公钥和目录里的不一样，这里直接拒绝。
   * - 被拉黑的钥匙**没有确认入口**。卡片上不给按钮，这里再挡一次 —— 拉黑是
   *   用户说过"这人的东西我不装"，不该存在一条"绕过它"的路径。
   */
  const installFromCatalogue = useCallback(
    async (entry: CatalogueEntry, pkg: CataloguePackage, acceptNewKey: boolean) => {
      if (!isTauri()) {
        setNotice({ kind: "error", text: t("Installing from the catalogue needs the desktop app.") });
        return;
      }
      const key = entry.publisher?.key;
      if (!key) return;

      if (isBlockedKey(key, blockedKeys)) {
        setNotice({
          kind: "error",
          text: t("{name} is signed with a key you blocked ({key}) — unblock it first.", {
            name: pickText(entry.name),
            key: keyFingerprint(key),
          }),
        });
        return;
      }

      const pinned = trustedKeys[entry.id];
      if (!acceptNewKey && pinned && pinned !== key) {
        setNotice({
          kind: "error",
          text: t("{name} is signed with a different key now — confirm it on the card first.", {
            name: pickText(entry.name),
          }),
        });
        return;
      }

      const before = records.get(entry.id)?.manifest.permissions ?? [];
      setCatalogueBusyId(entry.id);
      try {
        const result = await installCataloguePackage(entry, pkg);
        /*
         * 公开的演示钥匙不钉。内置目录（随应用发的那份）就是用它签的，而远端
         * 目录用发布者自己的钥匙 —— 钉住前者，用户切到远端就会被问一次
         * "换人了没有"，而那两把钥匙都是我们自己发的。详见 `isDemoPublisherKey`。
         */
        if (!isDemoPublisherKey(key)) trustKey(entry.id, key);
        // 内置包也要显式"安装"（不变量 1）；用户目录里的包本来就算已装，
        // 多记一次没有副作用
        installWidget(entry.id);
        const added = addedPermissions(before, pkg.permissions);
        if (added.length > 0) flagPermissionReview(entry.id, result.version, added);
        await refresh();
        setNotice({
          kind: "ok",
          text: result.previousVersion
            ? t("Updated {name} to {version}", { name: pickText(entry.name), version: result.version })
            : t("Installed {name} {version}", { name: pickText(entry.name), version: result.version }),
        });
      } catch (error) {
        setNotice({ kind: "error", text: `${pickText(entry.name)}: ${String(error)}` });
      } finally {
        setCatalogueBusyId(null);
      }
    },
    [
      blockedKeys,
      flagPermissionReview,
      installWidget,
      records,
      refresh,
      t,
      trustKey,
      trustedKeys,
    ],
  );

  const rollback = useCallback(
    async (record: WidgetRecord) => {
      try {
        const result = await rollbackWidget(record.manifest.id);
        await refresh();
        setNotice({
          kind: "ok",
          text: t("Rolled {name} back to {version}", {
            name: pickText(record.manifest.name),
            version: result.version ?? t("the previous version"),
          }),
        });
      } catch (error) {
        setNotice({ kind: "error", text: t("Could not roll back: {error}", { error: String(error) }) });
      }
    },
    [refresh, t],
  );

  const submitReport = useCallback(
    async (input: { reason: string; note: string; stars: number | null }) => {
      if (!reportTarget) return;
      const { record } = reportTarget;
      setReportSaving(true);
      setReportError(null);
      try {
        const path = await reportWidget({
          id: record.manifest.id,
          version: record.manifest.version,
          reason: input.reason,
          note: input.note,
          stars: input.stars,
        });
        // 顺手把评分落到本地：报告里带着它，界面上也该看到
        if (input.stars) rateWidget(record.manifest.id, input.stars, record.manifest.version);
        setReportResult({ path });
      } catch (error) {
        setReportError(String(error));
      } finally {
        setReportSaving(false);
      }
    },
    [rateWidget, reportTarget],
  );

  const closeReport = useCallback(() => {
    setReportTarget(null);
    setReportResult(null);
    setReportError(null);
  }, []);

  const uninstall = useCallback(
    async (record: WidgetRecord) => {
      // 用户目录里的包是真在磁盘上的，要交给 Rust 删；内置包只是取消启用
      if (record.source === "user" && isTauri()) {
        try {
          await invoke("uninstall_widget", { id: record.manifest.id });
        } catch (error) {
          setErrors((prev) => [...prev, { dir: record.dir, message: String(error) }]);
          return;
        }
        await refresh();
      }
      /*
       * 连同画布上的实例一起撤掉。
       * 只删 id 不删 placement 的话，会留下一个指向不存在组件的幽灵：
       * 它还在 placements 里（顶栏计数多一个），但 records 里查不到，
       * 于是既画不出来也点不到 —— 只能清状态文件才能收拾。
       */
      const { placements: current, removePlacement } = useLattice.getState();
      for (const placement of current) {
        if (placement.widgetId === record.manifest.id) removePlacement(placement.instanceId);
      }
      uninstallWidget(record.manifest.id);
    },
    [refresh, uninstallWidget],
  );

  /**
   * 从磁盘装组件。
   *
   * 没有文件选择框：直接把组件文件夹从资源管理器拖进窗口就行。
   * Tauri 的拖放事件给的是真实路径，正好是 `install_widget` 要的入参。
   * 顺手把拖进来的非组件目录（随便一个文件夹、一个文件）挡掉，
   * 只留一句"不是组件目录"，不往错误列表里灌红字。
   */
  const installFromPaths = useCallback(
    async (paths: string[]) => {
      if (!isTauri() || paths.length === 0) return;
      const installed: string[] = [];
      const failed: string[] = [];
      // 官方组件的 id 不能被用户包顶掉：records 是按 id 索引的，
      // 重名会让官方那个悄悄消失，而且没有任何提示
      const officialIds = new Set(
        widgets.filter((item) => item.source === "bundled").map((item) => item.manifest.id),
      );

      for (const path of paths) {
        try {
          const id = await invoke<string>("install_widget", { source: path });
          if (officialIds.has(id)) {
            await invoke("uninstall_widget", { id });
            failed.push(
              t('"{id}" collides with a bundled widget id — rename it and try again', { id }),
            );
            continue;
          }
          installWidget(id);
          installed.push(id);
        } catch (error) {
          const message = String(error);
          // 「不是组件目录」是拖错了，不是出错，不必打扰
          if (message.includes("Not a widget folder")) continue;
          failed.push(message);
        }
      }

      if (installed.length > 0) await refresh();

      if (failed.length > 0) {
        setNotice({ kind: "error", text: failed.join("; ") });
      } else if (installed.length > 0) {
        setNotice({
          kind: "ok",
          text: t("Installed {names} — click a card to place it on the canvas", {
            names: installed.join(", "),
          }),
        });
      }
    },
    [installWidget, refresh, t, widgets],
  );

  // 拖放由 webview 接管（Tauri 默认 dragDropEnabled），这里只关心"放下了"
  useEffect(() => {
    if (!isTauri()) return;
    let dispose: (() => void) | undefined;
    let disposed = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        void installFromPaths(event.payload.paths);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch((error) => setErrors((prev) => [...prev, { dir: "(drop)", message: String(error) }]));

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [installFromPaths]);

  const openWidgetsDir = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const dir = await invoke<string>("widgets_dir");
      await revealItemInDir(dir);
    } catch (error) {
      setNotice({ kind: "error", text: t("Could not open the widgets folder: {error}", { error: String(error) }) });
    }
  }, [t]);

  const toggleDesktop = useCallback(async () => {
    if (!isTauri()) return;
    setDesktopBusy(true);
    try {
      if (desktopMode) {
        await withTimeout(closeDesktop(), 10000, t("Bringing widgets back"));
        setDesktopMode(false);
      } else {
        const state = useLattice.getState();
        await withTimeout(
          syncDesktop(
          buildSpecs(state.placements, records, state.grants, state.desktopRects, state.configs),
        ),
          20000,
          t("Sending widgets to the desktop"),
        );
        setDesktopMode(true);
        // 让位这一步不阻塞按钮：最小化偶尔会慢一拍，不该把 busy 卡在这里
        void minimizeMain().catch(() => {});
      }
    } catch (error) {
      setErrors((prev) => [...prev, { dir: "(desktop)", message: String(error) }]);
    } finally {
      setDesktopBusy(false);
    }
  }, [desktopMode, records, setDesktopMode]);

  // 运行态下改画布要同步到真窗口；拖动是高频的，攒一下再发
  useEffect(() => {
    if (!desktopMode) return;
    const timer = setTimeout(() => {
      void syncDesktop(buildSpecs(placements, records, grants, desktopRects, configs)).catch((error) => {
        setErrors((prev) => [...prev, { dir: "(desktop)", message: String(error) }]);
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [desktopMode, placements, records, grants, desktopRects, configs]);

  const onDropWidget = useCallback(
    (event: React.DragEvent) => {
      const widgetId = event.dataTransfer.getData("application/x-lattice-widget");
      const record = records.get(widgetId);
      if (!record || !installedSet.has(widgetId)) return;
      event.preventDefault();

      const bounds = event.currentTarget.getBoundingClientRect();
      const { w, h } = record.manifest.size;
      const x = Math.max(0, Math.round(event.clientX - bounds.left - w / 2));
      const y = Math.max(0, Math.round(event.clientY - bounds.top - 12));

      addPlacement({
        instanceId: instanceIdFor(record.manifest.id),
        widgetId: record.manifest.id,
        x,
        y,
        w,
        h,
        layer: record.manifest.layer,
        clickThrough: false,
        pinned: false,
      });
    },
    [addPlacement, records, installedSet],
  );

  /**
   * 已安装组件的版本与权限，按 widgetId。
   *
   * 目录那一段要用它算"该装 / 该更新 / 已经最新"，以及"这次更新多要了哪些权限"。
   * 只放已安装的：没装过的组件没有"当前版本"这回事。
   */
  const installedVersions = useMemo(() => {
    const map = new Map<string, string>();
    for (const id of installedSet) {
      const version = records.get(id)?.manifest.version;
      if (version) map.set(id, version);
    }
    return map;
  }, [installedSet, records]);

  const installedPermissions = useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const id of installedSet) {
      map.set(id, records.get(id)?.manifest.permissions ?? []);
    }
    return map;
  }, [installedSet, records]);

  const storeBinding = useMemo<StoreBinding>(
    () => ({
      snapshot: catalogue,
      sources: catalogueSources,
      conflicts: catalogueConflicts,
      // 源 id → 名字：卡片上的来源角标与商店顶上那几行共用同一份
      sourceLabels: Object.fromEntries(
        catalogueSources.map((item) => [item.source.id, sourceLabel(item)]),
      ),
      busy: catalogueBusy,
      busyId: catalogueBusyId,
      installedVersions,
      installedPermissions,
      pinnedKeys: trustedKeys,
      blockedKeys,
      reviews: permissionReviews,
      onRefresh: () => void refreshCatalogue(),
      onInstall: (entry, pkg, acceptNewKey) =>
        void installFromCatalogue(entry, pkg, acceptNewKey),
      onBlockKey: (key) => {
        blockKey(key);
        setNotice({ kind: "ok", text: t("Blocked publisher key {key}", { key: keyFingerprint(key) }) });
      },
      onUnblockKey: (key) => {
        unblockKey(key);
        setNotice({
          kind: "ok",
          text: t("Unblocked publisher key {key}", { key: keyFingerprint(key) }),
        });
      },
    }),
    [
      catalogue,
      catalogueSources,
      catalogueConflicts,
      catalogueBusy,
      catalogueBusyId,
      blockedKeys,
      blockKey,
      installFromCatalogue,
      installedPermissions,
      installedVersions,
      permissionReviews,
      refreshCatalogue,
      t,
      trustedKeys,
      unblockKey,
    ],
  );

  /**
   * 待处理的权限复核。
   *
   * 一次只提示一条：同时弹三条横幅，用户会全部划掉。处理完一条，下一条自己
   * 浮上来 —— `Object.entries` 的顺序就是更新发生的顺序。
   */
  const review = useMemo(() => {
    const next = Object.entries(permissionReviews)[0];
    if (!next) return null;
    const [widgetId, entry] = next;
    return { widgetId, entry, name: pickText(records.get(widgetId)?.manifest.name) || widgetId };
  }, [permissionReviews, records]);

  /*
   * 顶栏只回答一件事：**现在要不要把画布送到桌面去**。
   *
   * 以前这里还挂着"几个在画布 / 几个已安装"的胶囊，加上调试和刷新两颗圆钮，
   * 右侧一共七件东西 —— 而那两颗数字在组件库头部和设置菜单里各有一份，
   * 刷新一次安装只按一次，调试是开发者动作。它们都挪进设置菜单了。
   *
   * 后来加回来的只有全局搜索那一颗：它**不是**数字，也不是"重复某个动作"，
   * 而是"东西一多就找不到"的出口 —— 装到二十个组件之后，翻两栏找一件东西
   * 比按一下贵得多。而且它有第二条入口（`Ctrl+Shift+F`）。
   *
   * 两条别踩回去：
   *   - 数字只在**一个**地方显示。想加"又有多少组件"之前先看 `lattice-panel-count`
   *     和设置菜单里那两行 —— 同一件事说三遍，用户就不信其中任何一遍。
   *   - 挪走的动作必须留第二条入口。调试有 `Ctrl+Shift+D`、搜索有 `Ctrl+Shift+F`，
   *     刷新只剩设置菜单里那一行，所以那一行不许再被折叠起来。
   */
  return (
    <div className="lattice-shell">
      <header className="lattice-topbar">
        <div className="lattice-brand">
          {/*
            左上那颗三线：开合组件库那一栏，和 Claude / VS Code 那颗同一个意思
            —— 它管的是**侧栏**，不是一个什么都装的抽屉菜单。

            三条规矩：
              · **放在最左、品牌标记之前**。它是"窗口的开关区"，先定位再读名字；
                窗饰那排按钮在右上角（`padding-right: 108px`），左边全空着。
              · **它是左栏唯一的命名入口**。左栏标题行那颗"收起"已经删掉 ——
                同一个开关同时出现在两头，等于告诉用户这里有两个东西。
              · **收起之后那条 40px 竖条整条都能点**（见 `.lattice-panel.is-collapsed`），
                所以从窄条回来不用先跑回顶栏；那颗三线的 `aria-expanded` 跟着状态走。
          */}
          <button
            type="button"
            className="lattice-icon-btn is-large"
            onClick={() => setPanelOpen("library", !libraryOpen)}
            aria-expanded={libraryOpen}
            title={t("Toggle the widget library")}
            aria-label={t("Toggle the widget library")}
          >
            <Glyph d={ICON.menu} />
          </button>
          <span className="lattice-brand-mark" aria-hidden />
          <span className="lattice-brand-name">Lattice</span>
        </div>

        <div className="lattice-topbar-actions">
          <button
            type="button"
            className={`lattice-btn${desktopMode ? " is-active" : " is-primary"}`}
            onClick={() => void toggleDesktop()}
            disabled={!isTauri() || desktopBusy}
            title={
              isTauri()
                ? t("Turn canvas widgets into real desktop windows; the main window will step aside")
                : t("Not available in browser preview — run npm run tauri:dev")
            }
          >
            {desktopMode ? t("Bring back") : t("Send to desktop")}
          </button>

          {/*
            一条竖线：左边是"把画布送到桌面"（这个窗口唯一的正经事），右边是
            三颗工具按钮（助手 / 主题 / 设置）。它们不是一类东西 —— 挤成一排
            时用户得逐个读过去才知道哪个会改变桌面。
          */}
          <span className="lattice-topbar-split" aria-hidden />

          {/*
            全局搜索（第一层）。放在这条竖线右边，因为它是"看"而不是
            "把画布送出去"—— 和助手 / 主题 / 设置同一类。

            它搜的是**清单里的元数据**（名字、id、说明、作者、权限），
            不搜用户数据；范围那句话直接复用库里那一句，两处共用一份。
          */}
          <button
            type="button"
            className={`lattice-icon-btn is-large${searchOpen ? " is-active" : ""}`}
            onClick={() => setSearchOpen((value) => !value)}
            aria-expanded={searchOpen}
            title={t("Search widgets and the catalogue (Ctrl+Shift+F)")}
            aria-label={t("Search widgets and the catalogue")}
          >
            <Glyph d={ICON.search} />
          </button>

          {/*
            画布总览（只读）。放在搜索旁边：两件事是同一个需求的两半 ——
            "东西太多找不着"（搜）和"东西太多看不清"（退后一步看全）。
          */}
          <button
            type="button"
            className={`lattice-icon-btn is-large${overviewOpen ? " is-active" : ""}`}
            onClick={() => {
              setOverviewOpen((value) => !value);
              setSearchOpen(false);
            }}
            aria-expanded={overviewOpen}
            title={t("Show the whole canvas at once (Ctrl+Shift+O)")}
            aria-label={t("Overview")}
          >
            <Glyph d={ICON.grid} />
          </button>

          <button
            type="button"
            className={`lattice-icon-btn is-large${assistantOpen ? " is-active" : ""}`}
            onClick={toggleAssistant}
            title={t("Assistant — tell it what to change on your desktop (Ctrl+K, separate window)")}
            aria-label={t("Toggle assistant")}
          >
            <Glyph d={ICON.agent} />
          </button>

          {/*
            听写的顶栏入口（0027 §4）：光标在这个窗口的某个输入框里时，按它
            说完就把字落进那个框。它和浮钮、热键、面板里那颗是同一个引擎 ——
            只是"人在哪"不同。组件够不到麦克风，所以它只能活在平台这一层。
          */}
          <DictationButton />

          <button
            type="button"
            className="lattice-icon-btn is-large"
            onClick={() => setTheme(nextTheme(theme))}
            title={t("Theme: {current} — click for {next}", {
              current: t(THEME_LABEL[theme]),
              next: t(THEME_LABEL[nextTheme(theme)]),
            })}
            aria-label={t("Theme: {current}", { current: t(THEME_LABEL[theme]) })}
          >
            <ThemeGlyph mode={theme} />
          </button>

          <SettingsMenu
            installedCount={installedSet.size}
            placementCount={placements.length}
            debugOpen={debugOpen}
            onToggleDebug={() => setDebugOpen((value) => !value)}
            refreshing={loading}
            onRefresh={() => void refresh()}
            onQuit={() => {
              if (isTauri()) void invoke("quit_app");
            }}
            onOpenAssistant={toggleAssistant}
            openAt={settingsAt}
          />
        </div>
      </header>

      <main
        className={[
          "lattice-main",
          libraryOpen ? "" : "is-left-collapsed",
          inspectorOpen ? "" : "is-right-collapsed",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <LibraryPanel
          widgets={widgets}
          installedIds={installedSet}
          errors={errors}
          loading={loading}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          onOpenWidgetsDir={() => void openWidgetsDir()}
          onAdd={addWidget}
          onInstall={install}
          onInstallPack={installPack}
          onUninstall={(record) => void uninstall(record)}
          store={storeBinding}
          backups={backups}
          ratings={ratings}
          onRollback={(record) => void rollback(record)}
          onRate={(record, stars) => rateWidget(record.manifest.id, stars, record.manifest.version)}
          onReport={(record) =>
            setReportTarget({ record, stars: ratings[record.manifest.id]?.stars ?? 0 })
          }
          onAddSource={openSourceList}
          onboarded={onboarded}
          onDismissOnboarding={dismissOnboarding}
          trash={trash}
          onRestoreTrash={restoreTrashed}
          onDeleteTrash={deleteTrashed}
          onEmptyTrash={emptyTrash}
          open={libraryOpen}
          onToggle={() => setPanelOpen("library", !libraryOpen)}
          reveal={libraryReveal}
        />
        <Canvas
          records={records}
          installedIds={installedSet}
          onDropWidget={onDropWidget}
          focus={canvasFocus}
        />
        <InspectorPanel
          records={records}
          open={inspectorOpen}
          onToggle={() => setPanelOpen("inspector", !inspectorOpen)}
        />
      </main>

      {/*
        调试面板浮在画布下沿，不占三栏的位置。开关它不会改变画布尺寸，
        也就不会触发桌面窗口那套"尺寸变了重铺壁纸"的连锁反应。
      */}
      <DebugPanel open={debugOpen} onClose={() => setDebugOpen(false)} />

      {/*
        全局搜索浮层。自己 portal 到 body（和右键菜单同一个办法），所以放在
        树里哪个位置都一样；挂在这里只是"和别的浮层挨着"。
      */}
      {searchOpen && (
        <SearchOverlay
          targets={searchTargets}
          onPick={pickSearchTarget}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/*
        画布总览。点一张卡 = 选中它 + 回画布上那张卡（和搜索选中同一条路：
        `canvasFocus` 滚过去 + 闪一圈）。总览自己**不写 store** —— 见那个文件的
        头注释。
      */}
      {overviewOpen && (
        <OverviewPanel
          records={records}
          installedIds={installedSet}
          onPick={(instanceId) => {
            setOverviewOpen(false);
            setCanvasFocus((prev) => ({ instanceId, nonce: (prev?.nonce ?? 0) + 1 }));
          }}
          onClose={() => setOverviewOpen(false)}
        />
      )}

      {/*
        抽屉只在**浏览器预览**里出现：桌面应用里 assistant 住在一个独立小窗
        （`assistant_window_toggle`），主窗口这颗按钮和 Ctrl+K 只是开关它。
        两边共用同一个 `AssistantPanel`，区别只在 surface —— 见 platform/assistant.ts。
      */}
      {!isTauri() && (
        <AssistantPanel
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          records={records}
          catalogue={shopHints}
        />
      )}

      {/*
        删除是可以反悔的。
        两颗 ✕ 都是不可逆删除，而它们只有 22×22、还挂在会淡入的窗饰上 ——
        手滑一次用户的布局就少一块。删的时候 store 留了快照，这里弹 8 秒。

        两条提示都塞进同一个底部容器：它们可能同时在场（删了一个、另一个正好崩了），
        各自 fixed 会叠在一起。
      */}
      <div className={`lattice-toasts${debugOpen ? " is-raised" : ""}`}>
        {/*
          连着崩了三次、Rust 那边已经不再自动重载的组件。
          这不是"提醒一下"：它的窗口现在是一块白板，不告诉用户就只能干看着。
          也不给"删掉"这种选项 —— 大部分情况下改完文件点一下重试就好了，
          真要删，画布上那颗 ✕ 一直都在。
        */}
        {/*
          新版本多要了权限。
          这一条**不会自己消失**：它不是提醒，是"有一件事等你决定"。新权限本来
          就没被授予（桥会拒），所以组件仍然按旧的授权在跑 —— 界面必须说清
          这一点，否则用户会以为组件已经拿到它了。
        */}
        {review ? (
          <div className="lattice-review" role="alert">
            <span className="lattice-review-text">
              <b>{review.name}</b>{" "}
              {t("{version} asks for {permissions}. It stays denied until you allow it.", {
                version: review.entry.version,
                permissions: review.entry.added.map((item) => permissionLabel(item)).join(", "),
              })}
            </span>
            <button
              type="button"
              className="lattice-review-action"
              onClick={() => {
                for (const permission of review.entry.added) grant(review.widgetId, permission);
                resolvePermissionReview(review.widgetId);
              }}
            >
              {t("Allow")}
            </button>
            <button
              type="button"
              className="lattice-undo-dismiss"
              onClick={() => resolvePermissionReview(review.widgetId)}
              title={t("Keep it denied")}
              aria-label={t("Keep it denied")}
            >
              ×
            </button>
          </div>
        ) : null}

        {crash ? (
          <div className="lattice-crash" role="alert">
            <span className="lattice-crash-text">
              <b>{crashName}</b>{" "}
              {t("keeps crashing — its window stopped reloading.")}
            </span>
            <button type="button" className="lattice-crash-action" onClick={() => void retryCrash()}>
              {t("Try again")}
            </button>
            <button
              type="button"
              className="lattice-undo-dismiss"
              onClick={() => setCrash(null)}
              title={t("Dismiss")}
              aria-label={t("Dismiss")}
            >
              ×
            </button>
          </div>
        ) : null}

        {lastClosed ? (
          <div className="lattice-undo" role="status">
            <span className="lattice-undo-text">
              {t("Removed")}{" "}
              <b>{pickText(records.get(lastClosed.placement.widgetId)?.manifest.name) || lastClosed.placement.widgetId}</b>
            </span>
            <button type="button" className="lattice-undo-action" onClick={restoreLastClosed}>
              {t("Undo")}
            </button>
            <button
              type="button"
              className="lattice-undo-dismiss"
              onClick={dismissLastClosed}
              title={t("Dismiss")}
              aria-label={t("Dismiss")}
            >
              ×
            </button>
          </div>
        ) : null}
      </div>

      <ReportDialog
        target={reportTarget}
        saving={reportSaving}
        result={reportResult}
        error={reportError}
        onClose={closeReport}
        onSubmit={(input) => void submitReport(input)}
      />
    </div>
  );
}
