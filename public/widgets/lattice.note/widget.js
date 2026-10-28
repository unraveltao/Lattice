/**
 * 便签组件
 *
 * 这个组件存在的意义不是"便签"这个功能，而是验证平台的一个硬问题：
 * 组件里能不能正常输入。桌面端窗口是 WS_EX_NOACTIVATE（永不激活）的，
 * 输入框要打字就必须有焦点 —— 这两件事在 Win32 层是打架的。
 * 在浏览器预览里它只是普通 textarea，到了独立窗口才见真章。
 *
 * 0.2 起多两件事：
 *  1. **预览**：底栏那颗按钮把正文按 Markdown 子集渲染出来（渲染器在
 *     `note-md.js` 里，和平台自己那份同一套方言）。默认仍然是"写"。
 *  2. **清空之后能找回**：把整段文字删光并落盘时，上一版正文会存进
 *     `backup` 这个键，24 小时内卡片上会出现一颗「恢复」。删掉一张便签的
 *     全部内容是不可逆的，而这颗「恢复」是它唯一的退路。
 *
 * 0.3 起有图片（design/0028）：
 *  - **进来只有两条路**：`textarea` 的粘贴、卡片的拖入。图片当场压到长边 480 /
 *    WebP 0.8，**内联成 base64 写进正文**（`![]({data:…}){width=…}`）—— 正文因此
 *    自己就是可导出的 Markdown，不需要第二个存储键。
 *  - **缩小只在预览态做**：图片右下角那颗按钮循环 25% / 50% / 100%，改的是源文本
 *    里的 `{width=N}`，不是 DOM 上的样式 —— 否则下次渲染就回去了。
 *  - **导出**走桥的 `file.save`（权限 `file:save`）：把 data URL 抽成 `images/N`,
 *    `{width=N}` 改写成 `<img width>`，一次交给平台弹保存框。用户取消时一句话都
 *    不说 —— 把"我不想存了"画成红字是这个仓库反复踩过的坑。
 *
 * 0.3.1 只改"装不下"那件事（三处，都在这一份里）：
 *  1. **闸门从张数换成总字节**：8 张 → 20 张护栏 + 1MB 真闸门，判据在
 *     `note-images.js` 的 `admit()`。0.3.0 的 8 张比 1MB 早得多地拦住人。
 *  2. **一批里能进几张就进几张**：0.3.0 是一票否决（粘 3 张、已有 6 张 → 三张全不进），
 *     现在逐张判、最后说一句"收下 2 张，1 张没进：合计到 1MB 了"。
 *  3. **导出成功后给一颗「清空」**：导出不会动正文，于是"导出完不敢删、只增不减"
 *     是这张便签撞墙的真正来路。清空走的是同一条 `wiped` 路，所以上一版仍然留 24
 *     小时可恢复 —— 这个按钮不该比手滑更危险。
 *
 * 0.4 起导出有三种形状（design/0031）：
 *  - **底栏那颗「导出」开一个菜单**，不再直接导：`md`（正文一个字都不改，图片是
 *    data URI，自包含）/ `zip`（note.md + images/，GitHub 认）/ `html`（渲染成一份
 *    网页，图片内联，双击就能看）。
 *  - **桥多认一个 `format`**：它只决定"单文件时补哪个扩展名、挑哪个对话框过滤器"；
 *    多文件或带 base64 仍然一律 zip（判据还是内容，不是这个参数）。
 */
(function () {
  "use strict";

  // ---------- 极简桥客户端 ----------
  var seq = 0;
  var pending = new Map();

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __lattice: 1, type: "request", id: id, method: method, params: params }, "*");
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error("Bridge call timed out: " + method));
      }, 3000);
    });
  }

  var THEME_MAP = {
    "--lattice-surface": "--surface",
    "--lattice-text": "--fg",
    "--lattice-text-muted": "--muted",
    "--lattice-accent": "--accent",
    "--lattice-border": "--border",
    "--lattice-radius": "--radius",
    "--lattice-font": "--font",
  };

  function applyTheme(tokens) {
    if (!tokens) return;
    Object.keys(THEME_MAP).forEach(function (source) {
      var value = tokens[source];
      if (value) document.documentElement.style.setProperty(THEME_MAP[source], value);
    });
  }

  /*
   * 界面语言。
   *
   * 便签上的字（状态行、字数、占位符、预览按钮）都是这个组件自己的，平台
   * 不知道中文怎么写。所以两件事都要做：启动时问一次 `lang.get`，用户中途
   * 换语言再收 `language` 推送，把已经画出去的字原地换掉。
   *
   * 首帧按 HTML 里写死的中文画（不变量 18）；英文界面等桥回来那一趟再翻，
   * 不为这几十毫秒画"加载中"。
   */
  var lang = "zh";

  /** 一句话的两种写法，按当前界面语言挑 */
  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("便签", "Note");
    textEl.placeholder = say("写点什么…", "Write something…");
    updateCount();
    // 状态行的文字由状态机给，重画当前那一条，别把"保存中…"写成别的
    renderStatus();
    // 预览按钮、恢复按钮、导出按钮、清空按钮、空预览的提示语都跟语言有关
    renderMode();
    updateRestore();
    updateExportLabel();
    updateMenu();
    updateClear();
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;
    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    // 平台界面换了语言。`lang.get` 那条是"建文档那一刻"的答案，这条是"后来变了"
    if (data.type === "language") {
      applyLanguage(data.payload);
      return;
    }
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (!key || key === "text") reloadText();
      if (!key || key === "backup") reloadBackup();
      return;
    }
    if (data.type !== "response") return;
    var entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve(data.result);
    } else {
      var error = new Error(data.error || "Bridge call failed");
      error.code = data.code;
      entry.reject(error);
    }
  });

  // ---------- 业务 ----------
  var md = window.__latticeNoteMarkdown;
  var imgs = window.__latticeNoteImages;

  var textEl = document.getElementById("text");
  var previewEl = document.getElementById("preview");
  var statusEl = document.getElementById("status");
  var countEl = document.getElementById("count");
  var modeEl = document.getElementById("mode");
  var restoreEl = document.getElementById("restore");
  var exportEl = document.getElementById("export");
  var clearEl = document.getElementById("clear");
  var menuEl = document.getElementById("menu");
  var menuItems = menuEl ? menuEl.querySelectorAll("[data-format]") : [];

  var timer = null;

  /*
   * 保存状态机
   *
   * 两个数字就够：
   *   revision  每次输入 +1，代表"用户想存的那一版内容"
   *   saved     已经确认落盘的版本
   *
   * 不这么写会出三种错，全都表现为"优先级搞反了"：
   *   1. 保存在飞的时候用户又敲了字，回调却把状态写成"已保存" —— 界面撒谎；
   *   2. 两次保存并发，旧的那次后完成，把新内容盖掉 —— 旧值赢了新值；
   *   3. 载入是异步的，用户先开始打字，磁盘上的旧内容回来把输入冲掉 ——
   *      磁盘赢了用户。
   */
  var revision = 0;
  var saved = 0;
  var saving = false;

  /** 上一次确认落盘的正文。清空检测靠它（null = 还不知道磁盘上是什么） */
  var lastSaved = null;
  /** 清空时留下的上一版：{ text, at }，24 小时内可恢复 */
  var backup = null;
  /** 视图：write（默认）/ read（Markdown 预览） */
  var mode = "write";

  /*
   * 状态行按"键"存，不存已经翻好的字：换语言时要能重画当前那一条。
   * kind 只管颜色（saved / error / 空）。
   */
  var statusKey = "loading";
  var statusKind = "";

  /*
   * 一条"压过保存状态"的话（图片被拒、导出完成）。
   *
   * 状态行有两个说话的人：保存状态机和一次性事件。0.3.0 里后者总被前者盖掉 ——
   * 拒收一张图之后 400ms，`save()` 就把状态行改成「已保存」，那句话用户根本没看见。
   * 所以一次性事件写进 `notice`：保存状态机照常记账（`statusKey`），但不许画上去；
   * **用户下一次真敲键盘**才收掉 —— 那时"刚才那张图没进"确实已经过去了。
   */
  var notice = null;

  /** 保存状态机的那几句话。notice 在的时候它们让位 */
  var SAVE_KEYS = { loading: 1, saving: 1, saved: 1, unsaved: 1 };

  /** 被拒的原因怎么说。`detail` 里的键和 `admit()` 的四个答案一一对应 */
  var REASON_TEXT = {
    full: function () {
      return say("合计到 1MB", "hit 1 MB");
    },
    countFull: function () {
      return say("已满 " + imgs.MAX_IMAGES + " 张", "already " + imgs.MAX_IMAGES + " images");
    },
    tooBig: function () {
      return say("压完超 120KB", "over 120 KB after squeezing");
    },
    broken: function () {
      return say("读不了", "could not be read");
    },
    mixed: function () {
      return say("超了上限", "over a limit");
    },
  };

  var STATUS_TEXT = {
    loading: function () {
      return say("正在载入…", "Loading…");
    },
    saving: function () {
      return say("保存中…", "Saving…");
    },
    saved: function () {
      return say("已保存", "Saved");
    },
    unsaved: function () {
      return say("未保存", "Unsaved");
    },
    noPermission: function () {
      return say("没有存储权限", "No storage permission");
    },
    saveFailed: function () {
      return say("保存失败", "Could not save");
    },
    loadFailed: function () {
      return say("读不到内容", "Could not load");
    },
    imageWorking: function () {
      return say("处理图片…", "Processing image…");
    },
    imageTooBig: function () {
      return say("压完还是超过 120KB", "Still over 120 KB after squeezing");
    },
    /*
     * 装不下时的两句话都带**下一步**，不只报数字。
     *
     * "先导出再清空"不是客套：1MB 是写盘成本（每次停顿重写三份）换来的上限，而这张
     * 便签只增不减的真正原因是"导出不动正文、用户又不敢删"。与其把上限抬到 4MB
     * （每次停顿落 12MB），不如把那条路指出来。
     */
    imageLimit: function () {
      return say("最多 " + imgs.MAX_IMAGES + " 张图 · 先导出再清空", "At most " + imgs.MAX_IMAGES + " images · export, then clear");
    },
    noteFull: function () {
      return say("图片到 1MB 了 · 先导出再清空", "Images reached 1 MB · export, then clear");
    },
    /** 一批里进了几张、没进几张 —— 一票否决改成逐张判之后必须有这句话 */
    imagePartial: function (detail) {
      var reason = REASON_TEXT[(detail && detail.reason) || "mixed"]();
      return say(
        "收下 " + detail.added + " 张，" + detail.rejected + " 张没进（" + reason + "）",
        "Took " + detail.added + ", skipped " + detail.rejected + " (" + reason + ")",
      );
    },
    /** 一张都没进、而且几种原因都有：说不出是哪一道墙，就别假装知道 */
    imageRefused: function () {
      return say("几张图都没进", "None of those images fit");
    },
    imageBroken: function () {
      return say("这张图读不了", "That image could not be read");
    },
    exportWorking: function () {
      return say("导出中…", "Exporting…");
    },
    exportDone: function () {
      return say("已导出", "Exported");
    },
    exportFailed: function () {
      return say("导出失败", "Could not export");
    },
    exportDenied: function () {
      return say("没有「保存文件」权限", "No file permission");
    },
    exportEmpty: function () {
      return say("还没有内容", "Nothing to export");
    },
  };

  /**
   * 按"现在该说哪一句"重画状态行。
   *
   * notice 只在两种时候画：`force`（刚发生的那件事就是它），或者当前这句来自保存
   * 状态机（`SAVE_KEYS`）—— 保存状态机是背景音，它不该把"刚才那张图没进"顶掉。
   */
  function renderStatus(force) {
    var showNotice = notice && (force || SAVE_KEYS[statusKey]);
    var shown = showNotice ? notice : { key: statusKey, kind: statusKind, detail: null, hint: "" };
    var text = STATUS_TEXT[shown.key](shown.detail);
    statusEl.textContent = text;
    statusEl.className = shown.kind ? "is-" + shown.kind : "";
    // 状态条只有 140px 宽（右边 120px 留给窗饰），长文案会被省略号截掉；
    // 截掉了才挂 title，没截就别挂 —— 不然"Saved"上也会凭空弹出个提示。
    // notice 自己带的 hint（下一步怎么办）是例外：它就是要被 hover 看到的
    if (shown.hint) statusEl.title = shown.hint;
    else if (statusEl.scrollWidth > statusEl.clientWidth) statusEl.title = text;
    else statusEl.removeAttribute("title");
  }

  function setStatus(key, kind) {
    statusKey = key;
    statusKind = kind || "";
    if (!SAVE_KEYS[key]) {
      // 保存状态机之外的话说明用户已经往下走了（导出、载入失败…）：旧 notice 作废
      notice = null;
    }
    renderStatus(false);
  }

  /** 说一句压过保存状态的话。`detail` 是这句话的参数，`hint` 是鼠标停上去才看的下一步 */
  function setNotice(key, detail, kind, hint) {
    notice = { key: key, detail: detail || null, kind: kind || "", hint: hint || "" };
    renderStatus(true);
  }

  function clearNotice() {
    if (!notice) return;
    notice = null;
    renderStatus(true);
  }

  function updateCount() {
    // 字数先剥掉图片再数：一张 40KB 的图会让字数跳到四万（design/0028 §8）
    var chars = imgs ? imgs.countChars(textEl.value) : Array.from(textEl.value).length;
    countEl.textContent = say(chars + " 字", chars + " chars");
  }

  /** 底栏那颗「导出」的字与提示。缺 `file:save` 权限时它照旧可点 —— 点下去会说缺什么 */
  function updateExportLabel() {
    if (!exportEl) return;
    exportEl.textContent = say("导出", "Export");
    exportEl.title = say("选一种格式导出", "Export in one of three shapes");
  }

  /*
   * 三种导出形状（0.4.0，design/0031）
   *
   * 卡片底栏放不下三颗按钮，而"导出"本身也不是一个动作、是一组动作 —— 所以它
   * 开一个菜单。三条路各自的取舍写在 `note-images.js` 的三个 plan 里：
   *
   *   md    正文一个字都不改（自包含，图片是 data URI）
   *   zip   note.md + images/（GitHub 认的那种）
   *   html  渲染成一份网页（图片内联，双击就能看）
   */
  function formatLabel(format) {
    if (format === "md") return say("单文件 .md", "One .md");
    if (format === "zip") return say("zip + 图片", "Zip + images");
    return say("单文件 .html", "One .html");
  }

  function formatHint(format) {
    if (format === "md") {
      return say(
        "一份自包含的 Markdown：图片以 base64 压在正文里，Typora / Obsidian 认",
        "One self-contained Markdown: images stay inline as base64 (Typora / Obsidian read it)",
      );
    }
    if (format === "zip") {
      return say(
        "note.md 加 images/ 文件夹：GitHub 也认这个",
        "note.md plus an images/ folder — GitHub reads this one too",
      );
    }
    return say(
      "一份网页：图片内联，双击就能看，发给别人也不缺图",
      "One web page: images inline, double-click to read, nothing goes missing when you send it",
    );
  }

  function updateMenu() {
    for (var i = 0; i < menuItems.length; i += 1) {
      var format = menuItems[i].getAttribute("data-format");
      menuItems[i].textContent = formatLabel(format);
      menuItems[i].title = formatHint(format);
    }
  }

  function setMenu(open) {
    if (!menuEl) return;
    menuEl.hidden = !open;
    if (exportEl) exportEl.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function menuOpen() {
    return !!menuEl && !menuEl.hidden;
  }

  /*
   * 「清空」只在"刚导出成功、正文还没被改过"时出现。
   *
   * 它解决一件真事：导出不动正文，于是用户导出之后不敢删，便签只增不减，最后撞上
   * 1MB。给一颗按钮，比在拒收时说一句"先导出再清空"更实在 —— 那句话现在指的就是它。
   *
   * 为什么它不该比手滑更危险：清空走的是保存状态机里那条 `wiped` 路（正文删光 →
   * 上一版进 `backup`），所以 24 小时内「恢复上一版」拿得回来。
   *
   * 为什么"改过字就收起来"：改过之后屏幕上的东西已经不是刚导出的那一份了，这时候
   * 再按"清空"清的是一份没被导出的内容 —— 按钮必须跟它承诺的东西对齐。
   */
  var exportedAt = 0;

  function updateClear() {
    if (!clearEl) return;
    clearEl.hidden = !(exportedAt > 0 && textEl.value.trim() !== "");
    clearEl.textContent = say("清空", "Clear");
    clearEl.title = say(
      "导出成功了 —— 清空这张便签？上一版留 24 小时，可以恢复",
      "Exported — clear this note? The previous version stays recoverable for 24 hours.",
    );
  }

  function clearNote() {
    exportedAt = 0;
    textEl.value = "";
    clearNotice();
    updateCount();
    updateClear();
    if (mode === "read") renderPreview();
    // 走 markEdited → 400ms 后 save()，那条路自己会发现"正文被清空"并留一份 backup
    markEdited();
  }

  if (clearEl) clearEl.addEventListener("click", clearNote);

  // ---------- 预览 ----------

  function renderPreview() {
    if (!previewEl) return;
    previewEl.setAttribute("data-empty", say("还没有内容", "Nothing here yet"));
    previewEl.innerHTML = md ? md.render(textEl.value) : "";
    decorateImages();
  }

  function renderMode() {
    var read = mode === "read";
    textEl.hidden = read;
    previewEl.hidden = !read;
    modeEl.textContent = read ? say("编辑", "Edit") : say("预览", "Preview");
    modeEl.setAttribute("aria-pressed", read ? "true" : "false");
    modeEl.setAttribute("aria-label", read ? say("回到编辑", "Back to editing") : say("预览 Markdown", "Preview Markdown"));
    if (read) renderPreview();
  }

  // ---------- 清空之后的退路 ----------

  /** 存档里那条备份能不能用：正文非空、时间是个数、还没过期（24 小时） */
  function normalizeBackup(value) {
    if (!value || typeof value !== "object") return null;
    if (typeof value.text !== "string" || !value.text.trim()) return null;
    if (typeof value.at !== "number" || !isFinite(value.at)) return null;
    if (Date.now() - value.at > 86400000) return null;
    return { text: value.text, at: value.at };
  }

  /**
   * 那颗「恢复」只在"正文是空的、而且还有上一版"的时候出现 ——
   * 正文非空时给它一颗恢复按钮，按下去等于把用户新写的东西删掉。
   */
  function updateRestore() {
    var visible = !!backup && textEl.value.trim() === "";
    restoreEl.hidden = !visible;
    restoreEl.textContent = say("恢复上一版", "Restore");
    restoreEl.title = backup
      ? say("恢复清空之前的文字", "Bring back the text from before you cleared it")
      : "";
  }

  function restore() {
    if (!backup) return;
    textEl.value = backup.text;
    backup = null;
    revision += 1;
    updateCount();
    updateRestore();
    clearNotice();
    clearTimeout(timer);
    // 备份用过就删掉：再留 24 小时只会让「恢复」在下次清空时指向更老的内容
    call("storage.remove", { key: "backup" }).catch(function () {});
    save();
    if (mode === "read") renderPreview();
    else textEl.focus();
  }

  restoreEl.addEventListener("click", restore);

  // ---------- 图片 ----------

  /** 只挑图片文件：拖进来一个 .md 不该被当成图 */
  function imageFilesOf(list) {
    var out = [];
    for (var i = 0; i < (list ? list.length : 0); i += 1) {
      var file = list[i];
      if (file && file.type && file.type.indexOf("image/") === 0) out.push(file);
    }
    return out;
  }

  /** 拖拽经过时 `files` 还是空的（浏览器到 drop 才填），得看 `items` */
  function hasImagePayload(data) {
    if (!data) return false;
    var items = data.items;
    for (var i = 0; i < (items ? items.length : 0); i += 1) {
      var item = items[i];
      if (item.kind === "file" && item.type && item.type.indexOf("image/") === 0) return true;
    }
    return imageFilesOf(data.files).length > 0;
  }

  /** 等比画到 canvas 上。`source` 可以是图片文件解出来的 bitmap，也可以是上一张 canvas */
  function drawScaled(source, maxEdge) {
    var size = imgs.fitSize(source.width, source.height, maxEdge);
    if (!size.width || !size.height) return null;
    var canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    var context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, size.width, size.height);
    return canvas;
  }

  /**
   * 一张 `File` → 一张压好的 data URL。
   *
   * 长边超过 2000 的先降一次采样再压到 480：4K 截图直接压要卡两秒，而这两秒是
   * 主线程（`createImageBitmap` 之后的绘制和编码都在这里）。
   */
  function compressImage(file) {
    return createImageBitmap(file).then(function (bitmap) {
      var source = bitmap;
      if (Math.max(bitmap.width, bitmap.height) > imgs.PRE_DOWNSCALE) {
        var middle = drawScaled(bitmap, imgs.PRE_DOWNSCALE);
        if (middle) source = middle;
      }
      var canvas = drawScaled(source, imgs.LONG_EDGE);
      if (bitmap.close) bitmap.close();
      if (!canvas) throw new Error("the image could not be drawn");
      var url = canvas.toDataURL("image/webp", imgs.QUALITY);
      if (url.indexOf("data:image/webp") !== 0) {
        // 浏览器不支持 WebP 编码（老 Chromium）：退 JPEG。导出时扩展名跟着变 .jpg
        url = canvas.toDataURL("image/jpeg", imgs.QUALITY);
      }
      return { url: url, width: canvas.width, height: canvas.height, bytes: imgs.dataUrlBytes(url) };
    });
  }

  /** 把一张图接在光标处（前后各补一个换行，光标落到图片下一行） */
  function insertImage(image) {
    var start = typeof textEl.selectionStart === "number" ? textEl.selectionStart : textEl.value.length;
    var end = typeof textEl.selectionEnd === "number" ? textEl.selectionEnd : start;
    var before = textEl.value.slice(0, start);
    var token =
      (before && before.slice(-1) !== "\n" ? "\n" : "") +
      "![](" +
      image.url +
      "){width=" +
      image.width +
      "}\n";
    textEl.setRangeText(token, start, end, "end");
    markEdited();
    textEl.focus();
  }

  /**
   * 一张一张地压、一张一张地插，**能进几张就进几张**。
   *
   * 0.3.0 是一票否决：粘 3 张、便签里已有 6 张 → 三张全不进，用户还得自己算还剩几张。
   * 现在每张单独问 `imgs.admit()`，最后说一句"收下 2 张，1 张没进（合计到 1MB）"。
   *
   * 判据只有一处（`admit`），这里只负责数：进了几张、每张为什么没进。
   */
  function addImages(files) {
    var picked = imageFilesOf(files);
    if (!picked.length) return;
    setStatus("imageWorking", "");
    var added = 0;
    var rejected = { full: 0, countFull: 0, tooBig: 0, broken: 0 };

    var chain = Promise.resolve();
    picked.forEach(function (file) {
      chain = chain.then(function () {
        return compressImage(file)
          .then(function (image) {
            var verdict = imgs.admit(textEl.value, image.bytes);
            if (verdict !== "ok") {
              rejected[verdict] += 1;
              return;
            }
            insertImage(image);
            added += 1;
          })
          .catch(function () {
            rejected.broken += 1;
          });
      });
    });

    chain.then(function () {
      reportAdmission(added, rejected);
    });
  }

  /**
   * 一批处理完之后说一句话。
   *
   * 三种结局：全进（什么都不说，保存状态机会说"已保存"）、全没进（说清撞的是哪一道
   * 墙）、进了一半（两件事都得说）。后两种都写进 `notice` —— 直接写状态行的话，
   * 400ms 后那次自动保存会把这句话盖成「已保存」。
   */
  function reportAdmission(added, rejected) {
    var total = rejected.full + rejected.countFull + rejected.tooBig + rejected.broken;
    if (!total) {
      // 一张都没被拒：把「处理图片…」收掉，剩下的交给保存状态机
      if (statusKey === "imageWorking") setStatus("saved", "saved");
      return;
    }

    var reason = dominantReason(rejected);
    var oversized = reason === "tooBig" || reason === "broken";

    if (!added) {
      var key =
        reason === "full"
          ? "noteFull"
          : reason === "countFull"
            ? "imageLimit"
            : reason === "broken"
              ? "imageBroken"
              : reason === "tooBig"
                ? "imageTooBig"
                : "imageRefused";
      setNotice(key, null, "error", nextStepHint(oversized));
      return;
    }

    setNotice("imagePartial", { added: added, rejected: total, reason: reason }, "error", nextStepHint(oversized));
  }

  /** 拒收之后该干什么。撞容量和撞单张是两件不同的事，指错路比不指更糟 */
  function nextStepHint(oversized) {
    if (oversized) {
      return say(
        "这张图本身太大或者读不了，换一张、或者先截小一点再贴。",
        "That image is too big or unreadable — try another one, or crop it first.",
      );
    }
    return say(
      "先「导出」再「清空」，或者换一张便签。压完的图只算这一份的 1MB。",
      "Export, then Clear — or use another note. Squeezed images only count against this note's 1 MB.",
    );
  }

  /** 拒收的原因里最多的是哪一个；两种以上打平就算 mixed（别挑一个假的当代表） */
  function dominantReason(rejected) {
    var keys = Object.keys(rejected).filter(function (key) {
      return rejected[key] > 0;
    });
    if (keys.length === 1) return keys[0];
    var best = keys[0];
    var tied = false;
    for (var i = 1; i < keys.length; i += 1) {
      if (rejected[keys[i]] > rejected[best]) {
        best = keys[i];
        tied = false;
      } else if (rejected[keys[i]] === rejected[best]) {
        tied = true;
      }
    }
    return tied ? "mixed" : best;
  }

  /**
   * 预览里的每张内联图右下角挂一颗三档按钮。
   *
   * 点一下改的是**源文本**里的 `{width=N}`（不是 DOM 的 style）—— 否则下次渲染、
   * 下次重开就回到原样了。序号按出现顺序，和 `note-images.js` 的 `cycleWidth` 对齐。
   */
  function bindImage(img) {
    var index = Number(img.getAttribute("data-note-index"));
    if (!isFinite(index)) return; // 相对路径 / blob: 的外部图不给宽度按钮

    var wrap = document.createElement("span");
    wrap.className = "note-img-wrap";
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);

    var button = document.createElement("button");
    button.type = "button";
    button.className = "note-img-size";
    wrap.appendChild(button);

    function label() {
      var natural = img.naturalWidth || 0;
      var shown = Number(img.getAttribute("width")) || natural;
      var percent = imgs.widthPercent(shown, natural);
      button.textContent = percent + "%";
      button.title = say("点一下换宽度：100% → 25% → 50%", "Click to cycle the width: 100% → 25% → 50%");
      button.setAttribute("aria-label", say("图片宽度 " + percent + "%", "Image width " + percent + "%"));
    }

    button.addEventListener("click", function () {
      var natural = img.naturalWidth || Number(img.getAttribute("width")) || 0;
      var next = imgs.cycleWidth(textEl.value, index, natural);
      if (next.text === textEl.value) return;
      textEl.value = next.text;
      markEdited();
      renderPreview();
    });

    img.addEventListener("load", label);
    label();
  }

  function decorateImages() {
    if (!previewEl) return;
    var list = previewEl.querySelectorAll("img.md-img");
    for (var i = 0; i < list.length; i += 1) bindImage(list[i]);
  }

  /*
   * 进来只有两条路：粘贴、拖入。
   *
   * **只接 `textarea` 的 paste**：接在 `document` 上时，桌面窗口那套焦点/z 序会让
   * 一些粘贴被吞掉（design/0028 §5）。拖入接在整张卡片上，并且 `preventDefault`
   * —— 不拦的话浏览器会把图片当成一次导航（"打开这个文件"），卡片当场变成一个
   * 预览窗口，便签还在，但用户刚才在看的东西没了。
   */
  textEl.addEventListener("paste", function (event) {
    var data = event.clipboardData;
    if (!data || !imageFilesOf(data.files).length) return;
    event.preventDefault();
    addImages(data.files);
  });

  document.addEventListener("dragover", function (event) {
    if (hasImagePayload(event.dataTransfer)) event.preventDefault();
  });

  document.addEventListener("drop", function (event) {
    if (!hasImagePayload(event.dataTransfer)) return;
    event.preventDefault();
    addImages(event.dataTransfer.files);
  });

  // ---------- 导出 ----------

  var exporting = false;

  /** 按格式挑那一份计划。三条路都在 `note-images.js` 里，这里只做选择 */
  function planFor(format) {
    var now = new Date();
    var prefix = say("便签", "Note");
    if (format === "html") {
      return imgs.htmlPlan(textEl.value, now, prefix, function (source) {
        // `true` = 按独立文档渲染：真链接、不带预览用的 `data-note-index`
        return md ? md.render(source, true) : "";
      }, lang);
    }
    if (format === "zip") return imgs.exportPlan(textEl.value, now, prefix);
    return imgs.inlinePlan(textEl.value, now, prefix);
  }

  /**
   * 把便签交给平台的保存框。
   *
   * `format` 决定的是**交出去的那一份文档长什么样**（自包含 .md / zip / 单文件
   * .html），由底栏那个菜单选；平台只看它来补扩展名和挑对话框的过滤器。
   *
   * 三件事都在这儿：切分（三个 `*Plan`）、缺权限时说清是哪一项、**取消时一句话
   * 都不说**（把状态行还原成点导出之前的样子）。
   *
   * 成功之后除了说「已导出」，还要让底栏那颗「清空」出现 —— 导出不动正文，
   * 而"导出完不敢删"正是这张便签最后撞上 1MB 的来路。
   */
  function exportNote(format) {
    if (exporting) return;
    // 空便签不导：判据是正文，不是"计划里那份文件"—— 一份 html 的壳子永远不空
    if (!textEl.value.trim()) {
      setStatus("exportEmpty", "");
      return;
    }
    var plan = planFor(format);
    exporting = true;
    var before = { key: statusKey, kind: statusKind };
    setStatus("exportWorking", "");
    call("file.save", { name: plan.baseName, format: plan.format, files: plan.files })
      .then(function (result) {
        exporting = false;
        if (result && result.ok) {
          exportedAt = Date.now();
          setNotice("exportDone", null, "saved", say(
            "已导出到 " + (result.path || "") + " —— 要清空这张便签的话，底栏那颗「清空」上一版留 24 小时",
            "Saved to " + (result.path || "") + " — the Clear button in the footer keeps the previous version for 24 hours",
          ));
          updateClear();
          return;
        }
        // 用户点了取消：不是错误，也不留一句话
        setStatus(before.key, before.kind);
      })
      .catch(function (error) {
        exporting = false;
        setStatus(error.code === "permission_denied" ? "exportDenied" : "exportFailed", "error");
      });
  }

  /*
   * 底栏那颗「导出」开菜单，不直接导出 —— 它现在是三个动作。
   *
   * 关菜单的三条路：选了其中一项、点了别处、按了 Esc。少一条就会留下一个
   * 挡住正文的浮层（卡片只有 200px 高，菜单占掉三分之一）。
   */
  if (exportEl) {
    exportEl.addEventListener("click", function (event) {
      event.stopPropagation();
      setMenu(!menuOpen());
    });
  }

  for (var menuIndex = 0; menuIndex < menuItems.length; menuIndex += 1) {
    menuItems[menuIndex].addEventListener("click", function (event) {
      event.stopPropagation();
      var format = this.getAttribute("data-format");
      setMenu(false);
      exportNote(format);
    });
  }

  document.addEventListener("click", function () {
    setMenu(false);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") setMenu(false);
  });

  // ---------- 保存 ----------

  /**
   * 正文改过了：更新字数、恢复条，并把"停手 400ms 就落盘"这条计时重新起一遍。
   *
   * 输入框的 `input`、插入图片、预览里改宽度都走这一个入口 —— 三条路各写一遍的话，
   * 迟早有一条忘了 `revision` 或忘了清计时器。
   */
  function markEdited() {
    revision += 1;
    updateCount();
    updateRestore();
    // 改过字之后，「清空」这颗按钮收起来：屏幕上的东西已经不是刚导出的那一份了
    exportedAt = 0;
    updateClear();
    // 正在保存时别把"保存中…"改回"未保存"，那会让人以为存完了又退回
    if (!saving) setStatus("unsaved", "");
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  }

  function save() {
    // 上一次还没回来就什么都不做：它回来时会发现 revision 更大，自己再存一次
    if (saving || saved >= revision) return;
    saving = true;
    var target = revision;
    var value = textEl.value;
    /*
     * 清空检测：正文被删光、而磁盘上还有一段非空的内容 —— 这就是"手滑"。
     * 先把上一版存进 backup，再写空的正文；顺序反过来的话，中间那一刻
     * 断电就两样都没了。
     *
     * 只在还没有备份时记录：连清两次不该把第一次的备份冲掉。
     */
    var wiped = value.trim() === "" && typeof lastSaved === "string" && lastSaved.trim() !== "" && !backup;
    setStatus("saving", "");
    var chain = Promise.resolve();
    if (wiped) {
      backup = { text: lastSaved, at: Date.now() };
      chain = call("storage.set", { key: "backup", value: backup }).catch(function () {
        /* 备份写不进去不该拦住正文的保存 */
      });
      updateRestore();
    }
    chain
      .then(function () {
        return call("storage.set", { key: "text", value: value });
      })
      .then(function () {
        lastSaved = value;
        saved = target;
        saving = false;
        updateRestore();
        if (revision > saved) {
          save();
          return;
        }
        setStatus("saved", "saved");
      })
      .catch(function (error) {
        saving = false;
        setStatus(error.code === "permission_denied" ? "noPermission" : "saveFailed", "error");
      });
  }

  // 真敲键盘才收掉那条 notice（"刚才那张图没进"到这个字为止就算过去了）
  textEl.addEventListener("input", function () {
    clearNotice();
    markEdited();
  });

  // 失焦立刻落盘，避免用户切走时最后 400ms 的输入丢掉
  textEl.addEventListener("blur", function () {
    clearTimeout(timer);
    save();
  });

  modeEl.addEventListener("click", function () {
    mode = mode === "read" ? "write" : "read";
    renderMode();
    if (mode === "write") textEl.focus();
  });

  /**
   * 别的实例改了这份便签，重读一次。
   *
   * 什么时候不重读（本地优先，和保存状态机是同一套优先级）：
   *   - 还有没落盘的输入（revision > saved）：用户正在写，磁盘上的不能盖过来
   *   - 光标就在输入框里：同上，哪怕刚好存完了也别在人家打字时换内容
   */
  function reloadText() {
    if (revision > saved) return;
    if (document.activeElement === textEl) return;
    call("storage.get", { key: "text" })
      .then(function (value) {
        if (revision > saved) return;
        if (typeof value !== "string") return;
        if (value === textEl.value) return;
        textEl.value = value;
        lastSaved = value;
        updateCount();
        updateRestore();
        updateClear();
        if (mode === "read") renderPreview();
        setStatus("saved", "saved");
      })
      .catch(function () {});
  }

  /** 备份可能是别的实例刚留下的：它一出现，「恢复」就该跟着出现 */
  function reloadBackup() {
    call("storage.get", { key: "backup" })
      .then(function (value) {
        var next = normalizeBackup(value);
        if (backup && next && backup.at === next.at) return;
        backup = next;
        updateRestore();
      })
      .catch(function () {});
  }

  // 窗口被收走 / 页面隐藏时补一次。postMessage 是异步的，不保证一定送达，
  // 但比干等那 400ms 定时器强
  function flush() {
    if (revision <= saved) return;
    clearTimeout(timer);
    save();
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住读盘和首屏
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画 */
    });

  call("storage.get", { key: "text" })
    .then(function (value) {
      if (revision > 0) {
        // 用户在这几十毫秒里已经开始打字了：磁盘上的旧内容优先级最低
        updateCount();
        setStatus("unsaved", "");
        return;
      }
      if (typeof value === "string") {
        textEl.value = value;
        lastSaved = value;
      } else {
        lastSaved = "";
      }
      updateCount();
      setStatus("saved", "saved");
    })
    .catch(function (error) {
      if (revision > 0) return;
      updateCount();
      setStatus(error.code === "permission_denied" ? "noPermission" : "loadFailed", "error");
    })
    .then(function () {
      updateRestore();
      return call("storage.get", { key: "backup" });
    })
    .then(function (value) {
      var next = normalizeBackup(value);
      if (!next && value) {
        // 过期或坏掉的备份不该永远躺在盘上
        call("storage.remove", { key: "backup" }).catch(function () {});
      }
      backup = next;
      updateRestore();
    })
    .catch(function () {
      /* 没有备份是常态 */
    })
    .then(function () {
      renderMode();
      updateExportLabel();
      updateMenu();
      updateClear();
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
