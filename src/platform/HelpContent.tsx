/**
 * 棂 / Lattice —— 组件的"怎么用"
 *
 * 两处挂载，一份内容：
 *   - 属性面板（选中桌面上的实例时）—— 用户正看着这个东西，想知道怎么用
 *   - 组件库卡片上的 `?` —— 还没放到桌面上时也得能看
 *
 * 内容全部来自清单（见 `runtime/help.ts`），这里只负责排版，不做任何判断：
 * 谁有说明、说明写了几节，在解析清单时就已经定了。
 */

import { useT } from "../runtime/i18n";
import type { ChangelogEntry, WidgetHelp } from "../runtime/help";

interface HelpContentProps {
  help: WidgetHelp;
  changelog?: ChangelogEntry[];
  /** 变更记录默认不展开：它是"我想知道这版改了什么"才点开的东西 */
  showHistory?: boolean;
}

export function HelpContent({ help, changelog = [], showHistory = true }: HelpContentProps) {
  const t = useT();
  return (
    <div className="lattice-help">
      {help.sections.map((section) => (
        <section key={section.title} className="lattice-help-section">
          <h4 className="lattice-help-title">{section.title}</h4>
          <ul className="lattice-help-list">
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}

      {showHistory && changelog.length > 0 && (
        <details className="lattice-help-history">
          <summary>
            {t("What changed")}
            <span className="lattice-lib-count">{changelog.length}</span>
          </summary>
          {changelog.map((entry) => (
            <div key={entry.version} className="lattice-help-release">
              <p className="lattice-help-version">
                v{entry.version}
                {entry.date ? <span>{entry.date}</span> : null}
              </p>
              <ul className="lattice-help-list">
                {entry.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/**
 * 组件卡片上的 `?` 打开的那个框。
 *
 * 和举报对话框同一套外壳（`.lattice-modal-*`），但只读：没有按钮，
 * 关掉就是关掉 —— 说明这种东西不该有"提交"。
 */
export function HelpDialog({
  name,
  version,
  help,
  changelog,
  onClose,
}: {
  name: string;
  version: string;
  help: WidgetHelp;
  changelog: ChangelogEntry[];
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="lattice-modal-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        className="lattice-modal is-help"
        role="dialog"
        aria-label={t("How to use {name}", { name })}
        aria-modal="true"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="lattice-modal-head">
          <span className="lattice-modal-title">{t("How to use {name}", { name })}</span>
          <button type="button" className="lattice-icon-btn" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </header>
        <div className="lattice-modal-body">
          <p className="lattice-modal-lead">v{version}</p>
          {help.sections.length > 0 ? (
            <HelpContent help={help} changelog={changelog} />
          ) : (
            <p className="lattice-modal-hint">
              {t("This widget does not ship a how-to yet. Its author can add one to the manifest.")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
