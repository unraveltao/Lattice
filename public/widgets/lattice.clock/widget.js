/**
 * 时钟组件
 *
 * 注意：这里是"第三方视角"的代码，不 import 平台任何东西，
 * 只通过 postMessage 跟宿主说话。等 @lattice/sdk 发布后，
 * 下面这段 call / 主题同步会被 SDK 取代，组件业务代码不用改。
 *
 * 这个版本有两处值得对照着看（都是 v0.3 改的）：
 *
 * 1. **12/24 小时制不再是卡片上的一颗按钮**，而是清单里的 `config`。
 *    以前那颗按钮把偏好写进 `storage`，粒度是"这个组件"—— 桌面上摆两个
 *    时钟，切一个另一个跟着变。现在配置按**实例**存在 `state.json` 里，
 *    由属性面板调，卡片把那一行空间还给了时间本身。
 * 2. **心跳挂在平台调度器上**，不是 `setInterval`。窗口最小化 / 收起时
 *    整条时间轴停摆，用户看不见的时钟不烧电；回来只补一拍。
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
  var config = { hour12: false, showSeconds: false };

  function applyConfig(next) {
    if (!next) return;
    config = {
      hour12: next.hour12 === true,
      showSeconds: next.showSeconds === true,
    };
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
  var tickId = 0;

  var WEEKDAYS = {
    zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

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

        // 日期：英文是 "Oct 22, Thu"（月份缩写 + 日 + 星期），中文是 "10月22日 周四"。
        // 时区 ID（Asia/Shanghai）是给程序看的，桌面时钟上没人想读它，
        // 换成星期几，这块空间才算有用。
        dateEl.textContent =
          lang === "en"
            ? MONTHS[date.getMonth()] + " " + date.getDate() + ", " + WEEKDAYS.en[date.getDay()]
            : date.getMonth() + 1 + "月" + date.getDate() + "日 " + WEEKDAYS.zh[date.getDay()];
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
})();
