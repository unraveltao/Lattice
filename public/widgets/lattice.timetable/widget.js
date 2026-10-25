/**
 * 课程表组件
 *
 * 一周的课表。数据全部走 storage 桥，组件自己不碰 localStorage ——
 * 沙箱 iframe 是不透明源，localStorage 本来就不可用；这样也顺带保证
 * "同一个组件的多个实例共享同一份课表"。
 *
 * # 为什么用绝对时间，而不是"第几节课"
 *
 * 每个学校的作息表都不一样（第 1 节 8:00 还是 8:20、一节课 40 还是 45 分钟）。
 * 组件存 `HH:MM` 的起止时刻，卡片按真实时间画；用户不需要先配置一份作息表，
 * 也不会因为换学校就把数据作废。
 *
 * # 为什么默认 360×320
 *
 * 一周五天 × 十个小时塞不进 240×140。默认给一张真正能读的周视图，最小
 * 300×240 仍然能用；再小就该换组件形态了，而不是继续压字号。
 *
 * # 奇偶周
 *
 * 只有填了 Term starts 才计算周次；没填就全部显示，不猜。周次按"第 1 周
 * 的周一"起算，跨夏令时用 UTC 日期戳做差，避免本地毫秒差把周次算少一周。
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

  function noop() {}

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
    // 静态文案、星期按钮、周次按钮、已经打开的编辑器和整张周视图都要重画
    paintChrome();
    buildPicks();
    paintPicks();
    if (editorState) updateSub();
    renderAll();
  }

  // -------------------------------------------------------------------------
  // 常量
  // -------------------------------------------------------------------------

  var KEY = "timetable";
  var MAX_COURSES = 200;
  /*
   * 两门语言的表：中文用「周一…周日」（和本文件注释里的叫法一致），英文照旧
   * 是三字母缩写 / 全名。星期头和编辑器里的星期按钮共用短名。
   */
  var DAY_NAMES = {
    zh: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  };
  var DAY_NAMES_LONG = {
    zh: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  };
  var WEEK_OPTIONS = [
    { value: "all", zh: "每周", en: "Every" },
    { value: "odd", zh: "单周", en: "Odd" },
    { value: "even", zh: "双周", en: "Even" },
  ];

  function dayName(index) {
    return DAY_NAMES[lang][index] || "";
  }

  function dayNameLong(index) {
    return DAY_NAMES_LONG[lang][index] || "";
  }

  /*
   * 六种课程颜色。
   *
   * 它们是**内容色**，不是主题色：只用来做低透明度的底和左边框，文字始终
   * 走 --fg / --muted。这样深浅主题下的可读性由平台令牌保证；如果拿课程色
   * 去染文字，浅色底板上迟早出现读不清的组合。todo 的优先级红黄绿同理。
   */
  var COLORS = ["#5dcaa5", "#7aa2f7", "#e0af68", "#bb9af7", "#f7768e", "#9ece6a"];

  // -------------------------------------------------------------------------
  // 纯函数：时间与日期
  // -------------------------------------------------------------------------

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function asDate(value) {
    if (value instanceof Date) return value;
    /*
     * 自检页在父窗口里 new Date，再把这个对象传进 iframe 的函数 —— 跨 realm
     * 的 Date 不是这个 realm 里 `Date` 的实例，`instanceof` 会假。看 getTime
     * 才是跨 realm 也成立判据；否则所有日期函数会悄悄退回"现在"。
     */
    if (
      value &&
      typeof value === "object" &&
      typeof value.getTime === "function"
    ) {
      var time = value.getTime();
      if (typeof time === "number" && isFinite(time)) return new Date(time);
    }
    if (typeof value === "number" && isFinite(value)) return new Date(value);
    return new Date();
  }

  /** `9:30` / `09:30` / `9：30` → 570；`24:00`、`9:75`、`9:5` → null */
  function parseTime(value) {
    var text = String(value == null ? "" : value).trim();
    var match = /^(\d{1,2})\s*[:：.]\s*(\d{2})$/.exec(text);
    if (!match) return null;
    var hour = Number(match[1]);
    var minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  /** 570 → `09:30`。1440 会得到 `24:00`，只用于显示，不写回数据 */
  function formatTime(minutes) {
    var total = Math.max(0, Math.round(minutes));
    var hour = Math.floor(total / 60);
    var minute = total % 60;
    return pad2(hour) + ":" + pad2(minute);
  }

  /** 周一 = 0，周日 = 6。JS 的 getDay() 是周日 = 0，这里换过来 */
  function dayIndex(value) {
    return (asDate(value).getDay() + 6) % 7;
  }

  function startOfDay(value) {
    var date = asDate(value);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  /** 这一周的周一（本地零点） */
  function startOfWeek(value) {
    var date = startOfDay(value);
    date.setDate(date.getDate() - dayIndex(date));
    return date;
  }

  function dateKey(value) {
    var date = asDate(value);
    return (
      date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
    );
  }

  /** `YYYY-MM-DD` → `{ year, month, day }`（month 0 起）；非法日期返回 null */
  function parseDateKey(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? "" : value));
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]) - 1;
    var day = Number(match[3]);
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    var date = new Date(year, month, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month ||
      date.getDate() !== day
    ) {
      return null;
    }
    return { year: year, month: month, day: day };
  }

  /** 当前周的日期表：`[{ day, label, num, key }]` */
  function weekDates(value, count) {
    var total = Math.max(1, Math.min(7, Number(count) || 5));
    var start = startOfWeek(value);
    var out = [];
    for (var i = 0; i < total; i += 1) {
      var date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.push({
        day: i,
        label: dayName(i),
        num: date.getDate(),
        key: dateKey(date),
      });
    }
    return out;
  }

  /**
   * 第几周，从 Term starts 那一周的周一开始算。
   *
   * 用 UTC 日期戳做差：本地毫秒差遇到夏令时会是 6 天 23 小时，floor 之后
   * 少数一周。日期本身没有时区，用 UTC 只是拿它当"日历天数"的计数轴。
   */
  function weekNumber(termStart, value) {
    var term = parseDateKey(termStart);
    if (!term) return null;
    var now = asDate(value);
    var currentStamp = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    var termStamp = Date.UTC(term.year, term.month, term.day);
    var days = Math.floor((currentStamp - termStamp) / 86400000);
    return Math.max(1, Math.floor(days / 7) + 1);
  }

  function courseVisible(course, weekNo) {
    var weeks = course && course.weeks;
    if (weeks !== "odd" && weeks !== "even") return true;
    if (weekNo == null) return true;
    return weeks === "odd" ? weekNo % 2 === 1 : weekNo % 2 === 0;
  }

  // -------------------------------------------------------------------------
  // 纯函数：数据
  // -------------------------------------------------------------------------

  function makeId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function colorFor(name) {
    var hash = 0;
    var text = String(name || "");
    for (var i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash % COLORS.length;
  }

  function suggestColor(list) {
    var used = new Set(
      (list || []).map(function (course) {
        return course.color;
      }),
    );
    for (var i = 0; i < COLORS.length; i += 1) {
      if (!used.has(i)) return i;
    }
    return (list || []).length % COLORS.length;
  }

  function sortCourses(list) {
    return (list || []).slice().sort(function (a, b) {
      if (a.day !== b.day) return a.day - b.day;
      if (a.start !== b.start) return a.start < b.start ? -1 : 1;
      if (a.end !== b.end) return a.end < b.end ? -1 : 1;
      if (a.name === b.name) return 0;
      return a.name < b.name ? -1 : 1;
    });
  }

  /**
   * 读存档：坏一条丢一条，不让一份写坏的数据把整张课表清空。
   * 和 `normalizeEvents` / `normalizeConfig` 同一条规矩。
   */
  function normalizeCourses(raw) {
    var list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray(raw.courses)
        ? raw.courses
        : [];
    var out = [];
    var seen = new Set();

    for (var i = 0; i < list.length && out.length < MAX_COURSES; i += 1) {
      var item = list[i];
      if (!item || typeof item !== "object") continue;

      var name = typeof item.name === "string" ? item.name.trim().slice(0, 80) : "";
      if (!name) continue;

      var day = Number(item.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;

      var start = parseTime(item.start);
      var end = parseTime(item.end);
      if (start == null || end == null || end <= start || end - start > 12 * 60) continue;

      var id = typeof item.id === "string" ? item.id.trim().slice(0, 80) : "";
      if (!id || seen.has(id)) id = makeId();
      seen.add(id);

      var room = typeof item.room === "string" ? item.room.trim().slice(0, 40) : "";
      var color =
        Number.isInteger(item.color) && item.color >= 0 && item.color < COLORS.length
          ? item.color
          : colorFor(name);
      var weeks = item.weeks === "odd" || item.weeks === "even" ? item.weeks : "all";

      out.push({
        id: id,
        day: day,
        start: formatTime(start),
        end: formatTime(end),
        name: name,
        room: room,
        color: color,
        weeks: weeks,
      });
    }

    return out;
  }

  function addCourse(list, course) {
    if (!course || list.length >= MAX_COURSES) return list;
    return list.concat([course]);
  }

  function updateCourse(list, course) {
    var found = false;
    var next = list.map(function (item) {
      if (item.id !== course.id) return item;
      found = true;
      return course;
    });
    return found ? next : list;
  }

  function removeCourse(list, id) {
    var next = list.filter(function (course) {
      return course.id !== id;
    });
    return next.length === list.length ? list : next;
  }

  /**
   * 把一天里重叠的课分到并排的 lane 上。
   *
   * 先按"重叠链"分簇：A 9–11、B 10–12、C 11–13 是一簇（C 和 A 不重叠，
   * 但都通过 B 连在一起），簇内取最大并发数作为总 lane 数。这样 A/B/C
   * 宽度一致，不会出现 A 占半栏、C 占整栏的参差。
   */
  function layoutDay(dayCourses, startMin, endMin) {
    var from = startMin == null ? 0 : startMin;
    var to = endMin == null ? 1440 : endMin;
    var range = Math.max(1, to - from);

    var entries = [];
    (dayCourses || []).forEach(function (course) {
      var start = parseTime(course.start);
      var end = parseTime(course.end);
      if (start == null || end == null || end <= start) return;
      entries.push({ course: course, s: start, e: end });
    });
    entries.sort(function (a, b) {
      return a.s - b.s || a.e - b.e;
    });

    var clusters = [];
    var current = [];
    var clusterEnd = -1;
    entries.forEach(function (entry) {
      if (current.length > 0 && entry.s >= clusterEnd) {
        clusters.push(current);
        current = [];
        clusterEnd = -1;
      }
      current.push(entry);
      clusterEnd = clusterEnd < 0 ? entry.e : Math.max(clusterEnd, entry.e);
    });
    if (current.length > 0) clusters.push(current);

    var blocks = [];
    clusters.forEach(function (cluster) {
      var laneEnds = [];
      var assigned = cluster.map(function (entry) {
        var lane = -1;
        for (var i = 0; i < laneEnds.length; i += 1) {
          if (laneEnds[i] <= entry.s) {
            lane = i;
            break;
          }
        }
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(entry.e);
        } else {
          laneEnds[lane] = entry.e;
        }
        return { entry: entry, lane: lane };
      });

      var lanes = Math.max(1, laneEnds.length);
      assigned.forEach(function (item) {
        var entry = item.entry;
        blocks.push({
          course: entry.course,
          lane: item.lane,
          lanes: lanes,
          top: ((entry.s - from) / range) * 100,
          height: ((entry.e - entry.s) / range) * 100,
        });
      });
    });

    blocks.sort(function (a, b) {
      return a.top - b.top || a.lane - b.lane;
    });
    return blocks;
  }

  /**
   * 卡片显示的时间范围：配置的首尾，加上课程自动撑开的部分。
   * 一节课在 7:30，卡片就从 7:00 开始画，而不是把它裁掉。
   */
  function resolveRange(config, courses) {
    var start = Math.max(0, Math.min(23, toInt(config.dayStart, 8))) * 60;
    var end = Math.max(1, Math.min(24, toInt(config.dayEnd, 18))) * 60;
    if (end <= start) {
      start = 8 * 60;
      end = 18 * 60;
    }

    (courses || []).forEach(function (course) {
      var s = parseTime(course.start);
      var e = parseTime(course.end);
      if (s == null || e == null) return;
      start = Math.min(start, Math.floor(s / 60) * 60);
      end = Math.max(end, Math.ceil(e / 60) * 60);
    });

    start = Math.max(0, start);
    end = Math.min(1440, end);
    if (end - start < 60) end = Math.min(1440, start + 60);
    if (end - start < 60) start = Math.max(0, end - 60);
    return { start: start, end: end, hours: (end - start) / 60 };
  }

  function isNowCourse(course, value) {
    var now = asDate(value);
    if (course.day !== dayIndex(now)) return false;
    var minutes = now.getHours() * 60 + now.getMinutes();
    var start = parseTime(course.start);
    var end = parseTime(course.end);
    return start != null && end != null && minutes >= start && minutes < end;
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  var DEFAULT_CONFIG = { days: "5", dayStart: 8, dayEnd: 18, termStart: "" };
  var config = Object.assign({}, DEFAULT_CONFIG);
  var courses = [];
  var touched = false;
  var writing = 0;
  var pendingReload = false;
  var saveError = false;
  var storageDenied = false;
  var editorOpen = false;
  var editorState = null;
  var currentRange = { start: 8 * 60, end: 18 * 60, hours: 10 };
  var currentDayCount = 5;
  var renderedKey = "";
  var tickId = null;

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  var root = document.getElementById("root");
  var titleLabelEl = document.getElementById("title-label");
  var weekEl = document.getElementById("week");
  var daybarEl = document.getElementById("daybar");
  var canvasEl = document.getElementById("canvas");
  var timesEl = document.getElementById("times");
  var gridEl = document.getElementById("grid");
  var hoursEl = document.getElementById("hours");
  var emptyEl = document.getElementById("empty");
  var addEl = document.getElementById("add");

  var editorEl = document.getElementById("editor");
  var editorTitleEl = document.getElementById("editor-title");
  var editorSubEl = document.getElementById("editor-sub");
  var formEl = document.getElementById("editor-form");
  var daysEl = document.getElementById("f-days");
  var weeksEl = document.getElementById("f-weeks");
  var colorsEl = document.getElementById("f-colors");
  var nameEl = document.getElementById("f-name");
  var roomEl = document.getElementById("f-room");
  var startEl = document.getElementById("f-start");
  var endEl = document.getElementById("f-end");
  var errorEl = document.getElementById("f-error");
  var deleteEl = document.getElementById("f-delete");
  var cancelEl = document.getElementById("f-cancel");
  var saveEl = document.getElementById("f-save");

  /** HTML 里写死的字段名，按 id 收在一处，换语言时挨个换 */
  var LABEL_ELS = {
    name: document.getElementById("lbl-name"),
    room: document.getElementById("lbl-room"),
    day: document.getElementById("lbl-day"),
    start: document.getElementById("lbl-start"),
    end: document.getElementById("lbl-end"),
    weeks: document.getElementById("lbl-weeks"),
    colour: document.getElementById("lbl-colour"),
  };

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  function toInt(value, fallback) {
    return typeof value === "number" && isFinite(value) ? Math.round(value) : fallback;
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pct(value) {
    return (Math.round(value * 10000) / 10000).toFixed(4) + "%";
  }

  function visibleCourses(value) {
    var now = asDate(value);
    var week = weekNumber(config.termStart, now);
    var count = Number(config.days) || 5;
    return courses.filter(function (course) {
      return course.day < count && courseVisible(course, week);
    });
  }

  /** HTML 里写死的那几句：标题、+ 按钮、字段名、分组的 aria-label、三个动作按钮 */
  function paintChrome() {
    document.title = say("课程表", "Timetable");
    titleLabelEl.textContent = say("课程表", "Timetable");
    addEl.setAttribute("aria-label", say("添加课程", "Add class"));
    addEl.title = say("添加课程", "Add class");
    LABEL_ELS.name.textContent = say("课程", "Class");
    LABEL_ELS.room.textContent = say("教室", "Room");
    LABEL_ELS.day.textContent = say("星期", "Day");
    LABEL_ELS.start.textContent = say("开始", "Starts");
    LABEL_ELS.end.textContent = say("结束", "Ends");
    LABEL_ELS.weeks.textContent = say("周次", "Weeks");
    LABEL_ELS.colour.textContent = say("颜色", "Colour");
    // 教室号和时刻是例子，不翻；名字的占位符跟着语言换
    nameEl.placeholder = say("微积分", "Calculus");
    daysEl.setAttribute("aria-label", say("星期几", "Day of the week"));
    weeksEl.setAttribute("aria-label", say("哪几周", "Which weeks"));
    colorsEl.setAttribute("aria-label", say("颜色", "Colour"));
    deleteEl.textContent = say("删除", "Delete");
    cancelEl.textContent = say("取消", "Cancel");
    if (editorState) paintEditorChrome();
  }

  /** 编辑器标题和主按钮跟着"新增 / 编辑"变，也跟语言变 */
  function paintEditorChrome() {
    var editing = Boolean(editorState && editorState.id);
    editorTitleEl.textContent = editing ? say("编辑课程", "Edit class") : say("添加课程", "Add class");
    saveEl.textContent = editing ? say("保存", "Save") : say("添加", "Add");
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  function renderHead(week) {
    if (saveError) {
      weekEl.textContent = say("未保存", "Not saved");
      weekEl.title = storageDenied
        ? say("需要存储权限才能保存", "Storage permission required to save")
        : say("保存失败", "Could not save");
      weekEl.classList.add("is-error");
      return;
    }
    weekEl.classList.remove("is-error");
    weekEl.title = "";
    weekEl.textContent = week ? say("第" + week + "周", "W" + week) : "";
  }

  function renderDaybar(dates, now) {
    var today = dateKey(now);
    var html = '<div class="tt-gutter"></div>';
    dates.forEach(function (date) {
      var cls = "tt-dayhead" + (date.key === today ? " is-today" : "");
      html +=
        '<div class="' +
        cls +
        '"><span class="tt-dayname">' +
        date.label +
        '</span><span class="tt-daynum">' +
        date.num +
        "</span></div>";
    });
    daybarEl.innerHTML = html;
  }

  function renderGrid(visible, dates, now) {
    var total = Math.max(1, currentRange.end - currentRange.start);
    var stepHours = currentRange.hours > 12 ? 2 : 1;

    var times = "";
    for (var m = currentRange.start; m < currentRange.end; m += stepHours * 60) {
      var top = ((m - currentRange.start) / total) * 100;
      var cls = "tt-hour-label" + (m === currentRange.start ? " is-first" : "");
      times +=
        '<span class="' + cls + '" style="top:' + pct(top) + '">' + formatTime(m) + "</span>";
    }
    if (currentRange.end > currentRange.start) {
      times +=
        '<span class="tt-hour-label is-last" style="top:100%">' +
        formatTime(currentRange.end) +
        "</span>";
    }
    timesEl.innerHTML = times;

    var lines = "";
    for (var line = currentRange.start; line <= currentRange.end; line += 60) {
      var lineTop = ((line - currentRange.start) / total) * 100;
      lines += '<div class="tt-hour-line" style="top:' + pct(lineTop) + '"></div>';
    }
    hoursEl.innerHTML = lines;

    var today = dateKey(now);
    var nowMinutes = now.getHours() * 60 + now.getMinutes();
    var html = "";

    dates.forEach(function (date, day) {
      var list = visible.filter(function (course) {
        return course.day === day;
      });
      var blocks = layoutDay(list, currentRange.start, currentRange.end);
      var colCls = "tt-col" + (date.key === today ? " is-today" : "");
      html += '<div class="' + colCls + '" data-day="' + day + '">';

      blocks.forEach(function (block) {
        var course = block.course;
        var start = parseTime(course.start);
        var end = parseTime(course.end);
        var duration = end == null || start == null ? 0 : end - start;
        var color = COLORS[course.color] || COLORS[0];
        var left = (block.lane / block.lanes) * 100;
        var width = 100 / block.lanes;
        var classes = ["tt-course"];
        if (duration < 45) classes.push("is-short");
        if (isNowCourse(course, now)) classes.push("is-now");

        var label =
          course.name +
          (lang === "en"
            ? ", " +
              dayNameLong(course.day) +
              " " +
              course.start +
              " to " +
              course.end +
              (course.room ? ", room " + course.room : "")
            : "，" +
              dayNameLong(course.day) +
              " " +
              course.start +
              "到" +
              course.end +
              (course.room ? "，教室 " + course.room : ""));
        var style =
          "--course-color:" +
          color +
          ";top:" +
          pct(block.top) +
          ";height:" +
          pct(block.height) +
          ";left:calc(" +
          pct(left) +
          " + 1px);width:calc(" +
          pct(width) +
          " - 2px)";

        html +=
          '<button type="button" class="' +
          classes.join(" ") +
          '" data-id="' +
          escapeHtml(course.id) +
          '" data-day="' +
          course.day +
          '" data-start="' +
          course.start +
          '" data-end="' +
          course.end +
          '" style="' +
          style +
          '" title="' +
          escapeHtml(label) +
          '" aria-label="' +
          escapeHtml(label) +
          '">';
        html += '<span class="tt-name">' + escapeHtml(course.name) + "</span>";
        if (course.room) html += '<span class="tt-room">' + escapeHtml(course.room) + "</span>";
        html += "</button>";
      });

      if (date.key === today) {
        var inRange = nowMinutes >= currentRange.start && nowMinutes <= currentRange.end;
        var nowTop = inRange
          ? ((nowMinutes - currentRange.start) / total) * 100
          : 0;
        html +=
          '<div class="tt-now" style="top:' +
          pct(nowTop) +
          (inRange ? "" : ";display:none") +
          '"></div>';
      }

      html += "</div>";
    });

    gridEl.innerHTML = html;
  }

  function renderEmpty(visible) {
    if (visible.length > 0) {
      emptyEl.classList.remove("is-visible");
      return;
    }
    if (storageDenied) {
      emptyEl.textContent = say(
        "授予存储权限才能保存这张课程表。",
        "Grant storage permission to keep this timetable.",
      );
    } else if (courses.length > 0) {
      emptyEl.textContent = say("这一周没有课", "No classes this week");
    } else {
      emptyEl.textContent = say(
        "还没有课——点空格子或 +",
        "No classes yet — click a slot or +",
      );
    }
    emptyEl.classList.add("is-visible");
  }

  function renderAll() {
    var now = new Date();
    var week = weekNumber(config.termStart, now);
    var dates = weekDates(now, config.days);
    var visible = visibleCourses(now);

    currentDayCount = Number(config.days) || 5;
    currentRange = resolveRange(config, visible);
    renderedKey = dateKey(now);

    root.style.setProperty("--days", String(currentDayCount));
    canvasEl.style.setProperty("--hours", String(currentRange.hours));

    renderHead(week);
    renderDaybar(dates, now);
    renderGrid(visible, dates, now);
    renderEmpty(visible);
  }

  /** 每分钟那一次：日期变了整张重画，否则只挪"现在"线和正在上的课 */
  function updateNow() {
    var now = new Date();
    if (dateKey(now) !== renderedKey) {
      renderAll();
      return;
    }

    var total = Math.max(1, currentRange.end - currentRange.start);
    var nowMinutes = now.getHours() * 60 + now.getMinutes();
    var today = dayIndex(now);
    var col = gridEl.querySelector('.tt-col[data-day="' + today + '"]');
    var line = col ? col.querySelector(".tt-now") : null;

    if (line) {
      if (nowMinutes < currentRange.start || nowMinutes > currentRange.end) {
        line.style.display = "none";
      } else {
        line.style.display = "block";
        line.style.top = pct(((nowMinutes - currentRange.start) / total) * 100);
      }
    }

    gridEl.querySelectorAll(".tt-course").forEach(function (element) {
      var day = Number(element.dataset.day);
      var start = parseTime(element.dataset.start);
      var end = parseTime(element.dataset.end);
      var active =
        day === today &&
        start != null &&
        end != null &&
        nowMinutes >= start &&
        nowMinutes < end;
      element.classList.toggle("is-now", active);
    });
  }

  // -------------------------------------------------------------------------
  // 配置
  // -------------------------------------------------------------------------

  function applyConfig(next) {
    if (!next) return;
    var days = String(next.days);
    config.days = days === "6" || days === "7" ? days : "5";
    config.dayStart = Math.max(0, Math.min(23, toInt(next.dayStart, 8)));
    config.dayEnd = Math.max(1, Math.min(24, toInt(next.dayEnd, 18)));
    config.termStart = parseDateKey(next.termStart) ? String(next.termStart) : "";
    renderAll();
  }

  // -------------------------------------------------------------------------
  // 存档
  // -------------------------------------------------------------------------

  function persist() {
    writing += 1;
    call("storage.set", { key: KEY, value: { courses: courses } })
      .then(function () {
        if (saveError || storageDenied) {
          saveError = false;
          storageDenied = false;
          renderHead(weekNumber(config.termStart, new Date()));
          renderEmpty(visibleCourses(new Date()));
        }
      })
      .catch(function (error) {
        saveError = true;
        if (error && error.code === "permission_denied") storageDenied = true;
        // 周次标题和它的悬停提示都交给 renderHead：那里按语言挑，也认得权限
        renderHead(weekNumber(config.termStart, new Date()));
        renderEmpty(visibleCourses(new Date()));
      })
      .then(function () {
        writing -= 1;
        if (writing === 0 && pendingReload && !editorOpen) {
          pendingReload = false;
          reload(false);
        }
      });
  }

  /**
   * 读存档。`initial` 是第一次读：如果用户已经动过手（touched），
   * 迟到的存档不许把他的操作盖掉 —— 这道闸门和 todo / calendar 一致。
   */
  function reload(initial) {
    if (writing > 0 || editorOpen) {
      pendingReload = true;
      return;
    }
    call("storage.get", { key: KEY })
      .then(function (value) {
        if (initial && touched) return;
        var wasDenied = storageDenied;
        storageDenied = false;
        var next = normalizeCourses(value);
        if (JSON.stringify(next) === JSON.stringify(courses)) {
          if (wasDenied) renderEmpty(visibleCourses(new Date()));
          return;
        }
        courses = next;
        renderAll();
      })
      .catch(function (error) {
        if (error && error.code === "permission_denied") {
          storageDenied = true;
          renderEmpty(visibleCourses(new Date()));
        }
      });
  }

  // -------------------------------------------------------------------------
  // 编辑器
  // -------------------------------------------------------------------------

  function buildPicks() {
    daysEl.innerHTML = DAY_NAMES[lang]
      .map(function (label, index) {
        return (
          '<button type="button" class="tt-pick" data-day="' +
          index +
          '" aria-pressed="false">' +
          label +
          "</button>"
        );
      })
      .join("");

    weeksEl.innerHTML = WEEK_OPTIONS.map(function (option) {
      return (
        '<button type="button" class="tt-pick" data-weeks="' +
        option.value +
        '" aria-pressed="false">' +
        option[lang] +
        "</button>"
      );
    }).join("");

    colorsEl.innerHTML = COLORS.map(function (color, index) {
      return (
        '<button type="button" class="tt-swatch" data-color="' +
        index +
        '" style="--course-color:' +
        color +
        '" aria-label="' +
        say("颜色 " + (index + 1), "Colour " + (index + 1)) +
        '" aria-pressed="false"></button>'
      );
    }).join("");
  }

  function paintPicks() {
    if (!editorState) return;

    daysEl.querySelectorAll(".tt-pick").forEach(function (button) {
      var on = Number(button.dataset.day) === editorState.day;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });

    weeksEl.querySelectorAll(".tt-pick").forEach(function (button) {
      var on = button.dataset.weeks === editorState.weeks;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });

    colorsEl.querySelectorAll(".tt-swatch").forEach(function (button) {
      var on = Number(button.dataset.color) === editorState.color;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function updateSub() {
    if (!editorState) return;
    editorSubEl.textContent =
      dayNameLong(editorState.day) +
      " · " +
      (startEl.value.trim() || "—") +
      "–" +
      (endEl.value.trim() || "—");
  }

  function openEditor(course, defaults) {
    var slot = defaults || {};
    editorState = {
      id: course ? course.id : null,
      day: course ? course.day : toInt(slot.day, 0),
      weeks: course ? course.weeks : "all",
      color: course ? course.color : toInt(slot.color, suggestColor(courses)),
    };

    nameEl.value = course ? course.name : "";
    roomEl.value = course ? course.room : "";
    startEl.value = course ? course.start : formatTime(toInt(slot.start, 8 * 60));
    endEl.value = course ? course.end : formatTime(toInt(slot.end, 9 * 60 + 30));
    deleteEl.hidden = !course;
    // 标题和主按钮跟着"新增 / 编辑"挑文案，语言切换时也走这一条
    paintEditorChrome();
    errorEl.textContent = "";

    editorOpen = true;
    editorEl.classList.add("is-open");
    editorEl.setAttribute("aria-hidden", "false");
    paintPicks();
    updateSub();

    nameEl.focus();
    nameEl.select();
  }

  function closeEditor() {
    editorOpen = false;
    editorState = null;
    editorEl.classList.remove("is-open");
    editorEl.setAttribute("aria-hidden", "true");
    if (pendingReload) {
      pendingReload = false;
      reload(false);
    }
  }

  function fail(message) {
    errorEl.textContent = message;
    return null;
  }

  function readEditor() {
    if (!editorState) return null;

    var name = nameEl.value.trim();
    if (!name) return fail(say("给这节课起个名字。", "Give the class a name."));

    var start = parseTime(startEl.value);
    if (start == null) return fail(say("开始时间要写成 09:30 这样。", "Start time should look like 09:30."));

    var end = parseTime(endEl.value);
    if (end == null) return fail(say("结束时间要写成 10:45 这样。", "End time should look like 10:45."));

    if (end <= start) return fail(say("结束时间要晚于开始时间。", "End time must be after the start time."));
    if (end - start > 12 * 60) return fail(say("一节课最长 12 小时。", "A class can be at most 12 hours long."));

    return {
      name: name.slice(0, 80),
      room: roomEl.value.trim().slice(0, 40),
      day: editorState.day,
      start: formatTime(start),
      end: formatTime(end),
      color: editorState.color,
      weeks: editorState.weeks,
    };
  }

  function saveEditor() {
    var data = readEditor();
    if (!data) return;

    if (editorState.id) {
      courses = updateCourse(courses, Object.assign({}, data, { id: editorState.id }));
    } else {
      var next = addCourse(courses, Object.assign({}, data, { id: makeId() }));
      if (next === courses) {
        fail(say("课程表满了（最多 " + MAX_COURSES + " 节）。", "The timetable is full (" + MAX_COURSES + " classes)."));
        return;
      }
      courses = next;
    }

    touched = true;
    closeEditor();
    renderAll();
    persist();
  }

  function deleteEditor() {
    if (!editorState || !editorState.id) return;
    courses = removeCourse(courses, editorState.id);
    touched = true;
    closeEditor();
    renderAll();
    persist();
  }

  function nextDefaultSlot() {
    var now = new Date();
    var count = Number(config.days) || 5;
    var today = dayIndex(now);
    var day = today < count ? today : 0;
    var range = resolveRange(config, visibleCourses(now));
    var minutes = now.getHours() * 60 + now.getMinutes();
    var start;

    if (minutes < range.start) start = range.start;
    else if (minutes > range.end - 30) start = Math.max(range.start, range.end - 60);
    else start = Math.ceil(minutes / 30) * 30;

    start = Math.max(range.start, Math.min(start, range.end - 30));
    start = Math.min(start, 23 * 60);
    var end = Math.min(start + 90, 23 * 60 + 59);
    if (end - start < 30) start = Math.max(0, end - 30);

    return {
      day: day,
      start: start,
      end: end,
      color: suggestColor(courses),
    };
  }

  function slotFromClick(event, col) {
    var rect = col.getBoundingClientRect();
    var total = Math.max(1, currentRange.end - currentRange.start);
    var ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
    var start = Math.round((currentRange.start + ratio * total) / 5) * 5;
    start = Math.max(currentRange.start, Math.min(start, currentRange.end - 15));
    start = Math.min(start, 23 * 60);
    var end = Math.min(start + 90, 23 * 60 + 59);
    if (end - start < 30) start = Math.max(0, end - 30);
    return {
      day: Number(col.dataset.day),
      start: start,
      end: end,
    };
  }

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  gridEl.addEventListener("click", function (event) {
    var courseEl = event.target.closest(".tt-course");
    if (courseEl) {
      var course = courses.find(function (item) {
        return item.id === courseEl.dataset.id;
      });
      if (course) openEditor(course, null);
      return;
    }

    var col = event.target.closest(".tt-col");
    if (!col) return;
    var slot = slotFromClick(event, col);
    openEditor(null, {
      day: slot.day,
      start: slot.start,
      end: slot.end,
      color: suggestColor(courses),
    });
  });

  addEl.addEventListener("click", function () {
    openEditor(null, nextDefaultSlot());
  });

  daysEl.addEventListener("click", function (event) {
    var button = event.target.closest(".tt-pick");
    if (!button || !editorState) return;
    editorState.day = Number(button.dataset.day);
    paintPicks();
    updateSub();
  });

  weeksEl.addEventListener("click", function (event) {
    var button = event.target.closest(".tt-pick");
    if (!button || !editorState) return;
    editorState.weeks = button.dataset.weeks;
    paintPicks();
  });

  colorsEl.addEventListener("click", function (event) {
    var button = event.target.closest(".tt-swatch");
    if (!button || !editorState) return;
    editorState.color = Number(button.dataset.color);
    paintPicks();
  });

  [nameEl, roomEl, startEl, endEl].forEach(function (input) {
    input.addEventListener("input", function () {
      errorEl.textContent = "";
      if (input === startEl || input === endEl) updateSub();
    });
  });

  [startEl, endEl].forEach(function (input) {
    input.addEventListener("blur", function () {
      var minutes = parseTime(input.value);
      if (minutes != null) input.value = formatTime(minutes);
      updateSub();
    });
  });

  cancelEl.addEventListener("click", closeEditor);
  deleteEl.addEventListener("click", deleteEditor);
  saveEl.addEventListener("click", saveEditor);

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    saveEditor();
  });

  editorEl.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeEditor();
      return;
    }
    if (event.key === "Enter" && event.target && event.target.tagName === "INPUT") {
      event.preventDefault();
      saveEditor();
    }
  });

  /*
   * 焦点落在编辑器外面（点了一下背景、或者从外面切回来）时，Escape 不会
   * 冒泡到编辑器。补一条窗口级监听：编辑器开着就认这一下。
   */
  window.addEventListener("keydown", function (event) {
    if (!editorOpen || event.key !== "Escape") return;
    event.preventDefault();
    closeEditor();
  });

  // -------------------------------------------------------------------------
  // 桥消息
  // -------------------------------------------------------------------------

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
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (!key || key === KEY) reload(false);
      return;
    }
    if (data.type === "tick") {
      var id = data.payload && data.payload.id;
      if (!tickId || id === tickId) updateNow();
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

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  paintChrome();
  buildPicks();
  renderAll();
  parent.postMessage({ __lattice: 1, type: "ready" }, "*");

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住配置和存档
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(noop);

  call("config.get")
    .then(function (values) {
      applyConfig(values);
    })
    .catch(noop)
    .then(function () {
      return reload(true);
    });

  call("schedule.every", { every: 30000 })
    .then(function (grant) {
      tickId = grant && grant.id ? grant.id : null;
    })
    .catch(noop);

  // -------------------------------------------------------------------------
  // 自检页接口：纯逻辑挂出来，DOM 只当它们的一个视图
  // -------------------------------------------------------------------------

  window.__latticeTimetable = {
    parseTime: parseTime,
    formatTime: formatTime,
    dayIndex: dayIndex,
    startOfWeek: startOfWeek,
    weekDates: weekDates,
    weekNumber: weekNumber,
    dateKey: dateKey,
    parseDateKey: parseDateKey,
    courseVisible: courseVisible,
    sortCourses: sortCourses,
    normalizeCourses: normalizeCourses,
    addCourse: addCourse,
    updateCourse: updateCourse,
    removeCourse: removeCourse,
    layoutDay: layoutDay,
    resolveRange: resolveRange,
    isNowCourse: isNowCourse,
    COLORS: COLORS.slice(),
    MAX_COURSES: MAX_COURSES,
    snapshot: function () {
      return {
        courses: courses.map(function (course) {
          return Object.assign({}, course);
        }),
        config: Object.assign({}, config),
        saveError: saveError,
        storageDenied: storageDenied,
        editorOpen: editorOpen,
        range: { start: currentRange.start, end: currentRange.end },
        days: currentDayCount,
        week: weekNumber(config.termStart, new Date()),
      };
    },
  };
})();
