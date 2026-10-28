/**
 * 思维导图的纯逻辑
 *
 * 三件事：把大纲文本解析成树、把树摆成坐标、把树写成三种别人的格式。
 * 这一层**不碰 DOM、不碰桥、不碰存储** —— 布局要测量文字宽度，所以 `measure`
 * 由调用方注入（真机是 canvas `measureText`，断言页传一个桩）。
 *
 * # 为什么位置是算出来的
 *
 * 数据结构里没有坐标（见 0022 §3）：节点是 `{ id, text, collapsed, children }`，
 * 摆在哪里由 `layout()` 决定。所以改一次从属关系不需要挪任何东西，agent 也
 * 不用编造坐标 —— 同一份大纲跑两次，出来的图一模一样。
 *
 * # 摆位是叠在自动布局上的一层（0033）
 *
 * 0.2 起用户可以拖动节点，但树里**仍然没有坐标**：被拖过的节点在 `offsets` 里
 * 记一对 `dx/dy`，`layout()` 把算出来的位置加上它。所以自动布局还是底 —— 加
 * 一个兄弟节点之后整行往下推，被拖过的那个跟着自己的底一起走，这是"偏移"的
 * 定义。反过来存绝对坐标，`Alt+↑↓` 换位置之后所有坐标就全错了。
 *
 * 偏移按 id 存，所以 `draw`（整张替换、重新编号 `n1..nN`）必须清空 offsets，
 * 否则 A 的摆位会贴到 B 身上。`append` 不动已有 id，偏移全部保留。
 *
 * # 为什么导出走数据而不是画布
 *
 * 卡片窄，长文本显示时要省略；导出要是走"显示用的那份文本"，用户复制走的
 * 就是半截话。所以显示截断只发生在渲染层，这一层永远读 `node.text` 全文。
 *
 * 挂在 `window.__latticeMindmapCore` 上，由 `index.html` 在 `widget.js` 之前
 * 用 `<script src>` 同步加载（断言页测的是同一份文件，不复制逻辑）。
 */
(function (global) {
  "use strict";

  /** 落盘格式的版本。不认识的版本当空图显示，但**不落盘**（读坏 ≠ 没有数据） */
  var VERSION = 1;

  /** 大纲的三个上限：超了**拒绝**，不截断（截断会让人以为写完了一半） */
  var MAX_NODES = 200;
  var MAX_DEPTH = 12;
  var MAX_TEXT = 80;

  /**
   * 单个节点的摆位最远能到哪。
   *
   * 量出来的：200 个节点 × 28px 行高 = 5600 高，再远就不是"挪开一点"而是"扔了"。
   * 夹住而不是拒绝 —— 摆位是拖动产生的，用户没有"提交"这个动作可以报错给他看。
   */
  var MAX_SHIFT = 4000;

  /** 节点宽度 = clamp(测量宽度 + 16, 64, 220) */
  var PAD_X = 16;
  var MIN_W = 64;
  var MAX_W = 220;

  /** 布局：一行 28px、列间距 40、四周留 16 */
  var ROW = 28;
  var COL_GAP = 40;
  var MARGIN = 16;
  var NODE_H = 20;

  var ZOOM_MIN = 0.4;
  var ZOOM_MAX = 2.5;

  var TONES = ["accent", "neutral", "warn"];

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  function clamp(value, low, high) {
    if (!isFinite(value)) return low;
    return value < low ? low : value > high ? high : value;
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  /** 按**码点**数长度：`😀` 是一个字，不是两个 */
  function points(text) {
    return Array.from(String(text));
  }

  /** 落盘的文本：压成一行、去掉首尾空白、按码点截到 80 */
  function cleanText(raw) {
    if (typeof raw !== "string") return "";
    var text = raw.replace(/\s+/g, " ").trim();
    var chars = points(text);
    return chars.length > MAX_TEXT ? chars.slice(0, MAX_TEXT).join("") : text;
  }

  function cloneNode(node) {
    var clone = { id: node.id, text: node.text, collapsed: node.collapsed === true, children: [] };
    if (node.tone) clone.tone = node.tone;
    for (var i = 0; i < node.children.length; i += 1) clone.children.push(cloneNode(node.children[i]));
    return clone;
  }

  // ---------------------------------------------------------------------------
  // 文档：空、克隆、读盘归一化
  // ---------------------------------------------------------------------------

  /**
   * 摆位表：`{ id: [dx, dy] }`，只记被拖过的节点。
   *
   * 深拷贝是必须的 —— 撤销栈靠"每份快照互不影响"，共用同一个数组会让
   * `Ctrl+Z` 退回去的位置跟着下一次拖动一起变。
   */
  function cloneOffsets(offsets) {
    var out = {};
    if (!offsets || typeof offsets !== "object") return out;
    Object.keys(offsets).forEach(function (id) {
      var pair = offsets[id];
      if (pair && pair.length === 2) out[id] = [pair[0], pair[1]];
    });
    return out;
  }

  /**
   * 读盘时归一化摆位。
   *
   * 只留**这棵树里真的有的 id**：`draw` 换过一整棵树之后，旧偏移的 id 会指向
   * 别的节点（或者根本不存在），留着就是一张随机错位的图。
   *
   * 只认两个有限数、`±MAX_SHIFT` 夹住、取整；`[0,0]` 当作没摆过（不写回盘）。
   */
  function normalizeOffsets(raw, ids) {
    var out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (id) {
      if (!ids || !ids[id]) return;
      var pair = raw[id];
      if (!Array.isArray(pair) || pair.length !== 2) return;
      var dx = Number(pair[0]);
      var dy = Number(pair[1]);
      if (!isFinite(dx) || !isFinite(dy)) return;
      dx = Math.round(clamp(dx, -MAX_SHIFT, MAX_SHIFT));
      dy = Math.round(clamp(dy, -MAX_SHIFT, MAX_SHIFT));
      if (!dx && !dy) return;
      out[id] = [dx, dy];
    });
    return out;
  }

  function emptyDoc() {
    return { version: VERSION, root: null, view: { x: 0, y: 0, zoom: 1 }, offsets: {} };
  }

  function cloneDoc(doc) {
    return {
      version: VERSION,
      root: doc && doc.root ? cloneNode(doc.root) : null,
      view: normalizeView(doc && doc.view),
      offsets: cloneOffsets(doc && doc.offsets),
    };
  }

  function normalizeView(raw) {
    if (!raw || typeof raw !== "object") return { x: 0, y: 0, zoom: 1 };
    return {
      x: isFinite(raw.x) ? round(raw.x) : 0,
      y: isFinite(raw.y) ? round(raw.y) : 0,
      zoom: isFinite(raw.zoom) ? round(clamp(raw.zoom, ZOOM_MIN, ZOOM_MAX)) : 1,
    };
  }

  /**
   * 读盘归一化。
   *
   * 返回 `{ trusted, doc }`：
   *   - `trusted: false` = 盘上那份结构不认识 —— 界面按空图显示，**但一个字节都别写回去**
   *   - `trusted: true` 且 `doc.root === null` = 这台机器上真的还没有图，可以种一份空的
   *
   * 这两种"看起来都是空"的状态必须分开：混在一起的那次事故是用户的图被一张
   * 空图顶掉了（0022 §5 第一行）。
   */
  function normalizeDoc(value) {
    if (value == null) return { trusted: true, doc: emptyDoc() };
    if (typeof value !== "object" || Array.isArray(value)) return { trusted: false, doc: emptyDoc() };
    if (value.version !== VERSION) return { trusted: false, doc: emptyDoc() };

    var seen = Object.create(null);
    var used = 0;
    var nextId = 1;

    function takeId(raw) {
      var id = typeof raw === "string" && raw && !seen[raw] ? raw : "";
      if (!id) {
        do {
          id = "n" + nextId;
          nextId += 1;
        } while (seen[id]);
      }
      seen[id] = true;
      return id;
    }

    function walk(raw, depth) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (depth > MAX_DEPTH || used >= MAX_NODES) return null;
      used += 1;
      var node = {
        id: takeId(raw.id),
        text: cleanText(raw.text),
        collapsed: raw.collapsed === true,
        children: [],
      };
      if (raw.tone === "accent" || raw.tone === "warn") node.tone = raw.tone;
      var kids = Array.isArray(raw.children) ? raw.children : [];
      for (var i = 0; i < kids.length; i += 1) {
        var child = walk(kids[i], depth + 1);
        if (child) node.children.push(child);
      }
      return node;
    }

    var root = value.root && typeof value.root === "object" ? walk(value.root, 0) : null;
    return {
      trusted: true,
      doc: {
        version: VERSION,
        root: root,
        view: normalizeView(value.view),
        offsets: normalizeOffsets(value.offsets, seen),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 大纲文本 → 树
  // ---------------------------------------------------------------------------

  /**
   * 一行一个节点，行首缩进决定层级。
   *
   * 用**栈**而不是"除以步长"：`2 / 3 / 4` 空格都对，混着写也对，一个 tab 当
   * 两个空格。猜步长的写法遇到 `    A` 和 `  B` 这种输入会把 B 算成 A 的父节点。
   *
   * 行首的 `- ` `* ` `+ ` `# ` 一律剥掉：模型爱写列表，Markdown 导出也带它，
   * 于是"复制出去的一段再粘回来"两边能互相喂。
   *
   * 多个顶层行：第一个当根、其余收成根的**子节点**，并用 `roots` 报出发生过
   * 这件事 —— 思维导图只有一个根，直接拒绝会让模型反复重试（0022 §5）。
   */
  function parseOutline(text) {
    if (typeof text !== "string") return { ok: false, error: "outline must be a string" };
    var raw = text.replace(/\r\n?/g, "\n").split("\n");
    var rows = [];
    for (var i = 0; i < raw.length; i += 1) {
      var line = raw[i].replace(/\t/g, "  ");
      var indent = /^ */.exec(line)[0].length;
      var body = line.slice(indent);
      body = body.replace(/^(?:[-*+]\s+|#+\s+)/, "");
      body = body.replace(/\s+$/, "");
      if (!body) continue;
      if (rows.length >= MAX_NODES) {
        return { ok: false, error: "the outline has more than " + MAX_NODES + " nodes" };
      }
      var chars = points(body);
      if (chars.length > MAX_TEXT) {
        return {
          ok: false,
          error: "a line is longer than " + MAX_TEXT + " characters: " + chars.slice(0, 24).join("") + "…",
        };
      }
      rows.push({ indent: indent, text: body });
    }
    if (!rows.length) return { ok: false, error: "the outline is empty" };

    var seq = 0;
    var stack = [];
    var root = null;
    var roots = 0;
    var depth = 0;

    for (var r = 0; r < rows.length; r += 1) {
      var row = rows[r];
      while (stack.length && stack[stack.length - 1].indent >= row.indent) stack.pop();
      seq += 1;
      var node = { id: "n" + seq, text: row.text, collapsed: false, children: [] };
      var parent = stack.length ? stack[stack.length - 1].node : null;
      var level;
      if (parent) {
        parent.children.push(node);
        level = stack[stack.length - 1].depth + 1;
      } else if (!root) {
        root = node;
        roots = 1;
        level = 0;
      } else {
        root.children.push(node);
        roots += 1;
        level = 1;
      }
      if (level > MAX_DEPTH) {
        return { ok: false, error: "the outline is nested deeper than " + MAX_DEPTH + " levels" };
      }
      if (level > depth) depth = level;
      stack.push({ indent: row.indent, node: node, depth: level });
    }

    return { ok: true, root: root, nodes: seq, depth: depth, roots: roots };
  }

  // ---------------------------------------------------------------------------
  // 树上的操作（都返回新树，不改入参 —— 撤销栈靠这个）
  // ---------------------------------------------------------------------------

  function findNode(root, id) {
    if (!root) return null;
    if (root.id === id) return root;
    for (var i = 0; i < root.children.length; i += 1) {
      var hit = findNode(root.children[i], id);
      if (hit) return hit;
    }
    return null;
  }

  /** `{ parent, index }`；根节点返回 `{ parent: null, index: -1 }`；找不到返回 null */
  function locate(root, id) {
    if (!root) return null;
    if (root.id === id) return { parent: null, index: -1 };
    for (var i = 0; i < root.children.length; i += 1) {
      if (root.children[i].id === id) return { parent: root, index: i };
      var deep = locate(root.children[i], id);
      if (deep) return deep;
    }
    return null;
  }

  function parentOf(root, id) {
    var spot = locate(root, id);
    return spot ? spot.parent : null;
  }

  function countNodes(node) {
    if (!node) return 0;
    var total = 1;
    for (var i = 0; i < node.children.length; i += 1) total += countNodes(node.children[i]);
    return total;
  }

  function depthOf(node) {
    if (!node) return 0;
    var deepest = 0;
    for (var i = 0; i < node.children.length; i += 1) {
      var child = depthOf(node.children[i]);
      if (child > deepest) deepest = child;
    }
    return deepest + 1;
  }

  /** 树上最大的 `n<数字>` 编号（不是节点数 —— 删过节点的树这两者不一样） */
  function maxIdNumber(root) {
    var max = 0;
    (function walk(node) {
      if (!node) return;
      var match = /^n(\d+)$/.exec(node.id);
      if (match) {
        var n = parseInt(match[1], 10);
        if (n > max) max = n;
      }
      for (var i = 0; i < node.children.length; i += 1) walk(node.children[i]);
    })(root);
    return max;
  }

  /** 下一个可用 id：扫一遍取最大的 `n<数字>`，不单独存计数器 */
  function nextIdFor(root) {
    return "n" + (maxIdNumber(root) + 1);
  }

  /** 前序遍历：键盘 `↑↓` 走的就是这个顺序 */
  function flatten(node) {
    var out = [];
    (function walk(current, level) {
      if (!current) return;
      out.push({ id: current.id, depth: level, node: current });
      if (current.collapsed) return;
      for (var i = 0; i < current.children.length; i += 1) walk(current.children[i], level + 1);
    })(node, 0);
    return out;
  }

  /** 一个节点 + 它所有子孙的 id。拖动时整支一起挪（0033），所以要有这个 */
  function subtreeIds(root, id) {
    var node = findNode(root, id);
    if (!node) return [];
    var out = [];
    (function walk(current) {
      out.push(current.id);
      for (var i = 0; i < current.children.length; i += 1) walk(current.children[i]);
    })(node);
    return out;
  }

  /**
   * 把一组节点的偏移设成「按下时的偏移 + 这一次拖了多少」。
   *
   * `base` 永远是**按下那一刻**的偏移表，不是上一帧的 —— 每帧都从同一个底算，
   * 拖回来才能精确回到原处（累加会漂）。
   *
   * `snap` 给行高（28）时，把**结果的纵坐标**吸到整数行。吸结果而不是吸位移：
   * 底本来就在行上，吸结果才会让"拖三次"和"拖一次"落在同一格。
   */
  function shiftOffsets(base, ids, dx, dy, snap) {
    var out = cloneOffsets(base);
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var at = out[id] || [0, 0];
      var x = Math.round(at[0] + dx);
      var y = Math.round(at[1] + dy);
      if (snap) y = Math.round(y / snap) * snap;
      if (x || y) out[id] = [x, y];
      else delete out[id];
    }
    return out;
  }

  function addChild(root, id, text) {
    if (!root) return { root: root, id: null };
    var next = cloneNode(root);
    var parent = findNode(next, id);
    if (!parent) return { root: root, id: null };
    var fresh = { id: nextIdFor(next), text: cleanText(text || ""), collapsed: false, children: [] };
    parent.children.push(fresh);
    parent.collapsed = false;
    return { root: next, id: fresh.id };
  }

  function addSibling(root, id, text) {
    if (!root) return { root: root, id: null };
    var spot = locate(root, id);
    if (!spot || !spot.parent) return { root: root, id: null };
    var next = cloneNode(root);
    var target = locate(next, id);
    var fresh = { id: nextIdFor(next), text: cleanText(text || ""), collapsed: false, children: [] };
    target.parent.children.splice(target.index + 1, 0, fresh);
    return { root: next, id: fresh.id };
  }

  /** `Shift+Tab`：提一级 —— 变成父节点的下一个兄弟，自己的子树整体跟着走 */
  function promote(root, id) {
    if (!root) return { root: root, moved: false };
    var spot = locate(root, id);
    if (!spot || !spot.parent) return { root: root, moved: false };
    var grand = locate(root, spot.parent.id).parent;
    if (!grand) return { root: root, moved: false };
    var next = cloneNode(root);
    var here = locate(next, id);
    var grandSpot = locate(next, here.parent.id);
    var node = here.parent.children.splice(here.index, 1)[0];
    grandSpot.parent.children.splice(grandSpot.index + 1, 0, node);
    return { root: next, moved: true };
  }

  /** `Alt+↑↓`：和相邻的兄弟换位置 */
  function reorder(root, id, delta) {
    if (!root || !delta) return { root: root, moved: false };
    var spot = locate(root, id);
    if (!spot || !spot.parent) return { root: root, moved: false };
    var next = cloneNode(root);
    var here = locate(next, id);
    var siblings = here.parent.children;
    var to = here.index + (delta > 0 ? 1 : -1);
    if (to < 0 || to >= siblings.length) return { root: root, moved: false };
    var held = siblings[here.index];
    siblings[here.index] = siblings[to];
    siblings[to] = held;
    return { root: next, moved: true };
  }

  /** 删子树。删的是根 → 整张图没了（`root: null`） */
  function removeNode(root, id) {
    if (!root) return { root: root, removed: false };
    if (root.id === id) return { root: null, removed: true };
    var spot = locate(root, id);
    if (!spot || !spot.parent) return { root: root, removed: false };
    var next = cloneNode(root);
    var here = locate(next, id);
    here.parent.children.splice(here.index, 1);
    return { root: next, removed: true };
  }

  function setText(root, id, text) {
    if (!root) return { root: root, changed: false };
    var clean = cleanText(text);
    var next = cloneNode(root);
    var node = findNode(next, id);
    if (!node || node.text === clean) return { root: root, changed: false };
    node.text = clean;
    return { root: next, changed: true };
  }

  function setCollapsed(root, id, collapsed) {
    if (!root) return { root: root, changed: false };
    var next = cloneNode(root);
    var node = findNode(next, id);
    if (!node || node.collapsed === !!collapsed) return { root: root, changed: false };
    node.collapsed = !!collapsed;
    return { root: next, changed: true };
  }

  /** agent `append` 用：把一棵（解析好的）子树挂到某个节点下面 */
  function attachSubtree(root, parentId, subtree) {
    if (!root || !subtree) return { root: root, added: 0 };
    var next = cloneNode(root);
    var parent = parentId ? findNode(next, parentId) : next;
    if (!parent) return { root: root, added: 0 };
    var base = maxIdNumber(next);
    var copy = cloneNode(subtree);
    // 进来的子树自带 n1..nK，和已有的撞了：整棵接着**最大编号**往下排。
    // 按节点数排是错的：删过节点的树里 `n1,n2,n5` 只有三个节点，接出来是 n4，
    // 而 n4 之后又轮到 n5 —— 两个节点共用一个 id，摆位（按 id 存）会互相打架。
    (function renumber(node, seq) {
      seq.value += 1;
      node.id = "n" + (base + seq.value);
      for (var i = 0; i < node.children.length; i += 1) renumber(node.children[i], seq);
    })(copy, { value: 0 });
    parent.children.push(copy);
    parent.collapsed = false;
    return { root: next, added: countNodes(copy) };
  }

  // ---------------------------------------------------------------------------
  // 布局
  // ---------------------------------------------------------------------------

  function nodeWidth(text, measure) {
    var width = 0;
    try {
      width = measure(text || " ") || 0;
    } catch (error) {
      width = 0;
    }
    return Math.round(clamp(width + PAD_X, MIN_W, MAX_W));
  }

  /**
   * 树 → 坐标。
   *
   * 一列一层：每个叶子占一行 28px，父节点的纵坐标是子树跨度的中点（这样
   * "父节点在自己的孩子之间"，而不是"贴着第一个孩子"）。列宽取该层最宽的那个
   * 节点，`x = 16 + Σ(上一层最宽 + 40)` —— 所以同一层的节点左边缘对齐。
   *
   * 折叠的节点不往下走，子树只占一行，`hidden` 告诉渲染层画 `+N`。
   *
   * `offsets` 是**摆位**（0033）：每个节点在算出来的位置上再加 `[dx, dy]`。
   * 注意 `place()` 往回返的仍是**没偏移**的中点 —— 孩子被拖走了，父节点不能
   * 跟着挪，否则"只有被拖的这一支动"就不成立了。
   */
  function layout(root, options) {
    var opts = options || {};
    var measure = typeof opts.measure === "function" ? opts.measure : function (text) {
      return points(text || "").length * 12;
    };
    var row = opts.row || ROW;
    var colGap = opts.colGap == null ? COL_GAP : opts.colGap;
    var margin = opts.pad == null ? MARGIN : opts.pad;
    var nodeH = opts.nodeH || NODE_H;
    var offsets = opts.offsets && typeof opts.offsets === "object" ? opts.offsets : null;

    if (!root) return { nodes: [], links: [], bounds: { w: 0, h: 0, minX: 0, minY: 0 }, rows: 0 };

    var widths = Object.create(null);
    var maxCol = [];
    var order = [];

    (function collect(node, depth) {
      var width = nodeWidth(node.text, measure);
      widths[node.id] = width;
      if (maxCol[depth] == null || width > maxCol[depth]) maxCol[depth] = width;
      order.push({ node: node, depth: depth });
      if (node.collapsed) return;
      for (var i = 0; i < node.children.length; i += 1) collect(node.children[i], depth + 1);
    })(root, 0);

    var colX = [];
    var acc = margin;
    for (var d = 0; d < maxCol.length; d += 1) {
      colX[d] = acc;
      acc += (maxCol[d] || 0) + colGap;
    }

    var spots = Object.create(null);
    var leaves = 0;

    (function place(node, depth) {
      var children = node.collapsed ? [] : node.children;
      var center;
      if (!children.length) {
        center = leaves * row + row / 2;
        leaves += 1;
      } else {
        var first = 0;
        var last = 0;
        for (var i = 0; i < children.length; i += 1) {
          var value = place(children[i], depth + 1);
          if (i === 0) first = value;
          last = value;
        }
        center = (first + last) / 2;
      }
      spots[node.id] = { x: colX[depth], y: center - nodeH / 2, w: widths[node.id], h: nodeH, center: center };
      var shift = offsets && offsets[node.id];
      if (shift) {
        spots[node.id].x += shift[0];
        spots[node.id].y += shift[1];
        // center 是文字的基线、左边那个小方点、连线端点的纵坐标 —— 它必须跟着偏，
        // 否则框挪了、字和线还在原地
        spots[node.id].center += shift[1];
      }
      return center;
    })(root, 0);

    var nodes = [];
    var byId = Object.create(null);
    for (var i = 0; i < order.length; i += 1) {
      var entry = order[i];
      var spot = spots[entry.node.id];
      var item = {
        id: entry.node.id,
        text: entry.node.text,
        tone: entry.node.tone || "neutral",
        depth: entry.depth,
        x: spot.x,
        y: round(spot.y),
        w: spot.w,
        h: spot.h,
        center: round(spot.center),
        hidden: entry.node.collapsed ? countNodes(entry.node) - 1 : 0,
        hasChildren: entry.node.children.length > 0,
      };
      nodes.push(item);
      byId[item.id] = item;
    }

    var links = [];
    for (var j = 0; j < order.length; j += 1) {
      var parent = order[j].node;
      if (parent.collapsed) continue;
      var from = byId[parent.id];
      for (var k = 0; k < parent.children.length; k += 1) {
        var child = byId[parent.children[k].id];
        if (!child) continue;
        var x1 = from.x + from.w;
        var y1 = from.center;
        var x2 = child.x;
        var y2 = child.center;
        var mid = (x1 + x2) / 2;
        links.push({
          from: from.id,
          to: child.id,
          d:
            "M " + round(x1) + " " + round(y1) +
            " C " + round(mid) + " " + round(y1) +
            ", " + round(mid) + " " + round(y2) +
            ", " + round(x2) + " " + round(y2),
        });
      }
    }

    // `w` / `h` 是**右沿 / 下沿**（0022 的断言按这个钉的）；拖到原点的左上角会出
    // 负数，所以另外记左沿 / 上沿 —— `fitView` 按"右沿 - 左沿"这个跨度算，不然
    // 负坐标那个节点会被切在屏幕外
    var bounds = { w: 0, h: 0, minX: 0, minY: 0 };
    for (var n = 0; n < nodes.length; n += 1) {
      bounds.w = Math.max(bounds.w, nodes[n].x + nodes[n].w);
      bounds.h = Math.max(bounds.h, nodes[n].y + nodes[n].h);
      if (nodes[n].x < bounds.minX) bounds.minX = nodes[n].x;
      if (nodes[n].y < bounds.minY) bounds.minY = nodes[n].y;
    }

    return { nodes: nodes, links: links, bounds: bounds, rows: leaves };
  }

  /** 屏幕点 → 命中哪个节点（画在后面的先命中） */
  function hitTest(result, view, screenX, screenY) {
    var v = view || { x: 0, y: 0, zoom: 1 };
    var zoom = v.zoom || 1;
    var x = (screenX - v.x) / zoom;
    var y = (screenY - v.y) / zoom;
    var nodes = (result && result.nodes) || [];
    for (var i = nodes.length - 1; i >= 0; i -= 1) {
      var node = nodes[i];
      if (x >= node.x && x <= node.x + node.w && y >= node.y && y <= node.y + node.h) {
        return { kind: "node", id: node.id };
      }
    }
    return { kind: null, id: null };
  }

  function screenToWorld(view, screenX, screenY) {
    var zoom = (view && view.zoom) || 1;
    return { x: (screenX - view.x) / zoom, y: (screenY - view.y) / zoom };
  }

  function clampZoom(zoom) {
    return round(clamp(zoom, ZOOM_MIN, ZOOM_MAX));
  }

  /**
   * 把整张图装进一块画布大小里；不放大（1 = 原尺寸就够）。
   *
   * 跨度按 `右沿 - 左沿` 算，不是直接拿 `w`：拖到原点左上角的节点会出负坐标，
   * 只看右沿的话那个节点会被切在屏幕外。
   */
  function fitView(bounds, width, height) {
    if (!bounds || !width || !height) return { x: 0, y: 0, zoom: 1 };
    var minX = isFinite(bounds.minX) ? bounds.minX : 0;
    var minY = isFinite(bounds.minY) ? bounds.minY : 0;
    var spanW = bounds.w - minX;
    var spanH = bounds.h - minY;
    if (!spanW || !spanH) return { x: 0, y: 0, zoom: 1 };
    var zoom = clampZoom(Math.min(width / (spanW + MARGIN * 2), height / (spanH + MARGIN * 2)));
    if (zoom > 1) zoom = 1;
    return {
      x: round((width - spanW * zoom) / 2 - MARGIN * zoom - minX * zoom),
      y: round((height - spanH * zoom) / 2 - MARGIN * zoom - minY * zoom),
      zoom: zoom,
    };
  }

  /** 缩放到某一点（那个点在屏幕上不动） */
  function zoomAt(view, screenX, screenY, nextZoom) {
    var zoom = clampZoom(nextZoom);
    var world = screenToWorld(view, screenX, screenY);
    return {
      x: round(screenX - world.x * zoom),
      y: round(screenY - world.y * zoom),
      zoom: zoom,
    };
  }

  // ---------------------------------------------------------------------------
  // 导出：三种别人的格式
  // ---------------------------------------------------------------------------

  /** 缩进大纲（纯文本）。折叠的子树照样导出 —— 导出的是内容，不是视图 */
  function toOutline(root) {
    if (!root) return "";
    var lines = [];
    (function walk(node, depth) {
      lines.push(new Array(depth + 1).join("  ") + node.text);
      for (var i = 0; i < node.children.length; i += 1) walk(node.children[i], depth + 1);
    })(root, 0);
    return lines.join("\n");
  }

  function toMarkdown(root) {
    if (!root) return "";
    var lines = [];
    (function walk(node, depth) {
      lines.push(new Array(depth + 1).join("  ") + "- " + (node.text || "-"));
      for (var i = 0; i < node.children.length; i += 1) walk(node.children[i], depth + 1);
    })(root, 0);
    return lines.join("\n");
  }

  /**
   * Mermaid 的 `mindmap`。
   *
   * 括号和方括号在 Mermaid 里是**语法**（`id[文字]` / `id((文字))`），冒号是形状
   * 分隔符 —— 节点文字里出现它们，整张图就渲染不出来。所以一律换成 `-`，换行
   * 压成空格。
   */
  function mermaidText(text) {
    var clean = String(text || "").replace(/[()[\]{}:]/g, "-").replace(/\s+/g, " ").trim();
    return clean || "-";
  }

  function toMermaid(root) {
    if (!root) return "mindmap";
    var lines = ["mindmap"];
    (function walk(node, depth) {
      lines.push(new Array(depth + 2).join("  ") + mermaidText(node.text));
      for (var i = 0; i < node.children.length; i += 1) walk(node.children[i], depth + 1);
    })(root, 0);
    return lines.join("\n");
  }

  function escapeXml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** OPML 2.0。XMind / 幕布 / 大纲工具都能读；XML 声明固定写死，少一行就是乱码 */
  function toOpml(root) {
    var lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', "  <head>", "    <title>Mind map</title>", "  </head>", "  <body>"];
    (function walk(node, depth) {
      var pad = new Array(depth + 3).join("  ");
      var head = pad + '<outline text="' + escapeXml(node.text) + '"';
      if (!node.children.length) {
        lines.push(head + "/>");
        return;
      }
      lines.push(head + ">");
      for (var i = 0; i < node.children.length; i += 1) walk(node.children[i], depth + 1);
      lines.push(pad + "</outline>");
    })(root, 0);
    lines.push("  </body>");
    lines.push("</opml>");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------

  global.__latticeMindmapCore = {
    VERSION: VERSION,
    MAX_NODES: MAX_NODES,
    MAX_DEPTH: MAX_DEPTH,
    MAX_TEXT: MAX_TEXT,
    MAX_SHIFT: MAX_SHIFT,
    MIN_W: MIN_W,
    MAX_W: MAX_W,
    ROW: ROW,
    COL_GAP: COL_GAP,
    NODE_H: NODE_H,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    TONES: TONES,
    clamp: clamp,
    points: points,
    cleanText: cleanText,
    emptyDoc: emptyDoc,
    cloneDoc: cloneDoc,
    cloneNode: cloneNode,
    cloneOffsets: cloneOffsets,
    normalizeDoc: normalizeDoc,
    normalizeView: normalizeView,
    normalizeOffsets: normalizeOffsets,
    parseOutline: parseOutline,
    findNode: findNode,
    locate: locate,
    parentOf: parentOf,
    countNodes: countNodes,
    depthOf: depthOf,
    nextIdFor: nextIdFor,
    maxIdNumber: maxIdNumber,
    flatten: flatten,
    subtreeIds: subtreeIds,
    shiftOffsets: shiftOffsets,
    addChild: addChild,
    addSibling: addSibling,
    promote: promote,
    reorder: reorder,
    removeNode: removeNode,
    setText: setText,
    setCollapsed: setCollapsed,
    attachSubtree: attachSubtree,
    layout: layout,
    nodeWidth: nodeWidth,
    hitTest: hitTest,
    screenToWorld: screenToWorld,
    clampZoom: clampZoom,
    fitView: fitView,
    zoomAt: zoomAt,
    toOutline: toOutline,
    toMarkdown: toMarkdown,
    toMermaid: toMermaid,
    mermaidText: mermaidText,
    toOpml: toOpml,
    escapeXml: escapeXml,
  };
})(window);
