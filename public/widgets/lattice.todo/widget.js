/**
 * 待办清单组件
 *
 * 数据全部走 storage 桥，组件自己不碰 localStorage ——
 * 沙箱 iframe 是不透明源，localStorage 本来就不可用，
 * 这样也顺带保证了"同一组件的多个实例共享同一份数据"。
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
   * 卡片上的字都是这个组件自己的（"还剩 2 项"、"优先级"），平台只负责告诉
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

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("待办", "Todo");
    titleEl.textContent = say("待办清单", "To-do");
    inputEl.placeholder = say("添加一条待办，回车确认", "Add a to-do, press Enter");
    emptyEl.textContent = say("还没有待办", "Nothing here yet");
    // 标题、占位符、圆点的 aria 都散在 render / paintMeta 里，重画一遍最省事。
    // 正拖着的时候不能重画 —— 手里那个 li 会变成离树的死节点
    if (drag) paintMeta();
    else render();
  }

  // ---------- 业务 ----------
  var STORAGE_KEY = "items";
  var items = [];

  /*
   * 优先级：三级，红 / 黄 / 绿，用一个小圆点表示。
   *
   * 点一下从"没设"开始依次是 红 → 黄 → 绿 → 没设。第一下给红，是因为
   * "这条重要"才是最常见的动作，别让人为了标个紧急先点两下。
   *
   * 没设的那一档画成空心圈而不是不画：一来整列对得齐，二来空心的圈
   * 本身就是"这儿可以点"的提示 —— 只在 hover 时才出现的按钮，用户
   * 永远发现不了。
   */
  var PRIORITY_ORDER = ["high", "med", "low"];
  var PRIORITY_LABEL = {
    high: { zh: "高", en: "High" },
    med: { zh: "中", en: "Medium" },
    low: { zh: "低", en: "Low" },
  };

  /** 圆点读给屏幕阅读器听的那一档，跟着界面语言走 */
  function priorityLabel(level) {
    return PRIORITY_LABEL[level][lang];
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
  var titleEl = document.querySelector(".todo-title");

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

  function paintMeta() {
    if (saveError) {
      metaEl.textContent = say("未保存", "Not saved");
      metaEl.classList.add("is-error");
      return;
    }
    metaEl.classList.remove("is-error");
    metaEl.title = "";
    if (items.length === 0) {
      metaEl.textContent = "";
      return;
    }
    var left = 0;
    items.forEach(function (item) {
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
   *   2. 圆点 / 勾选框 / 删除按钮自己有点击语义，从它们身上按下不许起拖。
   *   3. 列表能滚。指针停在上下边缘要自动滚；滚了之后"跟手"的位移必须跟着
   *      scrollTop 一起算，否则指针没动、行却在往回跑。
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

  function beginDrag(event, row) {
    if (event.button !== 0) return;
    // 只剩一条时没有"换位"可言，别让整行变成抓不动的假手柄
    if (items.length < 2) return;
    var from = Array.prototype.indexOf.call(listEl.children, row);
    if (from < 0) return;
    drag = {
      row: row,
      from: from,
      to: from,
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
    var dy = lastPointerY - state.startY + (listEl.scrollTop - state.startScroll);
    state.row.style.transform = "translateY(" + dy + "px)";

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

  function endDrag(keepOrder) {
    if (!drag) return;
    var state = drag;
    drag = null;
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

    if (keepOrder && state.to !== state.from) {
      items.splice(state.to, 0, items.splice(state.from, 1)[0]);
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
    if (event.key === "Escape" && drag) endDrag(false);
  });

  function render() {
    listEl.textContent = "";

    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "todo-item" + (item.done ? " is-done" : "");

      // 自绘勾选框：原生 checkbox 在沙箱 iframe 里会被画成浅色小方块，看不见
      var check = document.createElement("input");
      check.type = "checkbox";
      check.className = "todo-check";
      check.checked = item.done;
      check.title = item.done ? say("标为未完成", "Mark as not done") : say("标为完成", "Mark as done");
      check.setAttribute("aria-label", item.text);
      check.addEventListener("change", function () {
        item.done = check.checked;
        commit();
      });

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

      var text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = item.text;

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "todo-remove";
      remove.textContent = "×";
      remove.title = say("删除", "Delete");
      remove.setAttribute("aria-label", say("删除「" + item.text + "」", 'Delete "' + item.text + '"'));
      remove.addEventListener("click", function (event) {
        event.stopPropagation();
        items = items.filter(function (candidate) {
          return candidate.id !== item.id;
        });
        commit();
      });

      // 点整行都能勾：文字比那个小方框好点得多。
      // 勾选框、优先级圆点和删除按钮自己处理过事件，这里要让开，否则状态会翻两次。
      li.addEventListener("click", function (event) {
        if (suppressClick) return;
        if (event.target === check || event.target === remove || event.target === dot) return;
        item.done = !item.done;
        commit();
      });

      // 整行都能拖起来排序；那三个控件自己有点击语义，从它们身上按下不算拖
      li.addEventListener("pointerdown", function (event) {
        if (event.target === check || event.target === remove || event.target === dot) return;
        beginDrag(event, li);
      });

      li.appendChild(dot);
      li.appendChild(check);
      li.appendChild(text);
      li.appendChild(remove);
      listEl.appendChild(li);
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

    emptyEl.classList.toggle("is-visible", items.length === 0);
    paintMeta();
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    items.unshift({ id: String(Date.now()) + Math.random().toString(16).slice(2, 6), text: text, done: false });
    inputEl.value = "";
    commit();
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

  call("storage.get", { key: STORAGE_KEY })
    .then(function (value) {
      if (touched) return;
      if (Array.isArray(value)) {
        items = value.filter(function (item) {
          return item && typeof item.text === "string";
        });
      }
    })
    .catch(function () {})
    .then(function () {
      render();
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
