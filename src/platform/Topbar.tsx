import { invoke } from "@tauri-apps/api/core";
import { DictationButton } from "./DictationButton";
import { Glyph, ICON, ThemeGlyph } from "./icons";
import { SettingsMenu, type SettingsSection } from "./SettingsMenu";
import { isTauri } from "../runtime/registry";
import type { ThemeMode } from "./store";
import { useT } from "../runtime/i18n";

const THEME_CYCLE: ThemeMode[] = ["light", "dark", "system"];
const THEME_LABEL: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

function nextTheme(current: ThemeMode): ThemeMode {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
}

interface TopbarProps {
  libraryOpen: boolean;
  onToggleLibrary: () => void;
  desktopMode: boolean;
  desktopBusy: boolean;
  onToggleDesktop: () => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  overviewOpen: boolean;
  onToggleOverview: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  petHidden: boolean | null;
  onToggleCompanion: () => void;
  theme: ThemeMode;
  onSetTheme: (theme: ThemeMode) => void;
  installedCount: number;
  placementCount: number;
  debugOpen: boolean;
  onToggleDebug: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  settingsAt: { section: SettingsSection; nonce: number } | null;
}

export function Topbar({
  libraryOpen,
  onToggleLibrary,
  desktopMode,
  desktopBusy,
  onToggleDesktop,
  searchOpen,
  onToggleSearch,
  overviewOpen,
  onToggleOverview,
  assistantOpen,
  onToggleAssistant,
  petHidden,
  onToggleCompanion,
  theme,
  onSetTheme,
  installedCount,
  placementCount,
  debugOpen,
  onToggleDebug,
  refreshing,
  onRefresh,
  settingsAt,
}: TopbarProps) {
  const t = useT();

  return (
    <header className="lattice-topbar">
      <div className="lattice-brand">
        {/* 组件库开关留在品牌左侧；左栏本身也保留自己的窄条入口。 */}
        <button
          type="button"
          className="lattice-icon-btn is-large"
          onClick={onToggleLibrary}
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
          onClick={onToggleDesktop}
          disabled={!isTauri() || desktopBusy}
          title={
            isTauri()
              ? t("Turn canvas widgets into real desktop windows; the main window will step aside")
              : t("Not available in browser preview — run npm run tauri:dev")
          }
        >
          {desktopMode ? t("Bring back") : t("Send to desktop")}
        </button>

        {/* 区分改变桌面窗口状态的主操作与右侧的查看/设置工具。 */}
        <span className="lattice-topbar-split" aria-hidden />

        {/* 搜索与总览互斥，具体切换由 App 持有，避免浮层状态分散。 */}
        <button
          type="button"
          className={`lattice-icon-btn is-large${searchOpen ? " is-active" : ""}`}
          onClick={onToggleSearch}
          aria-expanded={searchOpen}
          title={t("Search widgets and the catalogue (Ctrl+Shift+F)")}
          aria-label={t("Search widgets and the catalogue")}
        >
          <Glyph d={ICON.search} />
        </button>

        <button
          type="button"
          className={`lattice-icon-btn is-large${overviewOpen ? " is-active" : ""}`}
          onClick={onToggleOverview}
          aria-expanded={overviewOpen}
          title={t("Show the whole canvas at once (Ctrl+Shift+O)")}
          aria-label={t("Overview")}
        >
          <Glyph d={ICON.grid} />
        </button>

        <button
          type="button"
          className={`lattice-icon-btn is-large${assistantOpen ? " is-active" : ""}`}
          onClick={onToggleAssistant}
          title={t("Assistant — tell it what to change on your desktop (Ctrl+K, separate window)")}
          aria-label={t("Toggle assistant")}
        >
          <Glyph d={ICON.agent} />
        </button>

        {/* Companion 是平台窗口，浏览器预览没有对应入口。 */}
        {isTauri() ? (
          <button
            type="button"
            className={`lattice-icon-btn is-large${petHidden === false ? " is-active" : ""}`}
            onClick={onToggleCompanion}
            aria-pressed={petHidden === false}
            title={
              petHidden === false
                ? t("Companion — she is on your desktop; click to hide her")
                : t("Companion — hidden; click to bring her back")
            }
            aria-label={t("Toggle the companion")}
          >
            <Glyph d={ICON.companion} />
          </button>
        ) : null}

        {/* 听写操作针对当前平台输入框，保持在主窗口顶层。 */}
        <DictationButton />

        <button
          type="button"
          className="lattice-icon-btn is-large"
          onClick={() => onSetTheme(nextTheme(theme))}
          title={t("Theme: {current} — click for {next}", {
            current: t(THEME_LABEL[theme]),
            next: t(THEME_LABEL[nextTheme(theme)]),
          })}
          aria-label={t("Theme: {current}", { current: t(THEME_LABEL[theme]) })}
        >
          <ThemeGlyph mode={theme} />
        </button>

        <SettingsMenu
          installedCount={installedCount}
          placementCount={placementCount}
          debugOpen={debugOpen}
          onToggleDebug={onToggleDebug}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onQuit={() => {
            if (isTauri()) void invoke("quit_app");
          }}
          onOpenAssistant={onToggleAssistant}
          openAt={settingsAt}
        />
      </div>
    </header>
  );
}
