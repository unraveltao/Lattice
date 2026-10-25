/**
 * 一个"够用就好"的 Markdown 渲染器 —— 只为在应用里读这个仓库自己的文档。
 *
 * # 为什么不引依赖
 *
 * 平台的依赖表已经比组件的规矩宽（组件是纯静态目录，一个依赖都不许有），
 * 再加一个 markdown 库不是不行，但代价是：多一棵要审计的依赖树、一套别人的
 * 转义规则、以及"它渲染出来的东西和我们文档里的写法对不上"时去读别人源码。
 * 文档是我们自己写的、方言也是自己定的 —— 自己解析，规则少一条就少一条坑。
 *
 * # 只做文档里真的出现过的写法
 *
 * 块级：标题、段落、围栏代码、GFM 表格、引用、有序 / 无序列表（含嵌套）、
 * 分隔线。行内：代码、粗体、斜体、删除线、链接、图片。
 *
 * **不认原始 HTML** —— 一律转义成文本。文档里的 HTML 全长在代码块里（示例
 * 代码），那些本来就该原样显示；别处出现尖括号，多半是写错了，转义比执行诚实。
 *
 * # 先转义再解析
 *
 * 顺序反过来（先解析、再对结果做净化）就得写一套 HTML 白名单，那是个无底洞。
 * 这里先把 `& < > "` 换成实体，之后拼进去的只有我们自己生成的标签。
 *
 * # 链接只放行三种
 *
 * `http(s)`、页内锚点、相对路径。`javascript:` / `file:` / `ms-settings:` 一律
 * 降级成纯文本 —— 和 `open_policy.rs` 是同一条规矩，只是这一层更早、也更窄。
 *
 * # 表格与代码块
 *
 * 文档里 400 多行表格、40 多个代码块，两者都会撑破 660px 的阅读区，所以各自
 * 包一层可横向滚动的壳（`.lattice-doc-table` / `.lattice-doc-code`）。壳在渲染器
 * 里给，样式在 CSS 里管 —— 渲染器不认识主题色。
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** 先把尖括号换成实体，后面所有拼装都在"没有真标签"的前提下进行 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char]);
}

/**
 * 标题的锚点。规则照着 GitHub 来：小写、去掉标点、空格换连字符。
 *
 * 中文原样留着 —— GitHub 也这样，所以 `WIDGET_SPEC.md#36-把能力声明成工具…`
 * 这种仓库里已经写好的链接能对上。
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 这个地址能不能写成 `href`。`null` = 不能，调用方降级成纯文本 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  if (href.startsWith("#")) return href;
  if (!HAS_SCHEME.test(href)) return href;
  return /^https?:/i.test(href) ? href : null;
}

const CODE_SLOT = "\u0000";

/**
 * 行内语法。
 *
 * 顺序是有讲究的：先把行内代码挖成占位符，再转义，再处理图片（必须早于链接，
 * 否则 `![x](y)` 里的 `[x](y)` 会被链接规则先吃掉），最后把代码填回去 ——
 * 代码里的 `**` 和 `[]` 不该被当成语法。
 */
function inline(text: string): string {
  const codes: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_SLOT}${codes.length - 1}${CODE_SLOT}`;
  });

  out = escapeHtml(out);

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, src: string) => {
    const url = safeHref(src);
    // 远程图（README 里那些徽章）不画：文档要能离线读，一个转圈的破图比没有更吵
    if (!url || HAS_SCHEME.test(url)) return `<span class="lattice-doc-alt">${alt}</span>`;
    return `<img src="${url}" alt="${alt}" loading="lazy" />`;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const url = safeHref(href);
    return url ? `<a href="${url}">${label}</a>` : label;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(（【])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return out.replace(new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, "g"), (_match, index: string) => {
    return codes[Number(index)] ?? "";
  });
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const CONTINUATION = /^\s+\S/;

/** 这一行会不会开一个新的块。段落靠它决定在哪停 */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    line.trimStart().startsWith("|")
  );
}

function uniqueId(base: string, used: Map<string, number>): string {
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

function splitRow(line: string): string[] {
  // `\|` 是单元格里的竖线，先换成占位符再切
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .replace(/\\\|/g, CODE_SLOT)
    .split("|")
    .map((cell) => cell.trim().split(CODE_SLOT).join("|"));
}

interface ListNode {
  ordered: boolean;
  items: ListItemNode[];
}

interface ListItemNode {
  text: string;
  list: ListNode | null;
}

function buildTree(items: Array<{ indent: number; ordered: boolean; text: string }>): ListNode {
  const root: ListNode = { ordered: items[0].ordered, items: [] };
  const stack: Array<{ indent: number; list: ListNode; last: ListItemNode | null }> = [
    { indent: items[0].indent, list: root, last: null },
  ];

  for (const item of items) {
    while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    const node: ListItemNode = { text: item.text, list: null };
    if (item.indent > top.indent && top.last) {
      const sub: ListNode = { ordered: item.ordered, items: [] };
      top.last.list = sub;
      sub.items.push(node);
      stack.push({ indent: item.indent, list: sub, last: node });
    } else {
      top.list.items.push(node);
      top.last = node;
    }
  }
  return root;
}

function renderListTree(list: ListNode): string {
  const tag = list.ordered ? "ol" : "ul";
  const body = list.items
    .map((item) => `<li>${inline(item.text)}${item.list ? renderListTree(item.list) : ""}</li>`)
    .join("");
  return `<${tag}>${body}</${tag}>`;
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const head = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });

  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(splitRow(lines[i]));
    i += 1;
  }

  const cell = (tag: "th" | "td", text: string, index: number) => {
    const style = align[index] ? ` style="text-align:${align[index]}"` : "";
    return `<${tag}${style}>${inline(text)}</${tag}>`;
  };

  const headHtml = head.some((text) => text.trim())
    ? `<thead><tr>${head.map((text, index) => cell("th", text, index)).join("")}</tr></thead>`
    : "";
  const bodyHtml = rows.length
    ? `<tbody>${rows
        .map((row) => `<tr>${row.map((text, index) => cell("td", text, index)).join("")}</tr>`)
        .join("")}</tbody>`
    : "";

  return {
    html: `<div class="lattice-doc-table"><table>${headHtml}${bodyHtml}</table></div>`,
    next: i,
  };
}

function renderBlocks(lines: string[], used: Map<string, number>): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2];
      const close = new RegExp(`^\\s*\\${marker}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      // 收尾那行可能是文件末尾（没写闭合），多跳一行也无害
      i += 1;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(
        `<div class="lattice-doc-code"><pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre></div>`,
      );
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const id = uniqueId(slugify(text) || `section-${level}`, used);
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE, "$1"));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(body, used)}</blockquote>`);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      const table = renderTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: Array<{ indent: number; ordered: boolean; text: string }> = [];
      while (i < lines.length) {
        const match = lines[i].match(LIST_ITEM);
        if (match) {
          items.push({ indent: match[1].length, ordered: /\d/.test(match[2]), text: match[3] });
          i += 1;
          continue;
        }
        if (!lines[i].trim()) {
          // 空行之后还是列表项就继续，否则这个列表到此为止
          if (i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) {
            i += 1;
            continue;
          }
          break;
        }
        // 缩进但没有项目符号：是上一条的续行
        if (CONTINUATION.test(lines[i]) && items.length > 0) {
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      out.push(renderListTree(buildTree(items)));
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length === 0) {
      // 落到这里说明上面每个分支都不认这一行（比如只写了 `|` 的残行）：
      // 原样当一段文字吃掉，绝不空转 —— 空转会死循环
      paragraph.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}

/** 把一份 Markdown 渲染成 HTML。调用方自己决定往哪儿塞（本仓库里是 `dangerouslySetInnerHTML`） */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  return renderBlocks(lines, new Map());
}
