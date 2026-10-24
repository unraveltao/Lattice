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

  /** 秒 → `12s` / `4m` / `3h 20m` / `2d 4h`。卡片窄，最多两位，能省则省 */
  function duration(seconds) {
    var total = Math.floor(Number(seconds));
    if (!isFinite(total) || total < 0) return "";
    if (total < 60) return total + "s";
    var minutes = Math.floor(total / 60);
    if (minutes < 60) return minutes + "m";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h " + (minutes % 60) + "m";
    return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
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

  // 自检页拿这几个跑断言（`tests/sysmon.html`）
  window.__latticeSysmon = {
    bytes: bytes,
    percent: percent,
    rate: rate,
    duration: duration,
    trendPoints: trendPoints,
    areaPoints: areaPoints,
    clamp01: clamp01,
  };

  // ---------- DOM ----------

  var el = {
    uptime: document.getElementById("uptime"),
    cpu: document.getElementById("cpu"),
    mem: document.getElementById("mem"),
    memSub: document.getElementById("mem-sub"),
    memCommit: document.getElementById("mem-commit"),
    trend: document.getElementById("trend"),
    svg: document.getElementById("trend-svg"),
    area: document.getElementById("trend-area"),
    cpuLine: document.getElementById("trend-cpu"),
    memLine: document.getElementById("trend-mem"),
    cores: document.getElementById("cores"),
    disk: document.getElementById("disk"),
    procs: document.getElementById("procs"),
    down: document.getElementById("down"),
    up: document.getElementById("up"),
    hint: document.getElementById("hint"),
  };

  /** 缓冲里留多少拍：60 × 1 秒 = 一分钟，正好是"刚才那一下卡顿还在不在" */
  var HISTORY = 60;

  var cpuHistory = [];
  var memHistory = [];
  /** 第一拍只是基线（后端没有前值，占用一定是 0），不进历史 */
  var primed = false;
  var trendBox = { w: 0, h: 0 };

  function setHint(text) {
    el.hint.textContent = text || "";
    el.hint.classList.toggle("is-visible", !!text);
  }

  /** 75% 起变黄、90% 起变红。写死中间调，深浅底板上都压得住 */
  function markLevel(node, ratio) {
    node.classList.toggle("is-high", ratio >= 0.75 && ratio < 0.9);
    node.classList.toggle("is-critical", ratio >= 0.9);
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
    if (!list || !list.length) {
      // 后端只在"这一拍真的测到了逐核数据"时才给数组；空数组 = 收起这一行
      el.cores.hidden = true;
      return;
    }
    el.cores.hidden = false;

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
      bar.title = "Core " + (at + 1) + " · " + percent(value) + "%";
    }
  }

  // ---------- 渲染 ----------

  function render(metrics) {
    if (!metrics) return;

    var cpu = metrics.cpu || {};
    var memory = metrics.memory || {};
    var disk = metrics.disk || {};
    var network = metrics.network || {};
    var system = metrics.system || {};

    var cpuUsage = clamp01(cpu.usage);
    var memUsage = clamp01(memory.usage);

    el.cpu.textContent = percent(cpuUsage) + "%";
    el.cpu.title =
      percent(cpuUsage) +
      "% across " +
      (cpu.cores || "?") +
      " logical cores · 0–100% is the whole machine, not one core";
    markLevel(el.cpu, cpuUsage);

    el.mem.textContent = percent(memUsage) + "%";
    el.mem.title =
      percent(memUsage) + "% of physical memory in use · " + bytes(memory.total) + " installed";
    markLevel(el.mem, memUsage);

    el.memSub.textContent = bytes(memory.used) + " / " + bytes(memory.total);
    // 提交量拿不到（老后端 / GetPerformanceInfo 失败）就整段留空，别写 "commit 0 B / 0 B"
    var hasCommit = memory.commitLimit > 0;
    el.memCommit.textContent = hasCommit
      ? "commit " + bytes(memory.commitUsed) + " / " + bytes(memory.commitLimit)
      : "";
    el.memCommit.title = hasCommit
      ? "Committed " +
        bytes(memory.commitUsed) +
        " of a " +
        bytes(memory.commitLimit) +
        " limit — the limit includes the page file, and running out of it is what actually fails allocations"
      : "";

    // 剩余空间比百分比好使：不用心算
    var diskFree = Math.max(0, (disk.total || 0) - (disk.used || 0));
    el.disk.textContent = disk.total > 0 ? (disk.mount || "C:") + " " + bytes(diskFree) + " free" : "—";
    el.disk.title =
      bytes(disk.used) +
      " used of " +
      bytes(disk.total) +
      " on " +
      (disk.mount || "C:") +
      " (" +
      percent(disk.usage) +
      "%)";
    markLevel(el.disk, clamp01(disk.usage));

    el.procs.textContent = system.processes ? system.processes + " processes" : "—";
    el.procs.title =
      (system.processes || 0) +
      " processes · " +
      (system.threads || 0) +
      " threads · " +
      (system.handles || 0) +
      " handles";

    el.down.textContent = "↓ " + rate(network.rxPerSec);
    el.up.textContent = "↑ " + rate(network.txPerSec);
    el.down.title = bytes(network.rxTotal) + " received since boot";
    el.up.title = bytes(network.txTotal) + " sent since boot";

    el.uptime.textContent = system.uptimeSec ? duration(system.uptimeSec) + " up" : "";

    renderCores(cpu.perCore);

    if (primed) {
      cpuHistory.push(cpuUsage);
      memHistory.push(memUsage);
      // 环形缓冲：满了丢最老的
      if (cpuHistory.length > HISTORY) cpuHistory.shift();
      if (memHistory.length > HISTORY) memHistory.shift();
    } else {
      primed = true;
    }
    // 每次渲染前量一次：`ResizeObserver` 在无头环境里可能还没跑第一拍，
    // 而 `drawTrend` 没有尺寸就什么都不画
    resizeTrend();
    drawTrend();
  }

  // ---------- 心跳 ----------

  var subscription = 0;
  var denied = false;
  var failures = 0;

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
          setHint("Needs the System metrics permission");
          return;
        }
        // 浏览器预览（npm run dev）走这条：WebView2 外面没有这些计数器
        if (error.code === "internal") {
          setHint("System metrics need the desktop app");
          return;
        }
        failures += 1;
        // 偶发失败（比如采样正卡在系统调用上）不吓人，连续三次才提示
        if (failures >= 3) setHint("Metrics unavailable");
      });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;

    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    if (data.type === "tick") {
      // 一条时间轴上可能挂着好几条心跳，认准自己那一条
      if (data.payload && data.payload.id === subscription) refresh();
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
      setHint("Scheduler unavailable");
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
