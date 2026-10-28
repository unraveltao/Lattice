/**
 * 系统监视器组件
 *
 * 数据全部来自 `system.metrics`（需要 `system:monitor` 权限），
 * 心跳挂在平台的调度器上 —— 组件自己不碰 `setInterval`。
 *
 * 为什么用调度器而不是定时器：
 *   - 卡片被藏起来 / 主窗口最小化时，平台会把整条时间轴停掉，组件不用操心；
 *   - 同一个组件以后要是还需要别的心跳（比如每 5 秒算一次峰值），
 *     挂到同一条时间轴上还是一个计时器，而不是两个。
 *
 * 0.2.0 加的都是"细节点"，每一处都有原因：
 *
 *   1. **折线是历史，不是装饰。** 单个百分比说不出"刚才是不是卡了一下"，
 *      一分钟的走势可以。CPU 带填充、内存走虚线，两个量共用一套坐标（都是
 *      0–100%），所以一眼能看出"内存一直很高、CPU 只是偶尔尖一下"。
 *
 *   2. **逐核条回答"是哪个核在忙"。** 16 核机器上整机 6% 可能是一个核跑满，
 *      也可能真是闲着 —— 整机数字分不出这两种。核数变了（休眠唤醒、热插拔）
 *      后端会给空数组，这一行就收起来，不画错位的图。
 *
 *   3. **内存副标题给提交量。** 物理内存满了系统只是变慢，提交量撞到上限
 *      会直接分配失败 —— 后者才是"要出事"的信号，但它不在任务管理器首屏。
 *
 *   4. **底栏给剩余空间和进程数。** "C: 45%" 要心算，"226 GB free" 不用。
 *
 *   5. **第一拍只建基线。** 速率类指标（CPU、网络）靠两次采样做差，后端第一次
 *      一定返回 0 —— 那一拍不进历史，否则折线最左边永远挂着一个假的坑。
 *
 * 0.3.0 把「电池」那个独立组件并了进来，并加了 GPU。三处非做不可的判断：
 *
 *   6. **电池是另一条心跳。** 指标一秒一拍，电量半分钟才变一次；把电源读数塞进
 *      每秒那条，等于每秒多收一份用不上的数据（`power.rs` 的注释里就写过这个
 *      理由）。所以这里挂两条 `schedule.every`，各认各的 `tick.id`。
 *
 *   7. **GPU 读不到就不画。** 平台给 `gpu: null` 表示"这台机器上没有可读的
 *      GPU 计数器"，和 `0%`（显卡闲着）是两件事。整行收起来，而不是画一个 0%。
 *      电池同理：台式机没有电池，那一行不该永远挂着一个 "—"。
 *
 *   8. **显不显示由属性面板决定。** 六个开关一一对应六块内容（走势 / 逐核 /
 *      GPU / 电池 / 网络 / 磁盘与进程）。开关只改 `hidden`，不重建 DOM ——
 *      折线靠 `ResizeObserver` 自己重新量，切一下不会掉帧。
 */
(function () {
  "use strict";

  // ---------- 桥 ----------

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
   * 行标签（内存 / 磁盘 / 网络）、单位、开机时长和提示行都是这个组件自己的字 ——
   * 平台不知道「内存」对应哪句英文。所以两门都留在这儿，按 `lang.get` 挑一份；
   * 用户中途换语言，平台推一条 `language`，把已经画出去的字原地换掉（两件事都要做：
   * 只读一次 = 换语言卡片不动，只听推送 = 语言停在建文档那一刻）。
   *
   * 首帧不等桥（不变量 18）：HTML 里写死的是中文；英文界面要等 `lang.get` 回来
   * 那一趟（几十毫秒）才翻。`lang` 只有 `zh` / `en` 两种 —— "跟随系统"是平台
   * 在设置里解析掉的。
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
    document.title = say("系统", "System");
    // 行标签、单位、提示行和已经画出去的读数全都要跟着换：当场重画一次，
    // 别等下一拍心跳 —— 那一拍在一秒后，用户会看见半张中文半张英文
    repaint();
  }

  // ---------- 纯逻辑（自检页直接调，别在测试里抄一份） ----------

  function clamp01(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    if (number < 0) return 0;
    if (number > 1) return 1;
    return number;
  }

  function percent(ratio) {
    return Math.round(clamp01(ratio) * 100);
  }

  function bytes(value) {
    var number = Number(value);
    if (!isFinite(number) || number < 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var at = 0;
    var rest = number;
    while (rest >= 1024 && at < units.length - 1) {
      rest /= 1024;
      at += 1;
    }
    /*
     * 三位数以上不再留小数：卡片就 268px 宽，多一位小数会把整行挤到换行。
     * 注意这里必须 `String(...)` —— `Math.round` 返回的是**数字**，直接往下
     * 走 `.replace` 会抛 "replace is not a function"。磁盘这种几百 GB 的量
     * 恰好每次都走这条分支，于是底栏那行网络数字永远停在占位符上（真撞过）。
     */
    var shown =
      rest >= 100 ? String(Math.round(rest)) : rest.toFixed(rest >= 10 ? 1 : 2);
    return shown.replace(/\.0+$|(\.\d)0$/, "$1") + " " + units[at];
  }

  function rate(value) {
    return bytes(value) + "/s";
  }

  /**
   * 秒 → `12s` / `4m` / `3h 20m` / `2d 4h`（中文写 `12秒` / `4分` / `3小时20分` / `2天4小时`）。
   * 卡片窄，最多两位，能省则省。数字与 `%` / `GB` 这类符号不翻，只有单位跟着语言走
   */
  function duration(seconds) {
    var total = Math.floor(Number(seconds));
    if (!isFinite(total) || total < 0) return "";
    // 中文单位之间不留空格，英文两个单位之间留一个（`3h 20m` / `3d 4h`）
    var s = say("秒", "s");
    var m = say("分", "m");
    var h = say("小时", "h");
    var d = say("天", "d");
    var gap = say("", " ");
    if (total < 60) return total + s;
    var minutes = Math.floor(total / 60);
    if (minutes < 60) return minutes + m;
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + h + gap + (minutes % 60) + m;
    return Math.floor(hours / 24) + d + gap + (hours % 24) + h;
  }

  /**
   * 历史缓冲 → 折线的 `points`。
   *
   * `samples` 是老 → 新、值 0..1；`capacity` 是缓冲最多能放几个点。横坐标按
   * **容量**算间距、从右端往左排：只有 10 个采样时线只占右边一小段，而不是
   * 撑满整幅 —— 后者会让"刚打开"和"一条平线"看起来一模一样。
   *
   * 上下各留 1.5px：贴边画的线会被裁掉半个描边。
   */
  function trendPoints(samples, capacity, width, height) {
    if (!samples || samples.length < 2) return "";
    if (!(width > 0) || !(height > 0)) return "";
    var slots = Math.max(samples.length, Number(capacity) || samples.length);
    if (slots < 2) return "";

    var top = 1.5;
    var bottom = height - 1.5;
    var span = width / (slots - 1);
    var points = [];
    for (var back = 0; back < samples.length; back += 1) {
      var x = width - back * span;
      if (x < -0.5) break;
      var value = clamp01(samples[samples.length - 1 - back]);
      var y = bottom - value * (bottom - top);
      points.push(x.toFixed(1) + "," + y.toFixed(1));
    }
    return points.reverse().join(" ");
  }

  /** 折线下方的填充：把折线两端垂直落到基线上，闭合成一个多边形 */
  function areaPoints(points, height) {
    if (!points) return "";
    var parts = points.split(" ");
    if (parts.length < 2) return "";
    var first = parts[0].split(",")[0];
    var last = parts[parts.length - 1].split(",")[0];
    var base = (height - 1.5).toFixed(1);
    return first + "," + base + " " + points + " " + last + "," + base;
  }

  // ---------- 电池（0.3.0 从 lattice.battery 搬过来的纯逻辑） ----------

  /**
   * 一份"什么都不知道"的电源读数 —— 首帧、读失败、浏览器预览都用它。
   * 全是 `null` / `false`，不是 0：0% 是"电池空了"，和"读不到"差着一次误报。
   */
  var EMPTY_POWER = {
    ac: null,
    percent: null,
    charging: false,
    noBattery: false,
    critical: false,
    saver: false,
    minutesLeft: null,
  };

  /** 电量低于这个数、又没在充电，就把数字标红。原来在清单的 `warnBelow` 里 */
  var WARN_PERCENT = 20;

  function numOrNull(value, min, max) {
    if (typeof value !== "number" || !isFinite(value)) return null;
    var rounded = Math.round(value);
    if (rounded < min || rounded > max) return null;
    return rounded;
  }

  /**
   * 宿主给的读数 → 组件认的读数。字段一律从严：
   * 不是 `true` 就当 `false`（少报一个"充电中"比多报安全），
   * 百分数与分钟越界当"读不出来"。
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
  function powerState(power) {
    if (power.noBattery) return "noBattery";
    if (power.ac === true) return power.charging ? "charging" : "plugged";
    if (power.ac === false) return "battery";
    return "unknown";
  }

  function stateText(key) {
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

  /**
   * 分钟 → 人话。秒数是系统估的、往下取整过的，"不到一分钟"按 0 处理 ——
   * 报"还能用 0 分钟"看着像已经关机了。
   */
  function formatMinutes(minutes) {
    if (typeof minutes !== "number" || !isFinite(minutes) || minutes < 0) return "";
    var total = Math.round(minutes);
    if (total < 1) return say("不到 1 分钟", "under a minute");
    if (total < 60) return say(total + " 分钟", total + " min");
    var hours = Math.floor(total / 60);
    var rest = total % 60;
    if (!rest) return say(hours + " 小时", hours + " h");
    return say(hours + " 小时 " + rest + " 分", hours + " h " + rest + " min");
  }

  /** 电量数字该不该标红：充着电不红（越充越红是吓人），系统说快关机一定红 */
  function powerAlarm(power) {
    if (power.noBattery || power.percent == null) return "none";
    if (power.critical && !power.charging) return "critical";
    if (!power.charging && power.percent <= WARN_PERCENT) return "low";
    return "ok";
  }

  /** 显存：`1.7 / 8.0 GB`。总量读不到（DXGI 没给）就只报用了多少 */
  function vramText(used, total) {
    if (!total) return bytes(used);
    return bytes(used) + " / " + bytes(total);
  }

  // 自检页拿这几个跑断言（`tests/sysmon.html`）
  window.__latticeSysmon = {
    bytes: bytes,
    percent: percent,
    rate: rate,
    duration: duration,
    trendPoints: trendPoints,
    areaPoints: areaPoints,
    clamp01: clamp01,
    parsePower: parsePower,
    powerState: powerState,
    stateText: stateText,
    formatMinutes: formatMinutes,
    powerAlarm: powerAlarm,
    vramText: vramText,
    EMPTY_POWER: EMPTY_POWER,
    WARN_PERCENT: WARN_PERCENT,
  };

  // ---------- DOM ----------

  var el = {
    title: document.getElementById("title"),
    uptime: document.getElementById("uptime"),
    cpu: document.getElementById("cpu"),
    mem: document.getElementById("mem"),
    memName: document.getElementById("mem-name"),
    memSub: document.getElementById("mem-sub"),
    memCommit: document.getElementById("mem-commit"),
    trend: document.getElementById("trend"),
    svg: document.getElementById("trend-svg"),
    area: document.getElementById("trend-area"),
    cpuLine: document.getElementById("trend-cpu"),
    memLine: document.getElementById("trend-mem"),
    cores: document.getElementById("cores"),
    gpu: document.getElementById("sec-gpu"),
    gpuValue: document.getElementById("gpu"),
    gpuName: document.getElementById("gpu-name"),
    gpuVram: document.getElementById("gpu-vram"),
    bat: document.getElementById("sec-bat"),
    batValue: document.getElementById("bat"),
    batName: document.getElementById("bat-name"),
    batState: document.getElementById("bat-state"),
    batLeft: document.getElementById("bat-left"),
    foot: document.getElementById("foot"),
    rowDisk: document.getElementById("row-disk"),
    rowNet: document.getElementById("row-net"),
    disk: document.getElementById("disk"),
    procs: document.getElementById("procs"),
    down: document.getElementById("down"),
    up: document.getElementById("up"),
    hint: document.getElementById("hint"),
  };

  /*
   * 属性面板那六个开关。默认全开 —— 和清单里的 `default` 必须一致：
   * 清单是属性面板的画法，这里是"没拿到配置时"的兜底，两边不一样就会出现
   * "面板上打着勾、卡片上没有"。
   */
  var config = {
    trace: true,
    cores: true,
    gpu: true,
    battery: true,
    network: true,
    disk: true,
  };

  /** 数据到位了没有。开关管"要不要"，这两个管"有没有" —— 两个条件都满足才显示 */
  var gpuReady = false;
  var coresReady = false;
  var power = EMPTY_POWER;

  /** 缓冲里留多少拍：60 × 1 秒 = 一分钟，正好是"刚才那一下卡顿还在不在" */
  var HISTORY = 60;

  /** 上一次画出来的读数：换语言要拿它重画，不能等下一拍心跳 */
  var lastMetrics = null;

  /**
   * 提示行留的是**原因**，不是那句已经翻好的话 —— 换语言时重挑一次就行。
   * 值见下面的 HINTS，空串表示不显示。
   */
  var hintCode = "";

  var HINTS = {
    denied: ["需要「系统指标」权限", "Needs the System metrics permission"],
    internal: ["系统指标要在桌面应用里读", "System metrics need the desktop app"],
    unavailable: ["读不到系统指标", "Metrics unavailable"],
    scheduler: ["调度器不可用", "Scheduler unavailable"],
  };

  var cpuHistory = [];
  var memHistory = [];
  /** 第一拍只是基线（后端没有前值，占用一定是 0），不进历史 */
  var primed = false;
  var trendBox = { w: 0, h: 0 };

  function setHint(code) {
    hintCode = code || "";
    paintHint();
  }

  function paintHint() {
    var pair = HINTS[hintCode];
    var text = pair ? say(pair[0], pair[1]) : "";
    el.hint.textContent = text;
    el.hint.classList.toggle("is-visible", !!text);
  }

  /** 75% 起变黄、90% 起变红。写死中间调，深浅底板上都压得住 */
  function markLevel(node, ratio) {
    node.classList.toggle("is-high", ratio >= 0.75 && ratio < 0.9);
    node.classList.toggle("is-critical", ratio >= 0.9);
  }

  // ---------- 开关 ----------

  function show(node, visible) {
    if (!node) return;
    // 用 `hidden` 而不是 class：`display: none` 不占 flex 的位置，下面的行会自己补上来
    node.hidden = !visible;
  }

  /**
   * 六个开关 → 六块内容的显隐。
   *
   * 每块要同时满足两件事才画得出来：用户开着它（`config`）、**而且这一拍有数**
   * （`gpuReady` / `coresReady` / 有没有电池）。后者不是"关掉了"，是"没这回事"
   * —— 台式机不该永远挂着一行 "电池 —"。
   */
  function paintSections() {
    show(el.trend, config.trace);
    show(el.cores, config.cores && coresReady);
    show(el.gpu, config.gpu && gpuReady);
    show(el.bat, config.battery && !power.noBattery);
    show(el.rowNet, config.network);
    show(el.rowDisk, config.disk);
    // 两行都关掉时整条底栏一起收，不然只剩一条横线挂在卡片底部
    show(el.foot, config.network || config.disk);
  }

  /** 配置推过来（打开时拉一次，属性面板里改一次推一次） */
  function applyConfig(next) {
    if (!next || typeof next !== "object") return;
    // 字段缺省一律当"开"：清单里没写的开关不该把内容藏起来
    config = {
      trace: next.trace !== false,
      cores: next.cores !== false,
      gpu: next.gpu !== false,
      battery: next.battery !== false,
      network: next.network !== false,
      disk: next.disk !== false,
    };
    paintSections();
    // 折线换了宽度（哪怕只是被旁边的块挤了一下）要重新量，否则描边会被拉伸
    resizeTrend();
  }

  // ---------- 折线 ----------

  /**
   * 量一次折线能画多大。
   *
   * `viewBox` 直接设成像素尺寸：1 个用户单位 = 1px，描边粗细就是所见即所得。
   * 用固定 viewBox 硬拉的话，横向和纵向缩放比不同，描边会一边粗一边细。
   */
  function resizeTrend() {
    var box = el.trend.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    var w = Math.round(box.width);
    var h = Math.round(box.height);
    if (w === trendBox.w && h === trendBox.h) return;
    trendBox = { w: w, h: h };
    el.svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    drawTrend();
  }

  function drawTrend() {
    if (!trendBox.w) return;
    var cpu = trendPoints(cpuHistory, HISTORY, trendBox.w, trendBox.h);
    var mem = trendPoints(memHistory, HISTORY, trendBox.w, trendBox.h);
    el.cpuLine.setAttribute("points", cpu);
    el.memLine.setAttribute("points", mem);
    el.area.setAttribute("points", areaPoints(cpu, trendBox.h));
  }

  // ---------- 逐核 ----------

  function renderCores(list) {
    // 后端只在"这一拍真的测到了逐核数据"时才给数组；空数组 = 这一行收起来。
    // 显不显示还取决于属性面板那个开关，两件事都交给 `paintSections` 判
    coresReady = !!(list && list.length);
    paintSections();
    if (!coresReady) return;

    // 节点数只增删在数量变化时：每秒重建 16 个 <i> 是白费力气，还会打断过渡
    if (el.cores.childElementCount !== list.length) {
      el.cores.textContent = "";
      for (var index = 0; index < list.length; index += 1) {
        el.cores.appendChild(document.createElement("i"));
      }
    }

    for (var at = 0; at < list.length; at += 1) {
      var bar = el.cores.children[at];
      var value = clamp01(list[at]);
      // 2px 的下限：一个完全闲着的核也得看得见，否则"16 核"会显示成 12 根条
      bar.style.height = "max(2px, " + (value * 100).toFixed(0) + "%)";
      bar.classList.toggle("is-high", value >= 0.75 && value < 0.9);
      bar.classList.toggle("is-critical", value >= 0.9);
      bar.title = say("核心 ", "Core ") + (at + 1) + " · " + percent(value) + "%";
    }
  }

  // ---------- 渲染 ----------

  function render(metrics) {
    if (!metrics) return;
    lastMetrics = metrics;

    if (primed) {
      cpuHistory.push(clamp01((metrics.cpu || {}).usage));
      memHistory.push(clamp01((metrics.memory || {}).usage));
      // 环形缓冲：满了丢最老的
      if (cpuHistory.length > HISTORY) cpuHistory.shift();
      if (memHistory.length > HISTORY) memHistory.shift();
    } else {
      primed = true;
    }
    paint(metrics);
  }

  /** 换语言时重画同一份读数：不进历史缓冲，也不重新采样 */
  function repaint() {
    el.title.textContent = say("系统", "System");
    el.memName.textContent = say("内存", "Memory");
    el.batName.textContent = say("电池", "Battery");
    if (lastMetrics) paint(lastMetrics);
    paintPower();
    paintHint();
  }

  /** 只把读数写到 DOM 上。历史缓冲和采样归 `render` 管，这里一次都不碰 */
  function paint(metrics) {
    var cpu = metrics.cpu || {};
    var memory = metrics.memory || {};
    var disk = metrics.disk || {};
    var network = metrics.network || {};
    var system = metrics.system || {};

    var cpuUsage = clamp01(cpu.usage);
    var memUsage = clamp01(memory.usage);

    el.cpu.textContent = percent(cpuUsage) + "%";
    el.cpu.title = say(
      percent(cpuUsage) +
        "%，" +
        (cpu.cores || "?") +
        " 个逻辑核的总和 · 0–100% 指的是整机，不是单个核",
      percent(cpuUsage) +
        "% across " +
        (cpu.cores || "?") +
        " logical cores · 0–100% is the whole machine, not one core",
    );
    markLevel(el.cpu, cpuUsage);

    el.mem.textContent = percent(memUsage) + "%";
    el.mem.title = say(
      "物理内存已用 " + percent(memUsage) + "% · 共 " + bytes(memory.total),
      percent(memUsage) + "% of physical memory in use · " + bytes(memory.total) + " installed",
    );
    markLevel(el.mem, memUsage);

    el.memSub.textContent = bytes(memory.used) + " / " + bytes(memory.total);
    // 提交量拿不到（老后端 / GetPerformanceInfo 失败）就整段留空，别写 "commit 0 B / 0 B"
    var hasCommit = memory.commitLimit > 0;
    el.memCommit.textContent = hasCommit
      ? say("已提交 ", "commit ") + bytes(memory.commitUsed) + " / " + bytes(memory.commitLimit)
      : "";
    el.memCommit.title = hasCommit
      ? say(
          "已提交 " +
            bytes(memory.commitUsed) +
            "，上限 " +
            bytes(memory.commitLimit) +
            " —— 上限里算进了页面文件，撞到它才会真的分配失败",
          "Committed " +
            bytes(memory.commitUsed) +
            " of a " +
            bytes(memory.commitLimit) +
            " limit — the limit includes the page file, and running out of it is what actually fails allocations",
        )
      : "";

    // 剩余空间比百分比好使：不用心算
    var diskFree = Math.max(0, (disk.total || 0) - (disk.used || 0));
    el.disk.textContent =
      disk.total > 0
        ? (disk.mount || "C:") + say(" 剩余 " + bytes(diskFree), " " + bytes(diskFree) + " free")
        : "—";
    el.disk.title = say(
      (disk.mount || "C:") +
        " 已用 " +
        bytes(disk.used) +
        "，共 " +
        bytes(disk.total) +
        "（" +
        percent(disk.usage) +
        "%）",
      bytes(disk.used) +
        " used of " +
        bytes(disk.total) +
        " on " +
        (disk.mount || "C:") +
        " (" +
        percent(disk.usage) +
        "%)",
    );
    markLevel(el.disk, clamp01(disk.usage));

    el.procs.textContent = system.processes
      ? system.processes + say(" 个进程", " processes")
      : "—";
    el.procs.title =
      (system.processes || 0) +
      say(" 个进程 · ", " processes · ") +
      (system.threads || 0) +
      say(" 个线程 · ", " threads · ") +
      (system.handles || 0) +
      say(" 个句柄", " handles");

    el.down.textContent = "↓ " + rate(network.rxPerSec);
    el.up.textContent = "↑ " + rate(network.txPerSec);
    el.down.title = say(
      "开机以来收到 " + bytes(network.rxTotal),
      bytes(network.rxTotal) + " received since boot",
    );
    el.up.title = say(
      "开机以来发出 " + bytes(network.txTotal),
      bytes(network.txTotal) + " sent since boot",
    );

    el.uptime.textContent = system.uptimeSec
      ? say("已开机 " + duration(system.uptimeSec), duration(system.uptimeSec) + " up")
      : "";

    renderCores(cpu.perCore);
    paintGpu(metrics.gpu);

    // 每次渲染前量一次：`ResizeObserver` 在无头环境里可能还没跑第一拍，
    // 而 `drawTrend` 没有尺寸就什么都不画
    resizeTrend();
    drawTrend();
  }

  /**
   * GPU 那一行。`gpu` 为 `null` = 这台机器上没有可读的 GPU 计数器（没有独显 /
   * 驱动没装 / 计数器被关掉），**不是 0%** —— 0% 是"显卡闲着"。整行收起来，
   * 因为"读不到"这件事没有值得占一行的信息量。
   */
  function paintGpu(gpu) {
    gpuReady = !!gpu;
    if (gpu) {
      var usage = clamp01(gpu.usage);
      el.gpuValue.textContent = percent(usage) + "%";
      el.gpuValue.title = say(
        "整块卡最忙那条引擎的占用 · 0–100% 指的是这张卡，不是单个进程",
        "The busiest engine on this adapter · 0–100% is the card, not one process",
      );
      markLevel(el.gpuValue, usage);
      // 名字放副标题：`NVIDIA GeForce RTX 3060` 塞不进左边那 40px 的标签位
      el.gpuName.textContent = gpu.name || "";
      el.gpuVram.textContent = vramText(gpu.used, gpu.total);
      el.gpuVram.title = say(
        "显存 " + bytes(gpu.used) + " / " + bytes(gpu.total),
        bytes(gpu.used) + " of " + bytes(gpu.total) + " VRAM",
      );
    }
    paintSections();
  }

  /**
   * 电池那一行。数据来自另一条心跳（半分钟一次），和指标不是同一份。
   *
   * 台式机没有电池：`noBattery` 时整行收起来 —— 那不是"关掉了"，是"没这回事"。
   */
  function paintPower() {
    var alarm = powerAlarm(power);
    el.batValue.textContent = power.percent == null ? "—" : power.percent + "%";
    el.batValue.classList.toggle("is-low", alarm === "low");
    el.batValue.classList.toggle("is-critical", alarm === "critical");
    el.batValue.title = say(
      "电量 " + (power.percent == null ? "读不到" : power.percent + "%") + " · 告警线 " + WARN_PERCENT + "%",
      (power.percent == null ? "No reading" : power.percent + "%") + " · warns below " + WARN_PERCENT + "%",
    );

    var state = stateText(powerState(power));
    if (power.saver) state += say(" · 省电模式", " · Saver");
    el.batState.textContent = state;

    var left = power.minutesLeft == null ? "" : formatMinutes(power.minutesLeft);
    el.batLeft.textContent = left ? say("还剩 " + left, left + " left") : "";
    paintSections();
  }

  // ---------- 心跳 ----------

  var subscription = 0;
  var powerSubscription = 0;
  var denied = false;
  var failures = 0;

  /** 电量多久问一次。它变得很慢，半分钟一拍足够（原来那个组件的节拍） */
  var POWER_MS = 30000;

  function refresh() {
    call("system.metrics")
      .then(function (metrics) {
        failures = 0;
        if (denied) {
          denied = false;
          setHint("");
        }
        render(metrics);
      })
      .catch(function (error) {
        if (error.code === "permission_denied") {
          denied = true;
          setHint("denied");
          return;
        }
        // 浏览器预览（npm run dev）走这条：WebView2 外面没有这些计数器
        if (error.code === "internal") {
          setHint("internal");
          return;
        }
        failures += 1;
        // 偶发失败（比如采样正卡在系统调用上）不吓人，连续三次才提示
        if (failures >= 3) setHint("unavailable");
      });
  }

  /**
   * 电源是**另一条**心跳：指标一秒一拍，电量半分钟才变一次，塞进同一条
   * 等于每秒多搬一份用不上的数据。读失败时保留上一次的数（和指标同一个
   * 错误模型：先怀疑是这一拍没读到，不是机器突然没有电池了）。
   */
  function refreshPower() {
    call("power.status")
      .then(function (raw) {
        power = parsePower(raw);
        paintPower();
      })
      .catch(function (error) {
        if (error.code === "permission_denied") {
          denied = true;
          setHint("denied");
        }
      });
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
    // 属性面板里改了开关。`config.get` 是打开时的那一份，这条是"后来改了"
    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
      return;
    }
    if (data.type === "tick") {
      // 一条时间轴上可能挂着好几条心跳，认准自己那一条
      var id = data.payload && data.payload.id;
      if (id && id === subscription) refresh();
      else if (id && id === powerSubscription) refreshPower();
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

  /*
   * 卡片尺寸变了（用户拖右下角）要重新量折线。
   *
   * `ResizeObserver` 比 `window.onresize` 准：卡片是窗口内容，窗口变了这里
   * 一定跟着变，反过来则不一定。
   */
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () {
      resizeTrend();
    }).observe(el.trend);
  }

  /*
   * 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
   * 不该拖住心跳，卡片也不该因为问不到语言就停在两种文字的混合状态。
   */
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画 */
    });

  /*
   * 先问一次开关。问不到就按"全开"画 —— 属性面板里那六个开关的默认值也是开，
   * 两边对齐才不会出现"面板上打着勾、卡片上没有"。
   */
  call("config.get")
    .then(function (value) {
      applyConfig(value);
    })
    .catch(function () {});

  /*
   * 电池挂在**第二条**心跳上（半分钟）。两条心跳各认各的 `tick.id`，
   * 平台的调度器一条时间轴上能挂好几条 —— 这是它存在的意义之一。
   */
  call("schedule.every", { every: POWER_MS })
    .then(function (grant) {
      powerSubscription = grant.id;
      refreshPower();
    })
    .catch(function () {});

  /*
   * 先打一拍再开始计时。
   *
   * 速率类指标（CPU 占用、网络吞吐）靠两次采样做差，Rust 侧第一次调用
   * 一定返回 0 —— 没有前值就编不出速率。所以启动时立刻调一次，把基线
   * 建立起来，第一次心跳（1 秒后）拿到的才是真数。
   */
  resizeTrend();
  call("schedule.every", { every: 1000 })
    .then(function (grant) {
      subscription = grant.id;
      refresh();
    })
    .catch(function () {
      setHint("scheduler");
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
