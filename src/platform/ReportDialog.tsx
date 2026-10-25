/**
 * 举报 / 评分对话框
 *
 * 平台没有服务端，所以"举报"能做到的是：**写一份结构化的 JSON 文件**，
 * 告诉用户它在哪儿，让他自己发给作者。这个对话框的文案必须把这件事说清楚 ——
 * 假装"已提交"比不做更糟：用户以为问题已经反映上去了，其实什么都没发生。
 *
 * 评分同理，是本地记录：给用户一个"我记得这个组件怎么样"的地方，
 * 也会随举报一起写进那份文件。
 */

import { useEffect, useMemo, useState } from "react";
import { useT } from "../runtime/i18n";
import { useText } from "../runtime/widget-text";
import type { WidgetRecord } from "../runtime/registry";

export interface ReportTarget {
  record: WidgetRecord;
  /** 当前评分，没打过是 0 */
  stars: number;
}

export interface ReportResult {
  path: string;
}

const REASONS = [
  "It is broken",
  "It asks for more than it needs",
  "The description is misleading",
  "It crashes or freezes my desktop",
  "Something else",
];

interface ReportDialogProps {
  target: ReportTarget | null;
  saving: boolean;
  result: ReportResult | null;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: { reason: string; note: string; stars: number | null }) => void;
}

export function ReportDialog({ target, saving, result, error, onClose, onSubmit }: ReportDialogProps) {
  const t = useT();
  /** 组件名是作者写的（可能两门），按当前语言取一份 */
  const text = useText();
  const [reason, setReason] = useState(REASONS[0]);
  const [note, setNote] = useState("");
  const [stars, setStars] = useState(0);

  // 每次打开都从干净的状态开始：上一次的草稿留在这里只会让人写错对象
  useEffect(() => {
    if (!target) return;
    setReason(REASONS[0]);
    setNote("");
    setStars(target.stars);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target, onClose]);

  const title = useMemo(
    () => (target ? t("Report {name}", { name: text(target.record.manifest.name) }) : ""),
    [target, t, text],
  );

  if (!target) return null;

  return (
    <div className="lattice-modal-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        className="lattice-modal"
        role="dialog"
        aria-label={title}
        aria-modal="true"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="lattice-modal-head">
          <span className="lattice-modal-title">{title}</span>
          <button type="button" className="lattice-icon-btn" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </header>

        {result ? (
          <div className="lattice-modal-body">
            <p className="lattice-modal-lead">
              {t("Saved. Lattice has no server, so nothing was uploaded — send this file to the author (or attach it to an issue) to report the problem.")}
            </p>
            <code className="lattice-mono lattice-modal-path">{result.path}</code>
            <footer className="lattice-modal-foot">
              <button type="button" className="lattice-btn is-small is-primary" onClick={onClose}>
                {t("Done")}
              </button>
            </footer>
          </div>
        ) : (
          <div className="lattice-modal-body">
            <p className="lattice-modal-lead">
              v{target.record.manifest.version} · {target.record.manifest.author}
            </p>

            <label className="lattice-textfield">
              <span>{t("What went wrong?")}</span>
              <select value={reason} onChange={(event) => setReason(event.target.value)}>
                {REASONS.map((item) => (
                  <option key={item} value={item}>
                    {t(item)}
                  </option>
                ))}
              </select>
            </label>

            <label className="lattice-textfield">
              <span>{t("Details (optional)")}</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value.slice(0, 2000))}
                rows={4}
                placeholder={t("What did you expect, and what happened instead?")}
              />
            </label>

            <div className="lattice-report-stars">
              <span>{t("Your rating")}</span>
              <div className="lattice-stars is-large" role="group" aria-label={t("Rating")}>
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`lattice-star${value <= stars ? " is-on" : ""}`}
                    onClick={() => setStars(value === stars ? 0 : value)}
                    aria-label={t(value === 1 ? "{count} star" : "{count} stars", { count: value })}
                    aria-pressed={value <= stars}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="lattice-modal-error">{error}</p>}

            <p className="lattice-modal-hint">
              {t("The report is written to a file on this computer. Nothing is sent anywhere.")}
            </p>

            <footer className="lattice-modal-foot">
              <button type="button" className="lattice-btn is-small" onClick={onClose}>
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="lattice-btn is-small is-primary"
                disabled={saving}
                onClick={() => onSubmit({ reason, note: note.trim(), stars: stars > 0 ? stars : null })}
              >
                {saving ? t("Saving…") : t("Save report")}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
