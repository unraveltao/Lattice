/**
 * 截止日期组件
 *
 * 一行文字就是一条：日期写在后面（`还书 3/15`、`猫粮 +3`、`体检 2026-05-01`、
 * `交房租 明天`）。解析全在 `deadline-core.js` 里，这里负责画、存、撤销。
 *
 * 三件小心事：
 *  1. 写盘是**串行**的。每改动一次就把整份列表写回去，两次写并发的话，
 *     旧的那份可能后完成，把新加的条目整块抹掉。
 *  2. 删除给 6 秒撤销。删掉一条截止日期是不可逆的（它不在组件回收站里），
 *     而这颗 × 就在行尾、和标题挨得很近。
 *  3. 别的实例改了同一份列表时，正在写盘或正在输入就先不重读 —— 否则
 *     手快的人会被自己的手速撤销一次。
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
    /* 桥目前只发八个令牌，危险色那一条是给将来留的：发下来就用，没发就用
       style.css 里的退路值（和便签的错误色一致） */
    "--lattice-danger": "--danger",
  };

  function applyTheme(tokens) {
    if (!tokens) return;
    Object.keys(THEME_MAP).forEach(function (source) {
      var value = tokens[source];
      if (value) document.documentElement.style.setProperty(THEME_MAP[source], value);
    });
  }

  var lang = "zh";

  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  // ---------- 业务 ----------
  var core = window.__latticeDeadlineCore;

  var headEl = document.getElementById("head");
  var listEl = document.getElementById("list");
  var inputEl = document.getElementById("add");

  var items = [];
  var today = core.startOfDay(new Date());
  var noStore = false;
  var writing = 0;
  var dirty = false;
  var lastWriteAt = 0;
  /** 顶上那行临时说的话（"没写日期，按明天算"） */
  var notice = "";
  var noticeTimer = 0;
  /** 刚删掉、还来得及撤销的那一条 */
  var undoItem = null;
  var undoTimer = 0;

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("截止日期", "Deadlines");
    inputEl.placeholder = say("还书 3/15", "Return book 3/15");
    inputEl.setAttribute("aria-label", say("添加一条截止日期", "Add a deadline"));
    render();
  }

  function summaryText() {
    var stats = core.summary(items, today);
    if (!stats.total) return say("还没有截止日期", "Nothing due yet");
    var text = say(
      stats.open + " 件" + (stats.done ? " · " + stats.done + " 件完成" : ""),
      stats.open + (stats.open === 1 ? " item" : " items") + (stats.done ? " · " + stats.done + " done" : ""),
    );
    if (stats.overdue) {
      text += say(" · " + stats.overdue + " 件逾期", " · " + stats.overdue + " overdue");
    }
    if (noStore) text += say(" · 不保存", " · not saved");
    return text;
  }

  function renderHead() {
    if (undoItem) {
      headEl.textContent = say("已删除「" + undoItem.title + "」· 撤销", "Deleted “" + undoItem.title + "” · Undo");
      headEl.classList.add("is-undo");
      headEl.removeAttribute("aria-disabled");
      return;
    }
    headEl.classList.remove("is-undo");
    headEl.textContent = notice || summaryText();
    // 撤销窗口关了之后这里只是一行字，不该再被键盘停住
    headEl.setAttribute("aria-disabled", "true");
  }

  function rowFor(item) {
    var due = core.parseDateKey(item.due);
    var days = due ? core.dayDiff(today, due) : 0;

    var row = document.createElement("li");
    row.className = "dl-row";
    row.setAttribute("data-done", item.done ? "true" : "false");
    row.setAttribute("data-overdue", !item.done && days < 0 ? "true" : "false");
    row.setAttribute("data-soon", !item.done && days >= 0 && days <= 3 ? "true" : "false");

    var check = document.createElement("button");
    check.type = "button";
    check.className = "dl-check";
    check.setAttribute("aria-pressed", item.done ? "true" : "false");
    check.setAttribute("aria-label", say("完成", "Mark done"));
    check.appendChild(document.createElement("span")).className = "dl-tick";
    check.addEventListener("click", function () {
      items = core.toggleItem(items, item.id);
      persist();
      render();
    });

    var title = document.createElement("span");
    title.className = "dl-title";
    title.textContent = item.title;
    title.title = item.title;

    var when = document.createElement("span");
    when.className = "dl-when";
    when.textContent = core.dueText(today, item.due, lang);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "dl-del";
    remove.textContent = "×";
    remove.setAttribute("aria-label", say("删除", "Delete"));
    remove.addEventListener("click", function () {
      removeItem(item);
    });

    row.appendChild(check);
    row.appendChild(title);
    row.appendChild(when);
    row.appendChild(remove);
    return row;
  }

  function renderList() {
    listEl.textContent = "";
    var sorted = core.sortItems(items);
    if (!sorted.length) {
      var empty = document.createElement("li");
      empty.className = "dl-empty";
      empty.textContent = say("下面写一行，日期放最后", "Type a line below, date last");
      listEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < sorted.length; i += 1) listEl.appendChild(rowFor(sorted[i]));
  }

  function render() {
    renderHead();
    renderList();
    document.body.setAttribute("data-empty", items.length ? "false" : "true");
  }

  // ---------- 落盘 ----------

  function persist() {
    if (writing > 0) {
      dirty = true;
      return;
    }
    writing += 1;
    dirty = false;
    call("storage.set", { key: "items", value: items })
      .catch(function (error) {
        if (error && error.code === "permission_denied") {
          noStore = true;
          render();
        }
      })
      .then(function () {
        writing -= 1;
        lastWriteAt = Date.now();
        if (dirty) {
          persist();
          return;
        }
        renderHead();
      });
  }

  /**
   * 别的实例写了同一份列表，重读一次。
   *
   * 三种时候不重读：自己正在写、刚写完 1.2 秒内（广播没有回执，只能按时间猜）、
   * 光标在输入框里（用户正在打字，列表换掉会让他刚看到的行跳位置）。
   */
  function reload() {
    if (writing > 0) return;
    if (Date.now() - lastWriteAt < 1200) return;
    if (document.activeElement === inputEl) return;
    call("storage.get", { key: "items" })
      .then(function (value) {
        if (writing > 0) return;
        var next = core.normalizeItems(value);
        if (JSON.stringify(next) === JSON.stringify(items)) return;
        items = next;
        render();
      })
      .catch(function () {});
  }

  // ---------- 增删 ----------

  function flashNotice(key) {
    notice = key;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      notice = "";
      renderHead();
    }, 3200);
    // 立刻画出来：调用方未必会再 render 一次（比如"只写了日期、没加条目"）
    renderHead();
  }

  function submit() {
    var raw = inputEl.value;
    var entry = core.parseLine(raw, today);
    if (!entry) {
      // 只写了个日期、或者什么都没写：提示一句，别让回车看起来像是坏了
      if (raw.trim()) flashNotice(say("先写一件事，再加日期", "Name the thing first"));
      return;
    }
    items = core.addItem(items, entry);
    inputEl.value = "";
    if (entry.guessed) flashNotice(say("没写日期，按明天算", "No date, assumed tomorrow"));
    persist();
    render();
    inputEl.focus();
  }

  function removeItem(item) {
    items = core.removeItem(items, item.id);
    undoItem = item;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () {
      undoItem = null;
      renderHead();
    }, 6000);
    persist();
    render();
  }

  headEl.addEventListener("click", function () {
    if (!undoItem) return;
    items = items.concat([undoItem]);
    undoItem = null;
    clearTimeout(undoTimer);
    persist();
    render();
  });

  inputEl.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape") {
      inputEl.value = "";
      inputEl.blur();
    }
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
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (!key || key === "items") reload();
      return;
    }
    if (data.type === "tick") {
      if (data.payload && data.payload.id === tickId) refreshToday();
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

  // ---------- 今天的日期 ----------

  var tickId = 0;

  /** 跨天之后「今天 / 明天 / 逾期 2 天」都要重算，所以只有日期变了才重画 */
  function refreshToday() {
    call("clock.now")
      .then(function (info) {
        var ms = info && typeof info.epochMs === "number" ? info.epochMs : Date.now();
        applyToday(new Date(ms));
      })
      .catch(function () {
        applyToday(new Date());
      });
  }

  function applyToday(now) {
    var next = core.startOfDay(now);
    if (next.getTime() === today.getTime()) return;
    today = next;
    render();
  }

  // ---------- 首帧与桥 ----------
  inputEl.placeholder = say("还书 3/15", "Return book 3/15");
  render();

  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到语言就按中文画 */
    });

  call("clock.now")
    .then(function (info) {
      var ms = info && typeof info.epochMs === "number" ? info.epochMs : Date.now();
      today = core.startOfDay(new Date(ms));
      render();
    })
    .catch(function () {
      /* 没时钟权限就用本机日期，倒数是同一天 */
    });

  call("storage.get", { key: "items" })
    .then(function (value) {
      items = core.normalizeItems(value);
      render();
    })
    .catch(function (error) {
      if (error && error.code === "permission_denied") {
        noStore = true;
        render();
      }
    })
    .then(function () {
      return call("schedule.every", { every: 60000 });
    })
    .then(function (grant) {
      tickId = grant && typeof grant.id === "number" ? grant.id : 0;
    })
    .catch(function () {
      /* 心跳没挂上也照样能用：只是跨天之后那几行倒数要等下次打开才更新 */
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
