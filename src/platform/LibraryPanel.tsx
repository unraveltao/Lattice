/**
 * 棂 / Lattice —— 组件库
 *
 * 平台开箱不带任何组件。这里分两段：
 *   - 已安装：能往画布上放的包
 *   - 可安装：发现到了但还没启用的包（官方包、用户目录里的包）
 *
 * 这个分界是产品定义的一部分，不是 UI 细节：没有安装这个动作，
 * 平台就退化成一个内置了几个组件的桌面工具，而不是扩展平台。
 *
 * 搜索只是**过滤视图**，不改变上面那个分界：查的时候"已安装 / 可安装"两段照旧分开，
 * 只是各自只留命中的卡片。所以搜出来的是"这些东西里有几个是已装的"，
 * 而不是把两种东西混成一列。
 *
 * 三段都能折叠（见 `LibSection`）：默认只摊开"已安装"，另外两段收着，
 * 标题行上写着数量、也能一次装完。装过十几个包之后，面板一打开看到的
 * 应该是自己摆好的东西，而不是一屏"还没装"。
 */

import { useMemo, useState } from "react";
import type { WidgetLoadError, WidgetRecord } from "../runtime/registry";
import { matchesWidget, tokenize } from "../runtime/library-search";
import { permissionLabel, isPermissionReady } from "../runtime/manifest";
import { useT } from "../runtime/i18n";
import { useText } from "../runtime/widget-text";
import { hasHelp } from "../runtime/help";
import { CatalogueSection, type StoreBinding } from "./CatalogueSection";
import { HelpDialog } from "./HelpContent";
import { LibSection } from "./LibSection";
import type { BackupInfo } from "./catalogue";
import { Glyph, ICON, PanelGlyph, WidgetIconMark } from "./icons";
import type { Rating } from "./store";

/** 安装结果提示。成功的会自己消失，失败的留着等用户处理 */
export interface InstallNotice {
  kind: "ok" | "error";
  text: string;
}

interface LibraryPanelProps {
  widgets: WidgetRecord[];
  /** 当前已启用的组件 id */
  installedIds: Set<string>;
  errors: WidgetLoadError[];
  loading: boolean;
  notice: InstallNotice | null;
  onDismissNotice: () => void;
  onOpenWidgetsDir: () => void;
  onAdd: (record: WidgetRecord) => void;
  onInstall: (record: WidgetRecord) => void;
  onInstallPack: (records: WidgetRecord[]) => void;
  onUninstall: (record: WidgetRecord) => void;
  /** 组件目录（商店）。读不到时传 null，这一段就不画 */
  store: StoreBinding;
  /** 每个组件有没有可回滚的上一版，按 widgetId */
  backups: Record<string, BackupInfo | null>;
  ratings: Record<string, Rating>;
  onRollback: (record: WidgetRecord) => void;
  onRate: (record: WidgetRecord, stars: number) => void;
  onReport: (record: WidgetRecord) => void;
  /** 面板是否展开；收起后退成一条竖条，只留开合按钮 */
  open: boolean;
  onToggle: () => void;
}

export function LibraryPanel({
  widgets,
  installedIds,
  errors,
  loading,
  notice,
  onDismissNotice,
  onOpenWidgetsDir,
  onAdd,
  onInstall,
  onInstallPack,
  onUninstall,
  store,
  backups,
  ratings,
  onRollback,
  onRate,
  onReport,
  open,
  onToggle,
}: LibraryPanelProps) {
  const t = useT();
  /** 组件名 / 描述是**作者写的**（可能两门），按当前语言取一份 */
  const text = useText();
  const [query, setQuery] = useState("");
  /** 正在看"怎么用"的那个组件。null = 没开 */
  const [helpTarget, setHelpTarget] = useState<WidgetRecord | null>(null);
  // 按空格切成多个词，每个词都得命中（"clock 24" 这种组合才有意义）
  const tokens = useMemo(() => tokenize(query), [query]);
  const filtering = tokens.length > 0;

  const installed = widgets.filter((record) => installedIds.has(record.manifest.id));
  /*
   * 目录里有的条目不在"可安装"里重复出现 —— 它在下方的目录段里，
   * 带着版本、签名和更新按钮。两处各画一遍的话，同一件事会有两个说法。
   */
  const catalogueIds = new Set((store.snapshot?.catalogue?.entries ?? []).map((item) => item.id));
  const available = widgets.filter(
    (record) => !installedIds.has(record.manifest.id) && !catalogueIds.has(record.manifest.id),
  );
  const officialPack = available.filter((record) => record.source === "bundled");

  const matches = (record: WidgetRecord) => matchesWidget(record, tokens);

  const shownInstalled = installed.filter(matches);
  const shownAvailable = available.filter(matches);
  const nothingMatched = filtering && shownInstalled.length === 0 && shownAvailable.length === 0;

  const activate = (record: WidgetRecord) => {
    if (!installedIds.has(record.manifest.id)) {
      onInstall(record);
      return;
    }
    onAdd(record);
  };

  const renderCard = (record: WidgetRecord) => {
    const isInstalled = installedIds.has(record.manifest.id);
    const review = store.reviews[record.manifest.id];
    const backup = backups[record.manifest.id] ?? null;
    const rating = ratings[record.manifest.id]?.stars ?? 0;

    return (
      <div
        key={record.manifest.id}
        className={`lattice-card${isInstalled ? "" : " is-available"}`}
        role="button"
        tabIndex={0}
        draggable={isInstalled}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-lattice-widget", record.manifest.id);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => activate(record)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate(record);
        }}
      >
        <div className="lattice-card-top">
          <span className="lattice-card-glyph" aria-hidden>
            {record.iconUrl ? (
              <WidgetIconMark url={record.iconUrl} size={17} />
            ) : (
              /* 没声明图标的包退回"名字首字"，总比空一块好认 */
              text(record.manifest.name).trim().slice(0, 1)
            )}
          </span>
          <span className="lattice-card-heading">
            <span className="lattice-card-name">{text(record.manifest.name)}</span>
            <code className="lattice-card-id">{record.manifest.id}</code>
          </span>
          {review ? (
            <span className="lattice-chip is-warn">{t("Review")}</span>
          ) : isInstalled ? (
            <span className="lattice-chip is-accent">{t("Installed")}</span>
          ) : (
            <span className="lattice-chip">{record.source === "bundled" ? t("Bundled") : t("Local")}</span>
          )}
        </div>

        <p className="lattice-card-desc">
          {text(record.manifest.description) || t("No description yet")}
        </p>

        <div className="lattice-card-meta">
          <span className="lattice-mono">v{record.manifest.version}</span>
          <span className="lattice-mono">{record.manifest.author}</span>
        </div>

        {record.manifest.permissions.length > 0 && (
          <div className="lattice-perm-list">
            {record.manifest.permissions.map((permission) => (
              <span
                key={permission}
                className={`lattice-perm${isPermissionReady(permission) ? "" : " is-pending"}`}
                title={
                  isPermissionReady(permission)
                    ? undefined
                    : t("Declared by the widget, but the platform has no bridge method for it yet")
                }
              >
                {permissionLabel(permission)}
              </span>
            ))}
          </div>
        )}

        {/*
          评分只对已安装的组件显示：没装过的人没有资格评价它 ——
          更重要的是，卡片上再挂一排星星会让"安装"这个动作更难看见。
        */}
        {isInstalled && (
          <div className="lattice-card-rating" onClick={(event) => event.stopPropagation()}>
            <div className="lattice-stars" role="group" aria-label={t("Rate {name}", { name: text(record.manifest.name) })}>
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`lattice-star${value <= rating ? " is-on" : ""}`}
                  onClick={() => onRate(record, value === rating ? 0 : value)}
                  aria-label={t(value === 1 ? "{count} star" : "{count} stars", { count: value })}
                  aria-pressed={value <= rating}
                  title={value === rating ? t("Click again to clear") : undefined}
                >
                  ★
                </button>
              ))}
            </div>
            {backup?.version ? (
              <button
                type="button"
                className="lattice-link-btn is-tiny"
                onClick={() => onRollback(record)}
                title={t("Restore {version} (the version you had before this update)", { version: backup.version })}
              >
                {t("Back to {version}", { version: backup.version })}
              </button>
            ) : null}
          </div>
        )}

        <div className="lattice-card-actions">
          {/*
            "怎么用"放在这一行的最左边：右边的 Install / Uninstall / Report
            是"对这份包动手"，`?` 是"先看看它是怎么用的"，两类不同。
            没写说明的组件不画这颗按钮 —— 点开一个空框比没有按钮更差。
          */}
          {hasHelp(record.manifest.help) && (
            <button
              type="button"
              className="lattice-icon-btn is-tiny lattice-card-help"
              onClick={(event) => {
                event.stopPropagation();
                setHelpTarget(record);
              }}
              title={t("How to use this widget")}
              aria-label={t("How to use {name}", { name: text(record.manifest.name) })}
            >
              <Glyph d={ICON.info} size={12} />
            </button>
          )}
          {isInstalled ? (
            <>
              <button
                type="button"
                className="lattice-link-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onReport(record);
                }}
              >
                {t("Report")}
              </button>
              <button
                type="button"
                className="lattice-link-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onUninstall(record);
                }}
              >
                {t("Uninstall")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="lattice-btn is-small"
              onClick={(event) => {
                event.stopPropagation();
                onInstall(record);
              }}
            >
              {t("Install")}
            </button>
          )}
        </div>
      </div>
    );
  };

  if (!open) {
    return (
      <aside className="lattice-panel lattice-panel-left is-collapsed">
        <button
          type="button"
          className="lattice-icon-btn is-large"
          onClick={onToggle}
          title={t("Show the widget library")}
          aria-label={t("Show the widget library")}
          aria-expanded={false}
        >
          <PanelGlyph side="left" />
        </button>
        <span className="lattice-panel-rail-label">{t("Widgets")}</span>
      </aside>
    );
  }

  return (
    <aside className="lattice-panel lattice-panel-left">
      <header className="lattice-panel-head">
        <h2 className="lattice-panel-title">{t("Widgets")}</h2>
        <span className="lattice-panel-count">{installed.length}</span>
        <div className="lattice-panel-actions">
          <button
            type="button"
            className="lattice-icon-btn"
            onClick={onOpenWidgetsDir}
            title={t("Open the widgets folder in Explorer")}
            aria-label={t("Open widgets folder")}
          >
            <Glyph d={ICON.folder} />
          </button>
          <button
            type="button"
            className="lattice-icon-btn"
            onClick={onToggle}
            title={t("Collapse the widget library")}
            aria-label={t("Collapse the widget library")}
            aria-expanded
          >
            <PanelGlyph side="left" />
          </button>
        </div>
      </header>

      {notice && (
        <div className={`lattice-notice is-${notice.kind}`} role="status">
          <span className="lattice-notice-text">{notice.text}</span>
          <button
            type="button"
            className="lattice-notice-close"
            onClick={onDismissNotice}
            aria-label={t("Dismiss notice")}
          >
            ×
          </button>
        </div>
      )}

      {widgets.length > 0 && (
        <div className="lattice-lib-search">
          <span className="lattice-lib-search-icon" aria-hidden>
            <Glyph d={ICON.search} size={13} />
          </span>
          <input
            type="search"
            className="lattice-lib-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Esc 不能漏到 window 上去：设置菜单也在听这个键
              event.stopPropagation();
              if (query) setQuery("");
              else event.currentTarget.blur();
            }}
            placeholder={t("Search widgets")}
            aria-label={t("Search widgets")}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button
              type="button"
              className="lattice-lib-search-clear"
              onClick={() => setQuery("")}
              aria-label={t("Clear search")}
              title={t("Clear search")}
            >
              <Glyph d={ICON.close} size={11} />
            </button>
          )}
        </div>
      )}

      <div className="lattice-panel-body">
        {loading && <p className="lattice-hint">{t("Scanning widgets…")}</p>}

        {!loading && widgets.length === 0 && (
          <div className="lattice-lib-note">
            <p className="lattice-lib-note-title">{t("No widgets at all")}</p>
            <p className="lattice-hint">
              {t("Drag a widget folder or a")} <code>.lattice</code>{" "}
              {t("package from Explorer into this window to install it.")}
            </p>
          </div>
        )}

        {!loading && !filtering && widgets.length > 0 && installed.length === 0 && (
          <div className="lattice-lib-note">
            <p className="lattice-lib-note-title">{t("The platform is empty")}</p>
            <p className="lattice-hint">
              {t("Nothing below is installed yet. Install one and the desktop has something to show.")}
            </p>
            {officialPack.length > 0 && (
              <button
                type="button"
                className="lattice-btn is-small is-primary"
                onClick={() => onInstallPack(officialPack)}
              >
                {t("Install the official pack ({count})", { count: officialPack.length })}
              </button>
            )}
          </div>
        )}

        {nothingMatched && (
          <div className="lattice-lib-note">
            <p className="lattice-lib-note-title">
              {t("Nothing matches “{query}”", { query: query.trim() })}
            </p>
            <p className="lattice-hint">
              {t("Search covers names, ids, descriptions, authors and permissions.")}
            </p>
            <button type="button" className="lattice-btn is-small" onClick={() => setQuery("")}>
              {t("Clear search")}
            </button>
          </div>
        )}

        {shownInstalled.length > 0 && (
          <LibSection
            title="Installed"
            count={filtering ? `${shownInstalled.length}/${installed.length}` : installed.length}
            defaultOpen
            forceOpen={filtering}
          >
            {shownInstalled.map(renderCard)}
          </LibSection>
        )}

        {shownAvailable.length > 0 && (
          <LibSection
            title="Available"
            count={filtering ? `${shownAvailable.length}/${available.length}` : available.length}
            /*
             * 这一段默认收起来。装完之后它只会越来越长，而已经装好的东西
             * 才是日常要用的 —— 每次打开面板先看见一堆"还没装"，会让人
             * 以为没装完。收起来不等于藏起来：标题行上就写着数量，
             * 想装一次点开就有。
             */
            forceOpen={filtering}
            action={
              officialPack.length > 1 ? (
                <button
                  type="button"
                  className="lattice-btn is-small"
                  onClick={() => onInstallPack(officialPack)}
                  title={t("Install all {count} bundled widgets at once", { count: officialPack.length })}
                >
                  {t("Install all")}
                </button>
              ) : null
            }
          >
            {shownAvailable.map(renderCard)}
          </LibSection>
        )}

        <CatalogueSection
          store={store}
          tokens={tokens}
          installedIds={installedIds}
          forceOpen={filtering}
        />

        {errors.length > 0 && (
          <div className="lattice-errors">
            <h3 className="lattice-errors-title">{t("Widgets that failed to load")}</h3>
            {errors.map((error) => (
              <div key={error.dir} className="lattice-error-row">
                <code className="lattice-mono">{error.dir}</code>
                <span>{error.message}</span>
              </div>
            ))}
          </div>
        )}

        <p className="lattice-lib-drop">
          {t("Drop a widget folder or a .lattice package anywhere in this window to install it.")}
        </p>
      </div>

      {helpTarget && (
        <HelpDialog
          name={text(helpTarget.manifest.name)}
          version={helpTarget.manifest.version}
          help={helpTarget.manifest.help}
          changelog={helpTarget.manifest.changelog}
          onClose={() => setHelpTarget(null)}
        />
      )}
    </aside>
  );
}
