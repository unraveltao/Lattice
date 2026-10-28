/**
 * 便签的 Markdown 渲染器 —— 和平台自己那份（`src/runtime/markdown.ts`）
 * 同一套方言，只是砍到"便签卡片用得上的那几种"。
 *
 * # 为什么是手写
 *
 * 组件是纯静态目录，一个依赖都不许引（平台的规矩比它自己还严）。而这里要
 * 的东西不多：标题、列表、引用、代码、粗斜体、删除线、链接。引一个库的代价
 * （多一棵要审计的依赖树、一套别人的转义规则）比这 150 行大得多。
 *
 * # 先转义再解析
 *
 * 顺序反过来（先解析、再净化）就得写一套 HTML 白名单，那是个无底洞。这里先把
 * `& < > "` 换成实体，之后拼进去的只有我们自己生成的标签 —— 便签里的尖括号
 * 永远显示成字面量。
 *
 * # 链接只显示、不跳转
 *
 * 组件跑在不透明源的沙箱里，点一个 `<a>` 就是一次导航：桌面端会被
 * `egress.rs` 取消，浏览器预览里会真的把卡片换成一页网页 —— 两种都不像话。
 * 所以链接渲染成带下划线的文字，地址放进 `title`，鼠标停上去能看见去哪。
 * 另外只认 http(s)、页内锚点和相对路径，其余（`javascript:` 之类）连 title
 * 都不给 —— 和 `open_policy.rs` 是同一条规矩。
 */
(function () {
  "use strict";

  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (char) {
      return ESCAPES[char];
    });
  }

  var HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

  /**
   * 一张图片的地址能不能真画出来。`null` = 不能，降级成 alt 文字。
   *
   * 只认三种：内联的 `data:image/`（便签自己贴进来的，0.3 起就是它）、当场的
   * `blob:`（预览用，存不下去）、相对路径（组件自己的文件）。`http(s)` **不认** ——
   * 卡片里没有位置，CSP 也只放行自己的资源；真去请求一次，用户看到的是一个破图标。
   * `//host/x` 这种协议相对的写法也拒：它等于一次外网请求。
   */
  function imageSrc(raw) {
    var src = String(raw || "").trim();
    if (!src) return null;
    if (/^(data:image\/|blob:)/i.test(src)) return src;
    if (src.startsWith("//")) return null;
    if (HAS_SCHEME.test(src)) return null;
    return src;
  }

  /** 这个地址能不能写进 title。`null` = 不能，链接降级成纯文字 */
  function safeHref(raw) {
    var href = String(raw || "").trim();
    if (!href) return null;
    if (href.startsWith("#")) return href;
    if (!HAS_SCHEME.test(href)) return href;
    return /^https?:/i.test(href) ? href : null;
  }

  var CODE_SLOT = "\u0000";

  /**
   * 行内语法。
   *
   * 顺序有讲究：先把行内代码挖成占位符，再转义，再处理图片（必须早于链接，
   * 否则 `![x](y)` 里的 `[x](y)` 会被链接规则先吃掉），最后把代码填回去 ——
   * 代码里的 `**` 和 `[]` 不该被当成语法。
   *
   * `doc` = 这份 HTML 要写进一份**独立文档**（导出成 .html），不是画在卡片里。
   * 两处差别：链接变成真的 `<a href>`（卡片里不能跳，一份网页里不能跳才怪），
   * 内联图不带 `data-note-index`（那是预览里那颗宽度按钮的序号，写进文件是噪音）。
   */
  function inline(text, doc) {
    var codes = [];
    var out = String(text).replace(/`([^`]+)`/g, function (_match, code) {
      codes.push("<code>" + escapeHtml(code) + "</code>");
      return CODE_SLOT + (codes.length - 1) + CODE_SLOT;
    });

    out = escapeHtml(out);

    /*
     * 图片：`![](data:image/webp;base64,…){width=240}`。
     *
     * 必须早于链接规则 —— 否则 `![x](y)` 里的 `[x](y)` 会被链接先吃掉，预览里就
     * 只剩一行字面量。`data-note-index` 是给预览里那三档宽度按钮用的序号（只数
     * 内联图）：点一下改的是源文本里对应的那个 `{width=N}`。
     */
    var imageIndex = 0;
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)(?:\{width=(\d+)\})?/g, function (_match, alt, src, width) {
      var url = imageSrc(src);
      if (!url) {
        // 外部图片不加载：卡片里没有位置，CSP 也只放行自己的资源
        return '<span class="md-alt">' + alt + "</span>";
      }
      var attrs = ' class="md-img" src="' + url + '" alt="' + alt + '"';
      if (width) attrs += ' width="' + width + '"';
      if (!doc && /^data:/i.test(url)) {
        attrs += ' data-note-index="' + imageIndex + '"';
        imageIndex += 1;
      }
      return "<img" + attrs + ">";
    });

    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_match, label, href) {
      var url = safeHref(href);
      if (!url) return label;
      // 地址在 `escapeHtml` 之后才取出来，所以这里拼进属性里不会有裸引号
      return doc
        ? '<a href="' + url + '">' + label + "</a>"
        : '<span class="md-link" title="' + url + '">' + label + "</span>";
    });

    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(（【])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    return out.replace(new RegExp(CODE_SLOT + "(\\d+)" + CODE_SLOT, "g"), function (_match, index) {
      return codes[Number(index)] || "";
    });
  }

  var FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  var HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  var HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var QUOTE = /^\s*>\s?(.*)$/;
  var CONTINUATION = /^\s+\S/;

  /** 这一行会不会开一个新的块。段落靠它决定在哪停 */
  function startsBlock(line) {
    return (
      FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
    );
  }

  function listTree(items) {
    var root = { ordered: items[0].ordered, items: [] };
    var stack = [{ indent: items[0].indent, list: root, last: null }];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) stack.pop();
      var top = stack[stack.length - 1];
      var node = { text: item.text, list: null };
      if (item.indent > top.indent && top.last) {
        var sub = { ordered: item.ordered, items: [] };
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

  function renderList(list, doc) {
    var tag = list.ordered ? "ol" : "ul";
    var body = list.items
      .map(function (item) {
        return "<li>" + inline(item.text, doc) + (item.list ? renderList(item.list, doc) : "") + "</li>";
      })
      .join("");
    return "<" + tag + ">" + body + "</" + tag + ">";
  }

  function renderBlocks(lines, doc) {
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      var fence = line.match(FENCE);
      if (fence) {
        var marker = fence[1][0];
        var close = new RegExp("^\\s*\\" + marker + "{" + fence[1].length + ",}\\s*$");
        var body = [];
        i += 1;
        while (i < lines.length && !close.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push("<pre><code>" + escapeHtml(body.join("\n")) + "</code></pre>");
        continue;
      }

      var heading = line.match(HEADING);
      if (heading) {
        var level = Math.min(3, heading[1].length);
        out.push("<h" + level + ">" + inline(heading[2], doc) + "</h" + level + ">");
        i += 1;
        continue;
      }

      if (HR.test(line)) {
        out.push("<hr />");
        i += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        var quoted = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          quoted.push(lines[i].replace(QUOTE, "$1"));
          i += 1;
        }
        out.push("<blockquote>" + renderBlocks(quoted, doc) + "</blockquote>");
        continue;
      }

      if (LIST_ITEM.test(line)) {
        var items = [];
        while (i < lines.length) {
          var match = lines[i].match(LIST_ITEM);
          if (match) {
            items.push({ indent: match[1].length, ordered: /\d/.test(match[2]), text: match[3] });
            i += 1;
            continue;
          }
          if (!lines[i].trim()) {
            if (i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) {
              i += 1;
              continue;
            }
            break;
          }
          // 缩进但没有项目符号：是上一条的续行
          if (CONTINUATION.test(lines[i]) && items.length > 0) {
            items[items.length - 1].text += " " + lines[i].trim();
            i += 1;
            continue;
          }
          break;
        }
        out.push(renderList(listTree(items), doc));
        continue;
      }

      var paragraph = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      if (paragraph.length === 0) {
        // 落到这里说明上面每个分支都不认这一行：原样当一段文字吃掉，绝不空转
        paragraph.push(lines[i]);
        i += 1;
      }
      out.push("<p>" + inline(paragraph.join(" "), doc) + "</p>");
    }

    return out.join("");
  }

  /**
   * 把一段文字渲染成 HTML。调用方自己决定塞进哪个容器。
   *
   * `doc` = true 时按"独立文档"渲染（真链接、不带预览用的序号），给导出 .html 用。
   */
  function render(source, doc) {
    var lines = String(source == null ? "" : source)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      .split("\n");
    return renderBlocks(lines, doc);
  }

  window.__latticeNoteMarkdown = {
    escapeHtml: escapeHtml,
    safeHref: safeHref,
    imageSrc: imageSrc,
    inline: inline,
    render: render,
  };
})();
