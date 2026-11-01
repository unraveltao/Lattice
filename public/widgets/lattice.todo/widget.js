/**
 * 待办清单组件
 *
 * 数据全部走 storage 桥，组件自己不碰 localStorage ——
 * 沙箱 iframe 是不透明源，localStorage 本来就不可用，
 * 这样也顺带保证了"同一组件的多个实例共享同一份数据"。
 *
 * 0.3.0 起一件事分三档：L1 想法 / L2 目标 / L3 执行（见 docs/design/LAT-0038）。
 * 档位是每条待办自己的一个字段（`level`），不是父子挂靠 —— 升格就是改这个数字，
 * 条目的 id 不变。三档在界面上是页签，一次只看一档。
 */
(function () {
  "use strict";

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
   * 卡片上的字都是这个组件自己的（"还剩 2 项"、"升格"），平台只负责告诉
   * 我们现在是哪一门。两件事都要做：启动时问一次 `lang.get`，用户中途换
   * 语言再收 `language` 推送 —— 只读一次，换语言卡片就不动。
   *
   * 首帧按 HTML 里写死的中文画（不变量 18）；英文界面等 `lang.get` 回来
   * 那一趟再翻，不为这几十毫秒画"加载中"。
   */
  var lang = "zh";

  /** 一句话的两种写法，按当前界面语言挑 */
  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  /*
   * ---------- 三档 ----------
   *
   * L1 想法 / L2 目标 / L3 执行，是**具体化程度**，不是时间视野、也不是父子挂靠。
   * 一条待办永远只在一档里，升格是改 `level`，不是另加一条 —— 所以 id 不变、
   * 优先级不变、勾没勾也不变。
   *
   * 认不出来一律当 3（执行层）：老数据没有这个字段，脏值也不该让整条消失。
   * 这和 readPriority 是同一个写法 —— 认不出就当没设，不抛、不猜。
   */
  var LEVEL_NAME = {
    1: { zh: "想法", en: "Idea" },
    2: { zh: "目标", en: "Goal" },
    3: { zh: "执行", en: "Action" },
  };
  var DEFAULT_LEVEL = 3;

  function readLevel(value) {
    var n = typeof value === "number" ? value : Number(value);
    return n === 1 || n === 2 || n === 3 ? n : DEFAULT_LEVEL;
  }

  function levelName(n) {
    return LEVEL_NAME[n][lang];
  }

  /** 标题栏左边那一格：「L3 · 执行」—— 三档的含义只有这一个地方说 */
  function levelTag(n) {
    return "L" + n + " · " + levelName(n);
  }

  // ---------- 业务 ----------
  var STORAGE_KEY = "items";
  var VIEW_KEY = "view";
  var items = [];
  var level = DEFAULT_LEVEL;

  /*
   * 优先级：三级，红 / 黄 / 绿，用一个小圆点表示。
   *
   * 点一下从"没设"开始依次是 红 → 黄 → 绿 → 没设。第一下给红，是因为
   * "这条重要"才是最常见的动作，别让人为了标个紧急先点两下。
   *
   * 没设的那一档画成空心圈而不是不画：一来整列对得齐，二来空心的圈
   * 本身就是"这儿可以点"的提示 —— 只在 hover 时才出现的按钮，用户
   * 永远发现不了。
   *
   * 它和档位是**两个正交的轴**：一条 L3 的执行项照样可以是红色。
   */
  var PRIORITY_ORDER = ["high", "med", "low"];
  var PRIORITY_LABEL = {
    high: { zh: "高", en: "High" },
    med: { zh: "中", en: "Medium" },
    low: { zh: "低", en: "Low" },
  };

  /** 圆点读给屏幕阅读器听的那一档，跟着界面语言走 */
  function priorityLabel(key) {
    return PRIORITY_LABEL[key][lang];
  }

  /** 磁盘上的老数据没有这个字段，也可能有脏值 —— 认不出来就当没设 */
  function readPriority(value) {
    return PRIORITY_ORDER.indexOf(value) >= 0 ? value : null;
  }

  function nextPriority(current) {
    if (!current) return "high";
    var at = PRIORITY_ORDER.indexOf(current);
    return at === PRIORITY_ORDER.length - 1 ? null : PRIORITY_ORDER[at + 1];
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
      // 空 key = 整份文件被替换过，什么都要重读
      if (!key || key === STORAGE_KEY) reload();
      if (!key || key === VIEW_KEY) reloadView();
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

  var formEl = document.getElementById("form");
  var inputEl = document.getElementById("input");
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var metaEl = document.getElementById("meta");
  var levelEl = document.getElementById("levelName");
  var tabsEl = document.getElementById("tabs");

  /*
   * 同一个组件可能在画布上有一个实例、桌面上又有一个，各自持一份内存列表。
   * 平台在每次落盘后广播 store-changed，收到就重读 —— 否则后写的那份会把
   * 对方刚加的事项整块覆盖掉，用户看到的是"加了几条，回头只剩一条"。
   *
   * 两个刹车：
   *   writing     自己的写入还在飞，这时候读到的可能是旧文件，等它落地再读
   *   pendingReload 在飞期间收到的通知，落地后补一次
   */
  var writing = 0;
  var pendingReload = false;

  /**
   * 落盘失败只在标题栏那一小格里说一句，不动输入框。
   * 以前是把提示写进 input.placeholder —— 出错一次，那句 "Add a to-do,
   * press Enter" 就永远回不来了。
   */
  var saveError = false;

  /** 当前这一档的条目，按 items 里的相对顺序 —— DOM 里那几行和它一一对应 */
  function viewItems() {
    return items.filter(function (item) {
      return readLevel(item.level) === level;
    });
  }

  function paintInput() {
    inputEl.placeholder = say("加一条 L" + level, "Add to L" + level);
  }

  function paintTabs() {
    Array.prototype.forEach.call(tabsEl.children, function (tab) {
      var n = Number(tab.dataset.level);
      tab.setAttribute("aria-selected", n === level ? "true" : "false");
    });
  }

  function paintMeta() {
    levelEl.textContent = levelTag(level);

    if (saveError) {
      metaEl.textContent = say("未保存", "Not saved");
      metaEl.classList.add("is-error");
      return;
    }
    metaEl.classList.remove("is-error");
    metaEl.title = "";

    var list = viewItems();
    if (list.length === 0) {
      metaEl.textContent = "";
      return;
    }
    // 想法没有"完成"这回事（那一档不画勾选框），所以它的计数就是总条数
    if (level === 1) {
      metaEl.textContent = say(
        list.length + " 条",
        list.length + (list.length === 1 ? " item" : " items"),
      );
      return;
    }
    var left = 0;
    list.forEach(function (item) {
      if (!item.done) left += 1;
    });
    // 中文没有复数，别照搬 "left" 的结构：还剩几项，全勾完就是全部完成
    metaEl.textContent =
      left === 0 ? say("全部完成", "All done") : say("还剩 " + left + " 项", left + " left");
  }

  function persist() {
    writing += 1;
    call("storage.set", { key: STORAGE_KEY, value: items })
      .then(function () {
        if (!saveError) return;
        saveError = false;
        paintMeta();
      })
      .catch(function (error) {
        saveError = true;
        paintMeta();
        metaEl.title =
          error.code === "permission_denied"
            ? say("保存需要存储权限", "Storage permission required to save")
            : say("保存失败", "Could not save");
      })
      .then(function () {
        writing -= 1;
        if (writing === 0 && pendingReload) {
          pendingReload = false;
          reload();
        }
      });
  }

  /** 从磁盘重读。内容没变就不重画，免得自己的回声把列表抖一下 */
  function reload() {
    if (writing > 0) {
      pendingReload = true;
      return;
    }
    // 拖到一半被重画，手里那个 li 就成了离树的死节点 —— 等松手再补
    if (drag) {
      pendingReload = true;
      return;
    }
    call("storage.get", { key: STORAGE_KEY })
      .then(function (value) {
        if (!Array.isArray(value)) return;
        var next = value.filter(function (item) {
          return item && typeof item.text === "string";
        });
        if (JSON.stringify(next) === JSON.stringify(items)) return;
        items = next;
        render();
      })
      .catch(function () {});
  }

  /*
   * 当前看哪一档也落盘（键 `view`）。它不是"界面状态"，是"这个人现在在干哪一档"，
   * 所以重启之后要回到原处。代价：它按 widgetId 存，两个宿主会跟着一起切档 ——
   * 同一份清单本来就该长一个样，和 store-changed 一个语义。
   */
  function persistView() {
    call("storage.set", { key: VIEW_KEY, value: { level: level } }).catch(function () {
      /* 存不下去只影响"下次重启回到哪档"，内存里照样能切 */
    });
  }

  function reloadView() {
    call("storage.get", { key: VIEW_KEY })
      .then(function (value) {
        var next = readLevel(value && value.level);
        if (next === level) return;
        level = next;
        render();
      })
      .catch(function () {});
  }

  /**
   * 用户是否已经动过这份列表。
   *
   * 载入是异步的：用户可能在磁盘内容回来之前就加了一条。那种情况下
   * 磁盘上的旧列表优先级最低，不能把它盖到用户刚改完的列表上 ——
   * 否则新加的那条会当场消失。
   */
  var touched = false;

  /** 改完状态统一走这里：重画 + 落盘 */
  function commit() {
    touched = true;
    render();
    persist();
  }

  function setView(next) {
    if (next === level) return;
    level = next;
    render();
    persistView();
  }

  /*
   * ---------- 换档 ----------
   *
   * 页签把另外两档藏起来了，所以"跨档拖动"没有落点。换档只有两条路：
   * 行尾 ⋯ 菜单（保证有的那条），和"拖到页签上松手"（快捷手势）。
   */

  /** 升格 / 降格。id 不变，所以优先级、勾没勾都跟着走 */
  function moveTo(item, target) {
    if (!item) return false;
    var from = readLevel(item.level);
    if (from === target) return false;
    item.level = target;
    // 换档后插到目标档最上面：切过去第一眼就看见它
    items = [item].concat(
      items.filter(function (candidate) {
        return candidate !== item;
      }),
    );
    if (target !== level) bumpTab(target);
    commit();
    return true;
  }

  var bumpTimer = 0;
  function bumpTab(target) {
    Array.prototype.forEach.call(tabsEl.children, function (tab) {
      tab.classList.toggle("is-bumped", Number(tab.dataset.level) === target);
    });
    window.clearTimeout(bumpTimer);
    bumpTimer = window.setTimeout(function () {
      Array.prototype.forEach.call(tabsEl.children, function (tab) {
        tab.classList.remove("is-bumped");
      });
    }, 600);
  }

  function removeItem(item) {
    items = items.filter(function (candidate) {
      return candidate !== item;
    });
    commit();
  }

  /*
   * ---------- 行尾的 ⋯ ----------
   *
   * 菜单挂在 body 上而不是行里：列表有 overflow-y: auto，挂进去一靠近底边
   * 就被裁掉半截。关闭有三条路 —— 点别处、按 Esc、重画。
   */
  var menuEl = null;
  var openMore = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    if (openMore) {
      openMore.setAttribute("aria-expanded", "false");
      openMore = null;
    }
  }

  function openMenu(item, row, moreBtn) {
    closeMenu();
    var from = readLevel(item.level);
    var entries = [
      { label: say("升格", "Promote"), to: from + 1, disabled: from >= 3 },
      { label: say("降格", "Demote"), to: from - 1, disabled: from <= 1 },
      { label: say("删除", "Delete"), to: 0, danger: true },
    ];

    var el = document.createElement("div");
    el.className = "todo-menu";
    el.setAttribute("role", "menu");

    entries.forEach(function (entry) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "todo-menu-item" + (entry.danger ? " is-danger" : "");
      btn.setAttribute("role", "menuitem");
      btn.disabled = !!entry.disabled;
      btn.textContent = entry.label;
      if (entry.to && !entry.disabled) {
        var key = document.createElement("span");
        key.className = "todo-menu-key";
        key.textContent = "L" + entry.to;
        btn.appendChild(key);
      }
      btn.addEventListener("click", function (event) {
        event.stopPropagation();
        closeMenu();
        if (entry.danger) removeItem(item);
        else moveTo(item, entry.to);
      });
      el.appendChild(btn);
    });

    document.body.appendChild(el);
    // 记账。少了这一行，closeMenu 永远早退（menuEl 恒为 null），
    // 每开一次就多留一个菜单在 DOM 里 —— 点第三行的时候第一行的菜单还在。
    menuEl = el;

    // 贴着行的右下角。放不下就**往上收**，而不是整个翻到行上方 ——
    // 卡片只有 240 高，翻上去会盖住页签，而换档正是从这个菜单发起的。
    var rect = row.getBoundingClientRect();
    var box = el.getBoundingClientRect();
    var left = Math.max(4, Math.min(rect.right - box.width, window.innerWidth - box.width - 4));
    var top = rect.bottom + 4;
    if (top + box.height > window.innerHeight - 4) {
      top = Math.max(4, Math.min(rect.top, window.innerHeight - box.height - 4));
    }
    el.style.left = left + "px";
    el.style.top = top + "px";

    openMore = moreBtn;
    moreBtn.setAttribute("aria-expanded", "true");
  }

  document.addEventListener(
    "pointerdown",
    function (event) {
      if (!menuEl) return;
      if (menuEl.contains(event.target)) return;
      closeMenu();
    },
    true,
  );

  /*
   * ---------- 拖动排序 ----------
   *
   * 自己用指针事件实现，不走 HTML5 拖放：沙箱 iframe 是不透明源，跨文档的
   * dataTransfer 本来就靠不住；自己算还能决定"跟手那一行怎么动、别的行怎么
   * 让位"，不必受浏览器那套拖影的摆布。
   *
   * 三个容易翻车的地方：
   *   1. 整行可拖，但整行也"点一下勾掉" —— 必须过阈值才认成拖动，而且抬手
   *      之后浏览器还会补一次 click，得把它吃掉，否则拖完那条被顺手勾上。
   *   2. 圆点 / 勾选框 / ⋯ 自己有点击语义，从它们身上按下不许起拖。
   *   3. 列表能滚。指针停在上下边缘要自动滚；滚了之后"跟手"的位移必须跟着
   *      scrollTop 一起算，否则指针没动、行却在往回跑。
   *
   * 0.3.0 多一条：指针停在页签上 = 松手换档，这时候不排序、不滚列表。
   */
  var DRAG_SLOP = 4;
  var EDGE_SCROLL = 20;
  var EDGE_SPEED = 8;

  var drag = null;
  var dragRaf = 0;
  var lastPointerY = 0;
  var suppressClick = false;

  /** 行在列表内容坐标里的位置 —— offsetTop 不受滚动影响，算目标位次用它 */
  function rowRects() {
    return Array.prototype.map.call(listEl.children, function (row) {
      return { top: row.offsetTop, h: row.offsetHeight };
    });
  }

  /** flex 的 gap 拿不到计算值（老版本），用相邻两行反推 */
  function rowGap(rects) {
    if (rects.length < 2) return 0;
    return Math.max(0, rects[1].top - rects[0].top - rects[0].h);
  }

  /** 指针落在哪颗页签上；不在页签区返回 null（0 不能当哨兵 —— 0 会被 readLevel 吃成 3） */
  function tabAt(y) {
    for (var i = 0; i < tabsEl.children.length; i += 1) {
      var box = tabsEl.children[i].getBoundingClientRect();
      if (y >= box.top && y <= box.bottom) return Number(tabsEl.children[i].dataset.level);
    }
    return null;
  }

  function paintTabHint(target) {
    Array.prototype.forEach.call(tabsEl.children, function (tab) {
      tab.classList.toggle("is-drop", Number(tab.dataset.level) === target);
    });
  }

  function beginDrag(event, row, item) {
    if (event.button !== 0) return;
    // 只剩一条时没有"换位"可言，但**换档**还得能拖 —— 所以这里不按条数早退
    var from = Array.prototype.indexOf.call(listEl.children, row);
    if (from < 0) return;
    drag = {
      row: row,
      item: item,
      from: from,
      to: from,
      tabLevel: null,
      pointerId: event.pointerId,
      startY: event.clientY,
      startScroll: listEl.scrollTop,
      rects: rowRects(),
      moved: false,
    };
    lastPointerY = event.clientY;
    // 合成事件没有真实指针，capture 会抛 NotFoundError —— 拿不到就算了，
    // document 上的监听照样收得到（真机上是真指针，capture 保证移出窗口也不丢）
    try {
      row.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 没有活动指针，无所谓 */
    }
  }

  function paintDrag() {
    var state = drag;
    var rawDy = lastPointerY - state.startY + (listEl.scrollTop - state.startScroll);
    // 拖到页签上时，行会顶出列表上沿被 overflow 裁掉 —— 夹在列表里，
    // 靠页签的虚线框说明"松手就换档"
    var minDy = -(state.row.offsetTop - listEl.scrollTop);
    state.row.style.transform = "translateY(" + Math.max(rawDy, minDy) + "px)";

    var target = tabAt(lastPointerY);
    state.tabLevel = target;
    if (target) {
      // 页签区不是排序落点：其余行回原位，只留页签高亮
      state.to = state.from;
      Array.prototype.forEach.call(listEl.children, function (row) {
        if (row !== state.row) row.style.transform = "";
      });
      paintTabHint(target);
      return;
    }
    paintTabHint(null);

    // 指针换算到内容坐标：比"每条的中点"低几条，就落在第几位
    var box = listEl.getBoundingClientRect();
    var y = lastPointerY - box.top + listEl.scrollTop;
    var to = 0;
    for (var i = 0; i < state.rects.length; i += 1) {
      if (y > state.rects[i].top + state.rects[i].h / 2) to = i;
    }
    state.to = to;

    // 其余行让位：挪到目标位次之前的整体下移一格，之后的整体上移一格
    var step = state.rects[state.from].h + rowGap(state.rects);
    var rows = listEl.children;
    for (var j = 0; j < rows.length; j += 1) {
      if (j === state.from) continue;
      var shift = 0;
      if (to < state.from && j >= to && j < state.from) shift = step;
      else if (to > state.from && j > state.from && j <= to) shift = -step;
      rows[j].style.transform = shift ? "translateY(" + shift + "px)" : "";
    }
  }

  function dragTick() {
    dragRaf = 0;
    if (!drag || !drag.moved) return;
    // 停在页签上时不该再滚列表 —— 那会让"松手换档"变成"顺手滚走"
    if (drag.tabLevel) {
      dragRaf = window.requestAnimationFrame(dragTick);
      return;
    }
    var box = listEl.getBoundingClientRect();
    var delta = 0;
    if (lastPointerY < box.top + EDGE_SCROLL) delta = -EDGE_SPEED;
    else if (lastPointerY > box.bottom - EDGE_SCROLL) delta = EDGE_SPEED;
    if (delta) {
      var before = listEl.scrollTop;
      listEl.scrollTop = before + delta;
      if (listEl.scrollTop !== before) paintDrag();
    }
    dragRaf = window.requestAnimationFrame(dragTick);
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    lastPointerY = event.clientY;
    if (!drag.moved) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_SLOP) return;
      drag.moved = true;
      drag.row.classList.add("is-dragging");
      paintDrag();
      if (!dragRaf) dragRaf = window.requestAnimationFrame(dragTick);
      return;
    }
    paintDrag();
  }

  /**
   * 在当前这一档里换位。
   *
   * 传进来的是**这一档的位次**，而 items 是三档混在一起的一根数组 ——
   * 所以不能直接 splice，得先找到目标那条在 items 里的位置。
   */
  function reorderWithinLevel(from, to) {
    var view = viewItems();
    var moved = view[from];
    var anchor = view[to];
    if (!moved || !anchor) return;
    items.splice(items.indexOf(moved), 1);
    var at = items.indexOf(anchor);
    if (at < 0) {
      items.unshift(moved);
      return;
    }
    items.splice(from < to ? at + 1 : at, 0, moved);
  }

  function endDrag(keepOrder) {
    if (!drag) return;
    var state = drag;
    drag = null;
    paintTabHint(null);
    if (dragRaf) {
      window.cancelAnimationFrame(dragRaf);
      dragRaf = 0;
    }
    state.row.classList.remove("is-dragging");
    Array.prototype.forEach.call(listEl.children, function (row) {
      row.style.transform = "";
    });
    try {
      state.row.releasePointerCapture(state.pointerId);
    } catch (error) {
      /* 没 capture 过 */
    }

    // 没过阈值 = 就是点了一下，交给 click 去勾
    if (!state.moved) return;

    // 抬手之后紧跟的那次 click 是拖动的尾巴，不是"我要勾掉它"
    suppressClick = true;
    window.setTimeout(function () {
      suppressClick = false;
    }, 0);

    if (keepOrder && state.tabLevel) {
      moveTo(state.item, state.tabLevel);
      return;
    }
    if (keepOrder && state.to !== state.from) {
      reorderWithinLevel(state.from, state.to);
      commit();
      return;
    }
    if (pendingReload) {
      pendingReload = false;
      reload();
    }
  }

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", function (event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag(true);
  });
  document.addEventListener("pointercancel", function (event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag(false);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (drag) endDrag(false);
    closeMenu();
  });

  function buildRow(item) {
    var itemLevel = readLevel(item.level);
    // 想法没有"完成"这回事：它只有两个出口 —— 变成目标，或者删掉
    var isAction = itemLevel !== 1;

    var li = document.createElement("li");
    li.className = "todo-item" + (isAction && item.done ? " is-done" : "");

    var priority = readPriority(item.priority);
    var upcoming = nextPriority(priority);
    var dot = document.createElement("button");
    dot.type = "button";
    dot.className = "todo-dot";
    if (priority) dot.dataset.level = priority;
    dot.title = priority
      ? say(
          "优先级：" + priorityLabel(priority) + "，点一下切换",
          "Priority: " + priorityLabel(priority) + " — click to change",
        )
      : say("设置优先级", "Set priority");
    dot.setAttribute(
      "aria-label",
      (priority ? say("优先级：", "Priority: ") + priorityLabel(priority) : say("没有优先级", "No priority")) +
        say("。点一下", ". Click to ") +
        (upcoming
          ? say("设为" + priorityLabel(upcoming), "set " + priorityLabel(upcoming).toLowerCase())
          : say("清除", "clear it")) +
        say("。", "."),
    );
    dot.addEventListener("click", function (event) {
      event.stopPropagation();
      // 重读一次而不是用闭包里的 priority：同一行被点了好几下时，
      // 闭包里那个值是上一轮渲染的，已经过期了
      var next = nextPriority(readPriority(item.priority));
      if (next) item.priority = next;
      else delete item.priority;
      commit();
    });

    // 自绘勾选框：原生 checkbox 在沙箱 iframe 里会被画成浅色小方块，看不见
    var check = null;
    if (isAction) {
      check = document.createElement("input");
      check.type = "checkbox";
      check.className = "todo-check";
      check.checked = !!item.done;
      check.title = item.done ? say("标为未完成", "Mark as not done") : say("标为完成", "Mark as done");
      check.setAttribute("aria-label", item.text);
      check.addEventListener("change", function () {
        item.done = check.checked;
        commit();
      });
    }

    var text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = item.text;

    var more = document.createElement("button");
    more.type = "button";
    more.className = "todo-more";
    more.textContent = "⋯";
    more.title = say("更多", "More");
    more.setAttribute("aria-label", say("「" + item.text + "」的更多操作", 'More actions for "' + item.text + '"'));
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", function (event) {
      event.stopPropagation();
      if (menuEl && openMore === more) {
        closeMenu();
        return;
      }
      openMenu(item, li, more);
    });

    // 点整行都能勾：文字比那个小方框好点得多。
    // 勾选框、优先级圆点和 ⋯ 自己处理过事件，这里要让开，否则状态会翻两次。
    li.addEventListener("click", function (event) {
      if (suppressClick) return;
      if (event.target === check || event.target === more || event.target === dot) return;
      if (!isAction) return;
      item.done = !item.done;
      commit();
    });

    // 整行都能拖起来排序 / 拖到页签上换档；那三个控件自己有点击语义，从它们身上按下不算拖
    li.addEventListener("pointerdown", function (event) {
      if (event.target === check || event.target === more || event.target === dot) return;
      beginDrag(event, li, item);
    });

    li.appendChild(dot);
    if (check) li.appendChild(check);
    li.appendChild(text);
    li.appendChild(more);
    return li;
  }

  function render() {
    closeMenu();

    var list = viewItems();
    listEl.textContent = "";
    list.forEach(function (item) {
      listEl.appendChild(buildRow(item));
    });

    /*
     * 只有真被省略号截断的行才挂 title。
     * 全都挂的话，鼠标扫过列表就一路弹系统那个白底黑框的原生提示框，
     * 内容还是屏幕上已经写着的那几个字 —— 在小卡片上特别扎眼。
     * 这里要等节点进树之后量，离树时 scrollWidth 恒等于 clientWidth。
     */
    Array.prototype.forEach.call(listEl.querySelectorAll(".todo-text"), function (el) {
      if (el.scrollWidth > el.clientWidth) el.title = el.textContent;
      else el.removeAttribute("title");
    });

    // 空态按档各说各的：用户得知道"这一档是什么"，而不是一句通用的"没有内容"
    emptyEl.textContent = say("还没有 L" + level + " · " + levelName(level), "Nothing in L" + level + " yet");
    emptyEl.classList.toggle("is-visible", list.length === 0);

    paintInput();
    paintTabs();
    paintMeta();
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("待办", "Todo");
    tabsEl.setAttribute("aria-label", say("层级", "Level"));
    // 正拖着的时候不能重画 —— 手里那个 li 会变成离树的死节点
    if (drag) paintMeta();
    else render();
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    // 落点跟着当前页签走：页签已经声明了"你在看哪一档"，在那里按回车就该落那儿
    items.unshift({
      id: String(Date.now()) + Math.random().toString(16).slice(2, 6),
      text: text,
      done: false,
      level: level,
    });
    inputEl.value = "";
    commit();
  });

  tabsEl.addEventListener("click", function (event) {
    var tab = event.target.closest ? event.target.closest(".todo-tab") : null;
    if (!tab) return;
    setView(Number(tab.dataset.level));
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

  // 列表和当前档各读一次，两条都落地之后才报 ready ——
  // 早报的话，测试点开页签时 view 可能还没回来，会把用户刚点的档盖掉
  var loadItems = call("storage.get", { key: STORAGE_KEY })
    .then(function (value) {
      if (touched) return;
      if (Array.isArray(value)) {
        items = value.filter(function (item) {
          return item && typeof item.text === "string";
        });
      }
    })
    .catch(function () {});

  var loadView = call("storage.get", { key: VIEW_KEY })
    .then(function (value) {
      // 老数据里没有这个键（读到 null）、或者读到别的东西（脏值），都按 3
      level = readLevel(value && value.level);
    })
    .catch(function () {});

  Promise.all([loadItems, loadView]).then(function () {
    render();
    parent.postMessage({ __lattice: 1, type: "ready" }, "*");
  });
})();
