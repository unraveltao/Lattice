/**
 * 棂 / Lattice —— 全局搜索浮层（`Ctrl+Shift+F`）
 *
 * # 它搜什么，不搜什么
 *
 * 只搜**清单里的元数据**：名字、id、描述、作者、权限。已装的组件和商店目录里的
 * 条目在同一张表里（`runtime/global-search.ts` 负责合成）。
 *
 * **不搜用户数据。** 组件 `storage` 里的正文宿主读不到（桥是"组件问宿主"的单向
 * 通道），真要做就得先加一条"把正文吐出来"的跨进程协议 —— 而且全局浮层里显示
 * 便签正文，截图和旁人一眼就能看到。范围那句话直接复用库里那一句，两处共用一份，
 * 边界一变两边一起变。
 *
 * # 选中之后
 *
 * 已装且摆在画布上的 → 滚到那张卡 + 选中 + 闪一下；其余（能装没装 / 商店条目 /
 * 装了没摆）→ 打开组件库并把搜索词设成那个 id。**不 `bringToFront`**：它会把
 * placement 挪到数组末尾，而数组顺序就是 z 序、且整份落盘 —— 一次只读的查找
 * 不该改写用户的布局。
 *
 * # 输入法
 *
 * ↑↓ 和 Enter 在**组合期间必须放行**：那时 ↑↓ 在翻候选词、Enter 在确认候选词。
 * 抢过来就是"打拼音打到一半打开了第一条"。两道判据一起用 —— Chromium 在提交
 * 候选词那次 `keydown` 上给 `isComposing: true`，老引擎只给 `keyCode 229`。
 * 这个仓库在 `App.tsx` 记过 Ctrl+Space 被输入法吃掉的亏。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { rankTargets, type SearchTarget } from "../runtime/global-search";
import { tokenize } from "../runtime/library-search";
import { useT } from "../runtime/i18n";
import { useText } from "../runtime/widget-text";
import { Glyph, ICON, WidgetIconMark } from "./icons";
import { useOverlayDismiss } from "./useOverlayDismiss";

export interface SearchOverlayProps {
  targets: readonly SearchTarget[];
  onPick: (target: SearchTarget) => void;
  onClose: () => void;
}

/** 一屏放得下的上限。再多也不会有人往下翻，而 DOM 是有代价的 */
const MAX_ROWS = 50;

export function SearchOverlay({ targets, onPick, onClose }: SearchOverlayProps) {
  const t = useT();
  const text = useText();
  /*
   * 这个 ref 挂在**背景**上，不是面板上。
   *
   * `useOverlayDismiss` 拿它回答"点的是不是浮层自己"。背景铺满视口，所以
   * 这个问题的答案永远是"是" —— 换句话说，那一条 pointerdown 判据在这一层
   * 是**故意不生效**的，关门由背景自己的 `onPointerDown` 负责。
   *
   * 为什么要这么绕：顶栏那颗搜索按钮就在背景底下。如果关门靠 window 上那个
   * 捕获阶段监听器，点按钮会**先关再开**（监听器关掉，按钮的 onClick 再 toggle
   * 回来），看上去像按钮失灵。让背景把这一下点击吃掉，按钮根本收不到 click，
   * 也就没有第二次。
   *
   * hook 剩下那几条（blur / resize）照常有用：拖窗口、切走再切回来，浮层该没。
   */
  const backdropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useOverlayDismiss(backdropRef, onClose, { scroll: false, escape: false });

  const tokens = useMemo(() => tokenize(query), [query]);
  /*
   * 空查询**不列全部**。装了几十个组件时那是一屏噪音，而"我要找什么"这件事
   * 用户自己还没说出口。空的时候只留一句范围说明，把注意力推回输入框。
   */
  const rows = useMemo(
    () => (tokens.length === 0 ? [] : rankTargets(targets, tokens).slice(0, MAX_ROWS)),
    [targets, tokens],
  );

  // 打开就聚焦，关掉把焦点还回去 —— 不然焦点落到 body 上，Tab 要从头开始
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previous?.focus({ preventScroll: true });
  }, []);

  // 换了词，高亮回第一条。不回的话按完三个字高亮还停在第四条上，Enter 会选错
  useEffect(() => setActive(0), [query]);

  // 让高亮那一行始终在可视区里（↑↓ 走过列表底部时）
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (rows.length > 0) setActive((index) => Math.min(index + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) onPick(row);
    } else if (event.key === "Escape") {
      /*
       * 先清词、再关 —— 和库面板那颗搜索框一个规矩（Esc 是"退一步"不是"全退"）。
       *
       * 这里**是 Esc 的唯一监听者**（`useOverlayDismiss` 那一份关了 escape），
       * 所以不需要 `stopPropagation`：焦点始终在输入框里（行是 `tabIndex={-1}`），
       * 每一下 Esc 都从这里过。
       */
      event.preventDefault();
      if (query !== "") setQuery("");
      else onClose();
    }
  };

  const badge = (row: SearchTarget) => {
    if (row.kind === "installed" && row.placed > 0) {
      return t("{count} on the canvas", { count: row.placed });
    }
    if (row.kind === "installed") return t("Installed");
    return t("Not installed");
  };

  return createPortal(
    /*
     * 背景吃下这一下 pointerdown 就关门 —— 见上面 `backdropRef` 上那段说明。
     * 面板自己 `stopPropagation`：点结果行是"选中"，不是"点别处"。
     */
    <div className="lattice-search-backdrop" ref={backdropRef} onPointerDown={onClose}>
      <div
        className="lattice-search-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t("Search widgets and the catalogue")}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="lattice-search-field">
          <Glyph d={ICON.search} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("Search widgets and the catalogue")}
            aria-label={t("Search widgets and the catalogue")}
            spellCheck={false}
            autoComplete="off"
            /*
             * combobox 那一套：焦点**始终留在输入框里**，↑↓ 挪的是
             * `aria-activedescendant`，不是焦点。三件事因此同时成立：
             *
             *   - Esc 永远落到同一个处理函数上。焦点要是能 Tab 到某一行，
             *     在那一行上按 Esc 就没人接 —— 浮层关不掉。
             *   - Enter 只有一处响应。行是 `<button>`，焦点在它上面时浏览器
             *     自己会发一次 click，再加上这里的一次就是"选中两遍"。
             *   - 屏幕阅读器念的是"组合框，第 2 项，共 5 项"，而不是每挪一格
             *     就重新宣布整块列表。
             *
             * 所以下面那些行都是 `tabIndex={-1}`：可点，但不进 Tab 序列。
             */
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="lattice-search-list"
            aria-autocomplete="list"
            aria-activedescendant={rows.length > 0 ? `lattice-search-opt-${active}` : undefined}
          />
        </div>

        {rows.length > 0 ? (
          <div className="lattice-search-rows" id="lattice-search-list" ref={listRef} role="listbox">
            {rows.map((row, index) => {
              const name = text(row.manifest.name);
              const iconUrl = row.record?.iconUrl ?? null;
              return (
                <button
                  key={`${row.kind}:${row.id}`}
                  id={`lattice-search-opt-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  data-index={index}
                  data-search-id={row.id}
                  className={`lattice-search-row${index === active ? " is-active" : ""}`}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => onPick(row)}
                >
                  {iconUrl ? (
                    <WidgetIconMark url={iconUrl} size={16} />
                  ) : (
                    <span className="lattice-search-initial" aria-hidden="true">
                      {name.slice(0, 1)}
                    </span>
                  )}
                  <span className="lattice-search-name">{name}</span>
                  <span className="lattice-search-meta">
                    {row.update && (
                      <span className="lattice-search-badge is-update">
                        {t("Update to {version}", { version: row.update })}
                      </span>
                    )}
                    <span className="lattice-search-badge">{badge(row)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="lattice-search-empty">
            {tokens.length === 0
              ? t("Search covers names, ids, descriptions, authors and permissions.")
              : t("Nothing matches “{query}”", { query })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
