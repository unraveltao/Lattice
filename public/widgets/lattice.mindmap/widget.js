/**
 * 思维导图组件
 *
 * 树是数据，位置是算出来的（见 `mindmap-core.js` 与 0022）。这一层只管 DOM、
 * 键盘、手势、撤销栈、剪贴板和桥。
 *
 * # 两条从 diagram 抄来的规矩
 *
 * **读失败 ≠ 没有数据**：`storage.get` 回 `null` 才是"这台机器上还没有图"，
 * 可以种一份空的并落盘；reject（权限被拒 / IPC 挂了）只把界面标成"没读到"，
 * **一个字节都不写** —— 否则用户的图会被一张空图顶掉。
 *
 * **有未落盘改动时先不重读**：两个宿主（画布一个、桌面窗口一个）各持一份内存
 * 副本，`store-changed` 一到就重读的话，正在这边打字的人会被另一边拽回去。
 *
 * # 键盘是两态
 *
 * 编辑态（textarea 里）：`Enter` 提交并加兄弟、`Tab` 提交并加子节点、`Esc` 退出。
 * 选中态：方向键走树、`Shift+Tab` 提一级、`Alt+↑↓` 换位置、`Delete` 删子树、`F2` 改名。
 * 编辑态里**输入法 composition 期间不响应** `Enter` / `Tab` —— 否则中文选词按回车
 * 会多出一个空节点（0022 §5）。
 */
(function () {
  "use strict";

  var C = window.__latticeMindmapCore;
  var KEY = "mindmap";
  var UNDO_LIMIT = 50;
  var SAVE_DELAY = 400;
  var FLASH_MS = 1800;
  var NS = "http://www.w3.org/2000/svg";
  var READ_OUTLINE_LIMIT = 3500;

  // ---------------------------------------------------------------------------
  // 桥
  // ---------------------------------------------------------------------------

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
        var error = new Error("Bridge call timed out: " + method);
        error.code = "timeout";
        reject(error);
      }, 3000);
    });
  }

  // ---------------------------------------------------------------------------
  // 文案（英文是主键，中文是另一门）
  // ---------------------------------------------------------------------------

  var TEXT = {
    en: {
      empty: "An empty map — one line is enough.",
      start: "Start a map",
      untitled: "Untitled",
      nodes: function (n) {
        return n === 1 ? "1 node" : n + " nodes";
      },
      saved: "Saved",
      saving: "Saving…",
      unsaved: "Not saved",
      unreadable: "Could not read the saved map",
      copied: "Copied",
      copyFailed: "Could not copy: the clipboard permission is off",
      copyFailedPlain: "Could not copy",
      undo: "Undo",
      redo: "Redo",
      fit: "Fit to window",
      markdown: "Copy as Markdown outline",
      mermaid: "Copy as Mermaid",
      opml: "Copy as OPML",
      deeper: "deeper",
    },
    zh: {
      empty: "空图 —— 一行字就够开始了。",
      start: "建一张图",
      untitled: "未命名",
      nodes: function (n) {
        return n + " 个节点";
      },
      saved: "已保存",
      saving: "保存中…",
      unsaved: "未保存",
      unreadable: "读不出已保存的图",
      copied: "已复制",
      copyFailed: "没复制成功：剪贴板权限没开",
      copyFailedPlain: "没复制成功",
      undo: "撤销",
      redo: "重做",
      fit: "适应窗口",
      markdown: "复制成 Markdown 大纲",
      mermaid: "复制成 Mermaid",
      opml: "复制成 OPML",
      deeper: "更深",
    },
  };

  var lang = "en";
  function t(key) {
    var table = TEXT[lang] || TEXT.en;
    return table[key] != null ? table[key] : TEXT.en[key];
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  var doc = C.emptyDoc();
  var selectedId = null;
  var editingId = null;
  var composing = false;
  var layoutResult = C.layout(null);
  var undoStack = [];
  var redoStack = [];
  var dirty = false;
  var saving = false;
  var saveAgain = false;
  var saveTimer = 0;
  var storageDenied = false;
  var unreadable = false;
  var reloadAfterSave = false;
  var config = { hideExports: false };
  var flashText = "";
  var flashBad = false;
  var flashGood = false;
  var flashTimer = 0;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  var stage = document.getElementById("stage");
  var viewport = document.getElementById("viewport");
  var linkLayer = document.getElementById("links");
  var nodeLayer = document.getElementById("nodes");
  var editor = document.getElementById("editor");
  var emptyBox = document.getElementById("empty");
  var emptyText = document.getElementById("empty-text");
  var startBtn = document.getElementById("start");
  var stateEl = document.getElementById("state");
  var zoomEl = document.getElementById("zoom");
  var barEl = document.getElementById("bar");
  var undoBtn = document.getElementById("undo");
  var redoBtn = document.getElementById("redo");

  var nodeEls = {};
  var linkEls = {};

  function el(name) {
    return document.createElementNS(NS, name);
  }

  // ---------------------------------------------------------------------------
  // 测量（布局需要，纯逻辑里不碰 DOM）
  // ---------------------------------------------------------------------------

  var measureCtx = document.createElement("canvas").getContext("2d");

  function measure(text) {
    measureCtx.font = "13px " + (getComputedStyle(document.body).fontFamily || "system-ui, sans-serif");
    return measureCtx.measureText(text || " ").width;
  }

  // ---------------------------------------------------------------------------
  // 主题 / 语言 / 配置
  // ---------------------------------------------------------------------------

  function applyTheme(tokens) {
    if (!tokens) return;
    Object.keys(tokens).forEach(function (name) {
      if (tokens[name]) document.documentElement.style.setProperty(name, tokens[name]);
    });
  }

  function applyLanguage(payload) {
    lang = payload && payload.lang === "zh" ? "zh" : "en";
    document.title = lang === "zh" ? "思维导图" : "Mind map";
    emptyText.textContent = t("empty");
    startBtn.textContent = t("start");
    undoBtn.title = t("undo");
    redoBtn.title = t("redo");
    document.getElementById("fit").title = t("fit");
    document.getElementById("copy-markdown").title = t("markdown");
    document.getElementById("copy-mermaid").title = t("mermaid");
    document.getElementById("copy-opml").title = t("opml");
    syncScene();
  }

  function applyConfig(raw) {
    config.hideExports = !!(raw && raw.hideExports === true);
    // 可见性只有一处判据：开关**和**数据同时看 —— 只写 `!开关` 会让"有没有图"
    // 这一半在 config-changed 来的时候被抹掉（它会来两次：get 一次、推送一次）
    syncChrome();
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  /** 显示用的文字：按宽度截断，末尾补省略号。**导出永远不用它** */
  function displayText(text, width) {
    var source = text || "";
    if (!source) return "";
    if (measure(source) <= width) return source;
    var chars = C.points(source);
    while (chars.length > 1) {
      chars.pop();
      var candidate = chars.join("") + "…";
      if (measure(candidate) <= width) return candidate;
    }
    return "…";
  }

  function createNodeEl() {
    var group = el("g");
    group.setAttribute("class", "mm-node");
    group.appendChild(el("rect")).setAttribute("class", "shape");
    group.appendChild(el("rect")).setAttribute("class", "dot");
    group.appendChild(el("text"));
    group.appendChild(el("text")).setAttribute("class", "mm-badge");
    var title = el("title");
    group.appendChild(title);
    return group;
  }

  function paintNode(group, node) {
    group.setAttribute("data-id", node.id);
    group.setAttribute("data-tone", node.tone);
    group.setAttribute("data-depth", String(node.depth));
    group.classList.toggle("is-selected", selectedId === node.id);

    var width = node.w;
    var height = node.h;
    var shape = group.querySelector(".shape");
    shape.setAttribute("x", String(node.x));
    shape.setAttribute("y", String(node.y));
    shape.setAttribute("width", String(width));
    shape.setAttribute("height", String(height));
    shape.setAttribute("rx", "6");

    // 左边一点强调色，让"哪一层"看得出来（不靠改字号，字号只有五档）
    var dot = group.querySelector(".dot");
    var dotSize = node.depth === 0 ? 4 : 3;
    dot.setAttribute("x", String(node.x + 3));
    dot.setAttribute("y", String(node.center - dotSize / 2));
    dot.setAttribute("width", String(dotSize));
    dot.setAttribute("height", String(dotSize));
    dot.setAttribute("rx", String(dotSize / 2));

    var text = group.querySelector("text");
    text.setAttribute("x", String(node.x + 11));
    text.setAttribute("y", String(node.center));
    text.setAttribute("text-anchor", "start");
    var words = displayText(node.text, width - 14);
    var placeholder = !node.text;
    text.textContent = placeholder ? t("untitled") : words;
    text.classList.toggle("is-placeholder", placeholder);

    var badge = group.querySelector(".mm-badge");
    if (node.hidden > 0) {
      badge.textContent = "+" + node.hidden;
      badge.setAttribute("x", String(node.x + width + 5));
      badge.setAttribute("y", String(node.center));
      badge.setAttribute("visibility", "visible");
    } else {
      badge.setAttribute("visibility", "hidden");
    }

    group.querySelector("title").textContent = node.text || t("untitled");
  }

  function syncScene() {
    layoutResult = C.layout(doc.root, { measure: measure });

    var view = doc.view;
    viewport.setAttribute(
      "transform",
      "translate(" + view.x + " " + view.y + ") scale(" + view.zoom + ")",
    );

    var seen = {};
    for (var i = 0; i < layoutResult.nodes.length; i += 1) {
      var node = layoutResult.nodes[i];
      seen[node.id] = true;
      var group = nodeEls[node.id];
      if (!group) {
        group = createNodeEl();
        nodeEls[node.id] = group;
        nodeLayer.appendChild(group);
      }
      paintNode(group, node);
    }
    Object.keys(nodeEls).forEach(function (id) {
      if (seen[id]) return;
      nodeLayer.removeChild(nodeEls[id]);
      delete nodeEls[id];
    });

    var seenLinks = {};
    for (var j = 0; j < layoutResult.links.length; j += 1) {
      var link = layoutResult.links[j];
      var key = link.from + ">" + link.to;
      seenLinks[key] = true;
      var path = linkEls[key];
      if (!path) {
        path = el("path");
        path.setAttribute("class", "mm-link");
        linkEls[key] = path;
        linkLayer.appendChild(path);
      }
      path.setAttribute("d", link.d);
    }
    Object.keys(linkEls).forEach(function (key) {
      if (seenLinks[key]) return;
      linkLayer.removeChild(linkEls[key]);
      delete linkEls[key];
    });

    zoomEl.textContent = Math.round(view.zoom * 100) + "%";
    syncChrome();
  }

  /** 所有"跟数据和开关都有关"的可见性：只在这里判一次 */
  function syncChrome() {
    var hasRoot = !!doc.root;
    emptyBox.hidden = hasRoot;
    barEl.setAttribute("data-empty", hasRoot ? "false" : "true");
    var hideCopy = !hasRoot || config.hideExports;
    ["copy-markdown", "copy-mermaid", "copy-opml"].forEach(function (id) {
      document.getElementById(id).hidden = hideCopy;
    });
    syncStatus();
    syncButtons();
  }

  function syncButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function syncStatus() {
    var text = "";
    var bad = false;
    var good = false;
    if (flashText) {
      text = flashText;
      bad = flashBad;
      good = flashGood;
    } else if (unreadable) {
      text = t("unreadable");
      bad = true;
    } else if (storageDenied) {
      text = t("unsaved");
      bad = true;
    } else if (!doc.root) {
      text = "";
    } else {
      var count = C.countNodes(doc.root);
      text = t("nodes")(count);
      if (dirty) {
        text += " · " + t("unsaved");
      } else if (saving) {
        text += " · " + t("saving");
      }
    }
    stateEl.textContent = text;
    stateEl.setAttribute("data-bad", bad ? "true" : "false");
    stateEl.setAttribute("data-good", good ? "true" : "false");
  }

  function flash(text, bad, good) {
    flashText = text;
    flashBad = !!bad;
    flashGood = !!good;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      flashText = "";
      flashBad = false;
      flashGood = false;
      syncStatus();
    }, FLASH_MS);
    syncStatus();
  }

  function select(id) {
    selectedId = id;
    if (id) ensureVisible(id);
    syncScene();
  }

  /** 把某个节点滚回视野（不是整张 fit —— 那会把用户刚缩放的比例扔掉） */
  function ensureVisible(id) {
    var node = null;
    for (var i = 0; i < layoutResult.nodes.length; i += 1) {
      if (layoutResult.nodes[i].id === id) node = layoutResult.nodes[i];
    }
    if (!node) return;
    var zoom = doc.view.zoom;
    var width = stage.clientWidth;
    var height = stage.clientHeight;
    if (!width || !height) return;
    var left = node.x * zoom + doc.view.x;
    var top = node.y * zoom + doc.view.y;
    var right = left + node.w * zoom;
    var bottom = top + node.h * zoom;
    var pad = 12;
    var dx = 0;
    var dy = 0;
    if (left < pad) dx = pad - left;
    else if (right > width - pad) dx = width - pad - right;
    if (top < pad) dy = pad - top;
    else if (bottom > height - pad) dy = height - pad - bottom;
    if (!dx && !dy) return;
    doc.view = { x: doc.view.x + dx, y: doc.view.y + dy, zoom: zoom };
  }

  // ---------------------------------------------------------------------------
  // 撤销
  // ---------------------------------------------------------------------------

  function pushUndo(snapshot) {
    undoStack.push(C.cloneDoc(snapshot));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    syncButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(C.cloneDoc(doc));
    doc = undoStack.pop();
    selectedId = C.findNode(doc.root, selectedId) ? selectedId : (doc.root ? doc.root.id : null);
    syncScene();
    save();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(C.cloneDoc(doc));
    doc = redoStack.pop();
    selectedId = C.findNode(doc.root, selectedId) ? selectedId : (doc.root ? doc.root.id : null);
    syncScene();
    save();
  }

  // ---------------------------------------------------------------------------
  // 落盘
  // ---------------------------------------------------------------------------

  function save() {
    dirty = true;
    syncStatus();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (saving) {
      saveAgain = true;
      return;
    }
    saving = true;
    syncStatus();
    var payload = C.cloneDoc(doc);
    call("storage.set", { key: KEY, value: payload })
      .then(function () {
        storageDenied = false;
        dirty = false;
        if (reloadAfterSave) {
          reloadAfterSave = false;
          reload(false);
          return;
        }
        syncStatus();
      })
      .catch(function (error) {
        storageDenied = !error || error.code === "permission_denied";
        syncStatus();
      })
      .then(function () {
        saving = false;
        if (saveAgain) {
          saveAgain = false;
          saveNow();
        } else {
          syncStatus();
        }
      });
  }

  function reload(initial) {
    call("storage.get", { key: KEY })
      .then(function (value) {
        var read = C.normalizeDoc(value);
        var hadView = !!(value && value.view && typeof value.view === "object" && isFinite(value.view.zoom));
        storageDenied = false;
        if (!read.trusted) {
          // 结构不认识：说清楚，但**绝不**写回去
          unreadable = true;
          syncScene();
          return;
        }
        unreadable = false;
        doc = read.doc;
        selectedId = doc.root ? doc.root.id : null;
        syncScene();
        if (!hadView && doc.root) {
          doc.view = C.fitView(layoutResult.bounds, stage.clientWidth, stage.clientHeight);
          syncScene();
        }
        // 盘上真没有：种一份空的，让"第一次打开"和"删光了"看起来一样
        if (value == null && !dirty) saveNow();
        if (initial) ensureVisible(selectedId);
      })
      .catch(function (error) {
        storageDenied = !error || error.code === "permission_denied" || error.code === "internal";
        syncScene();
      });
  }

  // ---------------------------------------------------------------------------
  // 手势：点选 / 平移 / 缩放
  // ---------------------------------------------------------------------------

  var gesture = null;

  function localPoint(event) {
    var rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event) {
    // 编辑框和空态那层都长在 stage 里，**点它们不是点画布**。少了这一句有两处
    // 会当场坏（都是真机才看得出来的，桩里点不出来）：
    //   1. `setPointerCapture` 会把 `pointerup` 从按钮手里抢到 stage，于是浏览器
    //      把 `click` 派给 stage —— 按钮的 click 处理器永远收不到，空卡片上那颗
    //      「建一张图」按下去没反应（pointerdown 在按钮上、pointerup 在 stage、
    //      click 在 stage，三段目标不一致就是证据）。
    //   2. 点自己正在打字的输入框会先 `commitEdit()`，编辑框当场关掉、光标放不进去。
    var target = event.target;
    if (target && target.closest && target.closest(".mm-edit, .mm-empty")) return;
    if (editingId) commitEdit();
    if (event.button !== 0 && event.button !== 1) return;
    var point = localPoint(event);
    var hit = C.hitTest(layoutResult, doc.view, point.x, point.y);
    if (hit.kind === "node") {
      select(hit.id);
      return;
    }
    selectedId = null;
    syncScene();
    gesture = { sx: point.x, sy: point.y, view: { x: doc.view.x, y: doc.view.y } };
    stage.classList.add("is-panning");
    stage.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!gesture) return;
    var point = localPoint(event);
    doc.view = {
      x: gesture.view.x + (point.x - gesture.sx),
      y: gesture.view.y + (point.y - gesture.sy),
      zoom: doc.view.zoom,
    };
    syncScene();
  }

  function onPointerUp() {
    if (!gesture) return;
    gesture = null;
    stage.classList.remove("is-panning");
    save();
  }

  function onWheel(event) {
    event.preventDefault();
    var point = localPoint(event);
    if (event.ctrlKey || event.metaKey) {
      var factor = Math.exp(-event.deltaY / 320);
      doc.view = C.zoomAt(doc.view, point.x, point.y, doc.view.zoom * factor);
    } else {
      doc.view = {
        x: doc.view.x - event.deltaX,
        y: doc.view.y - event.deltaY,
        zoom: doc.view.zoom,
      };
    }
    syncScene();
    save();
  }

  function onDoubleClick(event) {
    var point = localPoint(event);
    var hit = C.hitTest(layoutResult, doc.view, point.x, point.y);
    if (hit.kind === "node") startEdit(hit.id);
  }

  // ---------------------------------------------------------------------------
  // 编辑
  // ---------------------------------------------------------------------------

  function nodeOf(id) {
    return C.findNode(doc.root, id);
  }

  function startEdit(id) {
    var node = nodeOf(id);
    if (!node) return;
    editingId = id;
    var spot = null;
    for (var i = 0; i < layoutResult.nodes.length; i += 1) {
      if (layoutResult.nodes[i].id === id) spot = layoutResult.nodes[i];
    }
    if (!spot) return;
    var zoom = doc.view.zoom;
    editor.hidden = false;
    editor.value = node.text;
    // 位置跟着视图走，但字号固定在 13px（样式表里那一档）：让输入框的字跟着
    // 缩放变，就会写出 11/12/13/15/20 之外的字号，而且缩到 0.5 时那行字会溢出框
    // 被 `overflow: hidden` 切掉 —— 正在打的字看不见，比"框比节点大一点"糟得多
    var left = Math.round(spot.x * zoom + doc.view.x);
    var top = Math.round(spot.y * zoom + doc.view.y);
    var room = Math.max(120, stage.clientWidth - left - 8);
    editor.style.left = left + "px";
    editor.style.top = top + "px";
    editor.style.width = Math.min(room, Math.max(120, Math.round(spot.w * zoom))) + "px";
    editor.style.height = Math.max(20, Math.round(spot.h * zoom)) + "px";
    editor.focus();
    editor.select();
  }

  function commitEdit() {
    if (!editingId) return;
    var id = editingId;
    editingId = null;
    editor.hidden = true;
    var node = nodeOf(id);
    if (!node) return;
    var applied = C.setText(doc.root, id, editor.value);
    if (!applied.changed) return;
    pushUndo(doc);
    doc = { version: doc.version, root: applied.root, view: doc.view };
    syncScene();
    save();
  }

  function cancelEdit() {
    editingId = null;
    editor.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // 结构操作（选中态那套键）
  // ---------------------------------------------------------------------------

  function applyRoot(root) {
    var before = doc;
    pushUndo(before);
    doc = { version: doc.version, root: root, view: doc.view };
    syncScene();
    save();
  }

  function createRoot() {
    if (doc.root) return;
    pushUndo(doc);
    var root = { id: "n1", text: "", collapsed: false, children: [] };
    doc = { version: doc.version, root: root, view: doc.view };
    selectedId = root.id;
    syncScene();
    save();
    startEdit(root.id);
  }

  function addChildTo(id) {
    if (!doc.root) {
      createRoot();
      return;
    }
    var result = C.addChild(doc.root, id);
    if (!result.id) return;
    applyRoot(result.root);
    selectedId = result.id;
    ensureVisible(result.id);
    syncScene();
    startEdit(result.id);
  }

  function addSiblingTo(id) {
    if (!doc.root) return;
    var result = C.addSibling(doc.root, id);
    if (!result.id) return;
    applyRoot(result.root);
    selectedId = result.id;
    ensureVisible(result.id);
    syncScene();
    startEdit(result.id);
  }

  function promoteSelection() {
    if (!doc.root || !selectedId) return;
    var result = C.promote(doc.root, selectedId);
    if (!result.moved) return;
    applyRoot(result.root);
    ensureVisible(selectedId);
  }

  function reorderSelection(delta) {
    if (!doc.root || !selectedId) return;
    var result = C.reorder(doc.root, selectedId, delta);
    if (!result.moved) return;
    applyRoot(result.root);
    ensureVisible(selectedId);
  }

  function removeSelection() {
    if (!doc.root || !selectedId) return;
    var parent = C.parentOf(doc.root, selectedId);
    var result = C.removeNode(doc.root, selectedId);
    if (!result.removed) return;
    applyRoot(result.root);
    selectedId = result.root ? (parent ? parent.id : result.root.id) : null;
    syncScene();
  }

  function toggleSelection() {
    if (!doc.root || !selectedId) return;
    var node = nodeOf(selectedId);
    if (!node || !node.children.length) return;
    var result = C.setCollapsed(doc.root, selectedId, !node.collapsed);
    if (!result.changed) return;
    applyRoot(result.root);
    ensureVisible(selectedId);
  }

  /** `←`：展开着就折叠，已经折叠（或没有孩子）就回父节点 */
  function goLeft() {
    if (!doc.root || !selectedId) return;
    var node = nodeOf(selectedId);
    if (!node) return;
    if (node.children.length && !node.collapsed) {
      toggleSelection();
      return;
    }
    var parent = C.parentOf(doc.root, selectedId);
    if (parent) select(parent.id);
  }

  /** `→`：折叠着就展开，展开着就进第一个孩子 */
  function goRight() {
    if (!doc.root || !selectedId) return;
    var node = nodeOf(selectedId);
    if (!node) return;
    if (node.children.length && node.collapsed) {
      toggleSelection();
      return;
    }
    if (node.children.length) select(node.children[0].id);
  }

  function moveSelection(delta) {
    if (!doc.root) return;
    var order = C.flatten(doc.root);
    if (!order.length) return;
    var at = -1;
    for (var i = 0; i < order.length; i += 1) {
      if (order[i].id === selectedId) at = i;
    }
    var next = at < 0 ? 0 : at + delta;
    if (next < 0 || next >= order.length) return;
    select(order[next].id);
  }

  function fitToWindow() {
    if (!doc.root) return;
    layoutResult = C.layout(doc.root, { measure: measure });
    doc.view = C.fitView(layoutResult.bounds, stage.clientWidth, stage.clientHeight);
    syncScene();
    save();
  }

  // ---------------------------------------------------------------------------
  // 导出：只走 clipboard.write
  // ---------------------------------------------------------------------------

  function copy(kind) {
    if (!doc.root) return;
    var text = kind === "markdown" ? C.toMarkdown(doc.root) : kind === "mermaid" ? C.toMermaid(doc.root) : C.toOpml(doc.root);
    call("clipboard.write", { text: text })
      .then(function () {
        flash(t("copied"), false, true);
      })
      .catch(function (error) {
        var denied = error && error.code === "permission_denied";
        flash(denied ? t("copyFailed") : t("copyFailedPlain"), true, false);
      });
  }

  // ---------------------------------------------------------------------------
  // agent：一条消息进，一条消息出（契约见 0022 §4）
  // ---------------------------------------------------------------------------

  function handleAgentCall(payload, source) {
    var callId = payload && payload.callId;
    var tool = String((payload && payload.tool) || "");
    var args = (payload && payload.args) || {};

    function reply(result) {
      if (!source || !source.postMessage) return;
      source.postMessage({ __lattice: 1, type: "agent-result", payload: Object.assign({ callId: callId }, result) }, "*");
    }

    if (tool === "draw" || tool === "append") {
      var parsed = C.parseOutline(args.outline);
      if (!parsed.ok) {
        reply({ ok: false, error: parsed.error });
        return;
      }
      if (tool === "draw") {
        var before = doc;
        pushUndo(before);
        doc = { version: doc.version, root: parsed.root, view: doc.view };
        selectedId = parsed.root.id;
        syncScene();
        doc.view = C.fitView(layoutResult.bounds, stage.clientWidth, stage.clientHeight);
        syncScene();
        saveNow();
        reply({ ok: true, result: { nodes: parsed.nodes, depth: parsed.depth, roots: parsed.roots } });
        return;
      }
      // append：`under` 是节点文本（首个精确命中），缺省挂到根
      var target = doc.root;
      if (typeof args.under === "string" && args.under) {
        var order = C.flatten(doc.root);
        target = null;
        for (var i = 0; i < order.length; i += 1) {
          if (order[i].node.text === args.under) {
            target = order[i].node;
            break;
          }
        }
      }
      if (!target) {
        reply({ ok: false, error: "no node called " + args.under });
        return;
      }
      var attached = C.attachSubtree(doc.root, target.id, parsed.root);
      if (!attached.added) {
        reply({ ok: false, error: "could not attach the outline" });
        return;
      }
      pushUndo(doc);
      doc = { version: doc.version, root: attached.root, view: doc.view };
      selectedId = target.id;
      syncScene();
      saveNow();
      reply({ ok: true, result: { added: attached.added, nodes: C.countNodes(doc.root) } });
      return;
    }

    if (tool === "read") {
      var outline = C.toOutline(doc.root);
      var result = {
        nodes: C.countNodes(doc.root),
        depth: C.depthOf(doc.root),
      };
      if (outline && outline.length <= READ_OUTLINE_LIMIT) result.outline = outline;
      reply({ ok: true, result: result });
      return;
    }

    reply({ ok: false, error: "unknown tool: " + tool });
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("dblclick", onDoubleClick);

  startBtn.addEventListener("click", createRoot);

  editor.addEventListener("compositionstart", function () {
    composing = true;
  });
  editor.addEventListener("compositionend", function () {
    composing = false;
  });

  editor.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      return;
    }
    // 输入法选词时的回车 / Tab 是它自己的，不是我们的
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      var id = editingId;
      commitEdit();
      if (id) addSiblingTo(id);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      var here = editingId;
      commitEdit();
      if (here) addChildTo(here);
    }
  });
  editor.addEventListener("blur", function () {
    if (editingId) commitEdit();
  });

  window.addEventListener("keydown", function (event) {
    if (editingId) return;
    var meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (!doc.root) {
      if (event.key === "Enter") {
        event.preventDefault();
        createRoot();
      }
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      if (selectedId) startEdit(selectedId);
      return;
    }
    if (event.key === "Enter" && selectedId) {
      event.preventDefault();
      startEdit(selectedId);
      return;
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      promoteSelection();
      return;
    }
    if (event.key === "Tab" && selectedId) {
      event.preventDefault();
      addChildTo(selectedId);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeSelection();
      return;
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      reorderSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goLeft();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goRight();
    }
  });

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  document.getElementById("fit").addEventListener("click", fitToWindow);
  document.getElementById("copy-markdown").addEventListener("click", function () {
    copy("markdown");
  });
  document.getElementById("copy-mermaid").addEventListener("click", function () {
    copy("mermaid");
  });
  document.getElementById("copy-opml").addEventListener("click", function () {
    copy("opml");
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;

    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    if (data.type === "language") {
      applyLanguage(data.payload);
      return;
    }
    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
      return;
    }
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (key && key !== KEY) return;
      // 自己还没落盘的改动优先：否则这边正在打字，另一边的保存会把字换掉
      if (dirty || editingId) {
        reloadAfterSave = true;
        return;
      }
      reload(false);
      return;
    }
    if (data.type === "agent-call") {
      handleAgentCall(data.payload, event.source);
      return;
    }
    if (data.type !== "response") return;

    var entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else {
      var error = new Error(data.error || "Bridge call failed");
      error.code = data.code;
      entry.reject(error);
    }
  });

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  // 第一帧先用默认值画出来（空图 + 一行提示），不等桥：桥慢的时候空白三秒，
  // 那三秒里用户以为组件坏了（不变量 18）
  syncScene();
  parent.postMessage({ __lattice: 1, type: "ready" }, "*");

  call("lang.get")
    .then(applyLanguage)
    .catch(function () {});
  call("theme.get")
    .then(applyTheme)
    .catch(function () {});
  call("config.get")
    .then(applyConfig)
    .catch(function () {});
  reload(true);
})();
