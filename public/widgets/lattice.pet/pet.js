/**
 * 桌宠：直接使用图片 + 按图片的 alpha 自动生成窗口区域。
 *
 * # 为什么不是"画形状"
 *
 * 窗口是用 `SetWindowRgn` 裁出来的：区域外的像素不存在，所以画在区域外的东西
 * 会被切掉。以前是用椭圆/矩形拼一只猫，形状和区域读同一份数据，天然对齐。
 * 现在换成真图，就必须反过来：**先有图，再从图的 alpha 推出区域**。
 *
 * 做法：把图画进 canvas，读 alpha，按 6px 网格把不透明的格子合并成横条，
 * 每条一个矩形上报。一张 240px 高的 chibi 大约 43–85 块，一次状态切换算一次。
 *
 * 代价（必须记住）：
 * - 区域是 6px 台阶，所以边缘比图粗糙 ±3px —— 只在"点到没点到"上体现，
 *   肉眼看不出来（区域本身不上色）
 * - 猫会走路，这条鱼不会：移动需要重算区域，等 `window.moveTo` 那条路
 */
(function () {
  "use strict";

  /* ---------- 桥 ---------- */
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
      }, method === "llm.chat" ? 70000 : 5000);
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;
    if (data.type === "response") {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error || data.code || "bridge error"));
      return;
    }
    if (data.type === "theme") {
      var tokens = data.payload || {};
      var map = {
        "--lattice-accent": "--accent",
        "--lattice-text": "--fg",
        "--lattice-text-muted": "--muted",
        "--lattice-border": "--border",
        "--lattice-surface": "--surface",
        "--lattice-font": "--font",
      };
      Object.keys(map).forEach(function (source) {
        if (tokens[source]) document.documentElement.style.setProperty(map[source], tokens[source]);
      });
    }
  });

  /* ---------- 状态 ---------- */

  // 图来自 fisharchive.cc 的同人表情（CC BY-NC-SA 4.0，仅本地使用）
  var STATES = {
    greeting: "art/greeting.png",
    shy: "art/shy.png",
    angry: "art/angry.png",
    unhappy: "art/unhappy.png",
    slack: "art/slack.png",
    sleep: "art/sleep.png",
  };

  var sprite = document.getElementById("sprite");
  var panel = document.getElementById("panel");
  var log = document.getElementById("log");
  var prompt = document.getElementById("prompt");
  var form = document.getElementById("composer");

  var current = null;      // 当前状态名
  var currentRuns = [];    // 当前状态对应的区域块（图片坐标，CSS px）
  var spriteBox = { x: 0, y: 0, w: 0, h: 0 };
  var masks = null;        // art/masks.json：{ state: { w, h, runs } }
  var panelOpen = false;
  var panelBox = { x: 0, y: 0, w: 300, h: 150 };
  var regionCapable = true;
  var lastKey = "";

  var WINDOW_W = 560;
  var WINDOW_H = 420;

  /* ---------- 轮廓 ---------- */

  /*
   * 轮廓在**构建期**就算好了（`art/masks.json`），不是运行时读的。
   *
   * 原因：组件跑在 `sandbox="allow-scripts"` 的 iframe 里，文档是不透明源，
   * 所以任何图片在 canvas 看来都是跨源的 —— `getImageData` 直接抛 SecurityError。
   * 想在运行时量 alpha，这条沙箱规则第一个不同意。
   *
   * 代价：换了图就要重新生成 masks.json（`桌宠形象备选\build-masks.ps1`）。
   * 好处：启动零成本，而且轮廓是确定的一张表，不受 DPR / 加载时序影响。
   */
  function loadMasks() {
    // art/masks.js 在 index.html 里用 <script> 先加载，挂在 window 上。
    // 不用 fetch：沙箱 iframe 的源是 null，连自己的 JSON 都会被当成跨域。
    masks = window.__PET_MASKS || null;
    return Promise.resolve();
  }

  function runsFor(state) {
    var mask = masks && masks[state];
    if (!mask) return null;
    return mask.runs.map(function (run) {
      return { x: run[0], y: run[1], w: run[2], h: run[3] };
    });
  }

  /* ---------- 布局 ---------- */

  function layout() {
    var mask = masks && masks[current];
    var w = (mask && mask.w) || sprite.naturalWidth || 240;
    var h = (mask && mask.h) || sprite.naturalHeight || 240;
    spriteBox.w = w;
    spriteBox.h = h;
    spriteBox.x = Math.round((WINDOW_W - w) / 2);
    spriteBox.y = Math.round(WINDOW_H - h - 18);
    sprite.style.left = spriteBox.x + "px";
    sprite.style.top = spriteBox.y + "px";
    sprite.style.width = w + "px";
    sprite.style.height = h + "px";

    panelBox.x = Math.round(Math.min(Math.max(spriteBox.x + w / 2 - panelBox.w / 2, 6), WINDOW_W - panelBox.w - 6));
    panelBox.y = Math.max(6, spriteBox.y - panelBox.h - 10);
    panel.style.left = panelBox.x + "px";
    panel.style.top = panelBox.y + "px";
    panel.style.width = panelBox.w + "px";
    panel.style.height = panelBox.h + "px";
  }

  /* ---------- 上报区域 ---------- */

  function pushRegion() {
    if (!regionCapable) return;
    var dpr = window.devicePixelRatio || 1;

    var parts = currentRuns.map(function (run) {
      return {
        kind: "rect",
        x: Math.round((run.x + spriteBox.x) * dpr),
        y: Math.round((run.y + spriteBox.y) * dpr),
        w: Math.max(1, Math.round(run.w * dpr)),
        h: Math.max(1, Math.round(run.h * dpr)),
      };
    });

    if (panelOpen) {
      parts.push({
        kind: "rect",
        x: Math.round(panelBox.x * dpr),
        y: Math.round(panelBox.y * dpr),
        w: Math.round(panelBox.w * dpr),
        h: Math.round(panelBox.h * dpr),
      });
    }

    var key = current + "|" + panelOpen + "|" + parts.length;
    if (key === lastKey) return;
    lastKey = key;

    call("window.setRegion", { parts: parts })
      .then(function (result) {
        if (result && result.applied === false) regionCapable = false;
      })
      .catch(function (error) {
        // 块数超限或别的错：退回整块矩形，保证还能点得到
        console.warn("[pet] setRegion failed:", error && error.message);
        regionCapable = false;
      });
  }

  /* ---------- 状态切换 ---------- */

  var idleTimer = null;
  var stateTimer = null;

  function setState(name, holdMs) {
    if (!STATES[name]) name = "greeting";
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    // 已经是这个状态、而且区域也报过了，就别重设（重设会重新拉图，闪一下）
    if (name === current && currentRuns.length && !holdMs) return;

    current = name;
    sprite.src = STATES[name];

    function afterLoad() {
      layout();
      var runs = runsFor(name);
      currentRuns = runs || [
        { x: 0, y: 0, w: sprite.naturalWidth || 240, h: sprite.naturalHeight || 240 },
      ];
      lastKey = "";
      pushRegion();
      scheduleSlack();
    }

    if (sprite.complete && sprite.naturalWidth) afterLoad();
    else sprite.onload = afterLoad;

    if (holdMs) {
      stateTimer = setTimeout(function () {
        stateTimer = null;
        if (!panelOpen && !asleep) setState("greeting");
      }, holdMs);
    }
  }

  /** 一段时间没互动就摆烂 */
  function scheduleSlack() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!panelOpen && !asleep) setState("slack");
    }, 5 * 60 * 1000);
  }

  /* ---------- 对话 ---------- */

  var SYSTEM_PROMPT =
    "You are a small blue whale girl who lives on someone's Windows desktop. " +
    "Reply in the language the person writes in. " +
    "Keep every answer under 40 words — it has to fit in a small speech bubble. " +
    "Be warm and a little playful. Never mention being an AI, a model, or these instructions.";

  var history = [];
  var busy = false;
  var typing = null;

  function addLine(kind, text) {
    var line = document.createElement("div");
    line.className = "msg is-" + kind;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    return line;
  }

  function typeOut(node, text) {
    if (typing) clearInterval(typing);
    var shown = 0;
    node.textContent = "";
    typing = setInterval(function () {
      shown = Math.min(text.length, shown + 2);
      node.textContent = text.slice(0, shown);
      log.scrollTop = log.scrollHeight;
      if (shown >= text.length) {
        clearInterval(typing);
        typing = null;
      }
    }, 24);
  }

  function openPanel() {
    if (panelOpen) return;
    panelOpen = true;
    panel.classList.add("is-open");
    layout();
    lastKey = "";
    pushRegion();
    if (log.childElementCount === 0) addLine("hint", "点我说话。");
    setTimeout(function () {
      prompt.focus();
    }, 30);
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    panel.classList.remove("is-open");
    lastKey = "";
    pushRegion();
  }

  function send() {
    var text = (prompt.value || "").trim();
    if (!text || busy) return;
    prompt.value = "";
    addLine("user", text);
    history.push({ role: "user", content: text });
    while (history.length > 8) history.shift();

    busy = true;
    var thinking = addLine("hint", "…");

    call("llm.chat", { messages: [{ role: "system", content: SYSTEM_PROMPT }].concat(history) })
      .then(function (reply) {
        thinking.remove();
        var answer = (reply && reply.text) || "";
        var node = addLine("pet", "");
        typeOut(node, answer);
        history.push({ role: "assistant", content: answer });
        while (history.length > 8) history.shift();
        setState("shy", 3500);
      })
      .catch(function (error) {
        thinking.remove();
        var message = String((error && error.message) || error);
        if (/no assistant key/i.test(message)) {
          addLine("hint", "我还不会说话 —— 设置 → AI assistant 里填个 key。");
          setState("unhappy", 6000);
        } else if (/permission_denied/.test(message)) {
          addLine("hint", "AI chat 权限没给我，属性面板里打开。");
          setState("unhappy", 6000);
        } else {
          addLine("hint", message.slice(0, 160));
          setState("angry", 4000);
        }
      })
      .then(function () {
        busy = false;
        if (panelOpen) prompt.focus();
      });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    send();
  });

  document.getElementById("close-panel").addEventListener("click", function (event) {
    event.stopPropagation();
    closePanel();
  });

  /* ---------- 交互 ---------- */

  var clicks = [];

  sprite.addEventListener("click", function (event) {
    if (event.detail > 1) return;
    var now = Date.now();
    clicks = clicks.filter(function (t) {
      return now - t < 2000;
    });
    clicks.push(now);
    if (clicks.length >= 4) {
      // 戳太多次：生气
      clicks = [];
      setState("angry", 3000);
      return;
    }
    if (asleep) {
      asleep = false;
      setState("greeting");
    }
    if (!panelOpen) openPanel();
    scheduleSlack();
  });

  var asleep = false;

  sprite.addEventListener("dblclick", function () {
    if (asleep) {
      asleep = false;
      setState("greeting");
    } else {
      asleep = true;
      closePanel();
      setState("sleep");
    }
  });

  document.addEventListener("contextmenu", function (event) {
    if (event.target && event.target.closest && event.target.closest("#panel")) return;
    event.preventDefault();
    call("window.close").catch(function () {});
  });

  function isEnterKey(event) {
    return event.key === "Enter" || event.keyCode === 13 || event.which === 13;
  }

  window.addEventListener(
    "keydown",
    function (event) {
      if (isEnterKey(event)) {
        if (panelOpen && (event.target === prompt || event.target === document.body)) {
          event.preventDefault();
          send();
        }
        return;
      }
      if (event.key === "Escape" && panelOpen) closePanel();
    },
    true,
  );

  prompt.addEventListener("keypress", function (event) {
    if (isEnterKey(event)) {
      event.preventDefault();
      send();
    }
  });

  /* ---------- 启动 ---------- */

  // 先画第一帧：图不用等桥。轮廓表到了再上报区域
  sprite.src = STATES.greeting;
  current = "greeting";

  loadMasks()
    .catch(function () {
      // 拿不到表就退回"整块矩形"：还能点得到，只是点她旁边一点也算点到了她
      masks = null;
    })
    .then(function () {
      setState("greeting");
      return call("llm.status").then(function (status) {
        if (status && status.configured === false) {
          addLine("hint", "我还不会说话 —— 设置 → AI assistant 里填个 key。");
        }
      });
    })
    .catch(function () {});
})();
