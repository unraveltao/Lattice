/**
 * 棂 / Lattice —— 组件库里的一段（可折叠）
 *
 * 组件库有三段：已安装、可安装、目录。装到十几个包之后，这三段全部摊开
 * 会有三米长 —— 而其中真正需要动手的往往只有两三张卡片。所以每段都能收起来，
 * 标题行留"这一段有多少东西"和"一次做完"的动作。
 *
 * 两条规矩：
 *
 *   1. **收起来不能等于藏起来**。搜索的时候强制展开（`forceOpen`）：
 *      搜到了却看不见，比搜不到更让人以为功能坏了。
 *   2. **标题行的那颗按钮只管开合，不兼做别的**。安装全部、刷新目录这类
 *      动作放在标题行右侧单独一颗 —— 点标题想展开、结果装了一堆东西，
 *      这种误触的代价比多一个按钮大。
 */

import { useState, type ReactNode } from "react";
import { useT } from "../runtime/i18n";
import { Glyph, ICON } from "./icons";

interface LibSectionProps {
  title: string;
  /** 标题后面的数字。传 `null` 就不画那颗药丸 */
  count: number | string | null;
  /** 默认是否展开。已安装段展开，可安装 / 目录段收起 */
  defaultOpen?: boolean;
  /** 正在搜索 —— 无视折叠状态，一律展开 */
  forceOpen?: boolean;
  /** 标题行右侧的动作（安装全部、刷新目录…） */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function LibSection({
  title,
  count,
  defaultOpen = false,
  forceOpen = false,
  action,
  className,
  children,
}: LibSectionProps) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  /*
   * `title` 收的是英文原文（`Installed` / `Available` / 商店自己的名字），
   * 在这一层翻译：标题行和开合提示必须用同一个说法，不能让调用方各译一遍。
   */
  const label = t(title);
  const expanded = forceOpen || open;

  return (
    <section className={`lattice-lib-section${className ? ` ${className}` : ""}`}>
      <div className="lattice-lib-section-head">
        <h3 className="lattice-lib-section-title">
          <button
            type="button"
            className="lattice-lib-section-toggle"
            aria-expanded={expanded}
            onClick={() => setOpen((value) => !value)}
            title={t(expanded ? "Collapse {title}" : "Expand {title}", { title: label })}
          >
            <span className={`lattice-lib-chevron${expanded ? " is-open" : ""}`} aria-hidden>
              <Glyph d={ICON.chevron} size={12} />
            </span>
            <span className="lattice-lib-section-name">{label}</span>
            {count !== null && <span className="lattice-lib-count">{count}</span>}
          </button>
        </h3>
        {action ? <div className="lattice-lib-section-action">{action}</div> : null}
      </div>

      {expanded ? <div className="lattice-lib-section-body">{children}</div> : null}
    </section>
  );
}
