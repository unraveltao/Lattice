/**
 * 时钟组件
 *
 * 注意：这里是"第三方视角"的代码，不 import 平台任何东西，
 * 只通过 postMessage 跟宿主说话。等 @lattice/sdk 发布后，
 * 下面这段 call / 主题同步会被 SDK 取代，组件业务代码不用改。
 *
 * 这个版本有三处值得对照着看：
 *
 * 1. **12/24 小时制、秒数、表盘形态、其他时区都不是卡片上的按钮**，而是
 *    清单里的 `config`。以前那颗按钮把偏好写进 `storage`，粒度是"这个组件"
 *    —— 桌面上摆两个时钟，切一个另一个跟着变。现在配置按**实例**存在
 *    `state.json` 里，由属性面板调，卡片把那一行空间还给了时间本身。
 * 2. **心跳挂在平台调度器上**，不是 `setInterval`。窗口最小化 / 收起时
 *    整条时间轴停摆，用户看不见的时钟不烧电；回来只补一拍。
 * 3. **其他时区用 `Intl` 现算**，不是自己加偏移量。偏移量里有夏令时、
 *    有半小时时区（Asia/Kolkata）、有永久偏移（Asia/Kathmandu 是 5:45），
 *    手算这些不如把时区名交给运行时。
 *
 * 表盘是一张内联 SVG：时针 / 分针 / 秒针各自转一个角度。角度按"连续"算
 * （分针带着时针走、秒针带着分针走），否则 13:59 的时针会直挺挺指着 1 点，
 * 看着像停了。
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
   * 界面语言。
   *
   * 平台在设置里能切中英两门，而**卡片上的字是这个组件自己的** —— 平台不知道
   * "周日"对应哪句英文。所以两门都留在这儿，按 `lang.get` 挑一份；用户中途换
   * 语言，平台推一条 `language`，把已经画出去的字原地换掉（两件事都要做：只读
   * 一次 = 换语言卡片不动，只听推送 = 语言停在建文档那一刻）。
   *
   * 首帧不等桥（不变量 18）：HTML 里写死的是中文，中文界面看到的就是最终样子；
   * 英文界面要等 `lang.get` 回来那一趟（几十毫秒）才翻，换来的是不用先画一遍
   * "加载中"。`lang` 只有 `zh` / `en` 两种 —— "跟随系统"是平台在设置里解析掉的。
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
    document.title = say("时钟", "Clock");
    // 星期、月份、上午下午、报错那几句都跟语言有关，重画一次比逐个替换稳
    render();
  }

  /*
   * 配置。默认值写在这里**只是**为了在 `config.get` 回来之前有个能画的东西 ——
   * 真值永远以宿主给的为准（它已经按清单的 schema 合并过出厂值）。
   */
  var config = { hour12: false, showSeconds: false, face: "digital", zones: "" };
  /** 解析后的时区表（最多 3 条），`config.zones` 是用户写的那串原文 */
  var zoneList = [];

  var MAX_ZONES = 3;

  /** `"Asia/Tokyo, Europe/London"` → `["Asia/Tokyo", "Europe/London"]` */
  function parseZones(raw) {
    var out = [];
    String(raw == null ? "" : raw)
      .split(",")
      .forEach(function (piece) {
        var zone = piece.trim();
        if (!zone || out.length >= MAX_ZONES) return;
        out.push(zone);
      });
    return out;
  }

  /** `America/New_York` → `New York`：卡片上写时区 ID 没人想读 */
  function zoneLabel(zone) {
    var pieces = String(zone || "").split("/");
    var city = pieces[pieces.length - 1] || String(zone || "");
    return city.replace(/_/g, " ");
  }

  function applyConfig(next) {
    if (!next) return;
    config = {
      hour12: next.hour12 === true,
      showSeconds: next.showSeconds === true,
      face: next.face === "analog" ? "analog" : "digital",
      zones: typeof next.zones === "string" ? next.zones : "",
    };
    zoneList = parseZones(config.zones);
    render();
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

    // 属性面板改了配置：就地重画。宿主不会为了这个重载组件
    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
      return;
    }

    // 平台的心跳。一条时间轴上可能挂着好几条订阅，认准自己那一条
    if (data.type === "tick") {
      if (data.payload && data.payload.id === tickId) render();
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

  // ---------- 业务 ----------
  var root = document.getElementById("clock");
  var timeEl = document.getElementById("time");
  var suffixEl = document.getElementById("suffix");
  var dateEl = document.getElementById("date");
  var dialEl = document.getElementById("dial");
  var hourHand = document.getElementById("hand-hour");
  var minuteHand = document.getElementById("hand-minute");
  var secondHand = document.getElementById("hand-second");
  var zonesEl = document.getElementById("zones");
  var tickId = 0;

  var WEEKDAYS = {
    zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  // ---------- 表盘 ----------

  /**
   * 三根针的角度。按连续角度算：13:59 的时针在 1 和 2 之间，不是正指 1 点；
   * 分针带着秒走，秒针跳一格分针也挪一点 —— 不然看着像停了。
   */
  function angles(date) {
    var seconds = date.getSeconds();
    var minutes = date.getMinutes() + seconds / 60;
    var hours = (date.getHours() % 12) + minutes / 60;
    return {
      hour: round1(hours * 30),
      minute: round1(minutes * 6),
      second: round1(seconds * 6),
    };
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  /** 12 个刻度，每三个粗一档（3、6、9、12 点） */
  function buildTicks() {
    var group = document.getElementById("dial-ticks");
    if (!group) return;
    var ns = "http://www.w3.org/2000/svg";
    for (var i = 0; i < 12; i += 1) {
      var line = document.createElementNS(ns, "line");
      var major = i % 3 === 0;
      line.setAttribute("x1", "50");
      line.setAttribute("y1", major ? "5.5" : "7.5");
      line.setAttribute("x2", "50");
      line.setAttribute("y2", "11");
      line.setAttribute("class", major ? "dial-tick is-major" : "dial-tick");
      line.setAttribute("transform", "rotate(" + i * 30 + " 50 50)");
      group.appendChild(line);
    }
  }

  function paintDial(date) {
    if (!hourHand) return;
    var at = angles(date);
    hourHand.setAttribute("transform", "rotate(" + at.hour + " 50 50)");
    minuteHand.setAttribute("transform", "rotate(" + at.minute + " 50 50)");
    secondHand.setAttribute("transform", "rotate(" + at.second + " 50 50)");
  }

  // ---------- 其他时区 ----------

  var zoneFormats = {};

  /**
   * 每个时区一个 `Intl.DateTimeFormat`，认不出（写错名字）就缓存 null。
   * 缓存键带上 12/24 小时制 —— 换制式要换 formatter。
   */
  function zoneFormatter(zone) {
    var key = (config.hour12 ? "h12:" : "h23:") + zone;
    if (key in zoneFormats) return zoneFormats[key];
    var formatter = null;
    try {
      formatter = config.hour12
        ? new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })
        : new Intl.DateTimeFormat("en-GB", {
            timeZone: zone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          });
    } catch (error) {
      // 时区名写错：不抛、不猜，那一行下面会画 "--:--"
      formatter = null;
    }
    zoneFormats[key] = formatter;
    return formatter;
  }

  /** 某个时区的 `HH:MM`（或 12 小时制带上午 / 下午）；认不出返回 null */
  function zoneTime(date, zone) {
    var formatter = zoneFormatter(zone);
    if (!formatter) return null;
    var hour = "";
    var minute = "";
    var period = "";
    var parts = formatter.formatToParts(date);
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].type === "hour") hour = parts[i].value;
      else if (parts[i].type === "minute") minute = parts[i].value;
      else if (parts[i].type === "dayPeriod") period = parts[i].value;
    }
    if (!config.hour12) return hour + ":" + minute;
    var number = Number(hour) % 12 || 12;
    var suffix = String(period).toUpperCase() === "PM" ? say("下午", "PM") : say("上午", "AM");
    return number + ":" + minute + " " + suffix;
  }

  function renderZones(date) {
    if (!zonesEl) return;
    zonesEl.textContent = "";
    zonesEl.hidden = zoneList.length === 0;
    for (var i = 0; i < zoneList.length; i += 1) {
      var zone = zoneList[i];
      var row = document.createElement("div");
      row.className = "clock-zone";

      var name = document.createElement("span");
      name.className = "clock-zone-name";
      name.textContent = zoneLabel(zone);
      name.title = zone;

      var value = document.createElement("span");
      value.className = "clock-zone-time";
      var text = zoneTime(date, zone);
      value.textContent = text === null ? "--:--" : text;

      row.appendChild(name);
      row.appendChild(value);
      zonesEl.appendChild(row);
    }
  }

  // ---------- 主时钟 ----------

  function render() {
    call("clock.now")
      .then(function (info) {
        var date = new Date(info.epochMs);
        var hours = date.getHours();
        var suffix = "";
        if (config.hour12) {
          // 中文不写 AM/PM，写上午 / 下午；英文仍然是那三四个字母
          suffix = hours < 12 ? say("上午", "AM") : say("下午", "PM");
          hours = hours % 12 || 12;
        }

        var text = (config.hour12 ? hours : pad(hours)) + ":" + pad(date.getMinutes());
        if (config.showSeconds) text += ":" + pad(date.getSeconds());
        timeEl.textContent = text;
        // 上午/下午、AM/PM 用 12px 挂在数字右边：跟数字一样大的话会宽到折行
        suffixEl.textContent = suffix.trim();
        root.classList.toggle("is-long", config.showSeconds);
        root.classList.toggle("is-analog", config.face === "analog");

        // 日期：英文是 "Oct 22, Thu"（月份缩写 + 日 + 星期），中文是 "10月22日 周四"。
        // 时区 ID（Asia/Shanghai）是给程序看的，桌面时钟上没人想读它，
        // 换成星期几，这块空间才算有用。
        dateEl.textContent =
          lang === "en"
            ? MONTHS[date.getMonth()] + " " + date.getDate() + ", " + WEEKDAYS.en[date.getDay()]
            : date.getMonth() + 1 + "月" + date.getDate() + "日 " + WEEKDAYS.zh[date.getDay()];

        if (config.face === "analog") {
          paintDial(date);
          // 表盘上没有文字，读屏器就靠这一句
          dialEl.setAttribute("aria-label", text + (suffix ? " " + suffix.trim() : ""));
        }

        renderZones(date);
      })
      .catch(function (error) {
        timeEl.textContent = "--:--";
        dateEl.textContent =
          error.code === "permission_denied"
            ? say("需要「时钟」权限", "Needs clock permission")
            : say("读不到时间", "Could not read the time");
      });
  }

  /*
   * 启动顺序：先读配置（决定怎么画），再挂心跳，最后告诉宿主"我好了"。
   *
   * `ready` 之后宿主还会推一次主题和配置 —— 那是给"宿主先加载、组件后到"
   * 这种时序兜底的，重复应用一次没有副作用。
   */
  buildTicks();

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住配置和心跳
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画：时钟不该因为问不到语言就不走 */
    });

  call("config.get")
    .then(function (values) {
      if (values) applyConfig(values);
    })
    .catch(function () {
      /* 拿不到配置就用出厂值：时钟不该因为读不到偏好就不走 */
    })
    .then(function () {
      render();
      return call("schedule.every", { every: 1000 });
    })
    .then(function (grant) {
      tickId = grant && typeof grant.id === "number" ? grant.id : 0;
    })
    .catch(function () {
      /* 心跳没挂上就停在这一帧，至少时间是对的 */
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });

  /* 自检页用：解析时区、算角度、读当前配置 */
  window.__latticeClock = {
    parseZones: parseZones,
    zoneLabel: zoneLabel,
    angles: angles,
    zoneTime: function (date, zone) {
      return zoneTime(date, zone);
    },
    MAX_ZONES: MAX_ZONES,
    snapshot: function () {
      return { config: config, zones: zoneList.slice() };
    },
  };
})();
