/**
 * 架构图 / 流程图组件
 *
 * 一块能平移、能缩放的图面，图形是矩形 / 圆 / 菱形 / 文本，连线两端挂在图形上。
 * 纯逻辑在 `diagram-core.js`（坐标、几何、命中、排版、spec 解析），这一层只管
 * DOM、手势、撤销栈和桥。
 *
 * # 为什么不用 localStorage
 *
 * 沙箱 iframe 是不透明源，localStorage 本来就不可用；而且"所有 Diagram 共享
 * 同一份图"是这里想要的语义（和 todo / timetable 一样按 `widgetId` 存）。
 *
 * # 为什么一次手势只进撤销栈一步
 *
 * 拖动时每帧都在改坐标。按帧记的话，`Ctrl+Z` 五十次才退回拖之前那一格 ——
 * 用户按第三次就会以为撤销坏了。所以拖动只在 pointerup 时压一次快照。
 *
 * # 为什么读失败和没有数据要分开
 *
 * `null` 是"这台机器上还没有这张图"，可以种一份空图并保存；reject 是"这一下
 * 没读到"（权限被拒 / IPC 挂了），那种时候**一个字节都不能写** —— 否则用户的
 * 图会被一张空图顶掉。这个仓库真发生过一次（便签和待办被换成了出厂示例）。
 */
(function () {
  "use strict";

  var C = window.__latticeDiagramCore;
  var KEY = "diagram";
  var UNDO_LIMIT = 50;
  var SAVE_DELAY = 400;
  var NS = "http://www.w3.org/2000/svg";

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
  // 文案
  // ---------------------------------------------------------------------------

  var TEXT = {
    zh: {
      title: "架构图",
      empty: "双击空白处加一个框",
      unsaved: "未保存",
      unreadable: "读不出来",
      pickSecond: "再点一个框",
      addBox: "矩形",
      addDiamond: "菱形",
      addCircle: "圆",
      addText: "文本",
      connect: "连线（点两个框）",
      tone: "换色调",
      undo: "撤销",
      redo: "重做",
      fit: "适应窗口",
    },
    en: {
      title: "Diagram",
      empty: "Double-click to add a box",
      unsaved: "Not saved",
      unreadable: "Could not read",
      pickSecond: "Pick the second box",
      addBox: "Rectangle",
      addDiamond: "Diamond",
      addCircle: "Circle",
      addText: "Text",
      connect: "Connect (pick two boxes)",
      tone: "Cycle tone",
      undo: "Undo",
      redo: "Redo",
      fit: "Fit to window",
    },
  };

  var lang = "zh";
  function t(key) {
    var table = TEXT[lang] || TEXT.zh;
    return table[key] || TEXT.zh[key];
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  var doc = C.emptyDiagram();
  var selection = null;
  var connectMode = false;
  var connectFrom = null;
  var editing = null;
  var gesture = null;
  var undoStack = [];
  var redoStack = [];
  var dirty = false;
  var saving = false;
  var saveAgain = false;
  var saveTimer = 0;
  var storageDenied = false;
  var unreadable = false;
  var reloadAfterSave = false;
  var config = { snap: true };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  var stage = document.getElementById("stage");
  var viewport = document.getElementById("viewport");
  var nodeLayer = document.getElementById("nodes");
  var edgeLayer = document.getElementById("edges");
  var handleLayer = document.getElementById("handles");
  var editor = document.getElementById("editor");
  var emptyHint = document.getElementById("empty");
  var statusEl = document.getElementById("status");
  var titleEl = document.getElementById("title");
  var zoomEl = document.getElementById("zoom");
  var undoBtn = document.getElementById("undo");
  var redoBtn = document.getElementById("redo");
  var connectBtn = document.getElementById("connect");
  var toneBtn = document.getElementById("tone");

  var nodeEls = {};
  var edgeEls = {};

  function el(name) {
    return document.createElementNS(NS, name);
  }

  function applyTheme(tokens) {
    if (!tokens) return;
    Object.keys(tokens).forEach(function (name) {
      if (tokens[name]) document.documentElement.style.setProperty(name, tokens[name]);
    });
  }

  function applyLanguage(payload) {
    var next = payload && payload.lang === "en" ? "en" : "zh";
    if (next === lang && titleEl.textContent === t("title")) return;
    lang = next;
    titleEl.textContent = t("title");
    document.title = t("title");
    emptyHint.textContent = t("empty");
    document.getElementById("add-box").title = t("addBox");
    document.getElementById("add-diamond").title = t("addDiamond");
    document.getElementById("add-circle").title = t("addCircle");
    document.getElementById("add-text").title = t("addText");
    connectBtn.title = t("connect");
    toneBtn.title = t("tone");
    undoBtn.title = t("undo");
    redoBtn.title = t("redo");
    document.getElementById("fit").title = t("fit");
    syncStatus();
  }

  function applyConfig(raw) {
    config.snap = !(raw && raw.snap === false);
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function createNodeEl(node) {
    var group = el("g");
    group.setAttribute("class", "node");
    group.setAttribute("data-id", node.id);
    group.setAttribute("data-kind", node.kind);
    group.setAttribute("data-tone", node.tone);
    var shape = el(node.kind === "circle" ? "ellipse" : node.kind === "diamond" ? "polygon" : "rect");
    shape.setAttribute("class", "shape");
    if (node.kind === "box" || node.kind === "text") shape.setAttribute("rx", "8");
    group.appendChild(shape);
    group.appendChild(el("text"));
    return group;
  }

  function createEdgeEl() {
    var group = el("g");
    group.setAttribute("class", "edge");
    group.appendChild(el("path"));
    group.appendChild(el("polygon"));
    return group;
  }

  function paintText(group, node) {
    var text = group.querySelector("text");
    while (text.firstChild) text.removeChild(text.firstChild);
    var lines = C.wrapLabel(node.text, node.w);
    var lineHeight = 16;
    var centerX = node.x + node.w / 2;
    var topY = node.y + node.h / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach(function (line, index) {
      var span = el("tspan");
      span.setAttribute("x", String(Math.round(centerX)));
      span.setAttribute("y", String(Math.round(topY + index * lineHeight)));
      span.textContent = line;
      text.appendChild(span);
    });
  }

  function paintNode(group, node) {
    group.setAttribute("data-kind", node.kind);
    group.setAttribute("data-tone", node.tone);
    group.classList.toggle("is-selected", !!selection && selection.kind === "node" && selection.id === node.id);
    var shape = group.querySelector(".shape");
    if (node.kind === "circle") {
      shape.setAttribute("cx", String(node.x + node.w / 2));
      shape.setAttribute("cy", String(node.y + node.h / 2));
      shape.setAttribute("rx", String(node.w / 2));
      shape.setAttribute("ry", String(node.h / 2));
    } else if (node.kind === "diamond") {
      shape.setAttribute(
        "points",
        [
          [node.x + node.w / 2, node.y],
          [node.x + node.w, node.y + node.h / 2],
          [node.x + node.w / 2, node.y + node.h],
          [node.x, node.y + node.h / 2],
        ]
          .map(function (point) {
            return point.join(",");
          })
          .join(" "),
      );
    } else {
      shape.setAttribute("x", String(node.x));
      shape.setAttribute("y", String(node.y));
      shape.setAttribute("width", String(node.w));
      shape.setAttribute("height", String(node.h));
    }
    paintText(group, node);
  }

  function syncHandles() {
    while (handleLayer.firstChild) handleLayer.removeChild(handleLayer.firstChild);
    if (!selection || selection.kind !== "node") return;
    var node = C.findNode(doc, selection.id);
    if (!node) return;
    var size = 7 / doc.view.zoom;
    var corners = [
      ["nw", node.x, node.y],
      ["ne", node.x + node.w, node.y],
      ["sw", node.x, node.y + node.h],
      ["se", node.x + node.w, node.y + node.h],
    ];
    corners.forEach(function (corner) {
      var handle = el("rect");
      handle.setAttribute("data-handle", corner[0]);
      handle.setAttribute("x", String(corner[1] - size / 2));
      handle.setAttribute("y", String(corner[2] - size / 2));
      handle.setAttribute("width", String(size));
      handle.setAttribute("height", String(size));
      handle.setAttribute("rx", String(size / 5));
      handleLayer.appendChild(handle);
    });
  }

  function syncButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
    connectBtn.classList.toggle("is-on", connectMode);
    toneBtn.disabled = !selection || selection.kind !== "node";
  }

  function syncStatus() {
    var text = "";
    var bad = false;
    if (unreadable) {
      text = t("unreadable");
      bad = true;
    } else if (storageDenied) {
      text = t("unsaved");
      bad = true;
    } else if (connectFrom) {
      text = t("pickSecond");
    }
    statusEl.textContent = text;
    statusEl.setAttribute("data-bad", bad ? "true" : "false");
  }

  function syncScene() {
    var view = doc.view;
    viewport.setAttribute(
      "transform",
      "translate(" + view.x + " " + view.y + ") scale(" + view.zoom + ")",
    );

    var seenNodes = {};
    doc.nodes.forEach(function (node) {
      seenNodes[node.id] = true;
      var group = nodeEls[node.id];
      if (!group) {
        group = createNodeEl(node);
        nodeEls[node.id] = group;
        nodeLayer.appendChild(group);
      }
      paintNode(group, node);
    });
    Object.keys(nodeEls).forEach(function (id) {
      if (seenNodes[id]) return;
      nodeLayer.removeChild(nodeEls[id]);
      delete nodeEls[id];
    });

    var seenEdges = {};
    doc.edges.forEach(function (edge) {
      var from = C.findNode(doc, edge.from);
      var to = C.findNode(doc, edge.to);
      if (!from || !to) return;
      seenEdges[edge.id] = true;
      var group = edgeEls[edge.id];
      if (!group) {
        group = createEdgeEl();
        edgeEls[edge.id] = group;
        edgeLayer.appendChild(group);
      }
      group.classList.toggle("is-selected", !!selection && selection.kind === "edge" && selection.id === edge.id);
      var points = C.edgePoints(from, to);
      group.querySelector("path").setAttribute("d", C.edgePath(from, to));
      // 箭头按屏幕像素给大小，否则放大之后箭头会变成一大块
      group.querySelector("polygon").setAttribute("points", C.arrowHead(points, 9 / view.zoom));
    });
    Object.keys(edgeEls).forEach(function (id) {
      if (seenEdges[id]) return;
      edgeLayer.removeChild(edgeEls[id]);
      delete edgeEls[id];
    });

    syncHandles();
    emptyHint.hidden = doc.nodes.length > 0;
    zoomEl.textContent = Math.round(view.zoom * 100) + "%";
    syncButtons();
  }

  function select(next) {
    selection = next;
    syncScene();
  }

  // ---------------------------------------------------------------------------
  // 撤销
  // ---------------------------------------------------------------------------

  function pushUndo(snapshot) {
    undoStack.push(C.cloneDiagram(snapshot));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    syncButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(C.cloneDiagram(doc));
    doc = undoStack.pop();
    selection = null;
    syncScene();
    save();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(C.cloneDiagram(doc));
    doc = redoStack.pop();
    selection = null;
    syncScene();
    save();
  }

  // ---------------------------------------------------------------------------
  // 落盘
  // ---------------------------------------------------------------------------

  function save() {
    dirty = true;
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
    var payload = C.cloneDiagram(doc);
    call("storage.set", { key: KEY, value: payload })
      .then(function () {
        var recovered = storageDenied;
        storageDenied = false;
        dirty = false;
        if (recovered) syncStatus();
        if (reloadAfterSave) {
          reloadAfterSave = false;
          reload(false);
        }
      })
      .catch(function (error) {
        storageDenied = error && error.code === "permission_denied";
        syncStatus();
      })
      .then(function () {
        saving = false;
        if (saveAgain) {
          saveAgain = false;
          saveNow();
        }
      });
  }

  function reload(initial) {
    call("storage.get", { key: KEY })
      .then(function (value) {
        if (initial && gesture) return;
        var read = C.normalizeDiagram(value);
        var wasDenied = storageDenied;
        storageDenied = false;
        if (!read.trusted) {
          // 结构不认识：界面上说清楚，但**绝不**写回去
          unreadable = true;
          if (wasDenied) syncStatus();
          return;
        }
        unreadable = false;
        doc = read.diagram;
        selection = null;
        syncScene();
        if (wasDenied) syncStatus();
        // 盘上真没有：种一份空的，让"第一次打开"和"删光了"看起来一样
        if (value == null && !dirty) saveNow();
      })
      .catch(function (error) {
        storageDenied = !error || error.code === "permission_denied" || error.code === "internal";
        syncStatus();
      });
  }

  // ---------------------------------------------------------------------------
  // 手势
  // ---------------------------------------------------------------------------

  function localPoint(event) {
    var rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onDown(event) {
    if (editing) commitEdit();
    if (event.button !== 0 && event.button !== 1) return;
    var point = localPoint(event);

    var handle = event.target && event.target.closest ? event.target.closest("[data-handle]") : null;
    if (handle && selection && selection.kind === "node") {
      gesture = {
        kind: "resize",
        id: selection.id,
        corner: handle.getAttribute("data-handle"),
        snapshot: doc,
        moved: false,
      };
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    var hit = C.hitTest(doc, doc.view, point.x, point.y);
    if (hit.kind === "node") {
      if (connectMode) {
        connectTo(hit.id);
        return;
      }
      select({ kind: "node", id: hit.id });
      var node = C.findNode(doc, hit.id);
      var world = C.screenToWorld(doc.view, point.x, point.y);
      gesture = {
        kind: "move",
        id: hit.id,
        dx: world.x - node.x,
        dy: world.y - node.y,
        snapshot: doc,
        moved: false,
      };
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (hit.kind === "edge") {
      select({ kind: "edge", id: hit.id });
      return;
    }

    select(null);
    gesture = {
      kind: "pan",
      sx: point.x,
      sy: point.y,
      view: { x: doc.view.x, y: doc.view.y },
      moved: false,
    };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-panning");
  }

  function onMove(event) {
    if (!gesture) return;
    var point = localPoint(event);

    if (gesture.kind === "pan") {
      var dx = point.x - gesture.sx;
      var dy = point.y - gesture.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) gesture.moved = true;
      doc.view = { x: gesture.view.x + dx, y: gesture.view.y + dy, zoom: doc.view.zoom };
      syncScene();
      return;
    }

    var world = C.screenToWorld(doc.view, point.x, point.y);

    if (gesture.kind === "move") {
      var x = C.snap(world.x - gesture.dx, config.snap);
      var y = C.snap(world.y - gesture.dy, config.snap);
      var node = C.findNode(doc, gesture.id);
      if (!node || (node.x === x && node.y === y)) return;
      doc = C.applyOps(doc, [{ op: "move", id: gesture.id, x: x, y: y }]);
      gesture.moved = true;
      syncScene();
      return;
    }

    if (gesture.kind === "resize") {
      var target = C.findNode(doc, gesture.id);
      if (!target) return;
      var right = target.x + target.w;
      var bottom = target.y + target.h;
      var left = target.x;
      var top = target.y;
      var width = target.w;
      var height = target.h;

      if (gesture.corner.indexOf("w") !== -1) {
        left = C.snap(world.x, config.snap);
        width = right - left;
        if (width < 80) {
          width = 80;
          left = right - 80;
        }
      } else {
        width = C.snap(world.x, config.snap) - left;
        if (width < 80) width = 80;
      }
      if (gesture.corner.indexOf("n") !== -1) {
        top = C.snap(world.y, config.snap);
        height = bottom - top;
        if (height < 40) {
          height = 40;
          top = bottom - 40;
        }
      } else {
        height = C.snap(world.y, config.snap) - top;
        if (height < 40) height = 40;
      }

      if (left === target.x && top === target.y && width === target.w && height === target.h) return;
      doc = C.applyOps(doc, [
        { op: "resize", id: gesture.id, w: width, h: height },
        { op: "move", id: gesture.id, x: left, y: top },
      ]);
      gesture.moved = true;
      syncScene();
    }
  }

  function onUp() {
    if (!gesture) return;
    var done = gesture;
    gesture = null;
    stage.classList.remove("is-panning");
    if (!done.moved) return;
    if (done.kind === "pan") {
      save();
      return;
    }
    pushUndo(done.snapshot);
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
    var hit = C.hitTest(doc, doc.view, point.x, point.y);
    if (hit.kind === "node") {
      startEdit(C.findNode(doc, hit.id));
      return;
    }
    addNode("box", C.screenToWorld(doc.view, point.x, point.y));
  }

  // ---------------------------------------------------------------------------
  // 编辑
  // ---------------------------------------------------------------------------

  function addNode(kind, at) {
    var size = C.estimateNodeSize("");
    var spot = at || C.screenToWorld(doc.view, stage.clientWidth / 2, stage.clientHeight / 2);
    var before = doc;
    doc = C.applyOps(doc, [
      {
        op: "add-node",
        kind: kind,
        x: C.snap(spot.x - size.w / 2, config.snap),
        y: C.snap(spot.y - size.h / 2, config.snap),
      },
    ]);
    var node = doc.nodes[doc.nodes.length - 1];
    if (!node) return;
    pushUndo(before);
    select({ kind: "node", id: node.id });
    save();
    startEdit(node);
  }

  function startEdit(node) {
    if (!node) return;
    editing = node.id;
    var screen = C.worldToScreen(doc.view, node.x, node.y);
    var zoom = doc.view.zoom;
    editor.hidden = false;
    editor.value = node.text;
    editor.style.left = Math.round(screen.x) + "px";
    editor.style.top = Math.round(screen.y) + "px";
    editor.style.width = Math.max(64, Math.round(node.w * zoom)) + "px";
    editor.style.height = Math.max(26, Math.round(node.h * zoom)) + "px";
    editor.style.fontSize = Math.max(11, Math.round(13 * zoom)) + "px";
    editor.focus();
    editor.select();
  }

  function commitEdit() {
    if (!editing) return;
    var id = editing;
    editing = null;
    editor.hidden = true;
    var node = C.findNode(doc, id);
    if (!node) return;
    var value = editor.value.replace(/\s+/g, " ").trim().slice(0, 40);
    if (value === node.text) return;
    var before = doc;
    doc = C.applyOps(doc, [{ op: "text", id: id, text: value }]);
    pushUndo(before);
    syncScene();
    save();
  }

  function cancelEdit() {
    editing = null;
    editor.hidden = true;
  }

  function connectTo(id) {
    if (!connectFrom) {
      connectFrom = id;
      select({ kind: "node", id: id });
      syncStatus();
      return;
    }
    if (connectFrom === id) {
      connectFrom = null;
      syncStatus();
      return;
    }
    var before = doc;
    doc = C.applyOps(doc, [{ op: "add-edge", from: connectFrom, to: id }]);
    var made = doc.edges.length > before.edges.length;
    connectFrom = null;
    connectMode = false;
    if (made) {
      pushUndo(before);
      select({ kind: "edge", id: doc.edges[doc.edges.length - 1].id });
      save();
    } else {
      syncScene();
    }
    syncStatus();
  }

  function removeSelection() {
    if (!selection) return;
    var before = doc;
    doc = C.applyOps(doc, [{ op: "remove", id: selection.id }]);
    selection = null;
    pushUndo(before);
    syncScene();
    save();
  }

  function cycleTone() {
    if (!selection || selection.kind !== "node") return;
    var node = C.findNode(doc, selection.id);
    if (!node) return;
    var next = C.TONES[(C.TONES.indexOf(node.tone) + 1) % C.TONES.length];
    var before = doc;
    doc = C.applyOps(doc, [{ op: "tone", id: selection.id, tone: next }]);
    pushUndo(before);
    syncScene();
    save();
  }

  function fitToWindow() {
    doc.view = C.fitView(doc, stage.clientWidth, stage.clientHeight);
    syncScene();
    save();
  }

  // ---------------------------------------------------------------------------
  // agent：一条消息进，一条消息出
  // ---------------------------------------------------------------------------

  function labelOf(id) {
    var node = C.findNode(doc, id);
    return node ? node.text : "";
  }

  function handleAgentCall(payload, source) {
    var callId = payload && payload.callId;
    var tool = String((payload && payload.tool) || "");
    var args = (payload && payload.args) || {};

    function reply(result) {
      if (!source || !source.postMessage) return;
      source.postMessage({ __lattice: 1, type: "agent-result", payload: Object.assign({ callId: callId }, result) }, "*");
    }

    if (tool === "draw" || tool === "add") {
      var spec = C.parseSpec(args.spec);
      if (!spec.ok) {
        reply({ ok: false, error: spec.error });
        return;
      }
      var before = doc;
      doc = C.fromSpec(spec, doc, tool === "draw");
      doc.view = C.fitView(doc, stage.clientWidth, stage.clientHeight);
      // 整次调用只进撤销栈一步：`Ctrl+Z` 退回调用之前那一张
      pushUndo(before);
      selection = null;
      syncScene();
      saveNow();
      reply({ ok: true, result: { nodes: doc.nodes.length, edges: doc.edges.length } });
      return;
    }

    if (tool === "read") {
      reply({
        ok: true,
        result: {
          nodes: doc.nodes.map(function (node) {
            return { label: node.text, kind: node.kind };
          }),
          edges: doc.edges.map(function (edge) {
            return { from: labelOf(edge.from), to: labelOf(edge.to) };
          }),
        },
      });
      return;
    }

    reply({ ok: false, error: "unknown tool: " + tool });
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("dblclick", onDoubleClick);

  editor.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commitEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  });
  editor.addEventListener("blur", commitEdit);

  window.addEventListener("keydown", function (event) {
    if (!editor.hidden) return;
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
    if (event.key === "Delete" || event.key === "Backspace") {
      if (!selection) return;
      event.preventDefault();
      removeSelection();
      return;
    }
    if (event.key === "Escape") {
      connectFrom = null;
      connectMode = false;
      select(null);
      syncStatus();
    }
  });

  document.getElementById("add-box").addEventListener("click", function () {
    addNode("box");
  });
  document.getElementById("add-diamond").addEventListener("click", function () {
    addNode("diamond");
  });
  document.getElementById("add-circle").addEventListener("click", function () {
    addNode("circle");
  });
  document.getElementById("add-text").addEventListener("click", function () {
    addNode("text");
  });
  connectBtn.addEventListener("click", function () {
    connectMode = !connectMode;
    connectFrom = null;
    syncButtons();
    syncStatus();
  });
  toneBtn.addEventListener("click", cycleTone);
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  document.getElementById("fit").addEventListener("click", fitToWindow);

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
      // 自己还没落盘的改动优先：不然正拖着框会被另一个宿主拽回去
      if (dirty || gesture) {
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

  // 第一帧先用默认值画出来（空图 + 一行提示），不等桥 —— 桥慢的时候卡片
  // 空白最坏三秒，那三秒里用户以为组件坏了
  syncScene();
  syncStatus();
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
