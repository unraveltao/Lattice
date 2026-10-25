/**
 * 习惯组件
 *
 * 一张周视图：一行一个习惯，七格是本週；点一格就是"那天做了"。
 *
 * 这个组件的正确性全在**日期从哪儿来**。平台在窗口不可见时会停掉整条时间轴，
 * 所以"每秒加一"、"存一个计数器"这类写法在这里必然错：藏了半天回来只补一拍。
 * 存的是**本地日键**（`YYYY-MM-DD`），连续天数每次现算 —— 时间不往前走也不丢，
 * 走着走着过了零点，下一次 tick 自己就换到新的一天。
 *
 * 两条和"日键"一样容易写错的地方，都钉在 tests/habit.html 里：
 *   1. **不能用 `toISOString()` 取日期** —— 那是 UTC，东八区晚上八点之后会落成"明天"。
 *   2. **日键不要用 `00:00` 构造 Date** —— 夏令时切换那天那个时刻可能不存在，
 *      把它当"某一天的代表"会莫名少一天。这里一律用中午 12 点。
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
   * 界面语言：`lang.get` 拉一次（建文档那一刻的答案）+ 收 `language` 推送（后来变了）。
   * 两件都要 —— 只读一次换语言卡片不动，只听推送热重载之后停在旧语言。
   * 首帧按 HTML 里写死的中文画，不为这几十毫秒画"加载中"（不变量 18）。
   */
  var lang = "zh";

  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  // ---------- 纯逻辑 ----------

  /** 一张卡片最多摆几个习惯。再多就不是"看一眼"而是"翻一页"了 */
  var MAX_HABITS = 6;
  /** 每个习惯记多少天：约 13 个月，超了丢最老的 */
  var MAX_DAYS = 400;
  /** 名字长度按码点算，超了截断 —— 一行放不下长句子 */
  var MAX_NAME = 40;

  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** 本地日键。**不要用 `toISOString().slice(0, 10)`**：那是 UTC */
  function dayKey(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  /** 日键 → Date（中午 12 点）；形状或日期本身不合法返回 null */
  function keyToDate(key) {
    if (typeof key !== "string" || !DAY_RE.test(key)) return null;
    var y = Number(key.slice(0, 4));
    var m = Number(key.slice(5, 7));
    var d = Number(key.slice(8, 10));
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var date = new Date(y, m - 1, d, 12, 0, 0, 0);
    // 2026-02-31 会被 Date 顺延成 3 月 3 日 —— 倒回去比一次就认出来了
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return date;
  }

  /** 往后挪 n 天（n 可以是负的）。跨月、跨年、跨夏令时都由 Date 自己算 */
  function addDays(key, n) {
    var date = keyToDate(key);
    if (!date) return null;
    date.setDate(date.getDate() + n);
    return dayKey(date);
  }

  /** 0 = 周日，和 `Date#getDay` 一致 */
  function weekdayOf(key) {
    var date = keyToDate(key);
    return date ? date.getDay() : 0;
  }

  /** 这一周的起点。`start` 只认 `"mon"` / `"sun"`，别的当周一 */
  function weekStartKey(key, start) {
    var first = start === "sun" ? 0 : 1;
    var offset = weekdayOf(key) - first;
    if (offset < 0) offset += 7;
    return addDays(key, -offset);
  }

  /** 从某天起的七天 */
  function weekKeys(startKey) {
    var out = [];
    for (var i = 0; i < 7; i += 1) out.push(addDays(startKey, i));
    return out;
  }

  /**
   * 连续天数。
   *
   * 今天记过就从今天往前数；今天还没记就从昨天数 —— 今天还有一整天可以补，
   * 早上打开卡片就显示"断了"是在惩罚还没到晚上的人。
   */
  function streak(days, today) {
    var set = {};
    for (var i = 0; i < (days || []).length; i += 1) set[days[i]] = true;
    var from = set[today] ? today : addDays(today, -1);
    var count = 0;
    while (from && set[from]) {
      count += 1;
      from = addDays(from, -1);
    }
    return count;
  }

  /** 点一格：有就删、没有就加，回来仍然是排好序、有上限的数组 */
  function toggleDay(days, key) {
    var source = Array.isArray(days) ? days : [];
    var out = [];
    var removed = false;
    for (var i = 0; i < source.length; i += 1) {
      if (source[i] === key) removed = true;
      else out.push(source[i]);
    }
    if (!removed && keyToDate(key)) out.push(key);
    out.sort();
    if (out.length > MAX_DAYS) out = out.slice(out.length - MAX_DAYS);
    return out;
  }

  function cleanName(raw) {
    var text = String(raw == null ? "" : raw)
      .replace(/\s+/g, " ")
      .trim();
    return Array.from(text).slice(0, MAX_NAME).join("");
  }

  /** 下一个可用的 id。同一份清单里只有这几个，**递增**比随机好读也好断 */
  function newId(items) {
    var n = 1;
    var taken = {};
    for (var i = 0; i < items.length; i += 1) taken[items[i].id] = true;
    while (taken["h-" + n]) n += 1;
    return "h-" + n;
  }

  /**
   * 存档 → 内存。坏条目**逐条丢**（和不变量 17 同一条规矩）：
   * 一个手改坏的文件不该让整张卡片打不开。
   */
  function parseHabits(raw) {
    var source = raw && typeof raw === "object" && Array.isArray(raw.items) ? raw.items : [];
    var items = [];
    var seen = {};
    for (var i = 0; i < source.length; i += 1) {
      if (items.length >= MAX_HABITS) break;
      var entry = source[i];
      if (!entry || typeof entry !== "object") continue;
      var id = typeof entry.id === "string" ? entry.id : "";
      if (!/^h-[0-9]+$/.test(id) || seen[id]) continue;
      var name = cleanName(entry.name);
      if (!name) continue;
      var days = [];
      var raw_days = Array.isArray(entry.days) ? entry.days : [];
      for (var j = 0; j < raw_days.length; j += 1) {
        var day = raw_days[j];
        if (!keyToDate(day) || days.indexOf(day) >= 0) continue;
        days.push(day);
      }
      days.sort();
      if (days.length > MAX_DAYS) days = days.slice(days.length - MAX_DAYS);
      seen[id] = true;
      items.push({ id: id, name: name, days: days });
    }
    return { items: items };
  }

  // 断言页从这里取纯逻辑：不复制一份去测（和 diagram 的 `__latticeAgentFeed` 同一个路子）
  window.__latticeHabit = {
    dayKey: dayKey,
    addDays: addDays,
    weekdayOf: weekdayOf,
    weekStartKey: weekStartKey,
    weekKeys: weekKeys,
    streak: streak,
    toggleDay: toggleDay,
    cleanName: cleanName,
    parseHabits: parseHabits,
    newId: newId,
    MAX_HABITS: MAX_HABITS,
    MAX_DAYS: MAX_DAYS,
    MAX_NAME: MAX_NAME,
  };

  // ---------- 界面 ----------

  var listEl = document.getElementById("list");
  var weekdaysEl = document.getElementById("weekdays");
  var statusEl = document.getElementById("status");
  var addEl = document.getElementById("add");
  var titleEl = document.getElementById("title");

  var state = { items: [] };
  var config = { weekStart: "monday" };
  var today = dayKey(new Date());

  /*
   * 用户动过之后，迟到的存档不许再盖（不变量 18 的 `touched` 闸门）。
   * 和便签那台保存状态机是同一套优先级：用户的操作 > 磁盘。
   */
  var touched = false;
  var revision = 0;
  var saved = 0;
  var saving = false;

  /** 正在改名的那一行；null 表示没有 */
  var editingId = null;
  /** 等 render 之后要把光标放进去的那个 id（+ 加完之后立刻改名） */
  var focusId = null;

  var STATUS_TEXT = {
    limit: function () {
      return say("最多六个习惯", "Six habits at most");
    },
    noPermission: function () {
      return say("没有存储权限", "No storage permission");
    },
    saveFailed: function () {
      return say("保存失败", "Could not save");
    },
    loadFailed: function () {
      return say("读不到记录", "Could not load");
    },
  };

  var statusKey = null;

  function setStatus(key) {
    statusKey = key;
    if (!key) {
      statusEl.hidden = true;
      statusEl.textContent = "";
      statusEl.removeAttribute("title");
      return;
    }
    var text = STATUS_TEXT[key]();
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.className = "habit-status" + (key === "limit" ? "" : " is-error");
    // 状态行只有一行高，被截断了才挂 title
    if (statusEl.scrollWidth > statusEl.clientWidth) statusEl.title = text;
    else statusEl.removeAttribute("title");
  }

  function weekStart() {
    return config.weekStart === "sunday" ? "sun" : "mon";
  }

  var WEEKDAY_NAMES = {
    mon: { zh: ["一", "二", "三", "四", "五", "六", "日"], en: ["M", "T", "W", "T", "F", "S", "S"] },
    sun: { zh: ["日", "一", "二", "三", "四", "五", "六"], en: ["S", "M", "T", "W", "T", "F", "S"] },
  };

  function renderWeekdays(keys) {
    weekdaysEl.textContent = "";
    var spacer = document.createElement("span");
    spacer.className = "habit-spacer";
    weekdaysEl.appendChild(spacer);
    var names = WEEKDAY_NAMES[weekStart()][lang === "en" ? "en" : "zh"];
    for (var i = 0; i < 7; i += 1) {
      var cell = document.createElement("span");
      cell.className = "habit-weekday" + (keys[i] === today ? " is-today" : "");
      cell.textContent = names[i];
      weekdaysEl.appendChild(cell);
    }
  }

  function commitName(id, value) {
    var name = cleanName(value);
    if (!name) return false;
    var found = null;
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].id === id) found = state.items[i];
    }
    if (!found) return false;
    if (found.name !== name) {
      found.name = name;
      markChanged();
      save();
    }
    return true;
  }

  function renderRow(item, keys) {
    var row = document.createElement("div");
    row.className = "habit-row";
    row.setAttribute("data-id", item.id);

    if (editingId === item.id) {
      var input = document.createElement("input");
      input.className = "habit-input";
      input.id = "rename-" + item.id;
      input.value = item.name;
      input.maxLength = MAX_NAME;
      input.setAttribute("aria-label", say("习惯名字", "Habit name"));
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          commitName(item.id, input.value);
          editingId = null;
          render();
        } else if (event.key === "Escape") {
          event.preventDefault();
          editingId = null;
          render();
        }
      });
      input.addEventListener("blur", function () {
        if (editingId !== item.id) return;
        commitName(item.id, input.value);
        editingId = null;
        render();
      });
      row.appendChild(input);
      if (focusId === item.id) {
        focusId = null;
        setTimeout(function () {
          input.focus();
          input.select();
        }, 0);
      }
    } else {
      var name = document.createElement("button");
      name.type = "button";
      name.className = "habit-name";
      name.textContent = item.name;
      name.title = say("改名", "Rename");
      name.addEventListener("click", function () {
        editingId = item.id;
        render();
      });
      row.appendChild(name);
    }

    for (var i = 0; i < keys.length; i += 1) {
      (function (key) {
        var cell = document.createElement("button");
        cell.type = "button";
        cell.className = "habit-cell";
        cell.setAttribute("data-key", key);
        var on = item.days.indexOf(key) >= 0;
        if (on) cell.classList.add("is-on");
        if (key === today) cell.classList.add("is-today");
        cell.setAttribute("aria-pressed", on ? "true" : "false");
        cell.setAttribute("aria-label", key + (on ? say(" 记过了", " logged") : ""));
        cell.addEventListener("click", function () {
          item.days = toggleDay(item.days, key);
          markChanged();
          render();
          save();
        });
        row.appendChild(cell);
      })(keys[i]);
    }

    var streakEl = document.createElement("span");
    var days = streak(item.days, today);
    streakEl.className = "habit-streak" + (days > 0 ? " is-live" : "");
    streakEl.textContent = days > 0 ? String(days) : "·";
    streakEl.title = say(days + " 天连续", days + " day streak");
    row.appendChild(streakEl);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "habit-remove";
    remove.textContent = "×";
    remove.title = say("删除", "Delete");
    remove.setAttribute("aria-label", say("删除「" + item.name + "」", 'Delete "' + item.name + '"'));
    remove.addEventListener("click", function () {
      var next = [];
      for (var k = 0; k < state.items.length; k += 1) {
        if (state.items[k].id !== item.id) next.push(state.items[k]);
      }
      state.items = next;
      if (editingId === item.id) editingId = null;
      markChanged();
      render();
      save();
    });
    row.appendChild(remove);

    return row;
  }

  function render() {
    var keys = weekKeys(weekStartKey(today, weekStart()));
    renderWeekdays(keys);
    listEl.textContent = "";
    if (state.items.length === 0) {
      var empty = document.createElement("p");
      empty.className = "habit-empty";
      empty.textContent = say("还没有习惯，按 + 加一个", "No habits yet — press +");
      listEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < state.items.length; i += 1) {
      listEl.appendChild(renderRow(state.items[i], keys));
    }
  }

  /** 用户改了东西：闸门关上、版本加一、重画 */
  function markChanged() {
    touched = true;
    revision += 1;
  }

  function save() {
    // 上一次还没回来就什么都不做：它回来时会发现 revision 更大，自己再存一次
    if (saving || saved >= revision) return;
    saving = true;
    var target = revision;
    call("storage.set", { key: "habits", value: state })
      .then(function () {
        saved = target;
        saving = false;
        if (revision > saved) {
          save();
          return;
        }
        if (statusKey === "saveFailed" || statusKey === "noPermission") setStatus(null);
      })
      .catch(function (error) {
        saving = false;
        setStatus(error.code === "permission_denied" ? "noPermission" : "saveFailed");
      });
  }

  addEl.addEventListener("click", function () {
    if (state.items.length >= MAX_HABITS) {
      setStatus("limit");
      return;
    }
    var item = { id: newId(state.items), name: say("新习惯", "New habit"), days: [] };
    state.items.push(item);
    editingId = item.id;
    focusId = item.id;
    markChanged();
    render();
    save();
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
      // 还有没落盘的改动时不重读：谁后写谁赢，那是用户正在做的事
      if ((!key || key === "habits") && revision <= saved) reloadHabits();
      return;
    }
    if (data.type === "tick") {
      // 过了零点要换格：今天变了才重画，其余 tick 什么都不做
      var next = dayKey(new Date());
      if (next !== today) {
        today = next;
        render();
      }
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

  function applyConfig(next) {
    if (!next || typeof next !== "object") return;
    config = { weekStart: next.weekStart === "sunday" ? "sunday" : "monday" };
    if (!editingId) render();
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("习惯", "Habit");
    titleEl.textContent = say("本周", "This week");
    addEl.title = say("加一个习惯", "Add a habit");
    addEl.setAttribute("aria-label", addEl.title);
    if (statusKey) setStatus(statusKey);
    render();
  }

  function reloadHabits() {
    // 正在改名时不重读：输入框会被这次重画换掉，用户敲了一半的名字就丢了
    if (editingId) return;
    call("storage.get", { key: "habits" })
      .then(function (value) {
        state = parseHabits(value);
        render();
      })
      .catch(function () {});
  }

  // ---------- 启动 ----------
  // 首帧：空清单（那是默认值），同步画出来；等桥回来再换成真的（不变量 18）
  titleEl.textContent = say("本周", "This week");
  render();

  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画 */
    });

  call("config.get")
    .then(function (value) {
      applyConfig(value);
    })
    .catch(function () {});

  // 每分钟问一次"今天变了吗"。用时间轴而不是 `setInterval`：窗口不可见时
  // 整条时间轴停摆，回来只补一拍 —— 那一拍照样会认出新的今天（不变量 10）
  call("schedule.every", { every: 60000 }).catch(function () {});

  call("storage.get", { key: "habits" })
    .then(function (value) {
      if (touched) {
        // 这几十毫秒里用户已经动过手：磁盘上的旧清单优先级最低
        return;
      }
      state = parseHabits(value);
      render();
    })
    .catch(function (error) {
      if (touched) return;
      setStatus(error.code === "permission_denied" ? "noPermission" : "loadFailed");
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
