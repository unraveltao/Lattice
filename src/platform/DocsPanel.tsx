/**
 * 设置里的「帮助」页 —— 两态：目录 / 阅读。
 *
 * # 为什么是两态，不是左目录右正文
 *
 * 设置面板本身已经是"左导航 + 右正文"，再在里面嵌一层左目录就是三层缩进，
 * 660px 的正文区会被切成两半，而文档里 400 多行是表格。点进去、读完、退出来
 * 这条路径更像读文档，也更像截图里那种"一行一个入口"的样子。
 *
 * # 正文是仓库里那份 Markdown
 *
 * 见 `runtime/docs.ts` 开头那段：不另写一份说明，直接渲染打包进来的 .md。
 * 这里只负责两件事：把相对链接接住（`resolveDocLink`），以及给每份文档一个
 * "在 GitHub 打开"的出口（图片、锚点、别人改过的版本，都得有地方去）。
 *
 * # 一条别踩回去
 *
 * 正文里的链接**不能**交给浏览器默认行为：点了会把整个应用导航走（WebView 里
 * 就是白屏），而不是开一个浏览器窗口。所有 `<a>` 都在这儿拦下来重新分发。
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import { useLang, useT } from "../runtime/i18n";
import {
  DOCS,
  docFileName,
  docTitleFromMarkdown,
  loadDoc,
  resolveDocLink,
  rewriteImages,
  type DocEntry,
} from "../runtime/docs";
import { renderMarkdown } from "../runtime/markdown";
import { Glyph, ICON } from "./icons";
import { ISSUES_URL, openExternal, repoBlobUrl } from "./repo";

interface LoadedDoc {
  path: string;
  title: string;
  html: string;
  anchor: string;
}

/** 目录按清单里的顺序分组；同一组连着写就是一组，不另开一张表 */
function groupDocs(): Array<{ name: string; docs: DocEntry[] }> {
  const groups: Array<{ name: string; docs: DocEntry[] }> = [];
  for (const doc of DOCS) {
    const last = groups[groups.length - 1];
    if (last && last.name === doc.group) last.docs.push(doc);
    else groups.push({ name: doc.group, docs: [doc] });
  }
  return groups;
}

const GROUPS = groupDocs();

export function DocsPanel() {
  const t = useT();
  const language = useLang();
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 连点两份文档时，慢的那份不许盖掉后点的那份 */
  const ticket = useRef(0);

  const open = useCallback(
    async (path: string, anchor = "") => {
      const mine = ++ticket.current;
      setOpenPath(path);
      setError(null);
      try {
        const source = await loadDoc(path);
        if (mine !== ticket.current) return;
        if (source === null) {
          setDoc(null);
          setError(t("Could not read this page"));
          return;
        }
        const known = DOCS.find((item) => item.path === path);
        setDoc({
          path,
          // 目录里没有的文档（从正文链接跳过去的专题页）用正文第一行标题
          title: known ? t(known.title) : docTitleFromMarkdown(source) || docFileName(path),
          html: renderMarkdown(rewriteImages(path, source)),
          anchor,
        });
      } catch (problem) {
        if (mine !== ticket.current) return;
        setDoc(null);
        setError(String(problem instanceof Error ? problem.message : problem));
      }
    },
    [t],
  );

  // 锚点要等正文进 DOM 之后才找得到。滚动的是正文那一块，不是整个设置面板
  useEffect(() => {
    if (!doc?.anchor) return;
    const target = bodyRef.current?.querySelector(`#${CSS.escape(doc.anchor)}`);
    target?.scrollIntoView({ block: "start" });
  }, [doc]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (!anchor || !bodyRef.current?.contains(anchor)) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      event.preventDefault();

      const link = resolveDocLink(doc?.path ?? "", href);
      if (link.kind === "doc") {
        void open(link.path, link.anchor);
        return;
      }
      if (link.kind === "anchor") {
        bodyRef.current.querySelector(`#${CSS.escape(link.anchor)}`)?.scrollIntoView({ block: "start" });
        return;
      }
      if (link.kind === "external") {
        void openExternal(link.href);
        return;
      }
      // 指到包外的东西（仓库里的脚本、图片目录）：按仓库路径丢给 GitHub，
      // 总比"点了没反应"强
      void openExternal(repoBlobUrl(link.href.replace(/^\.?\//, "")));
    },
    [doc?.path, open],
  );

  if (!openPath) {
    return (
      <div className="lattice-doc-list">
        <p className="lattice-settings-hint">
          {t("These pages are the repository's own Markdown, bundled with the app.")}
          {language !== "zh" ? ` ${t("They are written in Chinese.")}` : ""}
        </p>

        {GROUPS.map((group) => (
          <section key={group.name} className="lattice-doc-group">
            <h3 className="lattice-doc-group-title">{t(group.name)}</h3>
            {group.docs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="lattice-doc-row"
                onClick={() => void open(entry.path)}
              >
                <span className="lattice-doc-row-text">
                  <span className="lattice-doc-row-title">{t(entry.title)}</span>
                  <span className="lattice-doc-row-desc">{t(entry.summary)}</span>
                </span>
                <Glyph d={ICON.chevron} />
              </button>
            ))}
          </section>
        ))}

        <div className="lattice-settings-row">
          <span className="lattice-settings-label">{t("Report a problem")}</span>
          <button
            type="button"
            className="lattice-btn is-small"
            onClick={() => void openExternal(ISSUES_URL)}
            title={ISSUES_URL}
          >
            {t("Open an issue")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lattice-doc-view">
      <div className="lattice-doc-toolbar">
        <button type="button" className="lattice-doc-back" onClick={() => setOpenPath(null)}>
          <Glyph d={ICON.back} />
          <span>{t("All documentation")}</span>
        </button>
        <span className="lattice-doc-here">{doc?.title ?? docFileName(openPath)}</span>
        <button
          type="button"
          className="lattice-btn is-small"
          onClick={() => void openExternal(repoBlobUrl(openPath))}
          title={repoBlobUrl(openPath)}
        >
          {t("Open on GitHub")}
        </button>
      </div>

      {error ? (
        <p className="lattice-modal-error">{error}</p>
      ) : doc ? (
        <div
          ref={bodyRef}
          className="lattice-doc-body"
          onClick={onClick}
          // 内容是自己仓库里的 Markdown，渲染器先转义再拼标签（见 runtime/markdown.ts）
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
      ) : (
        <p className="lattice-settings-hint">{t("Loading…")}</p>
      )}
    </div>
  );
}
