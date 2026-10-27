/**
 * 截止日期组件的纯逻辑：一行文字 → 一条待办，以及排序、倒数、增删。
 *
 * # 为什么是"打字"而不是日期选择器
 *
 * 卡片只有 240×140 的空间，而一个原生 `<input type="date">` 在沙箱里
 * 颜色是错的（文档的 `color-scheme` 被钉成 `normal`，深色底板上日历图标是
 * 黑的）。更要紧的是：截止日期卡片上通常一次要记好几件事，为每一件都摆一个
 * 日期控件，既挤又慢。所以这里只留一个输入框，日期写在后面：
 *
 *   还书 3/15        买猫粮 +3        体检 2026-05-01        交房租 明天
 *
 * 解析规则全部在这个文件里（`parseLine`），组件只管把结果画出来。
 *
 * # 认不出日期怎么办
 *
 * 不拒绝、不弹错：按明天算，并在卡片顶上明说"没写日期，按明天算"。
 * 一条被吞掉的输入比一条猜错日期的输入更让人恼火 —— 前者用户会以为组件坏了。
 */
(function () {
  "use strict";

  var DAY_MS = 86400000;

  // ---------- 日期小工具 ----------

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function dayDiff(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
  }

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  /** 存档里用 "2026-03-15"：可读、可排序、跨时区不会变成前一天 */
  function dateKey(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  /** 读回来非法就返回 null（不存在"差不多能用"的日期） */
  function parseDateKey(key) {
    if (typeof key !== "string") return null;
    var parts = key.split("-");
    if (parts.length !== 3) return null;
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var day = Number(parts[2]);
    if (!year || !month || !day) return null;
    var date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  // ---------- 一行文字 → 一条截止日期 ----------

  /*
   * 日期只认"写在最后"的那种（卡片上写起来最顺）：先从行尾剥掉日期，
   * 剩下的就是标题。"报告 v1.2" 这种以数字结尾的标题不该被吃掉，所以
   * 短日期前面必须有空白或分隔符 —— `v1.2` 前面是字母，不匹配。
   */
  var SEP = "(?:^|[\\s(（,，:：、])";
  var FULL_DATE = new RegExp(SEP + "(\\d{4})\\s*[-/.年]\\s*(\\d{1,2})\\s*[-/.月]\\s*(\\d{1,2})\\s*日?\\s*$");
  var SHORT_DATE = new RegExp(SEP + "(\\d{1,2})\\s*[-/.月]\\s*(\\d{1,2})\\s*日?\\s*$");
  /* 加号是最不容易误认的标记，前后都不用空格（「猫粮+3」也认） */
  var PLUS_DAYS = /\+\s*(\d{1,3})\s*[天日d]?\s*$/;
  /* 中文没有词间空格，"还书明天"也该认；英文那边仍然要求一个空格，
     免得把 "foodtoday" 这种词吃掉 */
  var RELATIVE_ZH = /(今天|明天|后天)\s*$/;
  var RELATIVE_EN = /(?:^|\s)(today|tomorrow)\s*$/i;

  function cutTitle(text, match) {
    // match.index 指向日期前面那个空白/括号，标题到此为止
    return text.slice(0, match.index).replace(/[\s,，、·:：]+$/, "").trim();
  }

  /**
   * 解析一行输入。
   *
   * @returns {{title: string, due: Date, guessed: boolean}|null} 没写标题就返回 null
   */
  function parseLine(text, today) {
    var source = String(text == null ? "" : text).trim();
    if (!source) return null;
    var base = startOfDay(today);

    /*
     * 每个分支里"日期认出来了、标题却是空的"都直接返回 null：那一行只写了
     * 一个日期，没有说要做的事。这种输入不该被猜成一条待办，也不该被
     * 当成标题吞下去 —— 组件那边会提示「先写一件事」。
     */
    var match = source.match(FULL_DATE);
    if (match) {
      var full = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (!isNaN(full.getTime()) && full.getMonth() === Number(match[2]) - 1) {
        var fullTitle = cutTitle(source, match);
        return fullTitle ? { title: fullTitle, due: full, guessed: false } : null;
      }
    }

    match = source.match(SHORT_DATE);
    if (match) {
      var month = Number(match[1]);
      var day = Number(match[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        var short = new Date(base.getFullYear(), month - 1, day);
        if (short.getMonth() === month - 1 && short.getDate() === day) {
          // 已经过去的日子按明年算（记逾期请写全年份）
          if (short < base) short = new Date(base.getFullYear() + 1, month - 1, day);
          var shortTitle = cutTitle(source, match);
          return shortTitle ? { title: shortTitle, due: short, guessed: false } : null;
        }
      }
    }

    match = source.match(PLUS_DAYS);
    if (match) {
      var days = Number(match[1]);
      var plusTitle = cutTitle(source, match);
      return plusTitle
        ? {
            title: plusTitle,
            due: new Date(base.getFullYear(), base.getMonth(), base.getDate() + days),
            guessed: false,
          }
        : null;
    }

    match = source.match(RELATIVE_ZH) || source.match(RELATIVE_EN);
    if (match) {
      var word = match[1].toLowerCase();
      var offset = word === "今天" || word === "today" ? 0 : word === "后天" ? 2 : 1;
      var wordTitle = cutTitle(source, match);
      return wordTitle
        ? {
            title: wordTitle,
            due: new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset),
            guessed: false,
          }
        : null;
    }

    // 没认出日期：按明天算，并且告诉调用方这是猜的
    return { title: source, due: new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1), guessed: true };
  }

  // ---------- 条目 ----------

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    var title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return null;
    var due = parseDateKey(raw.due);
    if (!due) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : "",
      title: title.slice(0, 120),
      due: dateKey(due),
      done: raw.done === true,
    };
  }

  /**
   * 坏条目逐条丢，和清单 / help 一条规矩：存档不该有"让整张卡片打不开"的权力。
   * 上限 200 条 —— 卡片上滚不完的列表没有意义，多出来的多半是坏文件。
   */
  function normalizeItems(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length && out.length < 200; i += 1) {
      var entry = normalizeEntry(raw[i]);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** 未完成的按日期排前面，完成的沉到底 —— 和待办组件的排序规矩一致 */
  function sortItems(items) {
    return items
      .map(function (item, index) {
        return { item: item, index: index };
      })
      .sort(function (a, b) {
        if (a.item.done !== b.item.done) return a.item.done ? 1 : -1;
        if (a.item.due !== b.item.due) return a.item.due < b.item.due ? -1 : 1;
        return a.index - b.index;
      })
      .map(function (entry) {
        return entry.item;
      });
  }

  function makeId(seed) {
    var random = Math.random().toString(36).slice(2, 6);
    return (typeof seed === "number" ? seed.toString(36) : Date.now().toString(36)) + random;
  }

  function addItem(items, entry, seed) {
    var item = {
      id: makeId(seed),
      title: entry.title,
      due: dateKey(entry.due),
      done: false,
    };
    return items.concat([item]);
  }

  function toggleItem(items, id) {
    return items.map(function (item) {
      return item.id === id ? { id: item.id, title: item.title, due: item.due, done: !item.done } : item;
    });
  }

  function removeItem(items, id) {
    return items.filter(function (item) {
      return item.id !== id;
    });
  }

  // ---------- 给人看的说法 ----------

  /**
   * 「逾期 2 天」/「今天」/「明天」/「3 天后」，超过一周就写日期本身 ——
   * 44 天后这种数字读起来没有意义，3 月 15 日才有。
   */
  function dueText(today, dueKey, lang) {
    var due = parseDateKey(dueKey);
    if (!due) return "";
    var days = dayDiff(today, due);
    var en = lang === "en";
    if (days < 0) {
      var late = -days;
      return en ? (late === 1 ? "1 day overdue" : late + " days overdue") : "逾期 " + late + " 天";
    }
    if (days === 0) return en ? "today" : "今天";
    if (days === 1) return en ? "tomorrow" : "明天";
    if (days === 2) return en ? "in 2 days" : "后天";
    if (days <= 7) return en ? "in " + days + " days" : days + " 天后";
    if (en) {
      var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return months[due.getMonth()] + " " + due.getDate();
    }
    return due.getMonth() + 1 + "月" + due.getDate() + "日";
  }

  /** 顶上那行：还剩几件、几件逾期（完成的单独数） */
  function summary(items, today) {
    var open = 0;
    var overdue = 0;
    var done = 0;
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].done) {
        done += 1;
        continue;
      }
      open += 1;
      if (dayDiff(today, parseDateKey(items[i].due) || today) < 0) overdue += 1;
    }
    return { open: open, overdue: overdue, done: done, total: items.length };
  }

  window.__latticeDeadlineCore = {
    startOfDay: startOfDay,
    dayDiff: dayDiff,
    dateKey: dateKey,
    parseDateKey: parseDateKey,
    parseLine: parseLine,
    normalizeItems: normalizeItems,
    sortItems: sortItems,
    addItem: addItem,
    toggleItem: toggleItem,
    removeItem: removeItem,
    dueText: dueText,
    summary: summary,
    makeId: makeId,
  };
})();
