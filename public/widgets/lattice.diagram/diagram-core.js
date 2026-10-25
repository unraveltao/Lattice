/**
 * 架构图 / 流程图的纯逻辑：文档模型、坐标、几何、命中、排版、agent 的 spec 解析。
 *
 * 为什么单独一层：这一层里每一条错了都不会报错 —— 只会把框画到隔壁、让线不
 * 跟着框走、或者让 agent 画出一张重叠的图。所以它不碰 DOM、不碰桥，由
 * `tests/diagram.html` 逐条钉住。
 *
 * 三条定死的约定：
 *   1. **坐标是世界坐标**，卡片只是视口。所有几何函数收发的都是世界坐标，
 *      只有 `screenToWorld` / `worldToScreen` 这两条知道屏幕。
 *   2. **端点位置不存**，由 `from` / `to` 两个图形的几何算出来 —— 拖框时线
 *      自然跟着走，不需要维护任何"线的坐标"。
 *   3. **排版是确定性的**：同一份 spec 跑两次，每个框的坐标一模一样。agent
 *      说同一句话画两次必须是同一张图，否则用户会以为它每次都在乱画。
 */
(function (global) {
  "use strict";

  var VERSION = 1;

  /** agent 一次能塞进来的上限。超了拒绝，不截断 —— 截断等于替它决定后半截不重要 */
  var MAX_NODES = 24;
  var MAX_EDGES = 40;
  var MAX_LABEL = 40;

  /** 拖动时的吸附格 */
  var GRID = 8;

  var KINDS = ["box", "circle", "diamond", "text"];
  var TONES = ["neutral", "accent", "warn"];

  var MIN_W = 80;
  var MIN_H = 40;
  var MAX_W = 240;

  var ZOOM_MIN = 0.4;
  var ZOOM_MAX = 2.5;

  /** 排版用的间距 */
  var GAP_X = 56;
  var GAP_Y = 24;

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  function clamp(value, low, high) {
    if (!isFinite(value)) return low;
    return value < low ? low : value > high ? high : value;
  }

  function round(value) {
    return Math.round(value);
  }

  function snap(value, on) {
    if (!on) return round(value);
    return round(value / GRID) * GRID;
  }

  function pick(value, allowed, fallback) {
    return allowed.indexOf(value) === -1 ? fallback : value;
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  // ---------------------------------------------------------------------------
  // 文档
  // ---------------------------------------------------------------------------

  function emptyDiagram() {
    return { version: VERSION, nodes: [], edges: [], view: { x: 0, y: 0, zoom: 1 } };
  }

  function cloneDiagram(diagram) {
    return {
      version: VERSION,
      nodes: diagram.nodes.map(function (node) {
        return {
          id: node.id,
          kind: node.kind,
          x: node.x,
          y: node.y,
          w: node.w,
          h: node.h,
          text: node.text,
          tone: node.tone,
        };
      }),
      edges: diagram.edges.map(function (edge) {
        return { id: edge.id, from: edge.from, to: edge.to };
      }),
      view: { x: diagram.view.x, y: diagram.view.y, zoom: diagram.view.zoom },
    };
  }

  /**
   * 按字数估一个框的大小。中文按 14px、其它按 8px，两边都留 padding。
   *
   * 不是"量出来的"：量要等 DOM，而排版（agent 那条）不能等 DOM。估错一点的
   * 后果只是框比字宽一点，不会盖住别人。
   */
  function estimateNodeSize(text) {
    var width = 0;
    var chars = String(text == null ? "" : text);
    for (var i = 0; i < chars.length; i += 1) {
      width += chars.charCodeAt(i) >= 0x2e80 ? 14 : 8;
    }
    return {
      w: clamp(width + 28, MIN_W, MAX_W),
      h: clamp(Math.ceil((width + 28) / MAX_W) * 22 + 26, MIN_H, 120),
    };
  }

  function nextId(list, prefix) {
    var max = 0;
    for (var i = 0; i < list.length; i += 1) {
      var match = /^[a-z](\d+)$/.exec(list[i].id || "");
      if (match) max = Math.max(max, Number(match[1]));
    }
    return prefix + (max + 1);
  }

  function normalizeView(raw) {
    var view = isObject(raw) ? raw : {};
    return {
      x: isFinite(view.x) ? round(view.x) : 0,
      y: isFinite(view.y) ? round(view.y) : 0,
      zoom: isFinite(view.zoom) ? clamp(view.zoom, ZOOM_MIN, ZOOM_MAX) : 1,
    };
  }

  /**
   * 读盘回来的东西一律走这里。
   *
   * 返回 `trusted` 是有原因的：`null`（没有数据）和"结构不认识"必须分开 ——
   * 前者可以种一份空图并保存，后者**一个字节都不能写**，否则用户的图就被一张
   * 空图顶掉了（这个仓库真发生过一次，见 PITFALLS「数据与落盘」）。
   */
  function normalizeDiagram(raw) {
    if (raw == null) return { diagram: emptyDiagram(), trusted: true };
    if (!isObject(raw) || !Array.isArray(raw.nodes)) {
      return { diagram: emptyDiagram(), trusted: false };
    }
    if (raw.version !== undefined && raw.version !== VERSION) {
      return { diagram: emptyDiagram(), trusted: false };
    }

    var seen = {};
    var nodes = [];
    for (var i = 0; i < raw.nodes.length && nodes.length < MAX_NODES; i += 1) {
      var node = raw.nodes[i];
      if (!isObject(node) || typeof node.id !== "string" || !node.id || seen[node.id]) continue;
      seen[node.id] = true;
      var size = estimateNodeSize(node.text);
      nodes.push({
        id: node.id,
        kind: pick(node.kind, KINDS, "box"),
        x: isFinite(node.x) ? round(node.x) : 0,
        y: isFinite(node.y) ? round(node.y) : 0,
        w: isFinite(node.w) ? clamp(round(node.w), MIN_W, MAX_W * 2) : size.w,
        h: isFinite(node.h) ? clamp(round(node.h), MIN_H, 400) : size.h,
        text: String(node.text == null ? "" : node.text).slice(0, MAX_LABEL),
        tone: pick(node.tone, TONES, "neutral"),
      });
    }

    var edges = [];
    var seenEdge = {};
    for (var j = 0; j < raw.edges.length && edges.length < MAX_EDGES; j += 1) {
      var edge = raw.edges[j];
      if (!isObject(edge) || typeof edge.id !== "string" || !edge.id || seenEdge[edge.id]) continue;
      // 端点指向不存在的图形 → 这条线没有意义，丢掉（不是画一条从 0,0 出发的线）
      if (!seen[edge.from] || !seen[edge.to] || edge.from === edge.to) continue;
      seenEdge[edge.id] = true;
      edges.push({ id: edge.id, from: edge.from, to: edge.to });
    }

    return { diagram: { version: VERSION, nodes: nodes, edges: edges, view: normalizeView(raw.view) }, trusted: true };
  }

  // ---------------------------------------------------------------------------
  // 坐标
  // ---------------------------------------------------------------------------

  function screenToWorld(view, sx, sy) {
    var zoom = view.zoom || 1;
    return { x: (sx - view.x) / zoom, y: (sy - view.y) / zoom };
  }

  function worldToScreen(view, wx, wy) {
    var zoom = view.zoom || 1;
    return { x: wx * zoom + view.x, y: wy * zoom + view.y };
  }

  /** 以屏幕上某一点为中心缩放：那个点底下的世界坐标不动 */
  function zoomAt(view, sx, sy, nextZoom) {
    var zoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
    var world = screenToWorld(view, sx, sy);
    return { x: round(sx - world.x * zoom), y: round(sy - world.y * zoom), zoom: zoom };
  }

  // ---------------------------------------------------------------------------
  // 几何：端点与曲线
  // ---------------------------------------------------------------------------

  function center(node) {
    return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  }

  function radius(node) {
    if (node.kind === "circle") return Math.min(node.w, node.h) / 2;
    return 0;
  }

  /**
   * 连线从哪条边出、从哪条边进。
   *
   * 比的是两个中心的位移：横向差更大就走左右，否则走上下。不做"哪个边最近"
   * 的精确比较 —— 两个框对角摆放时精确比较会算出斜边，而视觉上人只认四种。
   */
  function anchorPair(from, to) {
    var a = center(from);
    var b = center(to);
    var dx = b.x - a.x;
    var dy = b.y - a.y;

    if (Math.abs(dx) >= Math.abs(dy)) {
      var right = dx >= 0;
      return {
        from: { x: right ? from.x + from.w : from.x, y: a.y, nx: right ? 1 : -1, ny: 0 },
        to: { x: right ? to.x : to.x + to.w, y: b.y, nx: right ? -1 : 1, ny: 0 },
      };
    }

    var down = dy >= 0;
    return {
      from: { x: a.x, y: down ? from.y + from.h : from.y, nx: 0, ny: down ? 1 : -1 },
      to: { x: b.x, y: down ? to.y : to.y + to.h, nx: 0, ny: down ? -1 : 1 },
    };
  }

  /** 三次贝塞尔的四个点。控制点沿出边法线伸出，伸出的长度随距离增长但有上下限 */
  function edgePoints(from, to) {
    var pair = anchorPair(from, to);
    var dx = pair.to.x - pair.from.x;
    var dy = pair.to.y - pair.from.y;
    var reach = clamp(Math.sqrt(dx * dx + dy * dy) * 0.45, 24, 120);
    return {
      p0: { x: pair.from.x, y: pair.from.y },
      p1: { x: pair.from.x + pair.from.nx * reach, y: pair.from.y + pair.from.ny * reach },
      p2: { x: pair.to.x + pair.to.nx * reach, y: pair.to.y + pair.to.ny * reach },
      p3: { x: pair.to.x, y: pair.to.y },
      end: { x: pair.to.nx, y: pair.to.ny },
    };
  }

  function bezierAt(points, t) {
    var u = 1 - t;
    var a = u * u * u;
    var b = 3 * u * u * t;
    var c = 3 * u * t * t;
    var d = t * t * t;
    return {
      x: a * points.p0.x + b * points.p1.x + c * points.p2.x + d * points.p3.x,
      y: a * points.p0.y + b * points.p1.y + c * points.p2.y + d * points.p3.y,
    };
  }

  function edgePath(from, to) {
    var points = edgePoints(from, to);
    return (
      "M " +
      round(points.p0.x) +
      " " +
      round(points.p0.y) +
      " C " +
      round(points.p1.x) +
      " " +
      round(points.p1.y) +
      " " +
      round(points.p2.x) +
      " " +
      round(points.p2.y) +
      " " +
      round(points.p3.x) +
      " " +
      round(points.p3.y)
    );
  }

  /**
   * 把标签折成最多 3 行，超出第三行加省略号。
   *
   * SVG 的 `<text>` 不会自己换行，而框宽是用户拖出来的 —— 不折行的话长标签会
   * 直接横着穿出框外，盖住旁边的线。折行规则和 `estimateNodeSize` 用同一套
   * 字宽（中文 13、其它 7.5），两处不一致会让"估的框"和"排的字"对不上。
   */
  function wrapLabel(text, width) {
    var limit = Math.max(40, width - 16);
    var chars = String(text == null ? "" : text).split("");
    var lines = [];
    var line = "";
    var used = 0;
    var overflow = false;
    for (var i = 0; i < chars.length; i += 1) {
      var w = chars[i].charCodeAt(0) >= 0x2e80 ? 13 : 7.5;
      if (used + w > limit && line) {
        if (lines.length === 2) {
          overflow = true;
          break;
        }
        lines.push(line);
        line = "";
        used = 0;
      }
      line += chars[i];
      used += w;
    }
    if (line) lines.push(line);
    if (!lines.length) return [""];
    if (overflow) {
      var last = lines[2];
      lines[2] = (last.length > 1 ? last.slice(0, -1) : last) + "…";
    }
    return lines;
  }

  /** 箭头三角形的三个点（世界坐标），指向 `points.end` 那个方向 */  function arrowHead(points, size) {
    var length = size || 9;
    var width = length * 0.62;
    // 箭头方向取"曲线最后一点到 p3"的切线，不取出边的法线 —— 弯得厉害时法线会偏
    var back = bezierAt(points, 0.94);
    var dx = points.p3.x - back.x;
    var dy = points.p3.y - back.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len;
    var uy = dy / len;
    var tip = { x: points.p3.x, y: points.p3.y };
    var baseX = tip.x - ux * length;
    var baseY = tip.y - uy * length;
    return (
      round(tip.x) +
      "," +
      round(tip.y) +
      " " +
      round(baseX - uy * width) +
      "," +
      round(baseY + ux * width) +
      " " +
      round(baseX + uy * width) +
      "," +
      round(baseY - ux * width)
    );
  }

  function pointInNode(node, x, y) {
    var mid = center(node);
    if (node.kind === "circle") {
      // 椭圆而不是正圆：用户把框拖成长条时，命中也得跟着变成椭圆
      var rx = node.w / 2;
      var ry = node.h / 2;
      var nx = (x - mid.x) / rx;
      var ny = (y - mid.y) / ry;
      return nx * nx + ny * ny <= 1;
    }
    if (node.kind === "diamond") {
      var dx = Math.abs(x - mid.x) / (node.w / 2);
      var dy = Math.abs(y - mid.y) / (node.h / 2);
      return dx + dy <= 1;
    }
    return x >= node.x && x <= node.x + node.w && y >= node.y && y <= node.y + node.h;
  }

  function nodeAt(diagram, x, y) {
    // 倒着找：后画的在上面
    for (var i = diagram.nodes.length - 1; i >= 0; i -= 1) {
      if (pointInNode(diagram.nodes[i], x, y)) return diagram.nodes[i];
    }
    return null;
  }

  function findNode(diagram, id) {
    for (var i = 0; i < diagram.nodes.length; i += 1) {
      if (diagram.nodes[i].id === id) return diagram.nodes[i];
    }
    return null;
  }

  function distanceToEdge(diagram, edge, x, y) {
    var from = findNode(diagram, edge.from);
    var to = findNode(diagram, edge.to);
    if (!from || !to) return Infinity;
    var points = edgePoints(from, to);
    var best = Infinity;
    var previous = points.p0;
    for (var step = 1; step <= 16; step += 1) {
      var current = bezierAt(points, step / 16);
      var dx = current.x - previous.x;
      var dy = current.y - previous.y;
      var lenSq = dx * dx + dy * dy;
      var t = lenSq === 0 ? 0 : ((x - previous.x) * dx + (y - previous.y) * dy) / lenSq;
      t = clamp(t, 0, 1);
      var px = previous.x + dx * t;
      var py = previous.y + dy * t;
      var d = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
      if (d < best) best = d;
      previous = current;
    }
    return best;
  }

  function edgeAt(diagram, x, y, tolerance) {
    var limit = tolerance == null ? 7 : tolerance;
    for (var i = diagram.edges.length - 1; i >= 0; i -= 1) {
      if (distanceToEdge(diagram, diagram.edges[i], x, y) <= limit) return diagram.edges[i];
    }
    return null;
  }

  /** 屏幕坐标进，命中结果出。所有调用方（点击、拖动、双击）都从这里走 */
  function hitTest(diagram, view, sx, sy) {
    var world = screenToWorld(view, sx, sy);
    var node = nodeAt(diagram, world.x, world.y);
    if (node) return { kind: "node", id: node.id, node: node };
    var edge = edgeAt(diagram, world.x, world.y, 7 / (view.zoom || 1));
    if (edge) return { kind: "edge", id: edge.id, edge: edge };
    return { kind: null, id: null };
  }

  // ---------------------------------------------------------------------------
  // 编辑：所有改动都从 applyOps 走
  // ---------------------------------------------------------------------------

  function removeNode(diagram, id) {
    diagram.nodes = diagram.nodes.filter(function (node) {
      return node.id !== id;
    });
    diagram.edges = diagram.edges.filter(function (edge) {
      return edge.from !== id && edge.to !== id;
    });
  }

  /**
   * 改一份图，返回新的一份（不改入参）。
   *
   * 界面和 agent 都从这里进 —— 这样"agent 能做的事"和"人能做的事"永远是同一套
   * 语义，不会出现"界面上能删、agent 删了就崩"这种分叉。
   */
  function applyOps(diagram, ops) {
    var next = cloneDiagram(diagram);
    for (var i = 0; i < ops.length; i += 1) {
      var op = ops[i];
      if (!op || typeof op.op !== "string") continue;
      var node;
      switch (op.op) {
        case "add-node":
          if (next.nodes.length >= MAX_NODES) break;
          var size = estimateNodeSize(op.text);
          next.nodes.push({
            id: nextId(next.nodes, "n"),
            kind: pick(op.kind, KINDS, "box"),
            x: round(op.x || 0),
            y: round(op.y || 0),
            w: isFinite(op.w) ? round(op.w) : size.w,
            h: isFinite(op.h) ? round(op.h) : size.h,
            text: String(op.text == null ? "" : op.text).slice(0, MAX_LABEL),
            tone: pick(op.tone, TONES, "neutral"),
          });
          break;
        case "add-edge":
          if (next.edges.length >= MAX_EDGES) break;
          if (!findNode(next, op.from) || !findNode(next, op.to) || op.from === op.to) break;
          next.edges.push({ id: nextId(next.edges, "e"), from: op.from, to: op.to });
          break;
        case "move":
          node = findNode(next, op.id);
          if (!node) break;
          node.x = round(op.x);
          node.y = round(op.y);
          break;
        case "resize":
          node = findNode(next, op.id);
          if (!node) break;
          node.w = clamp(round(op.w), MIN_W, MAX_W * 2);
          node.h = clamp(round(op.h), MIN_H, 400);
          break;
        case "text":
          node = findNode(next, op.id);
          if (!node) break;
          node.text = String(op.text == null ? "" : op.text).slice(0, MAX_LABEL);
          break;
        case "tone":
          node = findNode(next, op.id);
          if (!node) break;
          node.tone = pick(op.tone, TONES, "neutral");
          break;
        case "remove":
          if (findNode(next, op.id)) removeNode(next, op.id);
          else
            next.edges = next.edges.filter(function (edge) {
              return edge.id !== op.id;
            });
          break;
        default:
          break;
      }
    }
    return next;
  }

  // ---------------------------------------------------------------------------
  // agent 的 spec：一行一条
  // ---------------------------------------------------------------------------

  /**
   * 工具参数只能传字符串 / 数字 / 布尔（WIDGET_SPEC §3.6），传不了数组对象。
   * 所以 agent 写的是几行文本：
   *
   *     # 注释随便写
   *     Platform:box
   *     Widget -> Platform
   *     Platform -> Desktop -> Phone
   *
   * `A -> B -> C` 是两条边；没定义过的标签第一次出现时按矩形建。
   */
  function parseSpec(text) {
    var source = String(text == null ? "" : text);
    var nodes = [];
    var index = {};
    var edges = [];
    var lines = source.split(/\r?\n/);

    function define(label, kind) {
      var name = label.trim();
      if (!name) return null;
      if (name.length > MAX_LABEL) return { error: "label is too long (max " + MAX_LABEL + "): " + name.slice(0, 12) + "…" };
      // 用 hasOwnProperty 而不是 `if (!index[name])`：下标 0 是假值，
      // 那样写会让第一个节点每被引用一次就多建一个（tests 里钉着这条）
      if (!Object.prototype.hasOwnProperty.call(index, name)) {
        if (nodes.length >= MAX_NODES) return { error: "too many nodes (max " + MAX_NODES + ")" };
        index[name] = nodes.length;
        nodes.push({ label: name, kind: pick(kind, KINDS, "box") });
      } else if (kind) {
        nodes[index[name]].kind = pick(kind, KINDS, "box");
      }
      return { at: index[name] };
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === "#") continue;

      var chain = line.split("->");
      if (chain.length > 1) {
        var previous = null;
        for (var part = 0; part < chain.length; part += 1) {
          var made = define(chain[part], null);
          if (made && made.error) return { ok: false, error: made.error };
          if (previous !== null) {
            if (edges.length >= MAX_EDGES) return { ok: false, error: "too many edges (max " + MAX_EDGES + ")" };
            if (previous !== made.at) edges.push({ from: previous, to: made.at });
          }
          previous = made.at;
        }
        continue;
      }

      // `Label:kind` —— 冒号后面不认识就当成标签的一部分（"Time: 09:30" 这种）
      var colon = line.lastIndexOf(":");
      var kind = colon > 0 ? line.slice(colon + 1).trim().toLowerCase() : "";
      if (colon > 0 && KINDS.indexOf(kind) !== -1) {
        var node = define(line.slice(0, colon), kind);
        if (node && node.error) return { ok: false, error: node.error };
        continue;
      }
      var plain = define(line, null);
      if (plain && plain.error) return { ok: false, error: plain.error };
    }

    if (!nodes.length) return { ok: false, error: "nothing to draw — write one node per line" };
    return { ok: true, nodes: nodes, edges: edges };
  }

  /**
   * 排版：按入边分层，从左到右。确定性来自"同层按输入顺序竖排"。
   *
   * 有环时（A→B→A）长路径分层算不出来 —— 那种情况把剩下的节点按输入顺序一个
   * 一列接在后面，图照样出来，不报错。宁可不漂亮，也别让 agent 的一次调用整张
   * 失败。
   */
  function layout(spec) {
    var count = spec.nodes.length;
    var layer = new Array(count);
    var incoming = new Array(count);
    var outgoing = new Array(count);
    var i;
    for (i = 0; i < count; i += 1) {
      incoming[i] = 0;
      outgoing[i] = [];
    }
    for (i = 0; i < spec.edges.length; i += 1) {
      var edge = spec.edges[i];
      if (edge.from === edge.to) continue;
      outgoing[edge.from].push(edge.to);
      incoming[edge.to] += 1;
    }

    var queue = [];
    for (i = 0; i < count; i += 1) if (incoming[i] === 0) queue.push(i);
    var done = 0;
    var depth = 0;
    while (queue.length && depth < count + 1) {
      var next = [];
      for (i = 0; i < queue.length; i += 1) {
        var at = queue[i];
        if (layer[at] === undefined) layer[at] = depth;
        done += 1;
        for (var o = 0; o < outgoing[at].length; o += 1) {
          var target = outgoing[at][o];
          incoming[target] -= 1;
          if (incoming[target] === 0) {
            layer[target] = Math.max(layer[target] === undefined ? 0 : layer[target], layer[at] + 1);
            next.push(target);
          }
        }
      }
      queue = next;
      depth += 1;
    }

    // 环：没被排到的节点一个一列，接在后面
    var tail = 0;
    var maxLayer = 0;
    for (i = 0; i < count; i += 1) if (layer[i] !== undefined) maxLayer = Math.max(maxLayer, layer[i]);
    for (i = 0; i < count; i += 1) {
      if (layer[i] === undefined) {
        tail += 1;
        layer[i] = maxLayer + tail;
      }
    }

    // 每层的高度，用来把同层竖向居中
    var columns = {};
    for (i = 0; i < count; i += 1) {
      if (!columns[layer[i]]) columns[layer[i]] = [];
      columns[layer[i]].push(i);
    }
    var sizes = spec.nodes.map(function (node) {
      return estimateNodeSize(node.label);
    });
    var tallest = 0;
    Object.keys(columns).forEach(function (key) {
      var height = 0;
      columns[key].forEach(function (index) {
        height += sizes[index].h + GAP_Y;
      });
      tallest = Math.max(tallest, height - GAP_Y);
    });

    var result = [];
    var cursorX = 24;
    var ordered = Object.keys(columns)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      });
    ordered.forEach(function (key) {
      var list = columns[key];
      var columnWidth = 0;
      list.forEach(function (index) {
        columnWidth = Math.max(columnWidth, sizes[index].w);
      });
      var totalHeight = 0;
      list.forEach(function (index) {
        totalHeight += sizes[index].h + GAP_Y;
      });
      totalHeight -= GAP_Y;
      var cursorY = 24 + Math.max(0, (tallest - totalHeight) / 2);
      list.forEach(function (index) {
        result.push({
          label: spec.nodes[index].label,
          kind: spec.nodes[index].kind,
          x: round(cursorX + (columnWidth - sizes[index].w) / 2),
          y: round(cursorY),
          w: sizes[index].w,
          h: sizes[index].h,
        });
        cursorY += sizes[index].h + GAP_Y;
      });
      cursorX += columnWidth + GAP_X;
    });

    // 按输入顺序还原（调用方按下标连边）
    return spec.nodes.map(function (node) {
      for (var r = 0; r < result.length; r += 1) {
        if (result[r].label === node.label) return result[r];
      }
      return { label: node.label, kind: node.kind, x: 24, y: 24, w: MIN_W, h: MIN_H };
    });
  }

  /**
   * 把一份 spec 变成图。`replace` 为真时整张换掉（`draw`），否则接在后面（`add`）。
   *
   * 追加时新图排在现有图的右边，避免压在老图上 —— 这也是确定性的：老图的宽度
   * 决定新图从哪开始。
   */
  function fromSpec(spec, existing, replace) {
    var placed = layout(spec);
    var base = replace ? emptyDiagram() : cloneDiagram(existing);
    var offsetX = 24;
    var offsetY = 24;
    if (!replace && base.nodes.length) {
      var right = 0;
      base.nodes.forEach(function (node) {
        right = Math.max(right, node.x + node.w);
      });
      offsetX = right + GAP_X;
    }

    var idOf = [];
    placed.forEach(function (node) {
      var id = nextId(base.nodes, "n");
      idOf.push(id);
      base.nodes.push({
        id: id,
        kind: node.kind,
        x: round(node.x - 24 + offsetX),
        y: round(node.y - 24 + offsetY),
        w: node.w,
        h: node.h,
        text: node.label,
        tone: "neutral",
      });
    });
    spec.edges.forEach(function (edge) {
      base.edges.push({ id: nextId(base.edges, "e"), from: idOf[edge.from], to: idOf[edge.to] });
    });

    // 让缩放和位置兜住整张图（只在第一次有内容时做，之后由用户自己控）
    base.view = normalizeView(base.view);
    return base;
  }

  /** 把整张图装进视口。边距 16px，缩放到刚好放下，但不超过 1（不放大） */
  function fitView(diagram, width, height) {
    if (!diagram.nodes.length || width <= 0 || height <= 0) return normalizeView(diagram.view);
    var left = Infinity;
    var top = Infinity;
    var right = -Infinity;
    var bottom = -Infinity;
    diagram.nodes.forEach(function (node) {
      left = Math.min(left, node.x);
      top = Math.min(top, node.y);
      right = Math.max(right, node.x + node.w);
      bottom = Math.max(bottom, node.y + node.h);
    });
    var pad = 16;
    var zoom = Math.min(
      (width - pad * 2) / Math.max(1, right - left),
      (height - pad * 2) / Math.max(1, bottom - top),
    );
    zoom = clamp(zoom, ZOOM_MIN, Math.min(1, ZOOM_MAX));
    return {
      x: round((width - (right - left) * zoom) / 2 - left * zoom),
      y: round((height - (bottom - top) * zoom) / 2 - top * zoom),
      zoom: zoom,
    };
  }

  global.__latticeDiagramCore = {
    VERSION: VERSION,
    MAX_NODES: MAX_NODES,
    MAX_EDGES: MAX_EDGES,
    MAX_LABEL: MAX_LABEL,
    GRID: GRID,
    KINDS: KINDS,
    TONES: TONES,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    emptyDiagram: emptyDiagram,
    cloneDiagram: cloneDiagram,
    normalizeDiagram: normalizeDiagram,
    estimateNodeSize: estimateNodeSize,
    screenToWorld: screenToWorld,
    worldToScreen: worldToScreen,
    zoomAt: zoomAt,
    snap: snap,
    clamp: clamp,
    center: center,
    edgePoints: edgePoints,
    edgePath: edgePath,
    wrapLabel: wrapLabel,
    arrowHead: arrowHead,
    pointInNode: pointInNode,
    nodeAt: nodeAt,
    findNode: findNode,
    distanceToEdge: distanceToEdge,
    edgeAt: edgeAt,
    hitTest: hitTest,
    applyOps: applyOps,
    parseSpec: parseSpec,
    layout: layout,
    fromSpec: fromSpec,
    fitView: fitView,
  };
})(typeof window !== "undefined" ? window : this);
