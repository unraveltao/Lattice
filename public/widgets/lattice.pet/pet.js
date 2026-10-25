/**
 * 桌宠：Coopanion 的鲸鱼 rig + 平台给的窗口区域。
 *
 * # 她是怎么"存在"于桌面上的
 *
 * 窗口不是矩形，而是 `SetWindowRgn` 裁出来的：区域外的像素不存在。所以一只
 * 桌宠由三件事对齐而成 —— 画面、轮廓、点击命中。这里的分工是：
 *
 *   - 画面：`pet-rig.js` 按 `whale/model.json` 的网格把 25 个部件画出来；
 *   - 轮廓：构建期算好的静止轮廓（`art/rig-data.js` 里的 `masks`），
 *     乘上当前缩放就是 `window.setRegion` 的输入；
 *   - 命中：系统按同一块区域裁窗口，所以"看得见"就等于"点得到"，不用另写一套。
 *
 * # 三条不能忘的
 *
 * 1. **轮廓只在"形状变了"时上报**：走动是整体挪窗口（`window.moveBy`），
 *    形状相对窗口没变，所以不用每帧重报 —— 那是每帧一次 GDI 区域重建。
 * 2. **不能读像素**：沙箱 iframe 是不透明源，`getImageData` 直接抛，
 *    所以轮廓只能构建期算（`art/build-masks.py`）。
 * 3. **心跳走平台的 `schedule.every`**，不用 `setInterval`：窗口藏起来时
 *    那条时间轴会停，宠物就不该还在"想事情"（不变量 10）。
 */
(function () {
  "use strict";

  /* ---------- 桥 ---------- */

  var seq = 0;
  var pending = new Map();

  var TIMEOUTS = { "llm.chat": 70000, "assistant.ask": 185000 };

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __lattice: 1, type: "request", id: id, method: method, params: params }, "*");
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error("Bridge call timed out: " + method));
      }, TIMEOUTS[method] || 5000);
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
    if (data.type === "tick") {
      roamTick();
      return;
    }
    if (data.type === "config-changed") {
      var next = (data.payload && data.payload.config) || {};
      applyConfig(next);
      return;
    }
    if (data.type === "language") {
      applyLanguage(data.payload);
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

  /* ---------- 元素与状态 ---------- */

  var canvas = document.getElementById("pet");
  var bubble = document.getElementById("bubble");
  var log = document.getElementById("log");
  var prompt = document.getElementById("prompt");
  var form = document.getElementById("composer");

  var WINDOW_W = 420;
  var WINDOW_H = 340;

  /*
   * 「大小」的出厂值。和清单里的 `config.scale.default` 是同一个数 ——
   * `config.get` 是往返，回来之前得先按这个画，否则第一帧是"铺满窗口"的
   * 巨兽，几十毫秒后突然缩一圈（不变量 18：先画第一帧，再等桥）。
   */
  var DEFAULT_SCALE = 0.55;

  var figure = null;
  var bubbleOpen = false;
  var bubbleBox = { x: 130, y: 6, w: 320, h: 170 };
  var regionCapable = true;
  var lastRegionKey = "";
  var asleep = false;
  var exprTimer = null;
  var stateTimer = null;
  var holdExpr = null;      // 临时表情（生气、害羞……），到点自己退回空闲脸

  /*
   * 气泡本体和区域不是同一个矩形：区域只有矩形粒度，而投影和尾巴都画在
   * 气泡外面。少留这圈边距，投影会在区域边界上被切出一条直线。
   * `TAIL_H` 必须和 `style.css` 里那两层伪元素的 `bottom:-14px` / 高度一致。
   */
  var PAD_X = 16;
  var PAD_TOP = 14;
  var PAD_BOTTOM = 26;
  var TAIL_H = 14;
  var BUBBLE_MAX_W = 288;

  /* ---------- 窗口区域 ---------- */

  /**
   * 上报轮廓。
   *
   * 只在"形状真的变了"时发：窗口尺寸、服装、气泡开合、气泡换了高度。走动不
   * 触发 —— 她动的是整个窗口，区域相对窗口没变。
   *
   * 判重键里必须带上气泡那块的**四个数**，不能只看"开着没有"：气泡的高度是
   * 内容定的，第 2 行和第 5 行一样是"开着"，只比开关状态就等于气泡长高了而
   * 区域没跟上 —— 多出来的字被区域切掉。
   */
  function pushRegion() {
    if (!figure || !regionCapable) return;
    var dpr = window.devicePixelRatio || 1;
    /*
     * 每块往四周多长 1 个设备像素。
     *
     * 区域是**系统剪裁**，1 个像素的差就是"她的边上出现一道一像素的缝"：
     * 轮廓表是按 6–18 rig 单位的带子算出来的（`art/build-masks.py`），
     * 相邻块各自 `Math.round` 之后完全可能差 1 像素；动画里的部件也会
     * 稍微挪进块之间的空档（实测拖动 / 松手那几帧有 2–3 个像素露在外面）。
     * 多长 1 像素不改变形状，只把这类"发丝缝"抹平，代价是点透的区域
     * 少了一像素宽的一条 —— 值。
     */
    var grow = 1;
    var parts = figure.region().map(function (part) {
      return {
        kind: "rect",
        x: Math.round(part.x * dpr) - grow,
        y: Math.round(part.y * dpr) - grow,
        w: Math.max(1, Math.round(part.w * dpr)) + grow * 2,
        h: Math.max(1, Math.round(part.h * dpr)) + grow * 2,
      };
    });

    if (bubbleOpen) {
      parts.push({
        kind: "rect",
        x: Math.round(bubbleBox.x * dpr) - grow,
        y: Math.round(bubbleBox.y * dpr) - grow,
        w: Math.round(bubbleBox.w * dpr) + grow * 2,
        h: Math.round(bubbleBox.h * dpr) + grow * 2,
      });
    }

    /*
     * 判重键要覆盖**每一块**，不能只看头那块（这条以前只拼了 `parts[0]`）：
     * 窗口只改高度时，头那块四舍五入之后完全可能没变，于是整条 `setRegion`
     * 都不发，系统继续用着旧轮廓 —— 她的脚 / 头顶就被旧区域切掉一刀。
     * 全部拼一遍也就几百个字符，而这里只在换尺寸 / 换衣服 / 气泡变高的
     * 时候才跑，不是每帧。
     */
    var key = parts
      .map(function (part) {
        return part.x + "," + part.y + "," + part.w + "," + part.h;
      })
      .join("|");
    if (key === lastRegionKey) return;
    lastRegionKey = key;

    call("window.setRegion", { parts: parts })
      .then(function (result) {
        if (result && result.applied === false) regionCapable = false;
      })
      .catch(function (error) {
        /*
         * 块数超限 / 老平台没有这个方法：退回"整块矩形"，保证还能点得到。
         * 一只点不到的宠物比一只区域粗糙的宠物糟得多。
         */
        console.warn("[pet] setRegion failed:", error && error.message);
        regionCapable = false;
      });
  }

  /* ---------- 布局 ---------- */

  function layout() {
    var width = window.innerWidth || WINDOW_W;
    var height = window.innerHeight || WINDOW_H;
    if (!figure) return;
    figure.layout(width, height, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * (window.devicePixelRatio || 1));
    canvas.height = Math.round(height * (window.devicePixelRatio || 1));

    placeBubble();
  }

  /**
   * 逐字显示的时候每一拍都想重摆一次，但读一次 `offsetHeight` 就是一次强制
   * 排版 —— 40 次/秒没有必要。折成 80ms 一次：换行本来就是十几颗字一下，
   * 看起来一样是"跟着字长"，少掉的只是白做的排版。
   */
  var fitAt = 0;

  function fitSoon() {
    var now = performance.now();
    if (now - fitAt < 80) return;
    fitAt = now;
    placeBubble();
  }

  /**
   * 把气泡摆到她头顶，并算出窗口区域要的那块矩形。
   *
   * 和 `layout()` 分开是必要的：`layout()` 会重设画布尺寸（等于把画布清空
   * 再画一遍），而气泡的高度是**内容**定的 —— 边说边长的每一次都得重新摆，
   * 要是每摆一次都走 `layout()`，她会一边说话一边闪。所以这里只量气泡、
   * 挪气泡、重报区域，她的画面一帧都不碰。
   */
  function placeBubble() {
    if (!figure) return;
    var width = window.innerWidth || WINDOW_W;
    var box = figure.artBox();

    // 1. 宽：先定气泡本体（换行由它决定），区域再加两侧边距
    var w = Math.max(180, Math.min(BUBBLE_MAX_W, width - PAD_X * 2 - 12));
    bubble.style.width = w + "px";
    bubbleBox.w = w + PAD_X * 2;

    // 2. 横：对准她的头，夹进窗口
    bubbleBox.x = Math.round(
      Math.min(Math.max(box.x + box.w / 2 - bubbleBox.w / 2, 6), width - bubbleBox.w - 6),
    );

    // 3. 高：先按"她头顶还剩多少地方"给消息区封顶
    /*
     * 窗口尺寸是平台给的（她调多大不改变窗口），而气泡和她的头抢的是同一块
     * 竖向空间：她调大一点，气泡就得矮一点。不封顶的话，一条长回答会把气泡
     * 顶到窗口外面 —— 顶上那几行直接看不见，或者反过来压在她脑袋上。
     * 33 是输入行（含边距）的高度，34 是消息区最少留一行的高度。
     */
    var room = Math.round(box.y - 6 - PAD_TOP - PAD_BOTTOM - TAIL_H - 33);
    log.style.maxHeight = Math.max(34, Math.min(104, room)) + "px";

    var h = bubble.offsetHeight || 0;
    if (!h) {
      // 收着的时候量不到高度（`display:none`），她的轮廓该重报还是要重报
      pushRegion();
      return;
    }
    bubbleBox.h = PAD_TOP + h + PAD_BOTTOM;

    // 4. 纵：尾巴尖落在她头顶上方 6px
    var tip = Math.max(6, Math.round(box.y - 6));
    bubbleBox.y = Math.max(6, tip - PAD_TOP - h - TAIL_H);

    bubble.style.left = bubbleBox.x + PAD_X + "px";
    bubble.style.top = bubbleBox.y + PAD_TOP + "px";

    // 5. 尾巴跟着她的头走：她挪到左边，尾巴就往左让（不越过圆角）
    var tail = box.x + box.w / 2 - (bubbleBox.x + PAD_X);
    tail = Math.round(Math.max(20, Math.min(w - 20, tail)));
    bubble.style.setProperty("--tail", tail + "px");

    pushRegion();
  }

  /* ---------- 表情 ---------- */

  var EXPR = {
    greeting: "neutral",
    shy: "shy",
    angry: "angry",
    unhappy: "unhappy",
    slack: "slack",
    sleep: "sleep",
  };

  function setState(name, holdMs) {
    if (!EXPR[name]) name = "greeting";
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    holdExpr = name;
    if (figure) figure.setExpression(EXPR[name]);
    if (holdMs) {
      stateTimer = setTimeout(function () {
        stateTimer = null;
        if (!bubbleOpen && !asleep) setState("greeting");
      }, holdMs);
    }
  }

  /** 一段时间没互动就摆烂 */
  function scheduleSlack() {
    if (exprTimer) clearTimeout(exprTimer);
    exprTimer = setTimeout(function () {
      if (!bubbleOpen && !asleep) setState("slack");
    }, 5 * 60 * 1000);
  }

  /* ---------- 动画循环 ---------- */

  var lastFrame = 0;
  var walkPhase = 0;

  function frame(now) {
    var dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
    lastFrame = now;
    if (figure) {
      if (walk.dir) walkPhase += dt * (roam === "free" ? 11 : 7);
      figure.setMotion({
        walking: !!walk.dir,
        speed: walk.dir ? (roam === "free" ? 58 : 26) : 0,
        phase: walkPhase,
        dragging: !!drag,
      });
      figure.setExpression(drag ? "dragged" : EXPR[holdExpr || "greeting"]);
      figure.tick(dt);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 她说什么语言 ---------- */

  /*
   * 平台界面能切成英文，但**她说的每句话都是作者写的**，平台不翻 —— 它不
   * 知道"点我说话。"对应哪句英文。所以这里两门都留着，按 `lang.get` 挑一份；
   * 用户中途换语言，平台会推一条 `language`，把已经说出口的那些话原地换掉。
   *
   * 首帧不等桥（不变量 18）：`index.html` 里写死的是中文，中文界面下看到的
   * 就是最终样子；英文界面要等 `lang.get` 回来那一趟（几十毫秒）才翻，换来
   * 的是不用先画一遍英文再被中文盖掉。
   */
  var lang = "zh";

  /** 资产缺失时标题要带一句"资产缺失"，换语言也得跟着换 */
  var assetsMissing = false;

  /** 一句话的两种写法，按当前界面语言挑 */
  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  /** 已经挂进气泡、还该跟着换语言的那些行（她自己的回答不算 —— 那是模型的话） */
  var spokenLines = [];

  function addLinePair(kind, zh, en) {
    var node = addLine(kind, say(zh, en));
    spokenLines.push({ node: node, zh: zh, en: en });
    return node;
  }

  function relabelSpokenLines() {
    var changed = false;
    spokenLines = spokenLines.filter(function (item) {
      if (!item.node.isConnected) return false;
      var text = say(item.zh, item.en);
      if (item.node.textContent !== text) {
        item.node.textContent = text;
        changed = true;
      }
      return true;
    });
    // 换过的句子长短不一样，气泡高度得重算一次
    if (changed) {
      fitSoon();
      placeBubble();
    }
  }

  /**
   * 换语言：HTML 里那几处静态字（标题、按钮、输入提示）+ 已经说出口的话。
   *
   * `lang` 只有 `zh` / `en` 两种 —— "跟随系统"是**平台**在设置里解析掉的，
   * 组件不用去猜系统区域。`zh` 是 HTML 里那份，所以回到中文不用重写一遍。
   */
  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;

    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = assetsMissing
      ? say("大肥鱼（资产缺失）", "Big Fishy (assets missing)")
      : say("大肥鱼", "Big Fishy");
    bubble.setAttribute("aria-label", say("大肥鱼", "Big Fishy"));
    prompt.placeholder = say("说点什么…", "Say something…");

    var close = document.getElementById("close-bubble");
    if (close) {
      close.title = say("收起（Esc）", "Put away (Esc)");
      close.setAttribute("aria-label", say("收起", "Put away"));
    }
    var sendButton = form.querySelector('button[type="submit"]');
    if (sendButton) {
      sendButton.textContent = say("发送", "Send");
      sendButton.title = say("发送（Enter）", "Send (Enter)");
    }

    relabelSpokenLines();
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
    placeBubble();
    return line;
  }

  /**
   * 逐字显示 + 一颗闪的竖条。
   *
   * 气泡的高度跟着字数长，所以每一拍都要重新摆一次（`placeBubble` 只量气泡、
   * 不碰画布，见那里的注释）。竖条是"她正在说"的信号 —— 40 个字要两秒，
   * 没有它看起来像卡住了。
   */
  function typeOut(node, text) {
    if (typing) clearInterval(typing);
    var caret = document.createElement("span");
    caret.className = "caret";
    var body = document.createTextNode("");
    var shown = 0;
    node.textContent = "";
    node.appendChild(body);
    node.appendChild(caret);
    typing = setInterval(function () {
      shown = Math.min(text.length, shown + 2);
      body.nodeValue = text.slice(0, shown);
      log.scrollTop = log.scrollHeight;
      fitSoon();
      if (shown >= text.length) {
        clearInterval(typing);
        typing = null;
        caret.remove();
        placeBubble();
      }
    }, 24);
  }

  function openBubble() {
    if (bubbleOpen) return;
    bubbleOpen = true;
    bubble.classList.add("is-open", "pop");
    setTimeout(function () {
      bubble.classList.remove("pop");
    }, 320);
    layout();
    if (log.childElementCount === 0) addLinePair("hint", "点我说话。", "Talk to me.");
    setTimeout(function () {
      prompt.focus();
    }, 30);
  }

  function closeBubble() {
    if (!bubbleOpen) return;
    bubbleOpen = false;
    bubble.classList.remove("is-open", "pop");
    lastRegionKey = "";
    pushRegion();
  }

  /**
   * 「替我调整桌面」没给时提醒一次。每句都提醒的话，她会变成一个弹窗。
   */
  var handHinted = false;

  /** 她这一轮做了什么。平台已经把动作名翻成了人话（`describeToolCall`），照抄就行 */
  function reportActions(actions) {
    for (var i = 0; i < actions.length; i += 1) {
      var item = actions[i] || {};
      if (!item.detail) continue;
      addLine("hint", (item.ok ? "· " : "× ") + item.detail);
    }
  }

  /** 把一轮的结果画进气泡：先她自己那句话，再她动过的东西 */
  function answerWith(reply) {
    var answer = (reply && reply.text) || "";
    var actions = (reply && reply.actions) || [];
    if (!answer) answer = actions.length ? say("好了。", "Done.") : "…";
    var node = addLine("pet", "");
    typeOut(node, answer);
    reportActions(actions);
    history.push({ role: "assistant", content: answer });
    while (history.length > 8) history.shift();
    setState("shy", 3500);
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
    var messages = [{ role: "system", content: SYSTEM_PROMPT }].concat(history);

    /*
     * 先请平台替她动手（`assistant.ask`，权限「替我调整桌面」）：那句话连同语气
     * 交给主窗口跑完整一轮，模型该调工具就调，回来的只有回话和"我做了什么"。
     *
     * 没有那项权限就退回「只说不动」（`llm.chat`）—— 她仍然会聊天，只是手还在
     * 平台手里；气泡里那句话是用户唯一能看懂的线索，所以只说一次。
     */
    call("assistant.ask", { messages: messages })
      .then(function (reply) {
        thinking.remove();
        answerWith(reply);
      })
      .catch(function (error) {
        var message = String((error && error.message) || error);
        if (/permission_denied/.test(message) || /unknown method/i.test(message)) {
          if (!handHinted) {
            handHinted = true;
            addLinePair(
              "hint",
              "给我「替我调整桌面」的权限，我就能替你摆组件。",
              "Grant me “Rearrange my desktop” and I can move things for you.",
            );
          }
          return call("llm.chat", { messages: messages }).then(function (reply) {
            thinking.remove();
            answerWith(reply);
          });
        }
        throw error;
      })
      .catch(function (error) {
        thinking.remove();
        var message = String((error && error.message) || error);
        if (/no assistant key/i.test(message)) {
          addLinePair(
            "hint",
            "我还不会说话 —— 设置 → AI assistant 里填个 key。",
            "I can't talk yet — add a key in Settings → AI assistant.",
          );
          setState("unhappy", 6000);
        } else if (/unknown method/i.test(message)) {
          // 这个版本的主线还没接 AI。别把"未知方法"这种内部错误甩给用户看 ——
          // 她只会以为组件坏了。
          addLinePair(
            "hint",
            "我还不会说话 —— 这个版本还没接上 AI。",
            "I can't talk yet — this version has no AI hooked up.",
          );
          setState("unhappy", 6000);
        } else if (/permission_denied/.test(message)) {
          addLinePair(
            "hint",
            "「Use my AI model」权限没给我，属性面板里打开。",
            "I don't have the “Use my AI model” permission — turn it on in the inspector.",
          );
          setState("unhappy", 6000);
        } else if (/already running/i.test(message) || /timed out/i.test(message)) {
          addLine("hint", say("等一下，我还在弄上一条。", "Hold on — I'm still on the last one."));
          setState("unhappy", 3000);
        } else {
          addLine("hint", message.slice(0, 160));
          setState("angry", 4000);
        }
      })
      .then(function () {
        busy = false;
        if (bubbleOpen) prompt.focus();
      });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    send();
  });

  document.getElementById("close-bubble").addEventListener("click", function (event) {
    event.stopPropagation();
    closeBubble();
  });

  /* ---------- 她会动：拖动 + 散步 ---------- */

  /*
   * 两件事都靠 `window.moveBy`（平台提供，不需要权限）：窗口没有窗饰，
   * 所以"被拖走"和"自己走"都只能由她自己提出来，平台负责夹回屏幕里。
   *
   * `movable === false` 说明这里不是桌面窗口（画布预览里没有位置可挪）。
   */
  var movable = null;
  var roam = "calm";
  var walk = { dir: 0, raf: 0, last: 0, until: 0, sampleAt: 0, sampleX: 0 };
  var roamAt = 0;
  var drag = null;
  var suppressClick = false;

  function moveBy(dx, dy) {
    return call("window.moveBy", { dx: dx, dy: dy })
      .then(function (result) {
        movable = !!(result && result.applied !== false);
        return result;
      })
      .catch(function () {
        // 桥不认识这个方法（旧平台）或者平台报错：停手，别再每帧重试
        movable = false;
        return null;
      });
  }

  function stopWalk() {
    walk.dir = 0;
  }

  /** 散步一帧：位移是"这一帧走了多少"，撞墙就把方向翻过来 */
  function stepWalk(now) {
    if (!walk.dir || movable === false) return;
    var dt = walk.last ? Math.min(0.05, (now - walk.last) / 1000) : 0.016;
    walk.last = now;

    if (now > walk.until) {
      stopWalk();
      decideLater();
      return;
    }

    var speed = roam === "free" ? 58 : 26; // px/s
    moveBy(walk.dir * speed * dt, 0).then(function (result) {
      if (!result || !result.applied) return;
      /*
       * 夹紧之后位置不再变 = 走到工作区边上了。判据取 0.5 秒的窗口而不是
       * 单帧：慢速散步时一帧只有 0.4px，四舍五入本来就会连着几帧不动。
       */
      if (!walk.sampleAt) {
        walk.sampleAt = now;
        walk.sampleX = result.x;
        return;
      }
      if (now - walk.sampleAt < 500) return;
      if (Math.abs(result.x - walk.sampleX) < 2) walk.dir = -walk.dir;
      walk.sampleAt = now;
      walk.sampleX = result.x;
    });

    walk.raf = requestAnimationFrame(stepWalk);
  }

  function startWalk(dir, ms) {
    if (movable === false || drag || bubbleOpen || asleep) return;
    walk.dir = dir;
    // 和 rAF 的时间戳同一把尺子（`performance.now()`），别混用 `Date.now()`
    walk.until = performance.now() + ms;
    walk.last = 0;
    walk.sampleAt = 0;
    walk.raf = requestAnimationFrame(stepWalk);
  }

  function decideLater() {
    var gap = roam === "free" ? 6 + Math.random() * 8 : 14 + Math.random() * 18;
    roamAt = Date.now() + gap * 1000;
  }

  /** 一秒一拍：够不够久、要不要出去走两步 */
  function roamTick() {
    if (roam === "off" || movable === false) return;
    if (drag || bubbleOpen || asleep || walk.dir) return;
    if (Date.now() < roamAt) return;
    if (Math.random() < 0.35) {
      decideLater();
      return;
    }
    var dir = Math.random() < 0.5 ? -1 : 1;
    var ms = 1200 + Math.random() * (roam === "free" ? 3200 : 1600);
    startWalk(dir, ms);
  }

  function applyConfig(config) {
    roam = config.roam === "off" || config.roam === "free" ? config.roam : "calm";
    if (roam === "off") stopWalk();
    var outfit = config.outfit === "cape" || config.outfit === "crew" ? config.outfit : "maid";
    if (figure && figure.outfit() !== outfit) {
      figure.setOutfit(outfit);
      lastRegionKey = "";
      layout();
    }
    // 「大小」：窗口尺寸是平台定的，她占多大由这一个系数决定
    var scale = Number(config.scale);
    if (figure && figure.setScale(Number.isFinite(scale) ? scale : DEFAULT_SCALE)) {
      lastRegionKey = "";
      layout();
    }
  }

  /* ---------- 输入 ---------- */

  var clicks = [];

  canvas.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 || bubbleOpen) return;
    // "她"只占窗口的一部分：画布上其余地方本来就是区域外的，等不到事件；
    // 但气泡开着的时候整块区域都在，别让点在气泡上的那一下把窗口拖走。
    drag = { id: event.pointerId, moved: false, acc: 0 };
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 拿不到捕获也能拖，只是拖不出窗口 */
    }
  });

  canvas.addEventListener("pointermove", function (event) {
    if (!drag || event.pointerId !== drag.id) return;

    /*
     * 位移用 `movementX/movementY`（这一下鼠标实际移动了多少），**不能用
     * `clientX`，也不该用 `screenX`**：
     *
     * - 窗口跟着指针一起动，`clientX` 于是几乎不变 —— 她会立刻在你手里停住。
     * - `screenX` 是"窗口屏幕坐标 + clientX"算出来的，而这两半不是同一帧更新的：
     *   实测拖 140px，窗口跑出去 200px —— 她比手快，越拖越远。
     */
    var dx = event.movementX || 0;
    var dy = event.movementY || 0;
    if (!dx && !dy) return;

    if (!drag.moved) {
      // 4px 之内还算"点一下"：不然每次点她都变成一次几像素的挪动
      drag.acc += Math.abs(dx) + Math.abs(dy);
      if (drag.acc < 4) return;
      drag.moved = true;
      stopWalk();
      document.body.classList.add("is-dragging");
    }
    moveBy(dx, dy);
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId && event.pointerId !== drag.id)) return;
    var moved = drag.moved;
    drag = null;
    document.body.classList.remove("is-dragging");
    if (moved) {
      // 抬手后浏览器补的那次 click 要吃掉，否则拖完会弹气泡
      suppressClick = true;
      setTimeout(function () {
        suppressClick = false;
      }, 0);
      decideLater();
    }
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("click", function (event) {
    if (suppressClick) return;
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
    if (!bubbleOpen) openBubble();
    scheduleSlack();
  });

  canvas.addEventListener("dblclick", function () {
    if (asleep) {
      asleep = false;
      setState("greeting");
    } else {
      asleep = true;
      closeBubble();
      setState("sleep");
    }
  });

  document.addEventListener("contextmenu", function (event) {
    if (event.target && event.target.closest && event.target.closest("#bubble")) return;
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
        if (bubbleOpen && (event.target === prompt || event.target === document.body)) {
          event.preventDefault();
          send();
        }
        return;
      }
      if (event.key === "Escape" && bubbleOpen) closeBubble();
    },
    true,
  );

  prompt.addEventListener("keypress", function (event) {
    if (isEnterKey(event)) {
      event.preventDefault();
      send();
    }
  });

  window.addEventListener("resize", layout);

  /* ---------- 启动 ---------- */

  var data = window.__PET_RIG_DATA;
  if (!data || !window.__PetFigure) {
    // 数据没带进来（打包漏了 art/rig-data.js）：至少别白屏
    assetsMissing = true;
    document.title = say("大肥鱼（资产缺失）", "Big Fishy (assets missing)");
  } else {
    figure = window.__PetFigure.create(canvas, data);
    figure.setScale(DEFAULT_SCALE);
    layout();
    setState("greeting");
    decideLater();
    requestAnimationFrame(frame);
  }

  // 心跳交给平台：窗口藏起来时它会停（所以她不会在看不见的时候还"想事情"）
  void call("schedule.every", { every: 1000 }).catch(function () {});

  call("config.get")
    .then(function (config) {
      applyConfig(config || {});
    })
    .catch(function () {});

  /*
   * 语言先问一次（首帧已经按 HTML 里的中文画好了，不变量 18）。
   * 她那几句"我还不会说话"要等它回来再挂 —— 英文界面上先冒一句中文很怪。
   */
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {})
    .then(function () {
      return call("llm.status");
    })
    .then(function (status) {
      if (status && status.configured === false) {
        addLinePair(
          "hint",
          "我还不会说话 —— 设置 → AI assistant 里填个 key。",
          "I can't talk yet — add a key in Settings → AI assistant.",
        );
      }
    })
    .catch(function () {});
})();
