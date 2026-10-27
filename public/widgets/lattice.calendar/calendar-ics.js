/**
 * 日历的 ICS 导入：把一段 `.ics` 文本解析成"哪天、几点、什么"。
 *
 * # 为什么是"粘贴文本"，不是文件选择
 *
 * 组件拿不到文件系统（桥只给 `storage` / `clipboard` / `network` 这几样，没有
 * 打开文件对话框）。而 `.ics` 就是纯文本：从任何日历应用导出、用记事本打开、
 * 全选粘进来，解析在我们自己手里 —— 不碰磁盘、不联网、不需要新权限。
 *
 * # 认多少
 *
 * 认 `VEVENT` 里的 `SUMMARY` / `DTSTART` / `DTEND` / `RRULE`，不认时区数据库
 * （`TZID=` 当本地时间处理）、不认 `EXDATE`（被单独取消的那一次）、不认
 * `VALARM` 之类挂在事件里的子组件（它们的属性会被跳过，不影响主体）。
 *
 * 重复事件（`FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`，带 `INTERVAL` / `COUNT` /
 * `UNTIL` / `BYDAY`）会展开成一条条：窗口一年、单个事件最多 120 条。再长的
 * 重复没有意义 —— 日历卡片是给人看这个月的，不是给机器存十年的。
 *
 * # 时间
 *
 * 带 `Z` 的按 UTC 换算成本地时间；不带的当浮动时间（就是本地时间）；全天
 * 事件的 `DTEND` 按 RFC 是"次日"（不含），所以 5/1–5/3 记在 5/1 和 5/2 两天。
 */
(function () {
  "use strict";

  var DAY_MS = 86400000;
  var MAX_INSTANCES = 120;
  var WINDOW_DAYS = 366;

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function keyOf(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function timeOf(date) {
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  /** 按日历日加减，不按毫秒：夏令时那天加 24 小时会跳到 23:00 */
  function addDays(date, days) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + days,
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    );
  }

  /** 两个日期差几个日历日（用 UTC 的同一时刻相减，绕开夏令时） */
  function daysBetween(from, to) {
    return Math.round(
      (Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) -
        Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) /
        DAY_MS,
    );
  }

  // ---------- 行 ----------

  /**
   * 折行展开：RFC 5545 允许把一行折成"换行 + 一个空格/制表符"。
   * 不展开的话，长标题会变成两行互不相干的属性。
   */
  function unfold(text) {
    return String(text == null ? "" : text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n[ \t]/g, "");
  }

  /** TEXT 类型的转义：`\n` 换行，`\\` 反斜杠，`\,` `\;` 原字符 */
  function unescapeText(value) {
    return String(value == null ? "" : value).replace(/\\[\\;,nN]/g, function (match) {
      if (match === "\\n" || match === "\\N") return "\n";
      if (match === "\\\\") return "\\";
      if (match === "\\;") return ";";
      return ",";
    });
  }

  /** `NAME;PARAM=VALUE:值` → { name, params, value } */
  function parseProperty(line) {
    var text = String(line == null ? "" : line);
    var colon = text.indexOf(":");
    if (colon < 0) return null;
    var head = text.slice(0, colon);
    var value = text.slice(colon + 1);
    var pieces = head.split(";");
    var params = {};
    for (var i = 1; i < pieces.length; i += 1) {
      var eq = pieces[i].indexOf("=");
      if (eq < 0) continue;
      var name = pieces[i].slice(0, eq).trim().toUpperCase();
      var param = pieces[i].slice(eq + 1).trim();
      if (param.charAt(0) === '"' && param.charAt(param.length - 1) === '"') {
        param = param.slice(1, -1);
      }
      params[name] = param;
    }
    return { name: pieces[0].trim().toUpperCase(), params: params, value: value };
  }

  // ---------- 值 ----------

  /**
   * 日期或日期时间。`20260501`（全天）或 `20260501T093000` / `...Z`。
   * 末尾带 `Z` 的按 UTC 换算成本地；其余当浮动时间。
   */
  function parseDateValue(value) {
    var match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
      String(value == null ? "" : value).trim(),
    );
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]) - 1;
    var day = Number(match[3]);
    var hour = match[4] ? Number(match[4]) : 0;
    var minute = match[5] ? Number(match[5]) : 0;
    var second = match[6] ? Number(match[6]) : 0;
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 60) return null;

    var date;
    if (match[7]) {
      date = new Date(Date.UTC(year, month, day, hour, minute, second));
      if (isNaN(date.getTime())) return null;
    } else {
      date = new Date(year, month, day, hour, minute, second);
      // 2 月 30 日会被 Date 滚成 3 月 2 日：那不是用户写的东西
      if (date.getMonth() !== month || date.getDate() !== day) return null;
    }
    return { date: date, allDay: !match[4] };
  }

  var WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  /** `FREQ=WEEKLY;BYDAY=MO,WE` → { freq, interval, count, until, byday } */
  function parseRule(value) {
    var rule = { freq: "", interval: 1, count: 0, until: null, byday: [] };
    String(value == null ? "" : value)
      .split(";")
      .forEach(function (piece) {
        var eq = piece.indexOf("=");
        if (eq < 0) return;
        var name = piece.slice(0, eq).trim().toUpperCase();
        var raw = piece.slice(eq + 1).trim();
        if (name === "FREQ") rule.freq = raw.toUpperCase();
        else if (name === "INTERVAL") rule.interval = Math.max(1, Math.floor(Number(raw) || 1));
        else if (name === "COUNT") rule.count = Math.max(0, Math.floor(Number(raw) || 0));
        else if (name === "UNTIL") {
          var parsed = parseDateValue(raw);
          rule.until = parsed ? parsed.date : null;
        } else if (name === "BYDAY") {
          rule.byday = raw
            .split(",")
            .map(function (entry) {
              return entry.trim().toUpperCase().slice(-2);
            })
            .filter(function (entry) {
              return entry in WEEKDAY;
            });
        }
      });
    return rule;
  }

  /**
   * 展开重复事件。日/周按"逐天扫描"（顺手统一了 INTERVAL 与 BYDAY），
   * 月/年按"月份跳跃"（要处理 31 号落到短月份时不存在的那一次）。
   */
  function expand(start, rule) {
    var out = [start];
    if (!rule || !rule.freq) return out;

    var windowEnd = addDays(start, WINDOW_DAYS);
    var until = rule.until && rule.until < windowEnd ? rule.until : windowEnd;
    var cap = Math.min(MAX_INSTANCES, rule.count > 0 ? rule.count : MAX_INSTANCES);
    if (cap <= 1) return out;

    if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
      var weekdays =
        rule.byday.length > 0
          ? rule.byday.map(function (name) {
              return WEEKDAY[name];
            })
          : [start.getDay()];
      var baseDay = startOfDay(start);
      // DTSTART 那一周的第一天（按周日切）：INTERVAL 是从这一周开始数的
      var weekAnchor = addDays(baseDay, -baseDay.getDay());
      for (var offset = 0; offset <= WINDOW_DAYS && out.length < cap; offset += 1) {
        var day = addDays(baseDay, offset);
        if (day > until) break;
        if (offset === 0) continue;
        if (rule.freq === "DAILY") {
          if (offset % rule.interval !== 0) continue;
        } else {
          var week = Math.floor(daysBetween(weekAnchor, day) / 7);
          if (week % rule.interval !== 0) continue;
          if (weekdays.indexOf(day.getDay()) < 0) continue;
        }
        out.push(
          new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            start.getHours(),
            start.getMinutes(),
            start.getSeconds(),
          ),
        );
      }
      return out;
    }

    if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
      var step = rule.freq === "MONTHLY" ? rule.interval : rule.interval * 12;
      for (var k = step; k <= 1200 && out.length < cap; k += step) {
        var candidate = new Date(
          start.getFullYear(),
          start.getMonth() + k,
          start.getDate(),
          start.getHours(),
          start.getMinutes(),
          start.getSeconds(),
        );
        // 31 号在只有 30 天的月份不存在；Date 会滚到下个月，那就跳过这一期
        if (candidate.getDate() !== start.getDate()) continue;
        if (candidate > until) break;
        out.push(candidate);
      }
    }
    return out;
  }

  // ---------- 解析整段文本 ----------

  /**
   * 解析一段 `.ics`。
   *
   * @returns {{entries: Array<{key: string, time: string, title: string}>,
   *            skipped: number, recurring: number, events: number}}
   *          `skipped` 是没有标题 / 没有可用开始时间的事件条数
   */
  function parseEvents(text, options) {
    var opts = options || {};
    var lines = unfold(text).split("\n");
    var blocks = [];
    var current = null;
    var depth = 0;

    for (var i = 0; i < lines.length; i += 1) {
      var prop = parseProperty(lines[i]);
      if (!prop) continue;
      if (prop.name === "BEGIN") {
        var component = prop.value.trim().toUpperCase();
        if (component === "VEVENT") {
          current = {};
          depth = 1;
        } else if (current) {
          depth += 1;
        }
        continue;
      }
      if (prop.name === "END") {
        var closing = prop.value.trim().toUpperCase();
        if (current && closing === "VEVENT" && depth === 1) {
          blocks.push(current);
          current = null;
          depth = 0;
        } else if (current) {
          depth = Math.max(1, depth - 1);
        }
        continue;
      }
      // 只收 VEVENT 自己的属性：VALARM 里的 SUMMARY 之类不该算到事件头上
      if (current && depth === 1 && !(prop.name in current)) current[prop.name] = prop;
    }

    var entries = [];
    var skipped = 0;
    var recurring = 0;

    blocks.forEach(function (block) {
      var summary = block.SUMMARY ? unescapeText(block.SUMMARY.value).trim() : "";
      // 折行展开后标题里可能落进换行：压成一行，卡片上放得下
      var title = summary.replace(/\s+/g, " ").slice(0, 200);
      var start = block.DTSTART ? parseDateValue(block.DTSTART.value) : null;
      if (!title || !start) {
        skipped += 1;
        return;
      }

      var rule = block.RRULE ? parseRule(block.RRULE.value) : null;
      if (rule && rule.freq) recurring += 1;
      var dates = rule && rule.freq ? expand(start.date, rule) : [start.date];

      /*
       * 全天的多日事件（会议、旅行）：DTEND 按 RFC 是"次日、不含"，
       * 所以 5/1–5/3 该画在 5/1 和 5/2 两天上。重复事件不展开这一段 ——
       * 每一期都跨三天的组合太少，代价是把条数翻几倍。
       */
      var spanDays = 0;
      if (start.allDay && block.DTEND && !(rule && rule.freq)) {
        var end = parseDateValue(block.DTEND.value);
        if (end && !end.allDay) end = { date: startOfDay(end.date) };
        if (end) {
          spanDays = daysBetween(startOfDay(start.date), startOfDay(end.date)) - 1;
          if (spanDays < 0) spanDays = 0;
          if (spanDays > 60) spanDays = 60;
        }
      }

      if (start.allDay) {
        dates.forEach(function (date) {
          var base = startOfDay(date);
          for (var day = 0; day <= spanDays; day += 1) {
            entries.push({ key: keyOf(addDays(base, day)), time: "", title: title });
          }
        });
        return;
      }

      dates.forEach(function (date) {
        entries.push({ key: keyOf(date), time: timeOf(date), title: title });
      });
    });

    return {
      entries: entries,
      skipped: skipped,
      recurring: recurring,
      events: blocks.length,
    };
  }

  // ---------- 合进日历的事件表 ----------

  function makeId(seed) {
    return (
      "ics-" +
      String(typeof seed === "number" ? seed : Date.now()) +
      "-" +
      Math.random().toString(36).slice(2, 6)
    );
  }

  /**
   * 把解析出来的条目并进 `{ "YYYY-MM-DD": [{id, time, title}] }`。
   *
   * 同一天里"时间 + 标题"完全一样的算重复，直接跳过：导入同一份 `.ics`
   * 两次不该让日历上出现两遍。原表不动，返回新表 —— 和日历自己那几个
   * 纯函数一个规矩（自检页靠这一点做断言）。
   */
  function mergeInto(events, entries, options) {
    var opts = options || {};
    var maxPerDay = opts.maxPerDay || 50;
    var next = {};
    Object.keys(events || {}).forEach(function (key) {
      next[key] = events[key];
    });

    var added = 0;
    var duplicates = 0;
    var overflow = 0;

    (entries || []).forEach(function (entry, index) {
      var list = Array.isArray(next[entry.key]) ? next[entry.key] : [];
      var time = entry.time || "";
      var duplicate = list.some(function (item) {
        return item && item.title === entry.title && (item.time || "") === time;
      });
      if (duplicate) {
        duplicates += 1;
        return;
      }
      if (list.length >= maxPerDay) {
        overflow += 1;
        return;
      }
      next[entry.key] = list.concat([{ id: makeId(index), time: time, title: entry.title }]);
      added += 1;
    });

    return { events: next, added: added, duplicates: duplicates, overflow: overflow };
  }

  window.__latticeIcs = {
    unfold: unfold,
    unescapeText: unescapeText,
    parseProperty: parseProperty,
    parseDateValue: parseDateValue,
    parseRule: parseRule,
    expand: expand,
    parseEvents: parseEvents,
    mergeInto: mergeInto,
    keyOf: keyOf,
    timeOf: timeOf,
    startOfDay: startOfDay,
    addDays: addDays,
    WEEKDAY: WEEKDAY,
    MAX_INSTANCES: MAX_INSTANCES,
    WINDOW_DAYS: WINDOW_DAYS,
  };
})();
