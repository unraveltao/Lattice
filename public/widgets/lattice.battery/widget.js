/**
 * 电池组件
 *
 * 只做一件事：每半分钟向平台要一次电源读数，画成"一个百分数 + 一条 + 两行字"。
 *
 * 为什么没有本地倒计时：剩余时间是**系统估的**，不是平台算的。插着电的时候它
 * 根本没有意义，而且平台在窗口不可见时会停掉整条时间轴（不变量 10）—— 自己
 * 每秒减一，藏起来半天之后就会变成一句错话。
 *
 * 读数的两个哨兵（`255` / `u32::MAX`）已经在 `power_policy.rs` 里判掉了，
 * 这里再防一层"不是数字 / 越界 / 缺字段"，只是为了让浏览器预览与将来的老宿主
 * 不至于画出一个 0%。口径钉在 `tests/battery.html`（`window.__latticeBattery`）。
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
   * 界面语言：`lang.get` 拉一次 + 收 `language` 推送，两件都要
   * （只读一次换语言卡片不动，只听推送热重载之后停在旧语言）。
   * 首帧按 HTML 里写死的中文画，不为这几十毫秒画"加载中"（不变量 18）。
   */
  var lang = "zh";

  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  // ---------- 纯逻辑 ----------

  /** 多久问一次。电量变得很慢，半分钟一拍足够；也远小于"插拔电源最多晚多久发现" */
  var REFRESH_MS = 30000;

  /** 一份"什么都不知道"的读数 —— 首帧、读失败、预览（没有 Rust）都用它 */
  var EMPTY = {
    ac: null,
    percent: null,
    charging: false,
    noBattery: false,
    critical: false,
    saver: false,
    minutesLeft: null,
  };

  function numOrNull(value, min, max) {
    if (typeof value !== "number" || !isFinite(value)) return null;
    var rounded = Math.round(value);
    if (rounded < min || rounded > max) return null;
    return rounded;
  }

  /**
   * 宿主给的读数 → 组件认的读数。字段一律从严：
   * 不是 `true` 就当 `false`（少报一个"充电中"比多报安全），
   * 百分数与分钟越界当"读不出来"（这正是不变量 18 那条"别把坏值画成好看的值"）。
   */
  function parsePower(raw) {
    var src = raw && typeof raw === "object" ? raw : {};
    return {
      ac: src.ac === true ? true : src.ac === false ? false : null,
      percent: numOrNull(src.percent, 0, 100),
      charging: src.charging === true,
      noBattery: src.noBattery === true,
      critical: src.critical === true,
      saver: src.saver === true,
      // 一星期的分钟数已经是"坏读数"能和"估得松"分开的地方了（见 power_policy.rs）
      minutesLeft: numOrNull(src.minutesLeft, 0, 10080),
    };
  }

  /**
   * 现在是什么状态。**没有电池排第一**：台式机上 `ac` 也可能是 true，
   * 那时说"接着电"没错但没用 —— 用户真正要知道的是"这台机器没有电池可读"。
   */
  function stateKey(power) {
    if (power.noBattery) return "noBattery";
    if (power.ac === true) return power.charging ? "charging" : "plugged";
    if (power.ac === false) return "battery";
    return "unknown";
  }

  /**
   * 整张卡片的调子。`charging` 压过一切（充着电说"电量低"是在吓人），
   * `critical` 压过阈值（系统说马上就要关机，比用户自己定的线更急）。
   */
  function tone(power, warnBelow) {
    if (power.noBattery) return "none";
    if (power.percent == null) return "unknown";
    if (power.charging) return "charging";
    if (power.critical) return "critical";
    if (power.percent <= warnBelow) return "low";
    return "ok";
  }

  /** 进度条的宽度。没读数就是 0，不做假水位 */
  function barWidth(percent) {
    if (typeof percent !== "number" || !isFinite(percent)) return 0;
    if (percent < 0) return 0;
    if (percent > 100) return 100;
    return Math.round(percent);
  }

  /** 配置里的告警线：坏值落回 20，夹进 0–99（100 等于"永远告警"，没有意义） */
  function warnOf(config) {
    var raw = config && typeof config === "object" ? config.warnBelow : null;
    if (typeof raw !== "number" || !isFinite(raw)) return 20;
    var value = Math.round(raw);
    if (value < 0) return 0;
    if (value > 99) return 99;
    return value;
  }

  /**
   * 分钟 → 人话。秒数是系统估的、往下取整过的，"不到一分钟"按 0 处理 ——
   * 报"还能用 0 分钟"看着像已经关机了。
   */
  function formatMinutes(minutes, which) {
    var zh = which !== "en";
    if (typeof minutes !== "number" || !isFinite(minutes) || minutes < 0) return "";
    var total = Math.round(minutes);
    if (total < 1) return zh ? "不到 1 分钟" : "under a minute";
    if (total < 60) return zh ? total + " 分钟" : total + " min";
    var hours = Math.floor(total / 60);
    var rest = total % 60;
    if (!rest) return zh ? hours + " 小时" : hours + " h";
    return zh ? hours + " 小时 " + rest + " 分" : hours + " h " + rest + " min";
  }

  /**
   * 第二行。顺序是"哪句话现在最有用"：
   * 系统说快关机 > 还剩多久 > 该插电了 > 空着。
   * 插着电的时候没有这些字 —— 那时既没有剩余时间，也不该催人插电。
   * `warnBelow` 就是配置里那一条，和整张卡片的调子用同一个判据（`tone`），
   * 免得"卡片变红了但下面写着没事"。
   */
  function detailText(power, which, showTime, warnBelow) {
    var zh = which !== "en";
    if (power.critical && !power.charging && !power.noBattery) {
      return zh ? "马上就要关机" : "About to shut down";
    }
    if (showTime && power.minutesLeft != null) {
      return zh ? "还剩 " + formatMinutes(power.minutesLeft, "zh") : formatMinutes(power.minutesLeft, "en") + " left";
    }
    if (power.ac === false && tone(power, warnBelow) === "low") {
      return zh ? "该插电了" : "Plug in when you can";
    }
    return "";
  }

  // 断言页从这里取纯逻辑：不复制一份去测（和 habit / diagram 同一个路子）
  window.__latticeBattery = {
    parsePower: parsePower,
    stateKey: stateKey,
    tone: tone,
    barWidth: barWidth,
    warnOf: warnOf,
    formatMinutes: formatMinutes,
    detailText: detailText,
    EMPTY: EMPTY,
    REFRESH_MS: REFRESH_MS,
  };

  // ---------- 界面 ----------

  var cardEl = document.getElementById("card");
  var titleEl = document.getElementById("title");
  var saverEl = document.getElementById("saver");
  var percentEl = document.getElementById("percent");
  var barEl = document.getElementById("bar");
  var fillEl = document.getElementById("fill");
  var stateEl = document.getElementById("state");
  var detailEl = document.getElementById("detail");

  var power = EMPTY;
  var config = { warnBelow: 20, showTime: true };
  /** 权限被拒过一次之后，卡片说的是"缺哪项权限"而不是"没有读数" */
  var denied = false;

  function stateText(key) {
    if (denied) return say("需要「系统指标」权限", "Needs the System metrics permission");
    switch (key) {
      case "noBattery":
        return say("没有电池", "No battery");
      case "charging":
        return say("充电中", "Charging");
      case "plugged":
        return say("接着电", "Plugged in");
      case "battery":
        return say("用电池", "On battery");
      default:
        return say("没有读数", "No reading");
    }
  }

  var TONE_CLASS = {
    charging: " is-charging",
    low: " is-low",
    critical: " is-critical",
    none: " is-muted",
    unknown: " is-muted",
  };

  function render() {
    var key = stateKey(power);
    var mood = tone(power, warnOf(config));
    cardEl.className = "battery" + (TONE_CLASS[mood] || "");

    var percent = power.percent;
    percentEl.textContent = denied || percent == null ? "—" : String(percent);
    fillEl.style.width = barWidth(percent) + "%";
    barEl.setAttribute("aria-valuenow", String(barWidth(percent)));
    barEl.setAttribute("aria-valuetext", stateText(key));

    stateEl.textContent = stateText(key);
    var detail = denied ? "" : detailText(power, lang, config.showTime !== false, warnOf(config));
    detailEl.textContent = detail;
    detailEl.hidden = detail === "";

    saverEl.textContent = say("省电模式", "Battery saver");
    saverEl.hidden = !power.saver;
  }

  function refresh() {
    return call("power.status")
      .then(function (raw) {
        denied = false;
        power = parsePower(raw);
        render();
      })
      .catch(function (error) {
        denied = Boolean(error && error.code === "permission_denied");
        power = EMPTY;
        render();
      });
  }

  function applyConfig(next) {
    if (!next || typeof next !== "object") return;
    config = { warnBelow: warnOf(next), showTime: next.showTime !== false };
    render();
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("电池", "Battery");
    titleEl.textContent = say("电池", "Battery");
    render();
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
    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
      return;
    }
    if (data.type === "tick") {
      // 一拍问一次。窗口藏起来时时间轴停摆，回来那一拍照样刷新（不变量 10）
      refresh();
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

  // ---------- 启动 ----------
  // 首帧：什么都不知道就画"没有读数"，同步画出来；等桥回来再换成真的（不变量 18）
  titleEl.textContent = say("电池", "Battery");
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

  call("schedule.every", { every: REFRESH_MS }).catch(function () {});

  // 第一拍读数拿到之后才报 ready：宿主据此把"加载中"撤掉，而这一拍就是
  // 卡片上最终会显示的那个数（不变量 18：先画默认值，回来再改）
  refresh().then(function () {
    parent.postMessage({ __lattice: 1, type: "ready" }, "*");
  });
})();
