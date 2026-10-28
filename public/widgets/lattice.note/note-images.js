/**
 * 便签里的图片 —— 纯逻辑那一半：正文里那一行长什么样、宽度怎么改、导出时怎么切。
 *
 * # 为什么图片要"压成代码"
 *
 * 便签的正文就是**一整份自包含的 Markdown**：图片是内联的 data URL，而不是"另一个
 * 键里的一串字节"。理由在 design/0028 §3：存储是一整个 JSON 文件，改一个键也要把
 * 整份读上来、改完写回去，字节放哪个键写盘量一模一样 —— 而内联换来的好处是
 * **正文自己就能导出**（导出时唯一的活是把 data URL 抽成文件）。
 *
 * 代价是编辑态里会看到一行很长的 base64（`{width=N}` 就在它后面）。这一条改不了，
 * 除非换成 contenteditable（那是重写编辑器），所以只做两件缓解：字数统计先剥掉
 * 图片再数、插入之后光标落到下一行。
 *
 * # 上限是硬前提，不是建议
 *
 * 不压缩的话，"一个便签里放三张截图"就是几 MB 的 JSON，每 400ms 自动保存一次要写
 * 三份盘（正文 + backup + `.bak`）。所以插入前一定压：长边 480、质量 0.8、WebP；
 * 压完还超 120KB 就拒绝。**拒绝时要说话** —— 悄悄丢掉一张图比拒绝更糟。
 *
 * # 闸门只有一道：总字节（0.3.1 改的）
 *
 * 0.3.0 有三道闸门，其中"最多 8 张"是个拍出来的数：8 × 120KB = 960KB < 1MB，
 * 于是"合计到 1MB 了"那句永远不会出现，而用户在第 9 张就被拦住 —— 那时便签里
 * 可能只有 300KB。**成本是字节的函数，不是张数的函数**（写盘放大 3× 只看字节），
 * 所以真闸门只有 `MAX_TOTAL_BYTES`；`MAX_IMAGES` 退成一道护栏（防一次拖进 200 个
 * 文件的荒唐值），20 张是照"1MB ÷ 典型 40KB ≈ 25 张"留的余量。
 *
 * 判据集中在 `admit()` 一处，`widget.js` 只照它给的四个答案做事。
 *
 * # 这个文件里没有 DOM
 *
 * canvas 那一段（`createImageBitmap` → 缩放 → `toDataURL`）在 `widget.js` 里，
 * 因为它必须有浏览器；这里只收"算得出来"的东西，`tests/note-images.html` 直接跑。
 */
(function () {
  "use strict";

  /** 压到长边多少像素 */
  var LONG_EDGE = 480;
  /** WebP 的质量 */
  var QUALITY = 0.8;
  /** 原图长边超过这个数就先降一次采样，再压到 `LONG_EDGE`（4K 截图直接压会卡两秒） */
  var PRE_DOWNSCALE = 2000;
  /** 单张压完之后的上限 */
  var MAX_IMAGE_BYTES = 120 * 1024;
  /**
   * 一张便签最多几张图。**这是护栏，不是成本闸门** —— 真闸门是 `MAX_TOTAL_BYTES`。
   *
   * 20 不是拍的：1MB ÷ 一张典型 40KB ≈ 25 张，留一点余量。0.3.0 的 8 张比它早得多地
   * 把用户拦住（8 张典型只有 320KB，离 1MB 还差三分之二）。
   */
  var MAX_IMAGES = 20;
  /** 一张便签里图片字节的总上限 —— 这一条才是真的那道墙 */
  var MAX_TOTAL_BYTES = 1024 * 1024;

  /**
   * 一张内联图片：`![](data:image/webp;base64,…){width=240}`。
   *
   * 只认 `data:image/`。`blob:` 是当场预览用的、存下去重开就没了（design/0028 §5
   * 的失败表里写着这条），所以它压根不进这张正则。
   */
  function imagePattern() {
    return /!\[([^\]]*)\]\((data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)(?:\{width=(\d+)\})?/gi;
  }

  /** 一段 base64（不带 `data:` 头）大约多少字节 */
  function base64Bytes(text) {
    var body = String(text == null ? "" : text);
    if (!body) return 0;
    var pad = body.slice(-2) === "==" ? 2 : body.slice(-1) === "=" ? 1 : 0;
    return Math.max(0, Math.floor((body.length * 3) / 4) - pad);
  }

  /** 一张 data URL 的字节数 */
  function dataUrlBytes(url) {
    var comma = String(url || "").indexOf(",");
    return comma < 0 ? 0 : base64Bytes(String(url).slice(comma + 1));
  }

  function mimeOf(url) {
    var match = /^data:image\/([a-z0-9.+-]+)/i.exec(String(url || ""));
    return match ? match[1].toLowerCase() : "";
  }

  /** 正文里的图片，按出现顺序 */
  function imagesIn(text) {
    var source = String(text == null ? "" : text);
    var pattern = imagePattern();
    var out = [];
    var match;
    while ((match = pattern.exec(source)) !== null) {
      out.push({
        index: out.length,
        alt: match[1],
        src: match[2],
        width: match[3] ? Number(match[3]) : 0,
        mime: mimeOf(match[2]),
        bytes: dataUrlBytes(match[2]),
      });
    }
    return out;
  }

  function imageCount(text) {
    return imagesIn(text).length;
  }

  function totalImageBytes(text) {
    var images = imagesIn(text);
    var sum = 0;
    for (var i = 0; i < images.length; i += 1) sum += images[i].bytes;
    return sum;
  }

  /**
   * 一张压好的图能不能进这张便签：`ok` / `tooBig` / `full` / `countFull`。
   *
   * 三道判断的顺序是有意的：**先单张、再总字节、最后张数**。总字节排在张数前面，
   * 是因为它才是真成本 —— 两个都满了的时候，说"到 1MB 了"比说"到 20 张了"更能
   * 指导用户下一步（去导出、去清空）。
   *
   * 返回的是**原因**而不是布尔：调用方要按原因说不同的话，而"悄悄丢掉一张"是
   * 这个组件最不该犯的错。
   */
  function admit(text, bytes) {
    var size = Number(bytes) || 0;
    if (size > MAX_IMAGE_BYTES) return "tooBig";
    if (totalImageBytes(text) + size > MAX_TOTAL_BYTES) return "full";
    if (imageCount(text) >= MAX_IMAGES) return "countFull";
    return "ok";
  }

  /** 把图片整段剥掉之后的正文（字数统计用） */
  function stripImages(text) {
    return String(text == null ? "" : text).replace(imagePattern(), "");
  }

  /** 字数：剥掉图片再数，否则一张 40KB 的图会让字数跳到四万 */
  function countChars(text) {
    return Array.from(stripImages(text)).length;
  }

  /** 按长边等比缩到 `max` 以内。两个数都是整数；有一边是 0 就返回 0 */
  function fitSize(width, height, max) {
    var w = Number(width) || 0;
    var h = Number(height) || 0;
    if (w <= 0 || h <= 0 || max <= 0) return { width: 0, height: 0 };
    var longest = Math.max(w, h);
    if (longest <= max) return { width: Math.round(w), height: Math.round(h) };
    var ratio = max / longest;
    return {
      width: Math.max(1, Math.round(w * ratio)),
      height: Math.max(1, Math.round(h * ratio)),
    };
  }

  /** 现在显示的是哪一档（25 / 50 / 100）。没有记录宽度 = 100% */
  function widthPercent(shown, natural) {
    var base = Number(natural) || 0;
    var px = Number(shown) || 0;
    if (!base || !px) return 100;
    var ratio = px / base;
    if (ratio <= 0.375) return 25;
    if (ratio <= 0.75) return 50;
    return 100;
  }

  function tokenOf(alt, src, px) {
    var token = "![" + alt + "](" + src + ")";
    return px ? token + "{width=" + px + "}" : token;
  }

  /**
   * 改第 `index` 张图的宽度（只改源文本里的 `{width=N}`）。
   *
   * `index` 越界或没有这张图时原样返回 —— 预览里的那颗按钮和正文之间的对应关系
   * 是"按出现顺序"，中间要是没对上，宁可什么都不改，也别改错一张。
   */
  function setWidthAt(text, index, px) {
    var source = String(text == null ? "" : text);
    var pattern = imagePattern();
    var width = Number(px) || 0;
    var seen = 0;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      if (seen === index) {
        var head = source.slice(0, match.index) + tokenOf(match[1], match[2], width);
        return head + source.slice(match.index + match[0].length);
      }
      seen += 1;
    }
    return source;
  }

  /**
   * 点一下换下一档：100 → 25 → 50 → 100。
   *
   * 百分比换算需要**原图宽度**（data URL 里没写，只能问画出来的那张 `<img>`），
   * 所以 `natural` 由调用方传进来；拿不到时退回当前记录的那个数。
   */
  function cycleWidth(text, index, natural) {
    var images = imagesIn(text);
    var image = images[index];
    if (!image) return { text: text, percent: 0 };
    var base = Number(natural) || image.width || 0;
    var current = widthPercent(image.width, base);
    var next = current === 100 ? 25 : current === 25 ? 50 : 100;
    var px = base ? Math.max(1, Math.round((base * next) / 100)) : 0;
    return { text: px ? setWidthAt(text, index, px) : String(text == null ? "" : text), percent: next };
  }

  function extensionFor(mime) {
    var value = String(mime || "").toLowerCase();
    if (value === "jpeg" || value === "jpg") return "jpg";
    if (value === "png") return "png";
    if (value === "gif") return "gif";
    if (value === "avif") return "avif";
    return "webp";
  }

  function base64Of(url) {
    var text = String(url || "");
    var comma = text.indexOf(",");
    return comma < 0 ? "" : text.slice(comma + 1);
  }

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  /** 没有标题时那个名字：`便签 2026-10-27 10-44`（前缀由调用方按界面语言给） */
  function fallbackName(now, prefix) {
    var date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    return (
      (prefix || "便签") +
      " " +
      date.getFullYear() +
      "-" +
      pad2(date.getMonth() + 1) +
      "-" +
      pad2(date.getDate()) +
      " " +
      pad2(date.getHours()) +
      "-" +
      pad2(date.getMinutes())
    );
  }

  /** 正文第一行是不是 `# 标题`。是就返回那个标题 */
  function titleOf(text) {
    var first = String(text == null ? "" : text).replace(/^\uFEFF/, "").split("\n")[0] || "";
    var match = /^\s*#\s+(.+?)\s*#*\s*$/.exec(first);
    return match ? match[1] : "";
  }

  /** 标题当文件名之前要洗一遍（Windows 的九个头、控制字符、60 个字） */
  function safeBaseName(raw) {
    var name = String(raw || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) return "";
    return Array.from(name).slice(0, 60).join("");
  }

  function defaultNoteName(text, now, prefix) {
    return safeBaseName(titleOf(text)) || fallbackName(now, prefix);
  }

  function escapeAttribute(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * 导出的切分：正文里的每张 data URL 抽成 `images/N.ext`，`{width=N}` 就地改写成
   * `<img src="images/N.ext" width="N">`。
   *
   * 为什么宽度要写成 HTML 属性：Markdown 没有图片尺寸语法，而 `{width=240}` 是
   * pandoc / Obsidian 的方言，GitHub 不认。`<img>` 是唯一所有渲染器都认的写法。
   *
   * 返回 `{ baseName, zip, files }`：`files` 就是 `file.save` 的 `files`。正文那条
   * 永远叫 `note.md`（zip 里解出来就是它），图片按出现顺序编号。
   */
  function exportPlan(text, now, prefix) {
    var source = String(text == null ? "" : text);
    var pattern = imagePattern();
    var body = "";
    var cursor = 0;
    var number = 0;
    var match;
    var files = [];

    while ((match = pattern.exec(source)) !== null) {
      body += source.slice(cursor, match.index);
      number += 1;
      var extension = extensionFor(mimeOf(match[2]));
      var tag = '<img src="images/' + number + "." + extension + '"';
      var alt = match[1];
      if (alt) tag += ' alt="' + escapeAttribute(alt) + '"';
      if (match[3]) tag += ' width="' + Number(match[3]) + '"';
      body += tag + ">";
      cursor = match.index + match[0].length;
    }
    body += source.slice(cursor);

    var base = defaultNoteName(source, now, prefix);
    files.push({ name: "note.md", text: body });

    var images = imagesIn(source);
    for (var i = 0; i < images.length; i += 1) {
      files.push({
        name: "images/" + (i + 1) + "." + extensionFor(images[i].mime),
        base64: base64Of(images[i].src),
      });
    }

    return { baseName: base, zip: images.length > 0, format: images.length > 0 ? "zip" : "md", files: files };
  }

  /**
   * 单文件自包含的 Markdown：**正文一个字都不改**。
   *
   * 这是 0028 那个决定的兑现 —— 图片字节压在正文里，所以正文自己就是一份完整的
   * 文档，导出时唯一的活是"给它起个名字"。相比之下 `exportPlan` 要抽出
   * `images/`、改写 `{width}`，因为它交出去的是一份**要带着文件夹走**的文档。
   *
   * 为什么 `{width=N}` 原样留着：它是 pandoc / Obsidian 认的写法，而 GitHub 反正
   * 不渲染 `data:` URI，改写成 `<img width>` 一分钱好处都没有。少一次改写就少一处
   * 和"正文即文档"这条前提打架的地方。
   */
  function inlinePlan(text, now, prefix) {
    var source = String(text == null ? "" : text);
    return {
      baseName: defaultNoteName(source, now, prefix),
      format: "md",
      files: [{ name: "note.md", text: source }],
    };
  }

  /**
   * 把渲染好的正文包成一份**单文件网页**：图片已经是内联的 `data:`，所以整份文档
   * 一个外部引用都没有，双击就能看、发给别人也不会缺图。
   *
   * 样式跟着预览的排版走（同一套字号与行距），但**底色是文档的底色**，不是卡片
   * 的透明底：一份白底黑字的文档才是"文档"，跟着系统深浅色走。
   */
  function htmlDocument(options) {
    var settings = options || {};
    var title = escapeAttribute(settings.title || "便签");
    var lang = settings.lang === "en" ? "en" : "zh-CN";
    var body = String(settings.body || "");

    var style = [
      ":root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--code:#f0f1f3;--accent:#1a7f5a;--rule:#d8dee4}",
      "@media (prefers-color-scheme:dark){:root{--fg:#ecebe6;--muted:#97978f;--bg:#16181a;--code:#23272b;--accent:#5dcaa5;--rule:#2c3136}}",
      "html{-webkit-text-size-adjust:100%}",
      "body{margin:0;padding:40px 20px 64px;background:var(--bg);color:var(--fg);",
      'font:15px/1.75 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}',
      "main{max-width:44rem;margin:0 auto;overflow-wrap:anywhere}",
      "h1,h2,h3{margin:1.4em 0 .5em;line-height:1.35;font-weight:600}",
      "h1{margin-top:0;font-size:1.6em}h2{font-size:1.25em}h3{font-size:1.05em}",
      "p{margin:0 0 .8em}ul,ol{margin:0 0 .8em;padding-left:1.4em}li{margin:.15em 0}",
      "blockquote{margin:0 0 .8em;padding-left:.8em;border-left:3px solid var(--rule);color:var(--muted)}",
      "hr{margin:1.6em 0;border:0;border-top:1px solid var(--rule)}",
      "code{padding:.1em .35em;border-radius:5px;background:var(--code);font-size:.88em;",
      'font-family:ui-monospace,"Cascadia Code",Consolas,monospace}',
      "pre{margin:0 0 .8em;padding:.7em .9em;border-radius:8px;background:var(--code);overflow-x:auto}",
      "pre code{padding:0;background:none}",
      "a{color:var(--accent)}",
      "img.md-img{display:block;max-width:100%;height:auto;margin:.4em 0 .9em;border-radius:8px}",
      ".md-alt{color:var(--muted)}",
      ".md-link{color:var(--accent);text-decoration:underline;text-underline-offset:2px}",
    ].join("");

    return [
      "<!doctype html>",
      '<html lang="' + lang + '">',
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "<title>" + title + "</title>",
      "<style>" + style + "</style>",
      "</head>",
      "<body>",
      '<main class="note">',
      body,
      "</main>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
  }

  /**
   * 单文件网页的导出计划：正文交给 `render`（渲染器在 `note-md.js`，这里只收一个
   * 函数，纯逻辑页不用把渲染器也拖进来），图片原样内联。
   */
  function htmlPlan(text, now, prefix, render, lang) {
    var source = String(text == null ? "" : text);
    var base = defaultNoteName(source, now, prefix);
    var body = typeof render === "function" ? render(source) : "";
    return {
      baseName: base,
      format: "html",
      files: [{ name: "note.html", text: htmlDocument({ title: base, lang: lang, body: body }) }],
    };
  }

  window.__latticeNoteImages = {
    LONG_EDGE: LONG_EDGE,
    QUALITY: QUALITY,
    PRE_DOWNSCALE: PRE_DOWNSCALE,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    MAX_IMAGES: MAX_IMAGES,
    MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
    base64Bytes: base64Bytes,
    dataUrlBytes: dataUrlBytes,
    imagesIn: imagesIn,
    imageCount: imageCount,
    totalImageBytes: totalImageBytes,
    admit: admit,
    stripImages: stripImages,
    countChars: countChars,
    fitSize: fitSize,
    widthPercent: widthPercent,
    setWidthAt: setWidthAt,
    cycleWidth: cycleWidth,
    extensionFor: extensionFor,
    base64Of: base64Of,
    defaultNoteName: defaultNoteName,
    exportPlan: exportPlan,
    inlinePlan: inlinePlan,
    htmlPlan: htmlPlan,
    htmlDocument: htmlDocument,
  };
})();
