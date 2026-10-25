/**
 * 设置面板（原来是一张 300px 的浮层）。
 *
 * 为什么升成面板：设置已经长到十几行，而档案页要放一张 53 周的热力图 ——
 * 浮层里放不下，只能砍成 12 周或者横向滚动。面板用左导航分区，每一区
 * 只回答一类问题：
 *
 *   Account      这台电脑上的我（资料 + 使用记录）
 *   Appearance   明暗
 *   Language     界面语言
 *   Desktop      画布与桌面行为（吸附、恢复、自启、暂停）
 *   Widgets      目录来源、重新扫描、调试面板
 *   Assistant    模型与 key（住在 assistant 自己的面板里，这里只是入口）
 *   About        版本、更新、退出
 *
 * 三条别踩回去：
 *   1. **不是账号系统**。没有服务端，名字/邮箱只写 `state.json`；每处
 *      "登录"的措辞都要能看见"只保存在这台电脑"。
 *   2. **危险动作沉底**：Sign out 和"清除使用记录"只在档案页底部，Quit
 *      只在 About 底部。它们都不许回到标题行。
 *   3. **每个旧入口都得有家**：刷新只在 Widgets 里那一行，不许再折叠；
 *      调试有 Ctrl+Shift+D，但这一行是它的可见入口。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { readAgentStatus, setAgentEnabled, type AgentStatus } from "./agent";
import { isStaleTarget, readAutostart, writeAutostart, type AutostartState } from "./autostart";
import { Glyph, ICON, ThemeGlyph } from "./icons";
import { keyFingerprint } from "../runtime/catalogue";
import {
  useLattice,
  isOfficialCatalogue,
  OFFICIAL_CATALOGUE_SOURCE,
  OFFICIAL_CATALOGUE_URL,
  type ThemeMode,
} from "./store";
import { isTauri } from "../runtime/registry";
import { parseUsage, type UsageData } from "../runtime/usage";
import { appVersion, checkForUpdate, installUpdate, type UpdateState } from "./updater";
import { useT, type LangPref } from "../runtime/i18n";
import { Avatar } from "./Avatar";
import { openConfigFile } from "./assistant";
import { ModelProfiles } from "./ModelProfiles";
import { ProfilePanel } from "./ProfilePanel";
import { openRepo, REPO, REPO_URL } from "./repo";

type Section = "account" | "models" | "appearance" | "language" | "desktop" | "widgets" | "assistant" | "about";

const SECTIONS: Array<{ id: Section; label: string; icon: string }> = [
  { id: "account", label: "Account", icon: ICON.user },
  { id: "models", label: "Models", icon: ICON.chip },
  { id: "appearance", label: "Appearance", icon: ICON.appearance },
  { id: "language", label: "Language", icon: ICON.language },
  { id: "desktop", label: "Desktop", icon: ICON.monitor },
  { id: "widgets", label: "Widgets", icon: ICON.store },
  { id: "assistant", label: "Assistant", icon: ICON.agent },
  { id: "about", label: "About", icon: ICON.info },
];

/**
 * 目录来源的三档。和 `CatalogueSource` 不是一回事：那边只有"内置 / 地址"，
 * 官方目录本身也是一个地址，但界面上该显示"官方"而不是一长串 URL。
 */
type CatalogueDraftKind = "official" | "url" | "bundled";

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
];

/**
 * 语言三档。两个语言名**永远是自己的语言**，只有第三档跟着界面翻 ——
 * 看不懂当前语言的人要能认出回自己那一档。
 */
const LANGUAGE_OPTIONS: Array<{ value: LangPref; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "system", label: "System" },
];

const EMPTY_USAGE: UsageData = { days: {}, totalMinutes: 0, since: null };

interface SettingsMenuProps {
  installedCount: number;
  placementCount: number;
  /** 调试面板开着没有。开关要显示真实状态，否则用户不知道再点一次是开还是关 */
  debugOpen: boolean;
  onToggleDebug: () => void;
  /** 正在重新扫描组件目录 —— 转一圈，让"点了"和"正在扫"区分得开 */
  refreshing: boolean;
  onRefresh: () => void;
  /** 真的退出应用。关主窗口只是收起来（桌面上还有组件时），退出走这里 */
  onQuit: () => void;
  /** 打开 assistant 抽屉（设置里那一条） */
  onOpenAssistant: () => void;
}

export function SettingsMenu({
  installedCount,
  placementCount,
  debugOpen,
  onToggleDebug,
  refreshing,
  onRefresh,
  onQuit,
  onOpenAssistant,
}: SettingsMenuProps) {
  const profile = useLattice((state) => state.profile);
  const signIn = useLattice((state) => state.signIn);
  const signOut = useLattice((state) => state.signOut);
  const theme = useLattice((state) => state.theme);
  const setTheme = useLattice((state) => state.setTheme);
  const language = useLattice((state) => state.language);
  const setLanguage = useLattice((state) => state.setLanguage);
  const snapToGrid = useLattice((state) => state.snapToGrid);
  const toggleSnap = useLattice((state) => state.toggleSnap);
  const restoreOnLaunch = useLattice((state) => state.restoreOnLaunch);
  const toggleRestoreOnLaunch = useLattice((state) => state.toggleRestoreOnLaunch);
  const paused = useLattice((state) => state.paused);
  const setPaused = useLattice((state) => state.setPaused);
  const catalogueSource = useLattice((state) => state.catalogueSource);
  const setCatalogueSource = useLattice((state) => state.setCatalogueSource);
  const blockedKeys = useLattice((state) => state.blockedKeys);
  const unblockKey = useLattice((state) => state.unblockKey);
  const t = useT();

  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>("account");
  /** Widgets 区里"目录来源"是一个子表单，不是第七个导航项 */
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [draftKind, setDraftKind] = useState<CatalogueDraftKind>("official");
  const [draftUrl, setDraftUrl] = useState("");
  /** 「打开配置文件」失败时的原话。成功不说话 —— 编辑器自己会跳出来 */
  const [configNote, setConfigNote] = useState<string | null>(null);

  /** 使用记录只在打开面板时读一次；清空后原地更新，不重新请求 */
  const [usage, setUsage] = useState<UsageData>(EMPTY_USAGE);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * 开机自启的真实状态在注册表里；`null` = 还不知道（浏览器预览 / 读取失败）。
   * 这时整行禁用，而不是先画"关闭"再跳成"开启" —— 开关自己抖一下，用户
   * 会以为点错了。
   */
  const [autostart, setAutostart] = useState<AutostartState | null>(null);
  const [autostartKnown, setAutostartKnown] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);

  /** Agent 端点。`null` = 还不知道。界面不显示令牌，只说它在哪个文件里 */
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  /** 平台更新状态：一次性的，不进 store */
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const [version, setVersion] = useState("");

  const close = useCallback(() => {
    setOpen(false);
    setCatalogueOpen(false);
  }, []);

  const openPanel = useCallback(() => {
    setSection("account");
    setCatalogueOpen(false);
    setOpen(true);
  }, []);

  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  // Ctrl+, 开关设置（和大多数桌面应用一致），Esc 关闭
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        if (open) close();
        else openPanel();
        return;
      }
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open, openPanel]);

  /*
   * 焦点陷阱：面板是 modal，Tab 不许跑到画布上的组件 iframe 里。
   * 打开时把焦点交给第一个导航项，关闭时还给齿轮 —— 不还的话，用户下次
   * 按 Tab 会从文档开头重新走一遍。
   */
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>(".lattice-settings-nav-item");
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((node) => node.offsetParent !== null);
      if (nodes.length === 0) return;
      const head = nodes[0];
      const tail = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // 收到齿轮上，不是"上一个有焦点的元素"：面板里可能有个 autoFocus 的
      // 输入框，它在 effect 之前就抢到了焦点；关面板时那个元素已经被卸载，
      // 焦点会掉到 body，下次 Tab 从头开始。
      triggerRef.current?.focus();
    };
  }, [open]);

  // 开机自启的状态只有注册表知道，面板一打开就问一次
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void readAutostart().then((state) => {
      if (!alive) return;
      setAutostart(state);
      setAutostartKnown(true);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  // Agent 端点状态在 Rust 那边（端口是它绑的），同样现问
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void readAgentStatus()
      .then((status) => {
        if (alive) setAgent(status);
      })
      .catch(() => {
        if (alive) setAgent(null);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 使用记录：打开档案页时读一次。浏览器预览里没有这个命令，保持空图
  useEffect(() => {
    if (!open || !isTauri()) return;
    let alive = true;
    void invoke<unknown>("usage_read")
      .then((raw) => {
        if (alive) setUsage(parseUsage(raw));
      })
      .catch(() => {
        if (alive) setUsage(EMPTY_USAGE);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const clearUsage = useCallback(async () => {
    if (isTauri()) {
      try {
        await invoke("usage_clear");
      } catch (error) {
        console.error("failed to clear usage history", error);
      }
    }
    setUsage(EMPTY_USAGE);
  }, []);

  const toggleAgent = useCallback(async () => {
    if (!agent || agentBusy) return;
    setAgentBusy(true);
    setAgentError(null);
    try {
      // 按返回值落状态，不自己取反：Rust 那边绑端口可能失败
      setAgent(await setAgentEnabled(!agent.enabled));
    } catch (error) {
      setAgentError(String(error));
    } finally {
      setAgentBusy(false);
    }
  }, [agent, agentBusy]);

  const toggleAutostart = useCallback(async () => {
    if (!autostart || autostartBusy) return;
    setAutostartBusy(true);
    setAutostartError(null);
    try {
      const next = await writeAutostart(!autostart.enabled);
      if (next) setAutostart(next);
    } catch (error) {
      setAutostartError(String(error));
    } finally {
      setAutostartBusy(false);
    }
  }, [autostart, autostartBusy]);

  const togglePaused = useCallback(async () => {
    try {
      setPaused(await invoke<boolean>("set_widgets_paused", { paused: !paused }));
    } catch (error) {
      console.error("Failed to pause or resume the desktop widgets", error);
    }
  }, [paused, setPaused]);

  const runUpdate = useCallback(async () => {
    if (update.status === "available") {
      const target = update.version;
      setUpdate({ status: "downloading", version: target, percent: 0 });
      try {
        await installUpdate(target, (percent) =>
          setUpdate({ status: "downloading", version: target, percent }),
        );
      } catch (error) {
        setUpdate({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (update.status === "checking" || update.status === "downloading") return;
    setUpdate({ status: "checking" });
    setUpdate(await checkForUpdate());
  }, [update]);

  const updateNote =
    update.status === "checking"
      ? t("Checking…")
      : update.status === "current"
        ? t("Up to date")
        : update.status === "available"
          ? t("Install v{version}", { version: update.version })
          : update.status === "downloading"
            ? `${update.percent}%`
            : update.status === "error"
              ? t("Failed")
              // 空闲时右边**什么都不写**：按钮上已经写着「检查」，
              // 再在它左边放一个「检查」就是同一句话说两遍
              : "";

  const updateHint =
    update.status === "error"
      ? update.message
      : update.status === "available"
        ? t("Update to v{version}, then Lattice restarts", { version: update.version })
        : t("Ask the release page whether a newer version exists");

  const startCatalogue = useCallback(() => {
    setDraftKind(isOfficialCatalogue(catalogueSource.url) ? "official" : catalogueSource.kind);
    setDraftUrl(catalogueSource.url);
    setCatalogueOpen(true);
  }, [catalogueSource]);

  const saveCatalogue = useCallback(() => {
    setCatalogueSource(
      draftKind === "bundled"
        ? { kind: "bundled", url: "" }
        : draftKind === "official"
          ? { ...OFFICIAL_CATALOGUE_SOURCE }
          : { kind: "url", url: draftUrl },
    );
    setCatalogueOpen(false);
  }, [draftKind, draftUrl, setCatalogueSource]);

  const staleAutostart = isStaleTarget(autostart);
  const autostartHint = autostartError
    ? autostartError
    : staleAutostart
      ? t("Registered for a different build — flip this off and on to point it at this one.")
      : null;

  const sectionLabel = SECTIONS.find((item) => item.id === section)?.label ?? "Account";

  /**
   * 「打开配置文件」：交给系统默认程序打开 `assistant.json`。
   *
   * 它**不是导入**：导入要先定义合并语义（同 id 覆盖还是新增？key 怎么算？
   * 导一半失败怎么办？），那是一个功能。这里只让人打开真正的那个文件去改，
   * 改完在 Models 页里点「重新读取」—— 后端每次都是现读磁盘，没有缓存。
   */
  const openConfig = useCallback(async () => {
    setConfigNote(null);
    try {
      await openConfigFile();
    } catch (problem) {
      setConfigNote(String(problem instanceof Error ? problem.message : problem));
    }
  }, []);

  return (
    <div className="lattice-settings">
      <button
        ref={triggerRef}
        type="button"
        className={`lattice-settings-trigger${open ? " is-open" : ""}`}
        onClick={() => {
          if (open) close();
          else openPanel();
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("Settings (Ctrl+,)")}
      >
        <Avatar name={profile?.name} size={24} />
      </button>

      {open &&
        createPortal(
          <div
            className="lattice-settings-backdrop"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              className="lattice-settings-panel"
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label={t("Settings")}
            >
              <aside className="lattice-settings-nav">
                <button
                  type="button"
                  className="lattice-settings-identity"
                  onClick={() => setSection("account")}
                >
                  <Avatar name={profile?.name} size={30} />
                  <span className="lattice-settings-identity-text">
                    <b>{profile?.name ?? t("Not signed in")}</b>
                    <small>{profile ? t("Local profile") : t("Sign in to keep your preferences")}</small>
                  </span>
                </button>

                <nav className="lattice-settings-nav-list" aria-label={t("Settings sections")}>
                  {SECTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`lattice-settings-nav-item${section === item.id ? " is-active" : ""}`}
                      onClick={() => {
                        setSection(item.id);
                        setCatalogueOpen(false);
                      }}
                      aria-current={section === item.id ? "page" : undefined}
                    >
                      <Glyph d={item.icon} />
                      <span>{t(item.label)}</span>
                    </button>
                  ))}
                </nav>
              </aside>

              <section className="lattice-settings-body">
                <header className="lattice-settings-head">
                  <h2>{t(sectionLabel)}</h2>
                  <div className="lattice-settings-head-actions">
                    {/* 只在 Models 页出现：这个按钮打开的就是这一页管的那份文件。
                        浏览器预览里没有磁盘文件这回事，藏掉比显示一个假路径诚实 */}
                    {section === "models" && isTauri() && (
                      <button type="button" className="lattice-btn is-small" onClick={() => void openConfig()}>
                        {t("Open configuration file")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="lattice-icon-btn"
                      onClick={close}
                      title={t("Close settings")}
                      aria-label={t("Close settings")}
                    >
                      <Glyph d={ICON.close} />
                    </button>
                  </div>
                </header>

                <div className="lattice-settings-content">
                  {section === "models" && (
                    <>
                      {configNote && <p className="lattice-modal-error">{configNote}</p>}
                      <ModelProfiles variant="settings" />
                    </>
                  )}

                  {section === "account" && (
                    <ProfilePanel
                      profile={profile}
                      installedCount={installedCount}
                      placementCount={placementCount}
                      usage={usage}
                      onSave={(name, email) => signIn(name, email)}
                      onSignOut={() => {
                        signOut();
                        close();
                      }}
                      onClearUsage={() => void clearUsage()}
                    />
                  )}

                  {section === "appearance" && (
                    <div className="lattice-settings-form">
                      <div className="lattice-settings-row">
                        <span className="lattice-settings-label">{t("Theme")}</span>
                        <div className="lattice-segmented is-compact is-icons">
                          {THEME_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={`lattice-segment${theme === option.value ? " is-active" : ""}`}
                              onClick={() => setTheme(option.value)}
                              aria-pressed={theme === option.value}
                              title={t(option.label)}
                              aria-label={t(option.label)}
                            >
                              <ThemeGlyph mode={option.value} />
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="lattice-settings-hint">
                        {t("Applies to this window and every widget on your desktop.")}
                      </p>
                    </div>
                  )}

                  {section === "language" && (
                    <div className="lattice-settings-form">
                      <div className="lattice-settings-row">
                        <span className="lattice-settings-label">{t("Language")}</span>
                        <div className="lattice-segmented is-compact">
                          {LANGUAGE_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={`lattice-segment${language === option.value ? " is-active" : ""}`}
                              onClick={() => setLanguage(option.value)}
                              aria-pressed={language === option.value}
                              title={option.value === "system" ? t("Follow Windows") : option.label}
                            >
                              {option.value === "system" ? t("System") : option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="lattice-settings-hint">
                        {t("The whole platform switches immediately. Widgets pick it up on their next frame.")}
                      </p>
                    </div>
                  )}

                  {section === "desktop" && (
                    <div className="lattice-settings-list">
                      <div className="lattice-menu-row is-static">
                        <Glyph d={ICON.grid} />
                        <span className="lattice-menu-label">{t("Snap to grid")}</span>
                        <label className="lattice-switch" title={t("Align to an 8px grid while dragging")}>
                          <input
                            type="checkbox"
                            checked={snapToGrid}
                            onChange={toggleSnap}
                            aria-label={t("Snap to grid")}
                          />
                        </label>
                      </div>

                      <div className="lattice-menu-row is-static">
                        <Glyph d={ICON.monitor} />
                        <span className="lattice-menu-label">{t("Restore on launch")}</span>
                        <label
                          className="lattice-switch"
                          title={t("Put your desktop widgets back when Lattice starts")}
                        >
                          <input
                            type="checkbox"
                            checked={restoreOnLaunch}
                            onChange={toggleRestoreOnLaunch}
                            aria-label={t("Restore widgets on launch")}
                          />
                        </label>
                      </div>

                      <div className="lattice-menu-row is-static">
                        <Glyph d={ICON.startup} />
                        <span className="lattice-menu-label">{t("Start with Windows")}</span>
                        <label
                          className="lattice-switch"
                          title={t("Launch Lattice when you sign in, so your widgets are already there")}
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(autostart?.enabled)}
                            disabled={!autostartKnown || autostartBusy}
                            onChange={() => void toggleAutostart()}
                            aria-label={t("Start Lattice with Windows")}
                          />
                        </label>
                      </div>

                      {autostartHint ? (
                        <p className={`lattice-menu-hint${autostartError ? " is-error" : ""}`}>{autostartHint}</p>
                      ) : null}

                      {placementCount > 0 ? (
                        <div className="lattice-menu-row is-static">
                          <Glyph d={ICON.pause} />
                          <span className="lattice-menu-label">{t("Pause widgets")}</span>
                          <label
                            className="lattice-switch"
                            title={t("Hide the widgets on your desktop and stop their timers, without closing Lattice")}
                          >
                            <input
                              type="checkbox"
                              checked={paused}
                              onChange={() => void togglePaused()}
                              aria-label={t("Pause desktop widgets")}
                            />
                          </label>
                        </div>
                      ) : null}
                    </div>
                  )}

                  {section === "widgets" && !catalogueOpen && (
                    <div className="lattice-settings-list">
                      <button type="button" className="lattice-menu-row" onClick={startCatalogue}>
                        <Glyph d={ICON.store} />
                        <span className="lattice-menu-label">{t("Widget catalogue")}</span>
                        <span className="lattice-menu-note">
                          {isOfficialCatalogue(catalogueSource.url)
                            ? t("Official")
                            : catalogueSource.kind === "bundled"
                              ? t("Bundled")
                              : t("Custom URL")}
                        </span>
                        <Glyph d={ICON.chevron} size={13} />
                      </button>

                      <button
                        type="button"
                        className={`lattice-menu-row${refreshing ? " is-spinning" : ""}`}
                        onClick={onRefresh}
                        disabled={refreshing}
                        title={t("Rescan the widgets folder")}
                      >
                        <Glyph d={ICON.refresh} />
                        <span className="lattice-menu-label">{t("Rescan widgets")}</span>
                      </button>

                      <div className="lattice-menu-row is-static">
                        <Glyph d={ICON.terminal} />
                        <span className="lattice-menu-label">{t("Debug panel")}</span>
                        <label
                          className="lattice-switch"
                          title={t("Bridge calls and widget console, live (Ctrl+Shift+D)")}
                        >
                          <input
                            type="checkbox"
                            checked={debugOpen}
                            onChange={onToggleDebug}
                            aria-label={t("Toggle debug panel")}
                          />
                        </label>
                      </div>

                      <p className="lattice-settings-hint">
                        {t("Widgets install from the library; this only decides where packages come from.")}
                      </p>
                    </div>
                  )}

                  {section === "widgets" && catalogueOpen && (
                    <div className="lattice-settings-form">
                      <div className="lattice-settings-form-head">
                        <button type="button" className="lattice-icon-btn" onClick={() => setCatalogueOpen(false)}>
                          <Glyph d={ICON.back} />
                          <span className="lattice-sr-only">{t("Back")}</span>
                        </button>
                        <span>{t("Widget catalogue")}</span>
                      </div>

                      <div className="lattice-segmented is-full">
                        <button
                          type="button"
                          className={`lattice-segment${draftKind === "official" ? " is-active" : ""}`}
                          onClick={() => setDraftKind("official")}
                        >
                          {t("Official")}
                        </button>
                        <button
                          type="button"
                          className={`lattice-segment${draftKind === "url" ? " is-active" : ""}`}
                          onClick={() => setDraftKind("url")}
                        >
                          {t("Custom URL")}
                        </button>
                        <button
                          type="button"
                          className={`lattice-segment${draftKind === "bundled" ? " is-active" : ""}`}
                          onClick={() => setDraftKind("bundled")}
                        >
                          {t("Bundled")}
                        </button>
                      </div>

                      <label className="lattice-textfield">
                        <span>{t("Catalogue address")}</span>
                        <input
                          value={draftKind === "official" ? OFFICIAL_CATALOGUE_URL : draftUrl}
                          onChange={(event) => setDraftUrl(event.target.value)}
                          placeholder="https://example.com/lattice/registry.json"
                          disabled={draftKind !== "url"}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </label>

                      <p className="lattice-account-hint">
                        {draftKind === "bundled"
                          ? t(
                              "The catalogue that ships with the app — a demo for when the network is down. Its packages are signed with a public key, so switching back to a real catalogue later will ask you to confirm a different publisher.",
                            )
                          : t(
                              "A plain JSON file — any static host works, no server needed. Packages are verified against the publisher key in that file before they are installed.",
                            )}
                      </p>

                      <div className="lattice-blocked">
                        <div className="lattice-blocked-head">
                          <span>{t("Blocked publishers")}</span>
                          <span className="lattice-blocked-count">{blockedKeys.length}</span>
                        </div>
                        {blockedKeys.length === 0 ? (
                          <p className="lattice-account-hint">
                            {t(
                              "Nothing blocked. Blocking a publisher key means nothing signed with it will be installed — pinned keys do not help if the key itself leaks.",
                            )}
                          </p>
                        ) : (
                          <ul className="lattice-blocked-list">
                            {blockedKeys.map((key) => (
                              <li key={key}>
                                <code title={key}>{keyFingerprint(key)}</code>
                                <button type="button" className="lattice-btn is-small" onClick={() => unblockKey(key)}>
                                  {t("Unblock")}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="lattice-settings-form-actions">
                        <button type="button" className="lattice-btn is-small" onClick={() => setCatalogueOpen(false)}>
                          {t("Cancel")}
                        </button>
                        <button
                          type="button"
                          className="lattice-btn is-small is-primary"
                          onClick={saveCatalogue}
                          disabled={draftKind === "url" && !draftUrl.trim()}
                        >
                          {t("Save")}
                        </button>
                      </div>
                    </div>
                  )}

                  {section === "assistant" && (
                    <div className="lattice-settings-list">
                      <div className="lattice-menu-row is-static">
                        <Glyph d={ICON.agent} />
                        <span className="lattice-menu-label">{t("Agent access")}</span>
                        <span className="lattice-menu-note">
                          {agentError
                            ? agentError
                            : agent?.enabled
                              ? `127.0.0.1:${agent.port ?? "…"}`
                              : ""}
                        </span>
                        <label
                          className="lattice-switch"
                          title={t("Let a local agent read and arrange the desktop over 127.0.0.1")}
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(agent?.enabled)}
                            disabled={!agent || agentBusy}
                            onChange={() => void toggleAgent()}
                            aria-label={t("Allow agent access")}
                          />
                        </label>
                      </div>

                      <button
                        type="button"
                        className="lattice-menu-row"
                        onClick={() => {
                          close();
                          onOpenAssistant();
                        }}
                        title={t("Talk to your own model with your own API key, and it arranges the desktop for you (Ctrl+K)")}
                      >
                        <Glyph d={ICON.agent} />
                        <span className="lattice-menu-label">{t("AI assistant")}</span>
                        <span className="lattice-menu-note">{t("Model · key · Ctrl+K")}</span>
                        <Glyph d={ICON.chevron} size={13} />
                      </button>

                      <p className="lattice-settings-hint">
                        {t("The built-in assistant uses your own OpenAI-compatible endpoint. Its key never reaches a widget.")}
                      </p>
                    </div>
                  )}

                  {/*
                    About 用的是"标签在左、值和动作在右"的竖排（`.lattice-settings-row`
                    和外观 / 语言那两页同一套），不是菜单行。这一页要回答的是
                    "这是哪个版本、跟谁要新的、源码在哪" —— 全是**读一眼**的
                    东西，没有一个是"进入下一层"，所以不该长得像可以点进去。
                  */}
                  {section === "about" && (
                    <div className="lattice-settings-form">
                      <div className="lattice-settings-row">
                        <span className="lattice-settings-label">{t("Version")}</span>
                        {/* 不补 `v` 前缀：`getVersion()` 回的就是 "0.1.1"，
                            预览里回 "dev" —— 补上去会变成 "vdev" */}
                        <span className="lattice-about-value">{version || "…"}</span>
                      </div>

                      <div>
                        <div className="lattice-settings-row">
                          <span className="lattice-settings-label">{t("Update Channel")}</span>
                          <span className="lattice-about-value">{t("Stable")}</span>
                        </div>
                        {/*
                          不画成一个只有一项的下拉框：能选的东西只有一样时，
                          那个箭头就是在骗人。真要有 beta 通道，先得有一条
                          能发预发布版的流水线，再说这个控件。
                        */}
                        <p className="lattice-settings-hint">
                          {t("Only one channel today — the update feed skips pre-releases, so a beta never arrives on its own.")}
                        </p>
                      </div>

                      <div>
                        <div className="lattice-settings-row">
                          <span className="lattice-settings-label">{t("Check for updates")}</span>
                          <span className="lattice-about-actions">
                            <span className="lattice-about-value">{updateNote}</span>
                            <button
                              type="button"
                              className="lattice-btn is-small"
                              onClick={() => void runUpdate()}
                              disabled={update.status === "checking" || update.status === "downloading"}
                              title={updateHint}
                            >
                              {update.status === "available" ? t("Install") : t("Check")}
                            </button>
                          </span>
                        </div>
                        {update.status === "error" && (
                          <p className="lattice-settings-hint">{update.message}</p>
                        )}
                      </div>

                      <div>
                        <div className="lattice-settings-row">
                          <span className="lattice-settings-label">{t("Open source")}</span>
                          <span className="lattice-about-actions">
                            <span className="lattice-about-value is-mono">{`github.com/${REPO}`}</span>
                            <button
                              type="button"
                              className="lattice-btn is-small"
                              onClick={() => void openRepo()}
                              title={REPO_URL}
                            >
                              {t("Star on GitHub")}
                            </button>
                          </span>
                        </div>
                        <p className="lattice-settings-hint">
                          {t("Open source and local-first: no account, no server of ours.")}
                        </p>
                      </div>

                      <div className="lattice-settings-danger">
                        <button
                          type="button"
                          className="lattice-menu-row is-danger"
                          onClick={() => {
                            close();
                            onQuit();
                          }}
                        >
                          <Glyph d={ICON.power} />
                          <span className="lattice-menu-label">{t("Quit Lattice")}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
