/**
 * 设置菜单
 *
 * 顶栏右上角那颗头像/齿轮按钮点开的就是它。菜单里放三类东西：
 *   1. 账号 —— 登录、个人信息、退出
 *   2. 外观 —— 明暗主题（浅色 / 跟随系统 / 深色）
 *   3. 画布行为 —— 网格吸附，和顶栏那个按钮绑同一份状态
 *
 * 关于"账号"的定位：棂是纯本地应用，没有服务端。这里的登录只是给这台
 * 机器起一个名字，写进 `lattice.platform.v1`，不上传、不联网。文案上
 * 明确写"只保存在这台电脑"，免得让人以为注册了云端账号。
 * 真要做多设备同步时，把 store 里的 signIn/signOut 换成网络实现即可，
 * 这个组件不用动。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readAgentStatus, setAgentEnabled, type AgentStatus } from "./agent";
import { isStaleTarget, readAutostart, writeAutostart, type AutostartState } from "./autostart";
import { Glyph, ICON, ThemeGlyph } from "./icons";
import { keyFingerprint } from "../runtime/catalogue";
import { useLattice, isOfficialCatalogue, OFFICIAL_CATALOGUE_SOURCE, OFFICIAL_CATALOGUE_URL, type ThemeMode } from "./store";
import { appVersion, checkForUpdate, installUpdate, type UpdateState } from "./updater";

type View = "menu" | "signin" | "profile" | "catalogue";

/**
 * 设置里"目录从哪儿来"的三档。
 *
 * 和 `CatalogueSource` 不是一回事：那边只有"内置 / 一个地址"。官方目录本身
 * 也是 `{ kind: "url" }`，但用户看到的应该是"官方"，而不是一长串 URL。
 * 两边在保存时换算，界面上永远只出现这三档。
 */
type CatalogueDraftKind = "official" | "url" | "bundled";

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
];

function Avatar({ name, size }: { name?: string; size: number }) {
  const initial = name?.trim().slice(0, 1).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (!initial) {
    return (
      <span className="lattice-avatar is-empty" style={style} aria-hidden="true">
        <Glyph d={ICON.user} size={Math.round(size * 0.5)} />
      </span>
    );
  }
  return (
    <span className="lattice-avatar" style={style} aria-hidden="true">
      {initial}
    </span>
  );
}

interface SettingsMenuProps {
  installedCount: number;
  placementCount: number;
  /** 真的退出应用。关主窗口只是收起来（桌面上还有组件时），退出走这里 */
  onQuit: () => void;
  /** 打开 assistant 抽屉（设置菜单里那一条） */
  onOpenAssistant: () => void;
}

export function SettingsMenu({ installedCount, placementCount, onQuit, onOpenAssistant }: SettingsMenuProps) {
  const profile = useLattice((state) => state.profile);
  const signIn = useLattice((state) => state.signIn);
  const signOut = useLattice((state) => state.signOut);
  const theme = useLattice((state) => state.theme);
  const setTheme = useLattice((state) => state.setTheme);
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

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [draftName, setDraftName] = useState("");
  const [draftEmail, setDraftEmail] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * 开机自启的真实状态。
   *
   * `null` = 还不知道（浏览器预览 / 读取失败）。这时整行画成禁用，
   * 而不是先画成"关闭"再跳成"开启"—— 开关自己抖一下，用户会以为点错了。
   */
  const [autostart, setAutostart] = useState<AutostartState | null>(null);
  const [autostartKnown, setAutostartKnown] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  /**
   * Agent 端点。`null` = 还不知道（浏览器预览 / 读取失败），整行画成禁用。
   *
   * 开关只管"听不听"，令牌和端口从 Rust 那边读回来 —— 界面**不显示令牌**，
   * 只说它在哪个文件里。理由：令牌是给 agent 用的，不是给人抄的；而把它摊在
   * 设置面板里，截图发出去就泄露了。
   */
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  /** 目录来源的草稿。保存之前不动真状态 —— 边打字边生效会一直发请求 */
  const [draftKind, setDraftKind] = useState<CatalogueDraftKind>("official");
  const [draftUrl, setDraftUrl] = useState("");
  /**
   * 平台自身的更新状态。**不进 store**：它是一次性的、跟这台机器这一次
   * 会话有关，重启之后"上次检查过"没有任何意义 —— 存下来只会让菜单里
   * 一直挂着一条过期的 "Up to date"。
   */
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const [version, setVersion] = useState("");

  const close = useCallback(() => {
    setOpen(false);
    setView("menu");
  }, []);

  const startSignIn = useCallback(() => {
    setDraftName(profile?.name ?? "");
    setDraftEmail(profile?.email ?? "");
    setView("signin");
  }, [profile]);

  const startProfile = useCallback(() => {
    setDraftName(profile?.name ?? "");
    setDraftEmail(profile?.email ?? "");
    setView("profile");
  }, [profile]);

  const startCatalogue = useCallback(() => {
    // 官方目录在 store 里也是 url，但这一页要显示成"官方"那一档
    setDraftKind(isOfficialCatalogue(catalogueSource.url) ? "official" : catalogueSource.kind);
    setDraftUrl(catalogueSource.url);
    setView("catalogue");
  }, [catalogueSource]);

  const saveCatalogue = useCallback(() => {
    setCatalogueSource(
      draftKind === "bundled"
        ? { kind: "bundled", url: "" }
        : draftKind === "official"
          ? { ...OFFICIAL_CATALOGUE_SOURCE }
          : { kind: "url", url: draftUrl },
    );
    setView("menu");
  }, [draftKind, draftUrl, setCatalogueSource]);

  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  /**
   * 一颗按钮两种含义：没查过就查，查到了就装。
   *
   * 没做成"查到之后长出一颗 Install 按钮"，是因为菜单高度会跟着跳 ——
   * 用户点完"检查"之后，鼠标底下的东西换了位置，很容易点错。
   */
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
      ? "Checking…"
      : update.status === "current"
        ? "Up to date"
        : update.status === "available"
          ? `Install v${update.version}`
          : update.status === "downloading"
            ? `${update.percent}%`
            : update.status === "error"
              ? "Failed"
              : "Check";

  const updateHint =
    update.status === "error"
      ? update.message
      : update.status === "available"
        ? `Update to v${update.version}, then Lattice restarts`
        : "Ask the release page whether a newer version exists";

  // Ctrl+, 打开设置（和大多数桌面应用的约定一致），Esc 关闭
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // 点到菜单外面就收起来。用 pointerdown 而不是 click：
  // 前者在鼠标按下时就触发，不会出现"点画布先选中组件、菜单还浮在上面"的错位
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const name = draftName.trim();
      if (!name) return;
      signIn(name, draftEmail);
      setView("menu");
    },
    [draftEmail, draftName, signIn],
  );

  const signedIn = Boolean(profile);

  /*
   * 开机自启的状态只有注册表知道，所以菜单一打开就去问一次。
   * 不在挂载时问：用户可能刚在任务管理器的"启动"页里把它关掉过，
   * 缓存一份只会显示错的。
   */
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

  /*
   * Agent 端点的状态在 Rust 那边（端口是它绑的），菜单一打开就问一次。
   * 关掉之后端口就没了，缓存一份会让界面显示一个已经不存在的地址。
   */
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

  const toggleAgent = useCallback(async () => {
    if (!agent || agentBusy) return;
    setAgentBusy(true);
    setAgentError(null);
    try {
      // 按返回值落状态，不自己取反：Rust 那边绑端口可能失败，
      // 自取反就会出现"界面开着、实际没听"
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
      // 拿到的永远是"写完之后"的真实状态：写失败时 Rust 抛错，
      // 不会出现开关显示已开、注册表里却没有的情况
      if (next) setAutostart(next);
    } catch (error) {
      setAutostartError(String(error));
    } finally {
      setAutostartBusy(false);
    }
  }, [autostart, autostartBusy]);

  const togglePaused = useCallback(async () => {
    try {
      // 真相在 Rust 那边（托盘菜单也会改它），所以按返回值落状态，不自己取反
      setPaused(await invoke<boolean>("set_widgets_paused", { paused: !paused }));
    } catch (error) {
      console.error("Failed to pause or resume the desktop widgets", error);
    }
  }, [paused, setPaused]);

  const staleAutostart = isStaleTarget(autostart);
  const autostartHint = autostartError
    ? autostartError
    : staleAutostart
      ? "Registered for a different build — flip this off and on to point it at this one."
      : null;

  return (
    <div className="lattice-settings" ref={rootRef}>
      <button
        type="button"
        className={`lattice-settings-trigger${open ? " is-open" : ""}`}
        onClick={() => {
          if (open) close();
          else {
            setView("menu");
            setOpen(true);
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Settings (Ctrl+,)"
      >
        <Avatar name={profile?.name} size={24} />
      </button>

      {open && (
        <div className="lattice-menu" role="dialog" aria-label="Settings">
          {view === "menu" && (
            <>
              <header className="lattice-account">
                <Avatar name={profile?.name} size={38} />
                <div className="lattice-account-text">
                  <div className="lattice-account-name">{profile?.name ?? "Not signed in"}</div>
                  <div className="lattice-account-sub">
                    {profile ? profile.email || "Local profile" : "Sign in to keep your preferences"}
                  </div>
                </div>
              </header>

              <div className="lattice-account-card">
                <div className="lattice-account-stats">
                  <div>
                    <span>Installed</span>
                    <b>{installedCount}</b>
                  </div>
                  <div>
                    <span>On canvas</span>
                    <b>{placementCount}</b>
                  </div>
                </div>
                <button
                  type="button"
                  className={`lattice-btn is-small${profile ? "" : " is-primary"}`}
                  onClick={profile ? startProfile : startSignIn}
                >
                  {profile ? "Edit profile" : "Sign in"}
                </button>
              </div>

              <div className="lattice-menu-list">
                <div className="lattice-menu-row is-static">
                  <Glyph d={ICON.appearance} />
                  <span className="lattice-menu-label">Appearance</span>
                  <div className="lattice-segmented is-compact is-icons">
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`lattice-segment${theme === option.value ? " is-active" : ""}`}
                        onClick={() => setTheme(option.value)}
                        aria-pressed={theme === option.value}
                        title={option.label}
                        aria-label={option.label}
                      >
                        <ThemeGlyph mode={option.value} />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="lattice-menu-row is-static">
                  <Glyph d={ICON.grid} />
                  <span className="lattice-menu-label">Snap to grid</span>
                  <label className="lattice-switch" title="Align to an 8px grid while dragging">
                    <input
                      type="checkbox"
                      checked={snapToGrid}
                      onChange={toggleSnap}
                      aria-label="Snap to grid"
                    />
                  </label>
                </div>

                <div className="lattice-menu-row is-static">
                  <Glyph d={ICON.monitor} />
                  <span className="lattice-menu-label">Restore on launch</span>
                  <label
                    className="lattice-switch"
                    title="Put your desktop widgets back when Lattice starts"
                  >
                    <input
                      type="checkbox"
                      checked={restoreOnLaunch}
                      onChange={toggleRestoreOnLaunch}
                      aria-label="Restore widgets on launch"
                    />
                  </label>
                </div>

                {/*
                  开机自启。真正的状态在注册表里，这里只是它的镜像 ——
                  所以开关要等读到了才可点，读到之前是禁用的灰。
                */}
                <div className="lattice-menu-row is-static">
                  <Glyph d={ICON.startup} />
                  <span className="lattice-menu-label">Start with Windows</span>
                  <label
                    className="lattice-switch"
                    title="Launch Lattice when you sign in, so your widgets are already there"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(autostart?.enabled)}
                      disabled={!autostartKnown || autostartBusy}
                      onChange={() => void toggleAutostart()}
                      aria-label="Start Lattice with Windows"
                    />
                  </label>
                </div>

                {/*
                  Agent 接入。**默认关**，而且关着的时候 Rust 那边根本不 bind ——
                  不是"绑上但拒绝"（见 agent.rs）。

                  这里不显示令牌：它是给 agent 用的，不是给人抄的，摊在面板上
                  截个图就泄露了。只显示端口，令牌位置写在 title 里。
                */}
                <div
                  className="lattice-menu-row is-static"
                  title="Token lives in %APPDATA%\com.iron-tom.lattice\agent\endpoint.json"
                >
                  <Glyph d={ICON.agent} />
                  <span className="lattice-menu-label">Agent access</span>
                  <span className="lattice-menu-note">
                    {agentError
                      ? agentError
                      : agent?.enabled
                        ? `127.0.0.1:${agent.port ?? "…"}`
                        : ""}
                  </span>
                  <label
                    className="lattice-switch"
                    title="Let a local agent read and arrange the desktop over 127.0.0.1"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(agent?.enabled)}
                      disabled={!agent || agentBusy}
                      onChange={() => void toggleAgent()}
                      aria-label="Allow agent access"
                    />
                  </label>
                </div>

                {/*
                  Assistant：平台**自己**带的那只。和上面那条不是一件事 ——
                  Agent access 是"让外部程序从 127.0.0.1 伸进来"，这条是
                  "在这里跟模型说话、它替你改桌面"。两扇门分开写，权限也分开。
                */}
                <button
                  type="button"
                  className="lattice-menu-row"
                  onClick={() => {
                    close();
                    onOpenAssistant();
                  }}
                  title="用你自己的模型和 API key 说话，它替你把桌面摆好（Ctrl+K）"
                >
                  <Glyph d={ICON.agent} />
                  <span className="lattice-menu-label">AI assistant</span>
                  <span className="lattice-menu-note">模型 · key · Ctrl+K</span>
                </button>

                {autostartHint ? (
                  <p className={`lattice-menu-hint${autostartError ? " is-error" : ""}`}>{autostartHint}</p>
                ) : null}

                {/*
                  暂停：把桌面上的组件窗口藏起来（不是只停动画）。藏起来之后
                  `document.visibilityState` 会变成 hidden，调度器整条停摆 ——
                  是真的不占 CPU。和托盘菜单那一项是同一个状态。
                */}
                {placementCount > 0 ? (
                  <div className="lattice-menu-row is-static">
                    <Glyph d={ICON.pause} />
                    <span className="lattice-menu-label">Pause widgets</span>
                    <label
                      className="lattice-switch"
                      title="Hide the widgets on your desktop and stop their timers, without closing Lattice"
                    >
                      <input
                        type="checkbox"
                        checked={paused}
                        onChange={() => void togglePaused()}
                        aria-label="Pause desktop widgets"
                      />
                    </label>
                  </div>
                ) : null}

                <button type="button" className="lattice-menu-row" onClick={startCatalogue}>
                  <Glyph d={ICON.store} />
                  <span className="lattice-menu-label">Widget catalogue</span>
                  <span className="lattice-menu-note">
                    {isOfficialCatalogue(catalogueSource.url)
                      ? "Official"
                      : catalogueSource.kind === "bundled"
                        ? "Bundled"
                        : "Custom URL"}
                  </span>
                  <Glyph d={ICON.chevron} size={13} />
                </button>

                <button
                  type="button"
                  className="lattice-menu-row"
                  onClick={profile ? startProfile : startSignIn}
                >
                  <Glyph d={ICON.user} />
                  <span className="lattice-menu-label">Profile</span>
                  <Glyph d={ICON.chevron} size={13} />
                </button>

                <div className="lattice-menu-row is-static">
                  <Glyph d={ICON.info} />
                  <span className="lattice-menu-label">About Lattice</span>
                  <span className="lattice-menu-note">
                    {version ? `v${version}` : "…"} · local-first
                  </span>
                </div>

                <button
                  type="button"
                  className="lattice-menu-row"
                  onClick={() => void runUpdate()}
                  disabled={update.status === "checking" || update.status === "downloading"}
                  title={updateHint}
                >
                  <Glyph d={ICON.refresh} />
                  <span className="lattice-menu-label">Check for updates</span>
                  <span className="lattice-menu-note">{updateNote}</span>
                </button>
              </div>

              {signedIn && (
                <>
                  <div className="lattice-menu-divider" />
                  <button
                    type="button"
                    className="lattice-menu-row is-danger"
                    onClick={() => {
                      signOut();
                      close();
                    }}
                  >
                    <Glyph d={ICON.logout} />
                    <span className="lattice-menu-label">Sign out</span>
                  </button>
                </>
              )}

              {/*
                退出只能从这里走：桌面上还有组件时，关主窗口只是把它收起来
                （组件得留着，否则"贴桌面"这件事就不成立了）。
              */}
              <div className="lattice-menu-divider" />
              <button
                type="button"
                className="lattice-menu-row is-danger"
                onClick={() => {
                  close();
                  onQuit();
                }}
              >
                <Glyph d={ICON.power} />
                <span className="lattice-menu-label">Quit Lattice</span>
              </button>
            </>
          )}

          {(view === "signin" || view === "profile") && (
            <form className="lattice-account-form" onSubmit={submit}>
              <header className="lattice-account-form-head">
                <button type="button" className="lattice-icon-btn" onClick={() => setView("menu")}>
                  <Glyph d={ICON.back} />
                  <span className="lattice-sr-only">Back</span>
                </button>
                <span>{view === "profile" ? "Profile" : "Sign in"}</span>
              </header>

              <div className="lattice-account-form-body">
                <div className="lattice-account-preview">
                  <Avatar name={draftName || profile?.name} size={46} />
                  <div>
                    <div className="lattice-account-name">{draftName.trim() || "Your name"}</div>
                    <div className="lattice-account-sub">{draftEmail.trim() || "No email yet"}</div>
                  </div>
                </div>

                <label className="lattice-textfield">
                  <span>Display name</span>
                  <input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder="What should we call you?"
                    maxLength={24}
                    autoFocus
                  />
                </label>

                <label className="lattice-textfield">
                  <span>Email (optional)</span>
                  <input
                    value={draftEmail}
                    onChange={(event) => setDraftEmail(event.target.value)}
                    placeholder="you@example.com"
                    inputMode="email"
                    maxLength={64}
                  />
                </label>

                <p className="lattice-account-hint">
                  Stored on this computer only. Nothing is uploaded, no password needed, and it is removed with the rest of the platform data.
                </p>
              </div>

              <footer className="lattice-account-form-foot">
                <button type="button" className="lattice-btn is-small" onClick={() => setView("menu")}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="lattice-btn is-small is-primary"
                  disabled={!draftName.trim()}
                >
                  {view === "profile" ? "Save" : "Sign in"}
                </button>
              </footer>
            </form>
          )}

          {view === "catalogue" && (
            <form
              className="lattice-account-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveCatalogue();
              }}
            >
              <header className="lattice-account-form-head">
                <button type="button" className="lattice-icon-btn" onClick={() => setView("menu")}>
                  <Glyph d={ICON.back} />
                  <span className="lattice-sr-only">Back</span>
                </button>
                <span>Widget catalogue</span>
              </header>

              <div className="lattice-account-form-body">
                <div className="lattice-segmented is-full">
                  <button
                    type="button"
                    className={`lattice-segment${draftKind === "official" ? " is-active" : ""}`}
                    onClick={() => setDraftKind("official")}
                  >
                    Official
                  </button>
                  <button
                    type="button"
                    className={`lattice-segment${draftKind === "url" ? " is-active" : ""}`}
                    onClick={() => setDraftKind("url")}
                  >
                    Custom URL
                  </button>
                  <button
                    type="button"
                    className={`lattice-segment${draftKind === "bundled" ? " is-active" : ""}`}
                    onClick={() => setDraftKind("bundled")}
                  >
                    Bundled
                  </button>
                </div>

                <label className="lattice-textfield">
                  <span>Catalogue address</span>
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
                    ? "The catalogue that ships with the app — a demo for when the network is down. Its packages are signed with a public key, so switching back to a real catalogue later will ask you to confirm a different publisher."
                    : "A plain JSON file — any static host works, no server needed. Packages are verified against the publisher key in that file before they are installed."}
                </p>

                {/*
                  拉黑名单放在这一页，因为它是"信任"的另一半：上面那格决定
                  **从哪儿取包**，这里决定**谁的包不装**。
                  卡片上也能拉黑（换钥匙时那句"旧的那把可能泄露了"），但只在
                  目录里还有那个条目时才有入口 —— 条目下架之后，这里是唯一的出口。
                */}
                <div className="lattice-blocked">
                  <div className="lattice-blocked-head">
                    <span>Blocked publishers</span>
                    <span className="lattice-blocked-count">{blockedKeys.length}</span>
                  </div>
                  {blockedKeys.length === 0 ? (
                    <p className="lattice-account-hint">
                      Nothing blocked. Blocking a publisher key means nothing signed with it will be
                      installed — pinned keys do not help if the key itself leaks.
                    </p>
                  ) : (
                    <ul className="lattice-blocked-list">
                      {blockedKeys.map((key) => (
                        <li key={key}>
                          <code title={key}>{keyFingerprint(key)}</code>
                          <button
                            type="button"
                            className="lattice-btn is-small"
                            onClick={() => unblockKey(key)}
                          >
                            Unblock
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <footer className="lattice-account-form-foot">
                <button type="button" className="lattice-btn is-small" onClick={() => setView("menu")}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="lattice-btn is-small is-primary"
                  disabled={draftKind === "url" && !draftUrl.trim()}
                >
                  Save
                </button>
              </footer>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
