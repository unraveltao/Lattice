/**
 * 计算器组件
 *
 * 三个页签共用一张卡片：算一下、转一下、算个哈希。分开做成三个组件的话，
 * 用户要装三张卡、再记住哪张是哪个 —— 而它们本来就是同一件事的三步。
 *
 * # 为什么自己写表达式解析，而不是 `eval`
 *
 * `eval` 在沙箱里也能跑，但它是"把用户输入当代码执行"，而这个组件的输入框
 * 是**别人也能往里贴东西**的地方（粘贴一行 JS 就执行了）。所以走正经的
 * 词法 + 调度场算法：认识的东西只有数字、`+ - * / % ^` 和括号，其余一律报
 * "Unexpected character"。代价是四十行代码，换来的是输入框不再是代码入口。
 *
 * # 为什么百分号是取模不是百分比
 *
 * 表达式计算器里 `17%5` 写成取模才自洽（`50%` 在纯表达式里没有"基准"，
 * 百分比的意义依赖上下文）。真想要百分比，`/100` 就在键盘上。
 *
 * # 心跳
 *
 * 这个组件不需要心跳 —— 结果是输入的函数，不是时间的函数。少一条时间轴，
 * 平台就少一件每秒要醒的事。
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // 桥
  // -------------------------------------------------------------------------

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
        var error = new Error("Bridge call timed out: " + method);
        error.code = "timeout";
        reject(error);
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
   * 卡片上的字是这个组件自己的 —— 平台不知道 "Copy" 该写成哪句中文。所以两门
   * 都留在这儿，按 `lang.get` 挑一份；用户中途换语言，平台推一条 `language`，
   * 把已经画出去的字原地换掉（两件事都要做：只读一次 = 换语言卡片不动，
   * 只听推送 = 语言停在建文档那一刻）。
   *
   * 首帧不等桥（不变量 18）：HTML 里写死的是中文，中文界面看到的就是最终样子；
   * 英文界面要等 `lang.get` 回来那一趟（几十毫秒）才翻。`lang` 只有 `zh` / `en`
   * 两种 —— "跟随系统"是平台在设置里解析掉的。
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
    document.title = say("计算器", "Calculator");
    // 页签、按钮、报错话、空态都跟语言有关，整块重画一次比逐个替换稳
    repaint();
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;
    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    // 平台界面换了语言。`lang.get` 是建文档那一刻的答案，这条是后来变了
    if (data.type === "language") {
      applyLanguage(data.payload);
      return;
    }
    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
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

  function noop() {}

  // -------------------------------------------------------------------------
  // 表达式：词法 → 调度场 → 求值
  // -------------------------------------------------------------------------

  var PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 4 };
  var RIGHT_ASSOC = { "^": true };
  /** 一元正负号：比乘除紧、比乘方松 —— 所以 -3^2 = -(3^2) = -9 */
  var UNARY_PREC = 3;

  function fail(zh, en) {
    var error = new Error(say(zh, en));
    error.userFacing = true;
    return error;
  }

  function tokenize(src) {
    var tokens = [];
    var i = 0;
    /** 上一个有意义的东西：null / "num" / "op" / "(" —— 用来判断一元负号 */
    var prev = null;

    while (i < src.length) {
      var ch = src.charAt(i);

      if (ch === " " || ch === "\t" || ch === "\n" || ch === ",") {
        i += 1;
        continue;
      }

      if ((ch >= "0" && ch <= "9") || ch === ".") {
        var start = i;
        var dots = 0;
        while (i < src.length) {
          var c = src.charAt(i);
          if (c >= "0" && c <= "9") {
            i += 1;
          } else if (c === ".") {
            dots += 1;
            if (dots > 1) throw fail("一个数里有两个小数点", "Two decimal points in one number");
            i += 1;
          } else if (c === "_") {
            // 千位分隔符：`1_000` 是给人看的，不是语法的一部分，所以直接吞掉
            i += 1;
          } else {
            break;
          }
        }
        var text = src.slice(start, i).replace(/_/g, "");
        if (text === ".") throw fail("小数点不能单独当一个数", "A number cannot be just a dot");
        tokens.push({ kind: "num", value: parseFloat(text) });
        prev = "num";
        continue;
      }

      if (ch === "(" || ch === ")") {
        tokens.push({ kind: ch });
        prev = ch === "(" ? "(" : "num";
        i += 1;
        continue;
      }

      if (PREC[ch] !== undefined) {
        var unary = (ch === "-" || ch === "+") && (prev === null || prev === "op" || prev === "(");
        if (unary) {
          tokens.push({ kind: "unary", value: ch === "-" ? -1 : 1 });
          prev = "op";
        } else {
          tokens.push({ kind: "op", value: ch });
          prev = "op";
        }
        i += 1;
        continue;
      }

      // × ÷ − 这些"看起来像运算符"的字符，给一句人话，而不是"Unexpected character"
      if (ch === "×" || ch === "÷" || ch === "−") {
        throw fail("用 * / -，别用 " + ch, "Use * / - instead of " + ch);
      }
      throw fail("不认识的字符：" + ch, "Unexpected character: " + ch);
    }
    return tokens;
  }

  /** 调度场算法：中缀 token 序列 → 后缀（RPN） */
  function toRpn(tokens) {
    var out = [];
    var stack = [];
    for (var i = 0; i < tokens.length; i += 1) {
      var token = tokens[i];
      if (token.kind === "num") {
        out.push(token);
      } else if (token.kind === "unary") {
        // 一元运算符是右结合的，所以"同优先级就弹出"要排除自己
        while (stack.length) {
          var top = stack[stack.length - 1];
          if (top.kind === "op" && PREC[top.value] >= UNARY_PREC) out.push(stack.pop());
          else break;
        }
        stack.push(token);
      } else if (token.kind === "op") {
        while (stack.length) {
          var topOp = stack[stack.length - 1];
          var topPrec = topOp.kind === "unary" ? UNARY_PREC : topOp.kind === "op" ? PREC[topOp.value] : 0;
          if (topOp.kind === "(") break;
          var mine = PREC[token.value];
          if (topPrec > mine || (topPrec === mine && !RIGHT_ASSOC[token.value])) out.push(stack.pop());
          else break;
        }
        stack.push(token);
      } else if (token.kind === "(") {
        stack.push(token);
      } else if (token.kind === ")") {
        var opened = false;
        while (stack.length) {
          var item = stack.pop();
          if (item.kind === "(") {
            opened = true;
            break;
          }
          out.push(item);
        }
        if (!opened) throw fail("括号不配对", "Unbalanced parentheses");
      }
    }
    while (stack.length) {
      var rest = stack.pop();
      if (rest.kind === "(") throw fail("括号不配对", "Unbalanced parentheses");
      out.push(rest);
    }
    return out;
  }

  function evalRpn(rpn) {
    var stack = [];
    for (var i = 0; i < rpn.length; i += 1) {
      var token = rpn[i];
      if (token.kind === "num") {
        stack.push(token.value);
      } else if (token.kind === "unary") {
        if (!stack.length) throw fail("正负号前面没有数", "Nothing to apply the sign to");
        stack.push(stack.pop() * token.value);
      } else {
        if (stack.length < 2) {
          throw fail(token.value + " 前面少一个数", "Missing a number before " + token.value);
        }
        var b = stack.pop();
        var a = stack.pop();
        switch (token.value) {
          case "+":
            stack.push(a + b);
            break;
          case "-":
            stack.push(a - b);
            break;
          case "*":
            stack.push(a * b);
            break;
          case "/":
            if (b === 0) throw fail("不能除以零", "Cannot divide by zero");
            stack.push(a / b);
            break;
          case "%":
            if (b === 0) throw fail("不能除以零", "Cannot divide by zero");
            stack.push(a % b);
            break;
          case "^":
            stack.push(Math.pow(a, b));
            break;
          default:
            throw fail("不认识的运算符 " + token.value, "Unknown operator " + token.value);
        }
      }
    }
    if (stack.length !== 1) throw fail("算式不完整", "Incomplete expression");
    return stack[0];
  }

  /**
   * 算一个表达式。空串返回 null（"还没输入"），出错抛带 `userFacing` 的错。
   *
   * 单独暴露出来是为了能在自检页里直接喂字符串 —— 这个函数是这个组件里唯一
   * 值得单独测的东西。
   */
  function evaluate(src) {
    var text = String(src == null ? "" : src).trim();
    if (!text) return null;
    var tokens = tokenize(text);
    if (!tokens.length) return null;
    return evalRpn(toRpn(tokens));
  }

  /**
   * 数字 → 人看的字符串。
   *
   * `0.1 + 0.2` 必须显示 0.3 而不是 0.30000000000000004：二进制浮点的尾巴
   * 对算数的人没有意义。`toPrecision(12)` 后再 Number 回来，顺手把尾随的零去掉。
   */
  function formatNumber(value) {
    if (typeof value !== "number" || Number.isNaN(value)) return "NaN";
    if (!isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    if (value === 0) return "0";
    var abs = Math.abs(value);
    if (abs >= 1e12 || abs < 1e-6) {
      return value
        .toExponential(6)
        .replace(/\.?0+e/, "e")
        .replace("e+", "e");
    }
    var rounded = Number(value.toPrecision(12));
    return String(rounded);
  }

  // -------------------------------------------------------------------------
  // Base64 / URL / MD5
  // -------------------------------------------------------------------------

  /*
   * Base64 要按 UTF-8 走。
   *
   * 直接 `btoa("中文")` 会抛 InvalidCharacterError —— btoa 只认 Latin-1。所以先
   * TextEncoder 成字节，再把字节一个个塞进 btoa 的"二进制字符串"。反过来解
   * 也一样：atob 出来的是字节串，要 TextDecoder 才变回文字。
   */
  function utf8ToBinary(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return binary;
  }

  function binaryToUtf8(binary) {
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function base64Encode(text) {
    return btoa(utf8ToBinary(text));
  }

  function base64Decode(text) {
    // 容忍粘贴时带进来的换行和空格：从别处复制来的 Base64 常常被折成几行
    var clean = String(text).replace(/\s+/g, "");
    try {
      return binaryToUtf8(atob(clean));
    } catch (error) {
      throw fail("不是合法的 Base64", "Not valid Base64");
    }
  }

  function urlEncode(text) {
    return encodeURIComponent(text);
  }

  function urlDecode(text) {
    try {
      return decodeURIComponent(String(text).replace(/\+/g, " "));
    } catch (error) {
      throw fail("不是合法的百分号编码", "Not valid percent-encoding");
    }
  }

  /*
   * MD5（RFC 1321）。WebCrypto 不提供它，而"核对一下这个文件的 md5"是最常见
   * 的用法之一，所以手写一份紧凑实现。输入按 UTF-8 取字节，输出 32 位小写 hex。
   *
   * 搬自邻仓 vela-cleanroom 的 `domain/md5.ts`（同一套 S/K 表与填充规则），
   * 只把 TS 的类型标注去掉。
   */
  var MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
    20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10,
    15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  /** K[i] = floor(2^32 × |sin(i+1)|) */
  var MD5_K = new Uint32Array(64);
  for (var mk = 0; mk < 64; mk += 1) MD5_K[mk] = Math.floor(Math.abs(Math.sin(mk + 1)) * 4294967296);

  function rotl(x, c) {
    return (x << c) | (x >>> (32 - c));
  }

  function md5Hex(input) {
    var msg = new TextEncoder().encode(input);
    var bitLen = BigInt(msg.length) * 8n;
    var padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
    padded.set(msg);
    padded[msg.length] = 0x80;
    for (var i = 0; i < 8; i += 1) {
      padded[padded.length - 8 + i] = Number((bitLen >> BigInt(8 * i)) & 0xffn);
    }

    var a0 = 0x67452301;
    var b0 = 0xefcdab89;
    var c0 = 0x98badcfe;
    var d0 = 0x10325476;
    var w = new Uint32Array(16);

    for (var off = 0; off < padded.length; off += 64) {
      for (var j = 0; j < 16; j += 1) {
        w[j] =
          padded[off + j * 4] |
          (padded[off + j * 4 + 1] << 8) |
          (padded[off + j * 4 + 2] << 16) |
          (padded[off + j * 4 + 3] << 24);
      }
      var A = a0;
      var B = b0;
      var C = c0;
      var D = d0;
      for (var k = 0; k < 64; k += 1) {
        var F;
        var g;
        if (k < 16) {
          F = (B & C) | (~B & D);
          g = k;
        } else if (k < 32) {
          F = (D & B) | (~D & C);
          g = (5 * k + 1) % 16;
        } else if (k < 48) {
          F = B ^ C ^ D;
          g = (3 * k + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * k) % 16;
        }
        var tmp = D;
        D = C;
        C = B;
        B = (B + rotl((A + F + MD5_K[k] + w[g]) >>> 0, MD5_S[k])) >>> 0;
        A = tmp;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    var out = new Uint8Array(16);
    var view = new DataView(out.buffer);
    view.setUint32(0, a0, true);
    view.setUint32(4, b0, true);
    view.setUint32(8, c0, true);
    view.setUint32(12, d0, true);
    var hex = "";
    for (var h = 0; h < out.length; h += 1) hex += out[h].toString(16).padStart(2, "0");
    return hex;
  }

  // -------------------------------------------------------------------------
  // 界面
  // -------------------------------------------------------------------------

  var root = document.getElementById("root");
  var titleEl = document.querySelector(".calc-title");
  var exprEl = document.getElementById("expr");
  var resultEl = document.getElementById("result");
  var historyEl = document.getElementById("history");
  var encodeIn = document.getElementById("encode-in");
  var encodeOut = document.getElementById("encode-out");
  var hashIn = document.getElementById("hash-in");
  var hashOut = document.getElementById("hash-out");
  var copyBtn = document.getElementById("copy");

  /** 页签上的词。两门都留在这儿，换语言时原地换掉，不重建页签 */
  var TAB_LABELS = {
    calc: { zh: "计算", en: "Calc" },
    encode: { zh: "编码", en: "Encode" },
    hash: { zh: "哈希", en: "Hash" },
  };

  var config = { keepHistory: true, historySize: 6 };
  var history = [];
  /** 当前能"复制"的那段文字；null = 没东西可复制（按钮藏起来） */
  var copyable = null;
  var copyTarget = null;
  /** 复制按钮上那一句现在是哪一种状态：idle / copied / selected / failed */
  var copyState = "idle";

  var EXPR_KEY = "expr";
  var HISTORY_KEY = "history";

  function applyConfig(next) {
    if (!next) return;
    config = {
      keepHistory: next.keepHistory !== false,
      historySize: clampInt(next.historySize, 3, 12, 6),
    };
    renderHistory();
  }

  function clampInt(value, min, max, fallback) {
    var number = Math.round(Number(value));
    if (!isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function showCopy(text, target) {
    copyable = text || null;
    copyTarget = target || null;
    copyBtn.hidden = !copyable;
  }

  /** 复制按钮上的字跟着状态和语言走（"已复制"两秒后就该变回"复制"） */
  function refreshCopyLabel() {
    copyBtn.textContent =
      copyState === "copied"
        ? say("已复制", "Copied")
        : copyState === "selected"
          ? say("已选中", "Selected")
          : copyState === "failed"
            ? say("复制失败", "Failed")
            : say("复制", "Copy");
  }

  /** 页面上那些写死的字：标题、页签、占位符、aria-label、空态 */
  function applyStaticText() {
    titleEl.textContent = say("计算器", "Calculator");
    Array.prototype.forEach.call(document.querySelectorAll(".calc-tab"), function (tab) {
      var labels = TAB_LABELS[tab.dataset.pane];
      if (labels) tab.textContent = labels[lang];
    });
    exprEl.setAttribute("aria-label", say("表达式", "Expression"));
    encodeIn.setAttribute("aria-label", say("编码输入", "Encode input"));
    encodeIn.placeholder = say("要编码或解码的文字", "Text to encode or decode");
    hashIn.setAttribute("aria-label", say("哈希输入", "Hash input"));
    hashIn.placeholder = say("要计算哈希的文字", "Text to hash");
    // 空态那行也是人看的字；已经有结果的时候别把结果盖掉
    if (encodeOut.dataset.empty === "true") encodeOut.textContent = say("还没有结果", "Nothing yet");
    if (hashOut.dataset.empty === "true") {
      hashOut.textContent = say("MD5 显示在这里", "MD5 appears here");
    }
    refreshCopyLabel();
  }

  /** 换语言之后重画：静态字 + 计算页上的报错话（别的页留着算好的结果） */
  function repaint() {
    applyStaticText();
    var pane = document.querySelector(".calc-pane.is-active");
    if (!pane || pane.dataset.pane === "calc") compute();
  }

  function setResult(text, isError) {
    resultEl.textContent = text;
    resultEl.classList.toggle("is-error", !!isError);
  }

  function compute() {
    try {
      var value = evaluate(exprEl.value);
      if (value === null) {
        setResult("= 0", false);
        showCopy(null);
        return;
      }
      var text = formatNumber(value);
      setResult("= " + text, false);
      showCopy(text, exprEl);
    } catch (error) {
      setResult(error.userFacing ? error.message : say("读不懂这段算式", "Could not read that"), true);
      showCopy(null);
    }
  }

  function renderHistory() {
    historyEl.innerHTML = "";
    if (!config.keepHistory) {
      historyEl.hidden = true;
      return;
    }
    historyEl.hidden = false;
    var rows = history.slice(0, config.historySize);
    for (var i = 0; i < rows.length; i += 1) {
      historyEl.appendChild(historyRow(rows[i]));
    }
  }

  function historyRow(entry) {
    var li = document.createElement("li");
    li.title = entry.expr + " = " + entry.result;
    var expr = document.createElement("span");
    expr.className = "calc-expr-text";
    expr.textContent = entry.expr;
    var answer = document.createElement("span");
    answer.className = "calc-answer";
    answer.textContent = entry.result;
    li.appendChild(expr);
    li.appendChild(answer);
    /*
     * 点一行把**答案**放回输入框，而不是把算式放回去：想复用的是一个数，
     * 不是重算一遍。算式在 title 里，需要抄的话还在。
     */
    li.addEventListener("click", function () {
      exprEl.value = entry.result;
      compute();
      exprEl.focus();
    });
    return li;
  }

  function pushHistory(expr, result) {
    history.unshift({ expr: expr, result: result });
    if (history.length > 24) history.length = 24;
    renderHistory();
    call("storage.set", { key: HISTORY_KEY, value: history }).catch(noop);
  }

  function saveExpr() {
    call("storage.set", { key: EXPR_KEY, value: exprEl.value }).catch(noop);
  }

  // ---- 页签 ----

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".calc-tab"));
  var panes = Array.prototype.slice.call(document.querySelectorAll(".calc-pane"));

  function activateTab(name) {
    tabs.forEach(function (tab) {
      tab.classList.toggle("is-active", tab.dataset.pane === name);
    });
    panes.forEach(function (pane) {
      pane.classList.toggle("is-active", pane.dataset.pane === name);
    });
    // 切页签就换一个"可复制的东西"，别让上一页的 Copy 留在那儿
    if (name === "calc") compute();
    else if (name === "encode") showCopy(encodeOut.dataset.empty === "true" ? null : encodeOut.textContent, encodeOut);
    else showCopy(hashOut.dataset.empty === "true" ? null : hashOut.textContent, hashOut);
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      activateTab(tab.dataset.pane);
    });
  });

  // ---- 计算页 ----

  var saveTimer = 0;
  exprEl.addEventListener("input", function () {
    compute();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveExpr, 400);
  });

  exprEl.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      try {
        var value = evaluate(exprEl.value);
        if (value === null) return;
        var result = formatNumber(value);
        pushHistory(exprEl.value.trim(), result);
        exprEl.value = result;
        compute();
        saveExpr();
      } catch (error) {
        /* 输入还没成形，回车不该把报错也记进历史 */
      }
      return;
    }
    if (event.key === "Escape") {
      exprEl.value = "";
      compute();
      saveExpr();
    }
  });

  // ---- 编码页 ----

  function setOutput(el, text, isError) {
    el.textContent = text;
    el.dataset.empty = text ? "false" : "true";
    el.classList.toggle("is-error", !!isError);
  }

  encodeIn.addEventListener("input", function () {
    // 输入一变，上一次的结果就不属于这段文字了
    setOutput(encodeOut, "", false);
    showCopy(null);
  });

  document.querySelectorAll("[data-encode]").forEach(function (button) {
    button.addEventListener("click", function () {
      var action = button.dataset.encode;
      try {
        var text = encodeIn.value;
        var out =
          action === "b64-enc"
            ? base64Encode(text)
            : action === "b64-dec"
              ? base64Decode(text)
              : action === "url-enc"
                ? urlEncode(text)
                : urlDecode(text);
        setOutput(encodeOut, out, false);
        showCopy(out, encodeOut);
      } catch (error) {
        setOutput(
          encodeOut,
          error.userFacing ? error.message : say("转不了这段文字", "Could not convert that"),
          true,
        );
        showCopy(null);
      }
    });
  });

  // ---- 哈希页 ----

  var hashTimer = 0;
  hashIn.addEventListener("input", function () {
    clearTimeout(hashTimer);
    // 边打边算是这个页签唯一有价值的地方，但每次按键都算一遍大文本会卡，
    // 所以 120ms 静默后再算
    hashTimer = setTimeout(function () {
      var text = hashIn.value;
      if (!text) {
        setOutput(hashOut, "", false);
        hashOut.dataset.empty = "true";
        hashOut.textContent = say("MD5 显示在这里", "MD5 appears here");
        showCopy(null);
        return;
      }
      var digest = md5Hex(text);
      setOutput(hashOut, digest, false);
      showCopy(digest, hashOut);
    }, 120);
  });

  // ---- 复制 ----

  copyBtn.addEventListener("click", function () {
    if (!copyable) return;
    call("clipboard.write", { text: copyable })
      .then(function () {
        copyState = "copied";
        refreshCopyLabel();
        setTimeout(function () {
          copyState = "idle";
          refreshCopyLabel();
        }, 1200);
      })
      .catch(function (error) {
        /*
         * 没有 clipboard:write 权限时不弹错：把文字选中，用户按 Ctrl+C 也能走。
         * 这条降级比"红字报错"有用 —— 剪贴板是这个组件的次要功能。
         */
        if (copyTarget && window.getSelection) {
          var range = document.createRange();
          range.selectNodeContents(copyTarget);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        copyState = error.code === "permission_denied" ? "selected" : "failed";
        refreshCopyLabel();
        setTimeout(function () {
          copyState = "idle";
          refreshCopyLabel();
        }, 1600);
      });
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住配置和存档 —— 计算器不该因为问不到语言就不算
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画 */
    });

  call("config.get")
    .then(function (values) {
      if (values) applyConfig(values);
    })
    .catch(noop)
    .then(function () {
      return call("storage.get", { key: HISTORY_KEY }).catch(function () {
        return null;
      });
    })
    .then(function (saved) {
      if (Array.isArray(saved)) {
        history = saved
          .filter(function (item) {
            return item && typeof item.expr === "string" && typeof item.result === "string";
          })
          .slice(0, 24);
      }
      renderHistory();
      return call("storage.get", { key: EXPR_KEY }).catch(function () {
        return null;
      });
    })
    .then(function (saved) {
      if (typeof saved === "string" && saved) exprEl.value = saved;
      compute();
    })
    .catch(noop)
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });

  /*
   * 自检页用：把纯函数挂到 window 上。
   * 生产环境里这几行不产生任何副作用（只是多了几个属性），但没有它们，
   * "0.1+0.2 显示 0.3" 这件事就只能靠眼睛看。
   */
  window.__latticeCalc = {
    evaluate: evaluate,
    formatNumber: formatNumber,
    base64Encode: base64Encode,
    base64Decode: base64Decode,
    md5Hex: md5Hex,
  };
  void root;
})();
