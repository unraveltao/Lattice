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
 *    自己就是可导出的 Markdown，不需要第二个存储键。上限：单张 120KB / 共 1MB /
 *    8 张，超了拒绝并说清楚（悄悄丢一张比拒绝糟得多）。
 *  - **缩小只在预览态做**：图片右下角那颗按钮循环 25% / 50% / 100%，改的是源文本
 *    里的 `{width=N}`，不是 DOM 上的样式 —— 否则下次渲染就回去了。
 *  - **导出**走桥的 `file.save`（权限 `file:save`）：把 data URL 抽成 `images/N`,
 *    `{width=N}` 改写成 `<img width>`，一次交给平台弹保存框。用户取消时一句话都
 *    不说 —— 把"我不想存了"画成红字是这个仓库反复踩过的坑。
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
    setStatus(statusKey, statusKind);
    // 预览按钮、恢复按钮、导出按钮、空预览的提示语都跟语言有关
    renderMode();
    updateRestore();
    updateExportLabel();
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
    imageLimit: function () {
      return say("最多 8 张图", "At most 8 images");
    },
    noteFull: function () {
      return say("图片总量到 1MB 了", "Images have reached 1 MB");
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

  function setStatus(key, kind) {
    statusKey = key;
    statusKind = kind || "";
    var text = STATUS_TEXT[key]();
    statusEl.textContent = text;
    statusEl.className = statusKind ? "is-" + statusKind : "";
    // 状态条只有 140px 宽（右边 120px 留给窗饰），长文案会被省略号截掉；
    // 截掉了才挂 title，没截就别挂 —— 不然"Saved"上也会凭空弹出个提示
    if (statusEl.scrollWidth > statusEl.clientWidth) statusEl.title = text;
    else statusEl.removeAttribute("title");
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
    exportEl.title = say(
      "把正文和图片导出成 Markdown 或 zip",
      "Export the note and its images as Markdown or a zip",
    );
  }

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
   * 一张一张地压、一张一张地插。
   *
   * 三条上限都在这里判：单张压完 ≤ 120KB、整张便签 ≤ 1MB、最多 8 张。任何一条
   * 越界都**停下并说明** —— 悄悄丢掉一张图，用户只会以为"贴失败了"。
   */
  function addImages(files) {
    var picked = imageFilesOf(files);
    if (!picked.length) return;
    if (imgs.imageCount(textEl.value) + picked.length > imgs.MAX_IMAGES) {
      setStatus("imageLimit", "error");
      return;
    }
    setStatus("imageWorking", "");
    var chain = Promise.resolve();
    picked.forEach(function (file) {
      chain = chain.then(function () {
        return compressImage(file)
          .then(function (image) {
            if (image.bytes > imgs.MAX_IMAGE_BYTES) {
              setStatus("imageTooBig", "error");
              return;
            }
            if (imgs.totalImageBytes(textEl.value) + image.bytes > imgs.MAX_TOTAL_BYTES) {
              setStatus("noteFull", "error");
              return;
            }
            insertImage(image);
          })
          .catch(function () {
            setStatus("imageBroken", "error");
          });
      });
    });
    chain.then(function () {
      // 插进去的图会触发一次保存（`markEdited`），状态行交给保存状态机；
      // 一张都没插进去时才把「处理图片…」收掉
      if (statusKey === "imageWorking") setStatus("saved", "saved");
    });
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

  /**
   * 把便签交给平台的保存框：正文 + 每张图各一个文件（多文件 → 平台打 zip）。
   *
   * 三件事都在这儿：切分（`imgs.exportPlan`）、缺权限时说清是哪一项、**取消时
   * 一句话都不说**（把状态行还原成点导出之前的样子）。
   */
  function exportNote() {
    if (exporting) return;
    var plan = imgs.exportPlan(textEl.value, new Date(), say("便签", "Note"));
    if (!plan.files[0].text.trim()) {
      setStatus("exportEmpty", "");
      return;
    }
    exporting = true;
    var before = { key: statusKey, kind: statusKind };
    setStatus("exportWorking", "");
    call("file.save", { name: plan.baseName, files: plan.files })
      .then(function (result) {
        exporting = false;
        if (result && result.ok) {
          setStatus("exportDone", "saved");
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

  if (exportEl) exportEl.addEventListener("click", exportNote);

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

  textEl.addEventListener("input", markEdited);

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
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
