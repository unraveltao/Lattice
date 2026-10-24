/**
 * Agent 板子 —— 显示本地 agent 刚才说了什么、改了什么。
 *
 * 这里**没有模型**，也不出网。它读的是平台自己写的审计日志
 * （`%APPDATA%\com.iron-tom.lattice\agent\audit.log`），所以：
 *
 *   - 它不可能被诱导去做事（它没有能做事的地方）
 *   - 它显示的东西不能被 agent 伪造：`act` 那几行是平台在执行时记的，
 *     不是 agent 自己写的；agent 只能通过 `say` 说自己的话
 *
 * 两条设计上的取舍：
 *
 * 1. **读操作不显示**。`state` / `health` 这类是 agent 在"看"，一秒钟看十次
 *    就会把它真正改的那一件事冲掉。板子上只留"说了什么"和"改了什么"。
 * 2. **轮询而不是订阅**。平台没有给组件推送审计事件的能力，而 2 秒一次的
 *    轮询挂在这条时间轴上，卡片藏起来时会自动停 —— 不会为了一个没人看的
 *    板子一直跑。
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
   * 配置。这里的默认值只是为了在 `config.get` 回来之前有个能画的东西 ——
   * 真值永远以宿主给的为准（它已经按清单的 schema 合并过出厂值）。
   */
  var config = { limit: "10", showActions: true };

  function applyConfig(next) {
    if (!next) return;
    config = {
      limit: typeof next.limit === "string" ? next.limit : "10",
      showActions: next.showActions !== false,
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

    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
      return;
    }

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

  // ---------- 纯逻辑（自检页直接调这几个） ----------

  var VERBS = {
    "placement.add": "added a widget",
    "placement.move": "moved a widget",
    "placement.resize": "resized a widget",
    "placement.remove": "removed a widget",
    "placement.pin": "pinned a widget",
    "placement.front": "brought a widget forward",
    "theme.set": "changed the theme",
    "widgets.pause": "paused or resumed the widgets",
  };

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  /*
   * 只留时分秒。审计日志里的 `at` 是毫秒时间戳，而这张卡上"哪一天"没有意义 ——
   * 它显示的是最近几十条，全都在今天。
   */
  function timeOf(at) {
    if (typeof at !== "number" || !isFinite(at)) return "";
    var date = new Date(at);
    if (isNaN(date.getTime())) return "";
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  /**
   * 一条审计记录 → 一行能读的东西。读操作返回 null（调用方据此跳过）。
   *
   * `act` 的动作名换成动词短语：`placement.move` 对写代码的人清楚，对
   * 桌面上看一眼的人不清楚。换不到的（将来新加的动作）就显示原名，
   * 那也比整行消失好。
   */
  function describe(entry) {
    if (!entry || typeof entry !== "object") return null;
    var op = typeof entry.op === "string" ? entry.op : "";
    var detail = typeof entry.detail === "string" ? entry.detail : "";

    if (op === "say") {
      if (!detail) return null;
      return { kind: "say", text: detail, time: timeOf(entry.at) };
    }
    if (op === "act") {
      return { kind: "act", text: VERBS[detail] || detail, action: detail, time: timeOf(entry.at) };
    }
    /*
     * 内置 assistant 走的是同一条审计日志（`llm.rs` 里 `assistant.chat`）。
     * 只有**调了工具**的那几轮才值得画：detail 形如
     * `deepseek-v4.1-flash · tools: placement.move`，而"问了一句、什么都没改"
     * 的那一轮和 `state` 读一样是噪声 —— 板子的用途是"谁动了我的桌面"。
     */
    if (op === "assistant.chat") {
      var at = detail.indexOf("tools: ");
      if (at < 0) return null;
      var names = detail
        .slice(at + 7)
        .split(",")
        .map(function (name) {
          return name.trim();
        })
        .filter(Boolean);
      if (names.length === 0) return null;
      var verbs = names.map(function (name) {
        return VERBS[name] || name;
      });
      return {
        kind: "act",
        text: "assistant · " + verbs.join(", "),
        action: names[0],
        time: timeOf(entry.at),
      };
    }
    return null;
  }

  /**
   * 端点回的那份 → 要画的几行。
   *
   * 新的在前：这块板子的用途是"刚才发生了什么"，往下翻历史是次要的。
   * 所以从数组末尾往前走，而不是画完再 reverse —— 顺便在凑够 limit 时
   * 就能停，不用把上千条都映射一遍。
   */
  function formatFeed(payload, limit, showActions) {
    /*
     * 先归一化再夹紧，两步分开做。
     *
     * 合成一步（`Math.floor(x) || 10`）的话 0 会变成 10、而 -5 会变成 1 ——
     * 两个都是"不合理的值"，处理方式却不一样，调用方没法预期。现在规则只有一条：
     * 不是正数就用默认值 10，再夹到 1..50。
     */
    var asked = Math.floor(Number(limit));
    var size = isFinite(asked) && asked > 0 ? asked : 10;
    size = Math.max(1, Math.min(50, size));

    var out = { enabled: false, rows: [] };
    if (!payload || typeof payload !== "object") return out;

    out.enabled = payload.enabled === true;
    var entries = Array.isArray(payload.entries) ? payload.entries : [];

    for (var index = entries.length - 1; index >= 0; index -= 1) {
      var row = describe(entries[index]);
      if (!row) continue;
      if (row.kind === "act" && showActions === false) continue;
      out.rows.push(row);
      if (out.rows.length >= size) break;
    }
    return out;
  }

  // 自检页调的就是这三个，不复制一份逻辑去测
  window.__latticeAgentFeed = { describe: describe, formatFeed: formatFeed, timeOf: timeOf };

  // ---------- 渲染 ----------

  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var stateEl = document.getElementById("state");
  var tickId = 0;

  function paint(feed) {
    stateEl.textContent = feed.enabled ? "live" : "off";
    stateEl.classList.toggle("is-live", feed.enabled);

    listEl.textContent = "";
    for (var index = 0; index < feed.rows.length; index += 1) {
      var row = feed.rows[index];
      var item = document.createElement("li");
      item.className = "row is-" + row.kind;

      var time = document.createElement("span");
      time.className = "row-time";
      time.textContent = row.time;

      var text = document.createElement("p");
      text.className = "row-text";
      // textContent 而不是 innerHTML：这些字来自 agent，是一段外部输入
      text.textContent = row.text;

      item.appendChild(time);
      item.appendChild(text);
      listEl.appendChild(item);
    }

    if (feed.rows.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = "Nothing yet.";
    } else {
      emptyEl.hidden = true;
    }
  }

  function notice(message) {
    stateEl.textContent = "";
    stateEl.classList.remove("is-live");
    listEl.textContent = "";
    emptyEl.hidden = false;
    emptyEl.textContent = message;
  }

  function render() {
    call("agent.activity", { limit: Number(config.limit) || 10 })
      .then(function (payload) {
        paint(formatFeed(payload, config.limit, config.showActions));
      })
      .catch(function (error) {
        notice(
          error && error.code === "permission_denied"
            ? "Needs Agent activity permission"
            : "Could not read the log",
        );
      });
  }

  /*
   * 启动顺序：先读配置，画一次，再挂心跳。
   *
   * 心跳 2 秒：审计日志是别人写进来的，平台没有"有新记录"这种事件可订，
   * 只能问。2 秒对"看一眼 AI 刚做了什么"够快，又不至于让磁盘一直响。
   */
  call("config.get")
    .then(function (values) {
      if (values) applyConfig(values);
    })
    .catch(function () {
      /* 读不到配置就用出厂值 */
    })
    .then(function () {
      render();
      return call("schedule.every", { every: 2000 });
    })
    .then(function (grant) {
      tickId = grant && typeof grant.id === "number" ? grant.id : 0;
    })
    .catch(function () {
      /* 心跳没挂上就停在第一帧 */
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
