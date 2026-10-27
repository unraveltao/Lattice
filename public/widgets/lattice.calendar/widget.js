/**
 * 日历组件
 *
 * 月视图 + 一天的事件。数据是"某一天 → 一串条目"，按日期键存成一张表，
 * 没有索引、没有游标 —— 一个月最多 42 天、每天几十条，全量读进来重算一遍
 * 比维护任何索引都便宜。
 *
 * # 为什么固定六周
 *
 * 有的月份只占 5 行（比如 2 月 1 号正好是周一），有的要 6 行。按实际行数
 * 画的话，翻月份时卡片高度会跳一下 —— 桌面上的组件是钉在固定尺寸里的，
 * 跳的是里面那层内容，看起来像重新加载。所以永远画 42 格。
 *
 * # 为什么邻月的日子也能点
 *
 * 灰色日子如果点不动，用户就得先翻月再找那一天；如果点得动却还留在本月，
 * 事件看起来像记到了错的月份。所以点邻月的日子 = **跳到那个月并选中它**。
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // 桥
  // -------------------------------------------------------------------------

  var seq = 0;
  var pending = new Map();

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage(
        { __lattice: 1, type: "request", id: id, method: method, params: params },
        "*",
      );
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        var error = new Error("Bridge call timed out: " + method);
        error.code = "timeout";
        reject(error);
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
   * 平台在设置里能切中英两门，而卡片上的字是这个组件自己的 —— 平台不知道
   * "周一"对应哪句英文。所以两门都留在这儿，按 `lang.get` 挑一份；用户中途
   * 换语言，平台推一条 `language`，把已经画出去的字原地换掉（两件事都要做：
   * 只读一次 = 换语言卡片不动，只听推送 = 语言停在建文档那一刻）。
   *
   * 首帧不等桥（不变量 18）：HTML 里写死的是中文；英文界面要等 `lang.get`
   * 回来那一趟才翻。`lang` 只有 `zh` / `en` 两种 —— "跟随系统"是平台解析掉的。
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
    document.title = say("日历", "Calendar");
    // 月份、星期头、日期、全天和空态都跟语言有关，整块重画一次最稳
    paintChrome();
    renderWeek();
    renderAll();
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
    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
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

  function noop() {}

  // -------------------------------------------------------------------------
  // 日期（纯函数）
  // -------------------------------------------------------------------------

  var MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  var MONTHS_SHORT = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  /** 本地日期 → `YYYY-MM-DD`。不用 toISOString：那个是 UTC，晚上会差一天 */
  function keyOf(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function todayKey(now) {
    return keyOf(new Date(now === undefined ? Date.now() : now));
  }

  function parseKey(key) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]) - 1;
    var day = Number(match[3]);
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    return { year: year, month: month, day: day };
  }

  /**
   * 42 格（6 周 × 7 天），`month` 是 0 起的。
   *
   * `new Date(y, m, 1 - offset + i)` 靠 Date 自己处理负数日 —— 手算"上个月
   * 有几天"会掉进闰年那个坑里。
   */
  function monthGrid(year, month, weekStart) {
    var firstWeekday = new Date(year, month, 1).getDay(); // 0 = 周日
    var anchor = weekStart === "sunday" ? 0 : 1;
    var offset = (firstWeekday - anchor + 7) % 7;
    var cells = [];
    for (var i = 0; i < 42; i += 1) {
      var date = new Date(year, month, 1 - offset + i);
      cells.push({
        key: keyOf(date),
        day: date.getDate(),
        inMonth: date.getMonth() === month && date.getFullYear() === year,
      });
    }
    return cells;
  }

  /*
   * 星期头。中文用「周一…周日」—— 和本文件注释里"周一"的叫法一致；
   * 周日起算只是把这张表转一圈，英文照旧是两字母缩写。
   */
  var WEEKDAYS = {
    zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    en: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  };

  function weekdayLabels(weekStart) {
    var labels = WEEKDAYS[lang];
    return weekStart === "sunday" ? labels.slice() : labels.slice(1).concat([labels[0]]);
  }

  function addMonths(year, month, delta) {
    var total = year * 12 + month + delta;
    return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
  }

  function formatMonth(year, month) {
    return lang === "en" ? MONTHS[month] + " " + year : year + "年" + (month + 1) + "月";
  }

  /** 英文 `Oct 24`、中文 `10月24日`；跨年了才带上年份（卡片窄，能省一个字是一个） */
  function formatDay(key, now) {
    var parsed = parseKey(key);
    if (!parsed) return "";
    var sameYear = new Date(now === undefined ? Date.now() : now).getFullYear() === parsed.year;
    if (lang === "en") {
      return MONTHS_SHORT[parsed.month] + " " + parsed.day + (sameYear ? "" : ", " + parsed.year);
    }
    return (
      (sameYear ? "" : parsed.year + "年") + (parsed.month + 1) + "月" + parsed.day + "日"
    );
  }

  // -------------------------------------------------------------------------
  // 条目（纯函数）
  // -------------------------------------------------------------------------

  /**
   * 一行字 → `{ time, title }`。
   *
   * 行首是时间就当成时间（`9:30 Standup` / `09：30 站会`，全角冒号也认），
   * 其余全是标题。这个约定比"两个输入框"省一半地方，也比"必须点开编辑"
   * 快一步 —— 日历上绝大多数条目就是"几点干什么"。
   */
  function parseEntry(text) {
    var source = String(text == null ? "" : text).trim();
    if (!source) return null;
    var match = /^(\d{1,2})\s*[:：.]\s*(\d{2})\s*([\s\S]*)$/.exec(source);
    if (match) {
      var hour = Number(match[1]);
      var minute = Number(match[2]);
      if (hour < 24 && minute < 60) {
        return { time: pad2(hour) + ":" + pad2(minute), title: match[3].trim() };
      }
    }
    return { time: "", title: source };
  }

  /** 没时间的排前面，其余按 `HH:MM` 字典序（定长字符串，字典序就是时间序） */
  function sortEvents(list) {
    return list.slice().sort(function (a, b) {
      if (a.time === b.time) return 0;
      if (!a.time) return -1;
      if (!b.time) return 1;
      return a.time < b.time ? -1 : 1;
    });
  }

  function eventsFor(events, key) {
    var list = events && events[key];
    return Array.isArray(list) ? sortEvents(list) : [];
  }

  function countOn(events, key) {
    var list = events && events[key];
    return Array.isArray(list) ? list.length : 0;
  }

  var MAX_PER_DAY = 50;

  /** 加一条。返回新的表（不改入参，自检页要靠这一点做断言） */
  function addEvent(events, key, entry, id) {
    if (!entry) return events;
    var current = Array.isArray(events[key]) ? events[key] : [];
    if (current.length >= MAX_PER_DAY) return events;
    var next = {};
    Object.keys(events).forEach(function (name) {
      next[name] = events[name];
    });
    next[key] = current.concat([{ id: id, time: entry.time, title: entry.title }]);
    return next;
  }

  function removeEvent(events, key, id) {
    var current = Array.isArray(events[key]) ? events[key] : [];
    var kept = current.filter(function (item) {
      return item.id !== id;
    });
    var next = {};
    Object.keys(events).forEach(function (name) {
      if (name !== key) next[name] = events[name];
    });
    // 空了就把这一天整条删掉，别在 state.json 里留一堆空数组
    if (kept.length > 0) next[key] = kept;
    return next;
  }

  // -------------------------------------------------------------------------
  // 界面
  // -------------------------------------------------------------------------

  var titleEl = document.getElementById("title");
  var weekEl = document.getElementById("week");
  var gridEl = document.getElementById("grid");
  var dayLabelEl = document.getElementById("day-label");
  var dayCountEl = document.getElementById("day-count");
  var eventsEl = document.getElementById("events");
  var entryEl = document.getElementById("entry");
  var prevEl = document.getElementById("prev");
  var nextEl = document.getElementById("next");

  // 粘贴导入那一层
  var importOpenEl = document.getElementById("import-open");
  var importSheetEl = document.getElementById("import-sheet");
  var importTitleEl = document.getElementById("import-title");
  var importHintEl = document.getElementById("import-hint");
  var importTextEl = document.getElementById("import-text");
  var importStatusEl = document.getElementById("import-status");
  var importCancelEl = document.getElementById("import-cancel");
  var importGoEl = document.getElementById("import-go");
  /** 导完之后那颗按钮变成「完成」，只负责收面板 */
  var importFinished = false;

  /** HTML 里那几句不随月份重画的字：翻月按钮、标题提示、输入框 —— 换语言时一起换 */
  function paintChrome() {
    prevEl.setAttribute("aria-label", say("上个月", "Previous month"));
    nextEl.setAttribute("aria-label", say("下个月", "Next month"));
    titleEl.title = say("回到今天", "Back to today");
    entryEl.placeholder = say("9:30 站会", "9:30 Standup");
    entryEl.setAttribute("aria-label", say("新条目", "New event"));
    importOpenEl.textContent = say("导入", "Import");
    importOpenEl.setAttribute("aria-label", say("粘贴日历导入", "Import a pasted calendar"));
    importTitleEl.textContent = say("粘贴日历", "Paste a calendar");
    importHintEl.textContent = say(
      "从日历应用导出 .ics，用记事本打开，全选粘到这里。",
      "Export an .ics from your calendar app, open it in Notepad, and paste it here.",
    );
    importTextEl.setAttribute("aria-label", say("ICS 文本", "ICS text"));
    importCancelEl.textContent = say("取消", "Cancel");
    // 导完那一次之后按钮是「完成」，别把它改回「导入」
    importGoEl.textContent = importFinished ? say("完成", "Done") : say("导入", "Import");
  }

  var KEY = "calendar";
  var weekStart = "monday";
  var events = {};
  var selected = todayKey();
  var parsed = parseKey(selected) || { year: 2020, month: 0, day: 1 };
  var view = { year: parsed.year, month: parsed.month };
  /** 用户动过之后，迟到的 storage.get 不许把界面倒回去 */
  var touched = false;

  function applyConfig(next) {
    if (!next) return;
    var value = String(next.weekStart || "");
    weekStart = value === "sunday" ? "sunday" : "monday";
    renderWeek();
    renderGrid();
  }

  function save() {
    call("storage.set", { key: KEY, value: { events: events, selected: selected } }).catch(noop);
  }

  function renderHead() {
    titleEl.textContent = formatMonth(view.year, view.month);
  }

  function renderWeek() {
    weekEl.innerHTML = weekdayLabels(weekStart)
      .map(function (label) {
        return '<span class="cal-weekday">' + label + "</span>";
      })
      .join("");
  }

  function renderGrid() {
    var today = todayKey();
    var cells = monthGrid(view.year, view.month, weekStart);
    var html = "";
    for (var i = 0; i < cells.length; i += 1) {
      var cell = cells[i];
      var classes = ["cal-cell"];
      if (!cell.inMonth) classes.push("is-out");
      if (cell.key === today) classes.push("is-today");
      if (cell.key === selected) classes.push("is-selected");
      var count = countOn(events, cell.key);
      html +=
        '<button type="button" class="' + classes.join(" ") + '" data-key="' + cell.key + '"' +
        ' aria-pressed="' + (cell.key === selected ? "true" : "false") + '">' +
        '<span class="cal-num">' + cell.day + "</span>" +
        (count > 0 ? '<span class="cal-dot" aria-hidden="true"></span>' : "") +
        "</button>";
    }
    gridEl.innerHTML = html;
  }

  function renderDay() {
    dayLabelEl.textContent = formatDay(selected);
    var list = eventsFor(events, selected);
    dayCountEl.textContent = list.length === 0 ? "" : String(list.length);
    if (list.length === 0) {
      eventsEl.innerHTML = '<li class="cal-empty">' + say("这天还没有安排。", "Nothing on this day.") + "</li>";
      return;
    }
    eventsEl.innerHTML = list
      .map(function (item) {
        return (
          '<li class="cal-event" data-id="' + item.id + '">' +
          '<span class="cal-event-time">' + (item.time || say("全天", "all day")) + "</span>" +
          '<span class="cal-event-title">' + escapeHtml(item.title || say("未命名", "Untitled")) + "</span>" +
          '<button type="button" class="cal-event-x" data-id="' + item.id + '" aria-label="' +
          say("删除", "Delete") + '">✕</button>' +
          "</li>"
        );
      })
      .join("");
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderAll() {
    renderHead();
    renderGrid();
    renderDay();
  }

  // ---- 交互 ----

  prevEl.addEventListener("click", function () {
    touched = true;
    view = addMonths(view.year, view.month, -1);
    renderHead();
    renderGrid();
  });

  nextEl.addEventListener("click", function () {
    touched = true;
    view = addMonths(view.year, view.month, 1);
    renderHead();
    renderGrid();
  });

  titleEl.addEventListener("click", function () {
    touched = true;
    selected = todayKey();
    var today = parseKey(selected);
    view = { year: today.year, month: today.month };
    renderAll();
    save();
  });

  gridEl.addEventListener("click", function (event) {
    var cell = event.target.closest(".cal-cell");
    if (!cell) return;
    touched = true;
    selected = cell.dataset.key;
    var at = parseKey(selected);
    /*
     * 点了邻月的日子就跟着跳到那个月：留在本月的话，上面写着"October"、
     * 下面列着 11 月 3 号的事件，看起来像记错了月份。
     */
    if (at && (at.year !== view.year || at.month !== view.month)) {
      view = { year: at.year, month: at.month };
    }
    renderAll();
    save();
    entryEl.focus();
  });

  entryEl.addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    var entry = parseEntry(entryEl.value);
    if (!entry) return;
    touched = true;
    var id = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6);
    events = addEvent(events, selected, entry, id);
    entryEl.value = "";
    renderGrid();
    renderDay();
    save();
  });

  eventsEl.addEventListener("click", function (event) {
    var button = event.target.closest(".cal-event-x");
    if (!button) return;
    touched = true;
    events = removeEvent(events, selected, button.dataset.id);
    renderGrid();
    renderDay();
    save();
  });

  // ---- 粘贴导入 ----

  function setImportStatus(text) {
    importStatusEl.textContent = text;
  }

  function openImport() {
    importFinished = false;
    importGoEl.disabled = false;
    importTextEl.value = "";
    setImportStatus("");
    paintChrome();
    importSheetEl.hidden = false;
    importTextEl.focus();
  }

  function closeImport() {
    importSheetEl.hidden = true;
    importTextEl.value = "";
    setImportStatus("");
    importFinished = false;
    importGoEl.disabled = false;
    importGoEl.textContent = say("导入", "Import");
    entryEl.focus();
  }

  /**
   * 解析 + 合并 + 报数。
   *
   * 解析出来的条目并进 `events` 之后立刻落盘，并且把视图跳到第一条导入的
   * 那一天 —— 导完停在原处、什么都看不见，用户会以为没成功。
   */
  function doImport() {
    var parser = window.__latticeIcs;
    if (!parser) return;
    var parsedIcs = parser.parseEvents(importTextEl.value);
    if (parsedIcs.entries.length === 0) {
      setImportStatus(
        parsedIcs.events === 0
          ? say("这一段里没有日历事件", "This text holds no calendar events")
          : say(
              "看不懂 " + parsedIcs.skipped + " 条（缺标题或缺开始时间）",
              "Could not read " + parsedIcs.skipped + " events (no title or start)",
            ),
      );
      return;
    }

    var merged = parser.mergeInto(events, parsedIcs.entries, { maxPerDay: MAX_PER_DAY });
    events = merged.events;
    touched = true;

    var first = parseKey(parsedIcs.entries[0].key);
    if (first) {
      selected = parsedIcs.entries[0].key;
      view = { year: first.year, month: first.month };
    }
    renderAll();
    save();

    var parts = [say("导入 " + merged.added + " 条", merged.added + " imported")];
    if (merged.duplicates) {
      parts.push(say("跳过 " + merged.duplicates + " 条重复", merged.duplicates + " duplicates"));
    }
    if (merged.overflow) {
      parts.push(
        say(
          "一天最多 " + MAX_PER_DAY + " 条，放不下 " + merged.overflow + " 条",
          MAX_PER_DAY + " per day is full, " + merged.overflow + " left out",
        ),
      );
    }
    if (parsedIcs.skipped) parts.push(say("看不懂 " + parsedIcs.skipped + " 条", parsedIcs.skipped + " unreadable"));
    setImportStatus(parts.join(" · "));

    importTextEl.value = "";
    importFinished = true;
    importGoEl.textContent = say("完成", "Done");
  }

  importOpenEl.addEventListener("click", openImport);
  importCancelEl.addEventListener("click", closeImport);
  importGoEl.addEventListener("click", function () {
    if (importFinished) {
      closeImport();
      return;
    }
    doImport();
  });
  importTextEl.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeImport();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      doImport();
    }
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  /*
   * 先画一帧（今天所在的月、空事件表），再去问配置和存档 ——
   * 等桥的话宿主慢一点卡片就是一块空白，而这一帧本来就画得出来。
   */
  paintChrome();
  renderWeek();
  renderAll();

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住配置和存档
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画：日历不该因为问不到语言就不翻月 */
    });

  call("config.get")
    .then(function (values) {
      if (values) applyConfig(values);
    })
    .catch(noop)
    .then(function () {
      return call("storage.get", { key: KEY }).catch(function () {
        return null;
      });
    })
    .then(function (saved) {
      if (touched || !saved || typeof saved !== "object") return;
      events = normalizeEvents(saved.events);
      var key = parseKey(saved.selected) ? String(saved.selected) : todayKey();
      selected = key;
      var at = parseKey(key);
      view = { year: at.year, month: at.month };
      renderAll();
    })
    .catch(noop)
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });

  /**
   * 读存档时逐条筛：日期键要合法、条目要有字符串标题、时间要么空要么
   * `HH:MM`。存坏一格只丢那一格 —— 整份退回空白等于把用户的日历清空。
   */
  function normalizeEvents(raw) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    Object.keys(raw).forEach(function (key) {
      if (!parseKey(key)) return;
      var list = raw[key];
      if (!Array.isArray(list)) return;
      var kept = [];
      for (var i = 0; i < list.length && kept.length < MAX_PER_DAY; i += 1) {
        var item = list[i];
        if (!item || typeof item !== "object") continue;
        var title = typeof item.title === "string" ? item.title.slice(0, 200) : "";
        var time = typeof item.time === "string" && /^\d{2}:\d{2}$/.test(item.time) ? item.time : "";
        var id = typeof item.id === "string" && item.id ? item.id : String(Date.now()) + "-" + i;
        kept.push({ id: id, time: time, title: title });
      }
      if (kept.length > 0) out[key] = kept;
    });
    return out;
  }

  /* 自检页用：日期与条目都是纯函数，DOM 只是它们的一个视图 */
  window.__latticeCalendar = {
    keyOf: keyOf,
    todayKey: todayKey,
    parseKey: parseKey,
    monthGrid: monthGrid,
    weekdayLabels: weekdayLabels,
    addMonths: addMonths,
    formatMonth: formatMonth,
    formatDay: formatDay,
    parseEntry: parseEntry,
    sortEvents: sortEvents,
    eventsFor: eventsFor,
    addEvent: addEvent,
    removeEvent: removeEvent,
    normalizeEvents: normalizeEvents,
    MAX_PER_DAY: MAX_PER_DAY,
    snapshot: function () {
      return {
        view: { year: view.year, month: view.month },
        selected: selected,
        weekStart: weekStart,
        events: events,
      };
    },
  };
})();
