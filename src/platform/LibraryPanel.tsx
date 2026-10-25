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
 *
 * 每一行照图层面板的办法排：**静止时只有身份和一颗 `⋯`**（没装的再加一颗
 * 安装），说明 / 版本 / 权限 / 评分 / 怎么用都在展开区，举报与卸载沉在
 * 展开区最底下、隔一条线。理由不是"好看"，是一列十五行时，动作挨着名字
 * 就等于误触 —— 而"读它"和"卸载它"长成一排时手指分不出来。
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
  /*
   * 展开了详情的那一行（一次只开一行）。
   *
   * 为什么默认全收着：装到十五个包之后，一屏能看到的行数就是这一屏的"分辨率"。
   * 版本、作者、权限、评分、回滚每行都摊开的话，一屏只剩四行 —— 而那五样
   * 一个月用不上一次。收起来不等于藏起来：`⋯` 常亮，一次点击全都在。
   */
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
    const expanded = expandedId === record.manifest.id;

    return (
      <div
        key={record.manifest.id}
        className={`lattice-card is-row${isInstalled ? "" : " is-available"}${expanded ? " is-expanded" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
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
          {/*
            静止时只留一颗 Review（它是"要你处理"的事）。"已安装"和"内置 / 本地"
            都很安静地搬进了展开区：前者和上面那一段的标题重复，后者一次装完就不用再看。
          */}
          {review ? <span className="lattice-chip is-warn">{t("Review")}</span> : null}

          {/*
            行尾只放两样：这一行的**主行动**（还没装的那种行才有的 Install）
            和**详情**开关（`⋯`）。别的都不在这儿。

            上一版把 ? / 举报 / 卸载 / ⋯ 四颗挤在行尾，再指过去才亮 —— 一列
            十五行就是七十五个按钮悬在名字边上等着被误点，而且"读它"和"卸载它"
            长成一排，手指分不出来。现在按用途分三处：

              · 行尾   主行动 + 详情（"我要它"）
              · 展开区 说明 / 版本 / 权限 / 怎么用 / 评分（"先看看"）
              · 最底下 举报、卸载，隔一条线（"会真的改动东西"）

            `⋯` 是唯一常亮的一颗，因为它也是"没有鼠标时怎么看到详情"的唯一入口。
          */}
          <div className="lattice-card-actions">
            {!isInstalled && (
              <button
                type="button"
                className="lattice-btn is-small is-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  onInstall(record);
                }}
              >
                {t("Install")}
              </button>
            )}
            <button
              type="button"
              className="lattice-icon-btn is-tiny lattice-card-more"
              onClick={(event) => {
                event.stopPropagation();
                setExpandedId(expanded ? null : record.manifest.id);
              }}
              aria-expanded={expanded}
              aria-label={t("Details for {name}", { name: text(record.manifest.name) })}
              title={t("Details")}
            >
              <Glyph d={ICON.chevron} size={12} />
            </button>
          </div>
        </div>

        <p className="lattice-card-desc">
          {text(record.manifest.description) || t("No description yet")}
        </p>

        <div className="lattice-card-meta">
          <span className="lattice-mono">v{record.manifest.version}</span>
          <span className="lattice-mono">{record.manifest.author}</span>
          <span className="lattice-mono">
            {record.source === "bundled" ? t("Bundled") : t("Local")}
          </span>
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
          怎么用：展开区里的一条文字链接，不再是行尾那颗 `?` 小图标。
          它属于"先看看"，跟下面的评分、举报本来就不是一类；写成一行字也比
          一个只有悬停才有提示的图标好认 —— 图标得先猜它是什么。
          没写说明的组件不画这一条（点开一个空框比没有入口更差）。
        */}
        {hasHelp(record.manifest.help) && (
          <button
            type="button"
            className="lattice-link-btn lattice-card-help"
            onClick={(event) => {
              event.stopPropagation();
              setHelpTarget(record);
            }}
            title={t("How to use this widget")}
            aria-label={t("How to use {name}", { name: text(record.manifest.name) })}
          >
            {t("How to use")}
          </button>
        )}

        {/*
          评分只对已安装的组件显示：没装过的人没有资格评价它 ——
          更重要的是，卡片上再挂一排星星会让"安装"这个动作更难看见。
          它和"回到上一版"都只在展开区里（`is-expanded` 才显示）：
          这两件事一个月用一次，没理由每行都占一条。
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

        {/*
          展开区的最底下：举报与卸载，单独一条线隔开。

          这两条是"会真的改动东西"的：卸载会删掉这个包，举报会写一份文件。
          所以它们不和上面的信息混在一排里 —— 位置最低、离"展开/收起"最远，
          和属性面板里那颗 `Remove`（沉在面板底部）是同一条规矩。
        */}
        {isInstalled && (
          <div className="lattice-card-danger">
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
          </div>
        )}
      </div>
    );
  };

  if (!open) {
    return (
      <aside className="lattice-panel lattice-panel-left is-collapsed">
        {/*
          收起之后，**整条 40px 竖条就是那颗按钮** —— 不是一个 30px 的图标
          挂在一根只会反光的条上。要从窄条回来时，鼠标已经在左边了，没必要
          先精确点中一个 16px 的箭头。
        */}
        <button
          type="button"
          className="lattice-panel-rail"
          onClick={onToggle}
          title={t("Show the widget library")}
          aria-label={t("Show the widget library")}
          aria-expanded={false}
        >
          <PanelGlyph side="left" />
          <span className="lattice-panel-rail-label">{t("Widgets")}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="lattice-panel lattice-panel-left">
      <header className="lattice-panel-head">
        <h2 className="lattice-panel-title">{t("Widgets")}</h2>
        <span className="lattice-panel-count">{installed.length}</span>
        {/*
          标题行只剩"打开组件目录"这一颗。**"收起"不在这儿** ——
          它挪到了顶栏左上角那颗三线（`App.tsx` 的 `.lattice-brand`）：
          同一个开关同时出现在两头，用户会以为这里是两件事，而且
          "收起这一栏"和"打开这个文件夹"本来就不同类。
        */}
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
