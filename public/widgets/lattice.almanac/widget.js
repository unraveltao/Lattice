/**
 * 农历 / 节气 / 节日组件
 *
 * 第三方视角：不 import 平台任何东西，只通过 postMessage 跟宿主说话。
 * 所有日期运算在 `almanac-core.js` 里（纯逻辑、按本地日期、可断言），这里
 * 只管排版、换语言和跟着一天一天翻篇。
 *
 * 两件事值得说明：
 *  1. **首帧不等桥。** 卡片上这些东西用这台机器自己的 `new Date()` 就能算，
 *     所以打开就是对的；`clock.now` 回来之后只是再算一次（平台时钟和系统
 *     时钟通常一致，不一致时以平台的为准）。
 *  2. **心跳一分钟一拍，且只在跨天时重画。** 农历/节气/节日的粒度是"天"，
 *     每分钟问一次是为了在午夜那一分钟翻过去，不是为了让卡片一直动。
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

  var lang = "zh";

  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  // ---------- 业务 ----------
  var core = window.__latticeAlmanacCore;

  var headEl = document.getElementById("head");
  var lunarEl = document.getElementById("lunar");
  var subEl = document.getElementById("sub");
  var termKeyEl = document.getElementById("term-key");
  var termNameEl = document.getElementById("term-name");
  var termWhenEl = document.getElementById("term-when");
  var festKeyEl = document.getElementById("fest-key");
  var festNameEl = document.getElementById("fest-name");
  var festWhenEl = document.getElementById("fest-when");

  var MONTHS_EN = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  var model = null;
  var tickId = 0;

  /** 「今天」/「明天」/「还有 12 天」—— 这三个说法比 "0 天" 好读 */
  function whenText(date, days) {
    if (days === 0) return say("今天", "today");
    if (days === 1) return say("明天", "tomorrow");
    if (lang === "en") return "in " + days + " days";
    return "还有 " + days + " 天";
  }

  function dateText(date) {
    var month = date.getMonth() + 1;
    var day = date.getDate();
    if (lang === "en") return MONTHS_EN[date.getMonth()] + " " + day;
    return month + "月" + day + "日";
  }

  function render() {
    if (!model) return;
    var g = model.gregorian;

    headEl.textContent =
      lang === "en"
        ? MONTHS_EN[g.month - 1] + " " + g.day + ", " + g.year + " · " + g.weekdayEn
        : g.year + "年" + g.month + "月" + g.day + "日 " + g.weekdayZh;

    var lunar = model.lunar;
    if (lunar) {
      lunarEl.textContent = lang === "en" ? core.lunarLabelEn(lunar) : lunar.label;
      subEl.textContent =
        lang === "en"
          ? lunar.gzPinyin + " year · " + lunar.zodiac.en
          : lunar.yearName + lunar.zodiac.zh + "年";
      lunarEl.removeAttribute("title");
    } else {
      // ICU 里没有中国历法的运行时（极少见）：不装作算过，只说没有
      lunarEl.textContent = say("农历不可用", "No Chinese calendar");
      subEl.textContent = "";
      lunarEl.title = say("这个运行时的 ICU 没有中国历法", "This runtime's ICU has no Chinese calendar");
    }

    termKeyEl.textContent = say("节气", "Term");
    festKeyEl.textContent = say("节日", "Festival");

    termNameEl.textContent = lang === "en" ? model.term.en : model.term.zh;
    termWhenEl.textContent = model.term.today
      ? say("就是今天", "today")
      : dateText(model.term.date) + " · " + whenText(model.term.date, model.term.days);

    festNameEl.textContent = lang === "en" ? model.festival.en : model.festival.zh;
    festWhenEl.textContent = model.festival.today
      ? say("就是今天", "today")
      : dateText(model.festival.date) + " · " + whenText(model.festival.date, model.festival.days);

    // 今天正是节气 / 节日时，那一行换成强调色
    document.body.setAttribute("data-term-today", model.term.today ? "true" : "false");
    document.body.setAttribute("data-festival-today", model.festival.today ? "true" : "false");
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("农历", "Almanac");
    render();
  }

  /** 换一天（或者第一次）：只有日期真的变了才重画，省掉一分钟一次的重排 */
  function applyModel(now) {
    var next = core.cardModel(now);
    var changed = !model || next.key !== model.key;
    model = next;
    if (changed) render();
  }

  function refresh() {
    call("clock.now")
      .then(function (info) {
        var ms = info && typeof info.epochMs === "number" ? info.epochMs : Date.now();
        applyModel(new Date(ms));
      })
      .catch(function () {
        // 读不到平台时钟（没权限 / 没宿主）：用这张卡片自己的钟，日期照样对
        applyModel(new Date());
      });
  }

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

    if (data.type === "tick") {
      if (data.payload && data.payload.id === tickId) refresh();
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

  // 首帧：不碰桥，先按这台机器自己的时钟画出来
  applyModel(new Date());

  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到语言就按中文画 */
    });

  refresh();

  call("schedule.every", { every: 60000 })
    .then(function (grant) {
      tickId = grant && typeof grant.id === "number" ? grant.id : 0;
    })
    .catch(function () {
      /* 心跳没挂上：卡片停在今天，跨天也不会自己翻 —— 但不会画错 */
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
