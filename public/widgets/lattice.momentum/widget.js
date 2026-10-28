/**
 * 长势组件（lattice.momentum）
 *
 * 两个页签：
 *  - **体检**：查一个仓库最近还行不行（52 周提交曲线 + 近 4 周对比 + 发版节奏 + 判定）
 *  - **榜单**：抓 github.com/trending 的 HTML（带本周新增 star）
 *
 * 纯逻辑全在 `momentum-core.js`（判定顺序、跳过最后一桶、发版去重、HTML 解析），
 * 这一层只管 DOM、桥、缓存和调度。规格是 `docs/design/LAT-0025-momentum-widget.md`。
 *
 * # 四条这一层必须自己担着的事
 *
 * **数据没拿到就不下结论。** 限流、断网、超时，一律走到"没读到"，**绝不**落到
 * "停更" —— 那是这个组件最容易犯、也最伤人的一个错（0025 §5 第一行）。
 *
 * **第一帧先画，再问桥。** 首屏是 HTML 里那段空态，配置 / 语言 / 缓存 / 模型状态
 * 都是之后才回来的，回来再改（不变量 18）。
 *
 * **过期先显示旧的，再后台重查。** 缓存里有旧数据就立刻画出来，请求回来了再换。
 * 让人盯着空卡片等 3 秒，比看到一小时前的数字糟得多。
 *
 * **刷新不调模型。** 一张摆在桌面上的卡片每三小时烧一次模型调用是不可接受的，
 * 所以只有"点解读"和"第一次查某个仓库"才走 `llm.chat`（0025 §4 最后一段）。
 */
(function () {
  "use strict";

  var C = window.__latticeMomentumCore;
  var KEY = "momentum";

  var NET_TIMEOUT = 25000;
  var CHAT_TIMEOUT = 70000;
  var RETRY_DELAY = 2000;
  var RETRY_LIMIT = 2;
  var WRITE_ECHO_MS = 1200;

  // ---------------------------------------------------------------------------
  // 桥
  // ---------------------------------------------------------------------------

  var seq = 0;
  var pending = new Map();

  function call(method, params, timeout) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __lattice: 1, type: "request", id: id, method: method, params: params }, "*");
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        var error = new Error("Bridge call timed out: " + method);
        error.code = "timeout";
        reject(error);
      }, timeout || 3000);
    });
  }

  function noop() {}

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // ---------------------------------------------------------------------------
  // 文案
  // ---------------------------------------------------------------------------

  var TEXT = {
    en: {
      health: "Health",
      trending: "Trending",
      checking: "Checking…",
      loadingList: "Loading the list…",
      query: "Check a repo to see whether it is still moving.",
      noRead: "Could not read it",
      reading: "Reading…",
      go: "Check",
      placeholder: "owner/repo",
      openIssues: function (n) {
        return formatInt(n) + " open";
      },
      recent: function (n) {
        return "last 4 weeks " + formatInt(n);
      },
      previous: function (n) {
        return "the 4 before " + formatInt(n);
      },
      change: function (pct, up) {
        return (up ? "+" : "−") + Math.abs(pct) + "%";
      },
      noCompare: "Not enough weeks to compare",
      cadence: function (days) {
        return "a release every " + (days === 1 ? "day" : days + " days");
      },
      oneRelease: "only one release",
      noReleases: "no releases",
      latest: function (tag, age) {
        return (tag ? "latest " + tag + " · " : "latest · ") + age;
      },
      verdict: {
        nodata: "Could not read it",
        archived: "Archived",
        fresh: "New, no commits yet",
        stalled: "Stalled",
        quiet: "Very quiet",
        faster: "Gaining",
        slower: "Slowing",
        steady: "Steady",
      },
      why: {
        weeks: "the commit curve did not arrive",
        none: "no data",
      },
      daily: "Today",
      weekly: "This week",
      monthly: "This month",
      incomplete: "This list is incomplete — the page was cut off.",
      broken: "The trending page structure changed, so nothing could be read. Open it on GitHub to see the list.",
      openGithub: "Open the trending page on GitHub",
      openRepo: "Open on GitHub",
      explain: "Explain",
      explaining: "Reading the recent work…",
      noteAgain: "Explain again",
      noteHint: "Written by your model. It never changes the verdict above.",
      noteFailed: "Could not get an explanation.",
      retry: "Click the verdict area to check again.",
      badRef: "Write it as owner/repo, or paste the GitHub URL.",
      denied: "Allow network access in the inspector.",
      limit: "GitHub is rate-limiting this machine (60 requests an hour without a token). Try again later.",
      missing: "There is no such repository.",
      blocked: "That host is not in this widget's manifest.",
      timedOut: "The request timed out.",
      truncated: "The response was cut off.",
      netFail: "Could not reach GitHub.",
      justNow: "just now",
      minutes: function (n) {
        return n + (n === 1 ? " minute ago" : " minutes ago");
      },
      hours: function (n) {
        return n + (n === 1 ? " hour ago" : " hours ago");
      },
      days: function (n) {
        return n + (n === 1 ? " day ago" : " days ago");
      },
      archivedNote: "read-only",
      shownCount: function (n) {
        return n + " repos";
      },
    },
    zh: {
      health: "体检",
      trending: "榜单",
      checking: "查询中…",
      loadingList: "正在取榜单…",
      query: "查一个仓库，看它最近还行不行。",
      noRead: "没读到",
      reading: "读不到存档",
      go: "查",
      placeholder: "owner/repo",
      openIssues: function (n) {
        return formatInt(n) + " 个未关闭";
      },
      recent: function (n) {
        return "近 4 周 " + formatInt(n) + " 次";
      },
      previous: function (n) {
        return "前 4 周 " + formatInt(n) + " 次";
      },
      change: function (pct, up) {
        return (up ? "+" : "−") + Math.abs(pct) + "%";
      },
      noCompare: "周数不够，比不了",
      cadence: function (days) {
        return "每 " + days + " 天一个版本";
      },
      oneRelease: "只发过 1 个版本",
      noReleases: "没有发版记录",
      latest: function (tag, age) {
        return (tag ? "最新 " + tag + " · " : "最新 · ") + age;
      },
      verdict: {
        nodata: "没读到",
        archived: "已归档",
        fresh: "刚建，还没有提交",
        stalled: "停更",
        quiet: "很安静",
        faster: "加速",
        slower: "放缓",
        steady: "平稳",
      },
      why: {
        weeks: "提交曲线没取到",
        none: "没有数据",
      },
      daily: "今天",
      weekly: "本周",
      monthly: "本月",
      incomplete: "榜单不完整 —— 页面被截断了。",
      broken: "trending 页面结构变了，一条都没解析出来。去 GitHub 上看吧。",
      openGithub: "在 GitHub 上打开榜单",
      openRepo: "在 GitHub 上打开",
      explain: "解读",
      explaining: "正在读最近的工作…",
      noteAgain: "再解读",
      noteHint: "模型写的，不参与上面的判定。",
      noteFailed: "没解读出来。",
      retry: "点一下判定那块可以重查。",
      badRef: "写成 owner/repo，或者直接粘 GitHub 地址。",
      denied: "在属性面板里允许联网。",
      limit: "GitHub 把这台机器限流了（不带 token 一小时 60 次）。过一会儿再试。",
      missing: "没有这个仓库。",
      blocked: "这个主机没写进组件清单。",
      timedOut: "请求超时了。",
      truncated: "响应被截断了。",
      netFail: "连不上 GitHub。",
      justNow: "刚刚",
      minutes: function (n) {
        return n + " 分钟前";
      },
      hours: function (n) {
        return n + " 小时前";
      },
      days: function (n) {
        return n + " 天前";
      },
      archivedNote: "只读",
      shownCount: function (n) {
        return n + " 个仓库";
      },
    },
  };

  var lang = "zh";
  function t(key) {
    var table = TEXT[lang] || TEXT.zh;
    var value = table[key];
    return value != null ? value : TEXT.zh[key];
  }

  function formatInt(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    try {
      return n.toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
    } catch (error) {
      return String(n);
    }
  }

  function ageText(from, now) {
    var diff = Math.max(0, (now || Date.now()) - from);
    var minutes = Math.floor(diff / 60000);
    if (minutes < 1) return t("justNow");
    if (minutes < 60) return t("minutes")(minutes);
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return t("hours")(hours);
    return t("days")(Math.floor(hours / 24));
  }

  var TONE = {
    faster: "good",
    steady: "ok",
    slower: "warn",
    quiet: "warn",
    stalled: "bad",
    archived: "bad",
    fresh: "ok",
    nodata: "bad",
  };

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  var config = { window: "weekly", refresh: 3 };
  var cache = C.emptyCache();
  var tab = "health";
  var win = "weekly";
  /** 用户自己点过分段控件之后，改配置不再把视图拽回去 */
  var winPicked = false;
  var currentKey = null;
  var healthBusy = false;
  var trendBusy = false;
  /** 上一次失败的形状：{ kind, detail: [zh, en] } —— 没有数据时才画 */
  var healthError = null;
  /** 有旧数据、但这次没刷新成功：只把顶上那一条标成"没读到" */
  var healthStale = false;
  var trendError = null;
  var trendNotice = null;
  var llmReady = false;
  var noteBusy = false;
  var noteError = false;
  var storageOk = true;
  var writing = false;
  var dirty = false;
  var lastWriteAt = 0;
  var run = 0;
  var trendRun = 0;
  var tickId = 0;
  var tickEvery = 0;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  var el = {
    root: document.getElementById("root"),
    state: document.getElementById("state"),
    tabHealth: document.getElementById("tab-health"),
    tabTrending: document.getElementById("tab-trending"),
    paneHealth: document.getElementById("pane-health"),
    paneTrending: document.getElementById("pane-trending"),
    form: document.getElementById("form"),
    query: document.getElementById("query"),
    go: document.getElementById("go"),
    figure: document.getElementById("figure"),
    name: document.getElementById("repo-name"),
    verdict: document.getElementById("verdict"),
    stats: document.getElementById("stats"),
    spark: document.getElementById("spark"),
    cmp: document.getElementById("cmp"),
    cadence: document.getElementById("cadence"),
    note: document.getElementById("note"),
    noteText: document.getElementById("note-text"),
    noteHint: document.getElementById("note-hint"),
    explain: document.getElementById("explain"),
    empty: document.getElementById("empty"),
    seg: document.getElementById("seg"),
    notice: document.getElementById("notice"),
    list: document.getElementById("list"),
    trendingEmpty: document.getElementById("trending-empty"),
    openGithub: document.getElementById("open-gh"),
  };

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  function render() {
    el.root.dataset.tab = tab;
    el.tabHealth.dataset.on = tab === "health" ? "true" : "false";
    el.tabTrending.dataset.on = tab === "trending" ? "true" : "false";
    el.tabHealth.setAttribute("aria-selected", tab === "health" ? "true" : "false");
    el.tabTrending.setAttribute("aria-selected", tab === "trending" ? "true" : "false");
    show(el.paneHealth, tab === "health");
    show(el.paneTrending, tab === "trending");
    el.tabHealth.textContent = t("health");
    el.tabTrending.textContent = t("trending");
    el.query.placeholder = t("placeholder");
    el.go.textContent = t("go");
    el.noteHint.textContent = t("noteHint");
    el.openGithub.textContent = t("openGithub");

    if (tab === "health") renderHealth();
    else renderTrending();
    renderState();
  }

  /** 顶上那一条：写"此刻的状态"，不写组件名（WIDGET_SPEC §5.1）。 */
  function renderState() {
    var text = "";
    var tone = "muted";
    if (tab === "health") {
      var entry = currentEntry();
      if (healthBusy) {
        text = t("checking");
      } else if (healthError) {
        text = pair(healthError.detail);
        tone = "bad";
      } else if (entry) {
        var verdict = judgeEntry(entry);
        text = t("verdict")[verdict.kind] || t("noRead");
        tone = TONE[verdict.kind] || "muted";
        text += " · " + ageText(entry.at);
        if (healthStale) {
          text += " · " + t("noRead");
          tone = "warn";
        }
      }
    } else {
      if (trendBusy) {
        text = t("loadingList");
      } else {
        text = t(win);
        var cached = cache.trending[win];
        if (cached) text += " · " + ageText(cached.at);
        else if (trendError) tone = "bad";
      }
    }
    el.state.textContent = text;
    el.state.dataset.tone = tone;
  }

  function currentEntry() {
    return currentKey ? cache.repos[currentKey] || null : null;
  }

  function judgeEntry(entry) {
    return C.judge({ repo: entry.data.repo, weeks: entry.data.weeks, now: Date.now() });
  }

  function renderHealth() {
    var entry = currentEntry();
    if (!entry) {
      show(el.figure, false);
      show(el.empty, true);
      el.empty.textContent = healthBusy
        ? t("checking")
        : healthError
          ? pair(healthError.detail)
          : t("query");
      el.empty.dataset.tone = healthError && !healthBusy ? "bad" : "muted";
      return;
    }

    show(el.empty, false);
    show(el.figure, true);

    var data = entry.data;
    var repo = data.repo;
    var verdict = judgeEntry(entry);

    el.name.textContent = repo.full;
    el.name.title = t("openRepo");
    el.name.dataset.url = repo.htmlUrl;

    el.verdict.textContent = t("verdict")[verdict.kind] || t("noRead");
    el.verdict.dataset.tone = TONE[verdict.kind] || "muted";
    el.verdict.title =
      verdict.kind === "nodata" ? (t("why")[verdict.reason] || t("noRead")) : "";

    // 数字：star / 未关闭 issue / 语言。archived 也在这里标一下（判定那块已经说了）
    var bits = ["★ " + formatInt(repo.stars), t("openIssues")(repo.issues)];
    if (repo.language) bits.push(repo.language);
    if (repo.archived) bits.push(t("archivedNote"));
    el.stats.textContent = bits.join(" · ");

    paintSpark(data.weeks);
    renderCompare(verdict);
    renderCadence(data.releases);
    renderNote(entry);
    // 没配模型时这一块整个不出现（不是显示一个空框）
    show(el.explain, llmReady);
    el.explain.textContent = entry.note ? t("noteAgain") : t("explain");
  }

  /*
   * 52 根柱子。最后那一根是**本周进行中**，所以画浅一点、不参与对比 —— 图和数字
   * 必须是同一件事，否则"图上明显在涨、下面写着放缓"。
   */
  function paintSpark(weeks) {
    while (el.spark.firstChild) el.spark.removeChild(el.spark.firstChild);
    show(el.spark, Boolean(weeks && weeks.length));
    if (!weeks || !weeks.length) return;

    var peak = 1;
    for (var i = 0; i < weeks.length; i++) peak = Math.max(peak, weeks[i]);
    var step = 208 / weeks.length;
    var width = Math.max(1.4, step - 1.2);
    var last = weeks.length - 1;

    for (var j = 0; j < weeks.length; j++) {
      var value = weeks[j];
      var height = Math.max(1.2, Math.round((value / peak) * 40));
      var bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bar.setAttribute("x", String(Math.round(j * step * 10) / 10));
      bar.setAttribute("y", String(44 - height));
      bar.setAttribute("width", String(Math.round(width * 10) / 10));
      bar.setAttribute("height", String(height));
      bar.setAttribute("rx", "1");
      bar.setAttribute("class", "mo-bar");
      // 近 4 周（可比的那四桶）用强调色，最后一桶（本周进行中）浅一档
      if (j >= weeks.length - 5 && j < last) bar.dataset.zone = "recent";
      if (j === last) bar.dataset.zone = "current";
      el.spark.appendChild(bar);
    }
  }

  function renderCompare(verdict) {
    if (verdict.recent == null) {
      el.cmp.textContent = t("noCompare");
      el.cmp.dataset.tone = "muted";
      return;
    }
    var parts = [t("recent")(verdict.recent)];
    if (verdict.previous != null) parts.push(t("previous")(verdict.previous));
    if (verdict.change != null) {
      var pct = Math.round(verdict.change * 100);
      parts.push(t("change")(pct, pct > 0));
    }
    el.cmp.textContent = parts.join(" · ");
    var tone = TONE[verdict.kind] || "muted";
    el.cmp.dataset.tone = tone === "bad" || tone === "warn" ? "warn" : "ok";
  }

  function renderCadence(releases) {
    var info = C.cadence(releases);
    if (!info.count) {
      el.cadence.textContent = t("noReleases");
      return;
    }
    var text;
    if (info.count === 1 || info.medianGapDays == null) {
      text = t("oneRelease");
    } else {
      text = t("cadence")(info.medianGapDays);
    }
    if (info.latestAt != null) {
      text += " · " + t("latest")(info.latestTag, ageText(info.latestAt));
    }
    el.cadence.textContent = text;
  }

  function renderNote(entry) {
    var note = entry.note && entry.note.text ? entry.note.text : "";
    show(el.note, Boolean(note) || noteBusy || noteError);
    if (noteBusy) {
      el.noteText.textContent = t("explaining");
      show(el.noteHint, false);
      return;
    }
    if (note) {
      el.noteText.textContent = note;
      show(el.noteHint, true);
      return;
    }
    el.noteText.textContent = t("noteFailed");
    show(el.noteHint, false);
  }

  function renderTrending() {
    var buttons = el.seg.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var name = buttons[i].getAttribute("data-window");
      buttons[i].dataset.on = name === win ? "true" : "false";
      buttons[i].setAttribute("aria-pressed", name === win ? "true" : "false");
      buttons[i].textContent = t(name);
    }

    var entry = cache.trending[win];
    var items = entry ? entry.items : [];

    while (el.list.firstChild) el.list.removeChild(el.list.firstChild);
    for (var j = 0; j < items.length; j++) el.list.appendChild(renderRow(items[j], j));

    var notice = "";
    var noticeTone = "warn";
    if (trendBusy && !items.length) {
      notice = "";
      el.trendingEmpty.textContent = t("loadingList");
      el.trendingEmpty.dataset.tone = "muted";
    } else if (items.length) {
      el.trendingEmpty.textContent = "";
      if (entry && entry.truncated) notice = t("incomplete");
    } else if (trendError) {
      el.trendingEmpty.textContent = pair(trendError.detail);
      el.trendingEmpty.dataset.tone = "bad";
      noticeTone = "bad";
    } else if (entry) {
      // 有缓存、解析 0 条：页面结构变了 —— 不是"今天没有热门"（0025 §5）
      el.trendingEmpty.textContent = t("broken");
      el.trendingEmpty.dataset.tone = "bad";
      noticeTone = "bad";
    } else {
      el.trendingEmpty.textContent = t("loadingList");
      el.trendingEmpty.dataset.tone = "muted";
    }

    if (!notice && trendNotice) notice = pair(trendNotice);
    show(el.notice, Boolean(notice));
    el.notice.textContent = notice;
    el.notice.dataset.tone = noticeTone;
    show(el.trendingEmpty, !items.length);
    show(el.list, items.length > 0);
    show(el.openGithub, Boolean(trendError) || !items.length);
  }

  function renderRow(item, index) {
    var row = document.createElement("li");
    row.className = "mo-item";

    var button = document.createElement("button");
    button.type = "button";
    button.className = "mo-row";
    button.title = item.url;
    button.dataset.url = item.url;

    var rank = document.createElement("span");
    rank.className = "mo-rank";
    rank.textContent = String(index + 1);

    var body = document.createElement("span");
    body.className = "mo-body";

    var head = document.createElement("span");
    head.className = "mo-row-head";
    var name = document.createElement("span");
    name.className = "mo-row-name";
    name.textContent = item.full;
    head.appendChild(name);
    if (item.gained != null) {
      var gain = document.createElement("span");
      gain.className = "mo-gain";
      gain.textContent = "+" + formatInt(item.gained);
      head.appendChild(gain);
    }

    var meta = document.createElement("span");
    meta.className = "mo-row-meta";
    var bits = [];
    if (item.stars != null) bits.push("★ " + formatInt(item.stars));
    if (item.language) bits.push(item.language);
    meta.textContent = bits.join(" · ");

    body.appendChild(head);
    if (item.description) {
      var desc = document.createElement("span");
      desc.className = "mo-row-desc";
      desc.textContent = item.description;
      body.appendChild(desc);
    }
    if (meta.textContent) body.appendChild(meta);

    button.appendChild(rank);
    button.appendChild(body);
    row.appendChild(button);
    return row;
  }

  function pair(text) {
    return lang === "zh" ? text[0] : text[1];
  }

  // ---------------------------------------------------------------------------
  // 网络
  // ---------------------------------------------------------------------------

  /*
   * 一次请求，回桥的原始形状。**不在这一层判成败** —— 那个 202（GitHub 正在算
   * 提交统计）要走另一条路，它既不是成功也不是失败。
   */
  function request(url, timeout) {
    return call("network.fetch", { url: url, headers: { accept: "application/json" } }, timeout || NET_TIMEOUT);
  }

  function asJson(response) {
    if (!response || typeof response.body !== "string") return null;
    try {
      return JSON.parse(response.body);
    } catch (error) {
      return null;
    }
  }

  function httpError(status, headers) {
    var error = new Error("HTTP " + status);
    error.code = "http";
    error.status = status;
    error.headers = headers || {};
    return error;
  }

  function fetchJson(url) {
    return request(url).then(function (response) {
      if (!response) throw httpError(0, {});
      if (response.status === 403 || response.status === 429) throw httpError(response.status, response.headers);
      if (response.status === 404) throw httpError(404, response.headers);
      if (response.status >= 300 && response.status < 400) throw httpError(response.status, response.headers);
      if (!response.ok) throw httpError(response.status, response.headers);
      if (response.truncated) {
        var cut = new Error("truncated");
        cut.code = "truncated";
        throw cut;
      }
      return asJson(response);
    });
  }

  /**
   * 提交统计：可能回 **202**（GitHub 说"我还在算"）。
   *
   * 隔 2 秒重试，最多两次；还不行就**只缺曲线**，其余照常显示。把它当失败的话，
   * 一个明明很活跃的仓库会因为没有曲线而落到"没读到"。
   */
  function fetchParticipation(url) {
    var tries = 0;

    function once() {
      return request(url)
        .then(function (response) {
          if (!response) return null;
          if (response.status === 202 || response.status === 204) {
            if (tries >= RETRY_LIMIT) return null;
            tries += 1;
            return delay(RETRY_DELAY).then(once);
          }
          if (!response.ok || response.truncated) return null;
          return asJson(response);
        })
        .catch(function () {
          return null;
        });
    }

    return once();
  }

  function shapeRelease(item) {
    if (!item || typeof item !== "object") return null;
    return {
      tag_name: String(item.tag_name || item.name || ""),
      name: String(item.name || ""),
      draft: item.draft === true,
      prerelease: item.prerelease === true,
      published_at: typeof item.published_at === "string" ? item.published_at : null,
      created_at: typeof item.created_at === "string" ? item.created_at : null,
    };
  }

  function describeFailure(error) {
    var code = error && error.code;
    var status = error && error.status;
    if (code === "permission_denied") return { kind: "denied", detail: [t("denied"), t("denied")] };
    if (code === "timeout") return { kind: "timeout", detail: [t("timedOut"), t("timedOut")] };
    if (code === "truncated") return { kind: "truncated", detail: [t("truncated"), t("truncated")] };
    if (status === 404) return { kind: "missing", detail: [t("missing"), t("missing")] };
    if (status === 403 || status === 429) return { kind: "limit", detail: [t("limit"), t("limit")] };
    if (code === "internal" && /network\.hosts/.test(String(error.message))) {
      return { kind: "blocked", detail: [t("blocked"), t("blocked")] };
    }
    return { kind: "net", detail: [t("netFail"), t("netFail")] };
  }

  // ---------------------------------------------------------------------------
  // 体检
  // ---------------------------------------------------------------------------

  function openRepo(ref) {
    currentKey = ref.key;
    var cached = cache.repos[ref.key] || null;
    var stale = cached ? !C.fresh(cached, C.REPO_TTL, Date.now()) : true;

    healthError = null;
    el.query.value = ref.full;
    render();

    if (!stale) return Promise.resolve(cached);
    return fetchHealth(ref, { interpretFirst: !cached });
  }

  function fetchHealth(ref, options) {
    var myRun = ++run;
    var base = "https://api.github.com/repos/" + encodeURIComponent(ref.owner) + "/" + encodeURIComponent(ref.name);

    healthBusy = true;
    healthError = null;
    healthStale = false;
    render();

    return Promise.all([
      fetchJson(base),
      fetchParticipation(base + "/stats/participation"),
      fetchJson(base + "/releases?per_page=10").catch(function () {
        // 发版拿不到只该缺那一行，不该让整个体检失败
        return [];
      }),
    ])
      .then(function (results) {
        if (myRun !== run) return null;
        var repo = C.normalizeRepo(results[0]);
        if (!repo) {
          throw httpError(0, {});
        }
        var weeks = C.weeksOf(results[1]);
        var releases = Array.isArray(results[2]) ? results[2].map(shapeRelease).filter(Boolean) : [];
        var entry = {
          at: Date.now(),
          data: { repo: repo, weeks: weeks, releases: releases.slice(0, 10) },
          note: (cache.repos[ref.key] && cache.repos[ref.key].note) || null,
        };
        cache.repos[ref.key] = entry;
        pruneRepos();
        healthBusy = false;
        healthError = null;
        healthStale = false;
        persist();
        render();
        if (options && options.interpretFirst && llmReady && !entry.note) interpret(true);
        return entry;
      })
      .catch(function (error) {
        if (myRun !== run) return null;
        healthBusy = false;
        var problem = describeFailure(error);
        // 有旧数据就继续显示旧数据，只在顶上那一条说"没读到"；没有才把整页换成错误
        healthStale = Boolean(currentEntry());
        healthError = currentEntry() ? null : problem;
        render();
        return null;
      });
  }

  function pruneRepos() {
    var keys = Object.keys(cache.repos).sort(function (a, b) {
      return cache.repos[b].at - cache.repos[a].at;
    });
    keys.slice(C.MAX_REPOS).forEach(function (key) {
      delete cache.repos[key];
    });
  }

  function submitQuery() {
    var ref = C.parseRepoRef(el.query.value);
    if (!ref) {
      healthError = { kind: "bad", detail: [t("badRef"), t("badRef")] };
      render();
      return;
    }
    if (healthBusy) run += 1; // 作废在飞的那次
    openRepo(ref);
  }

  // ---------------------------------------------------------------------------
  // 榜单
  // ---------------------------------------------------------------------------

  /** 榜单那一页是 HTML：单独走一条，不经过 `fetchJson` 的 JSON 解析。 */
  function fetchTrendingHtml(name) {
    return request(C.trendingUrl(name)).then(function (response) {
      if (!response) throw httpError(0, {});
      if (response.status === 403 || response.status === 429) throw httpError(response.status, response.headers);
      if (!response.ok) throw httpError(response.status, response.headers);
      return { html: String(response.body || ""), truncated: response.truncated === true };
    });
  }

  function parseTrendingPage(name, html, truncated) {
    var parsed = C.parseTrending(html, truncated);
    var entry = { at: Date.now(), items: parsed.items, truncated: parsed.truncated };
    cache.trending[name] = entry;
    trendBusy = false;
    trendError = null;
    // 截断要写在缓存里：下次从盘上读回来，那一行提示还得在
    persist();
    render();
    return entry;
  }

  function refreshTrending() {
    var name = win;
    trendBusy = true;
    trendNotice = null;
    trendError = null;
    render();
    var myRun = ++trendRun;

    return fetchTrendingHtml(name)
      .then(function (result) {
        if (myRun !== trendRun) return null;
        return parseTrendingPage(name, result.html, result.truncated);
      })
      .catch(function (error) {
        if (myRun !== trendRun) return null;
        trendBusy = false;
        var problem = describeFailure(error);
        // 有缓存就继续显示旧的（顶上那一行说"没读到"），没有才整页说
        trendError = cache.trending[name] ? null : problem;
        if (cache.trending[name]) trendNotice = problem.detail;
        render();
        return null;
      });
  }

  // ---------------------------------------------------------------------------
  // 模型（只写一句话，不参与判断）
  // ---------------------------------------------------------------------------

  function collectCommits(entry) {
    var repo = entry.data.repo;
    var url =
      "https://api.github.com/repos/" +
      encodeURIComponent(repo.full.split("/")[0]) +
      "/" +
      encodeURIComponent(repo.full.split("/")[1]) +
      "/commits?per_page=10";
    return fetchJson(url)
      .then(function (list) {
        if (!Array.isArray(list)) return [];
        return list
          .map(function (item) {
            var message = item && item.commit && item.commit.message;
            return typeof message === "string" ? message.split("\n")[0].trim().slice(0, 90) : "";
          })
          .filter(Boolean);
      })
      .catch(function () {
        // 提交列表拿不到不该挡住解读：三条发版标题也够模型说一句话了
        return [];
      });
  }

  function promptFor(entry, commits) {
    var data = entry.data;
    var repo = data.repo;
    var verdict = C.judge({ repo: repo, weeks: data.weeks, now: Date.now() });
    var before = verdict.previous == null ? "?" : String(verdict.previous);
    var releases = (data.releases || [])
      .slice(0, 3)
      .map(function (item) {
        var day = item.published_at ? item.published_at.slice(0, 10) : "";
        return "- " + (item.tag_name || item.name || "?") + (day ? " (" + day + ")" : "");
      })
      .join("\n");

    var system =
      lang === "zh"
        ? "你在替一个人读一个开源项目的最近工作。只回一句话，中文，40 个字以内：说它在做什么、卡在哪。不要下结论（不要写“活跃”“停更”“该不该用”），不要重复我给的数字，不要客套。"
        : "You are reading an open-source project's recent work for someone. Answer with one English sentence, at most 25 words: what they are doing, what is stuck. Do not judge (no “active”, “abandoned”, “should I use it”), do not repeat my numbers, no pleasantries.";

    var lines = [
      repo.full + (repo.description ? " — " + repo.description : ""),
      (lang === "zh" ? "近 4 周 " : "Last 4 weeks: ") + verdict.recent + (lang === "zh" ? " 次提交，前 4 周 " : " commits; the 4 before: ") + before,
    ];
    if (releases) lines.push((lang === "zh" ? "最近的发版：\n" : "Recent releases:\n") + releases);
    if (commits.length) {
      lines.push(
        (lang === "zh" ? "最近的提交：\n" : "Recent commits:\n") +
          commits
            .slice(0, 10)
            .map(function (text) {
              return "- " + text;
            })
            .join("\n"),
      );
    }

    return [
      { role: "system", content: system },
      { role: "user", content: lines.join("\n") },
    ];
  }

  function interpret(force) {
    var entry = currentEntry();
    if (!entry || !llmReady || noteBusy) return Promise.resolve(null);
    if (entry.note && !force) return Promise.resolve(entry.note);

    noteBusy = true;
    noteError = false;
    renderHealth();

    return collectCommits(entry)
      .then(function (commits) {
        return call("llm.chat", { messages: promptFor(entry, commits) }, CHAT_TIMEOUT);
      })
      .then(function (reply) {
        var text = reply && typeof reply.text === "string" ? reply.text.trim() : "";
        text = text.replace(/^["“']|["”']$/g, "").replace(/\s+/g, " ").slice(0, 240);
        if (!text) throw new Error("empty reply");
        entry.note = { text: text, at: Date.now() };
        noteBusy = false;
        noteError = false;
        persist();
        render();
        return entry.note;
      })
      .catch(function () {
        noteBusy = false;
        noteError = true;
        renderHealth();
        return null;
      });
  }

  // ---------------------------------------------------------------------------
  // 缓存
  // ---------------------------------------------------------------------------

  function persist() {
    if (!storageOk) return;
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    dirty = false;
    lastWriteAt = Date.now();
    call("storage.set", { key: KEY, value: cache })
      .catch(function () {
        storageOk = false;
      })
      .then(function () {
        writing = false;
        if (dirty) persist();
      });
  }

  function loadCache() {
    return call("storage.get", { key: KEY })
      .then(function (raw) {
        cache = C.normalizeCache(raw);
        /*
         * `version` 不认识 = 盘上那份是别的形状：当空缓存画。
         * 这里**不写盘** —— 启动这一段本来就不写，只有真拿到数据之后才 persist，
         * 所以上一版的缓存不会在"打开卡片"这一下被抹掉。
         */
        adoptCache();
        render();
      })
      .catch(function () {
        // 读失败 ≠ 没有数据：只把界面标成读不到，一个字节都不写
        storageOk = false;
        healthError = currentEntry() ? null : { kind: "denied", detail: [t("reading"), t("reading")] };
        render();
      });
  }

  /** 盘上那份回来之后：没有当前仓库就从缓存里挑最近查过的那个摆出来。 */
  function adoptCache() {
    if (currentKey) return;
    var keys = Object.keys(cache.repos);
    if (!keys.length) return;
    keys.sort(function (a, b) {
      return cache.repos[b].at - cache.repos[a].at;
    });
    currentKey = keys[0];
    var repo = cache.repos[currentKey].data.repo;
    if (!el.query.value) el.query.value = repo.full;
  }

  // ---------------------------------------------------------------------------
  // 配置与调度
  // ---------------------------------------------------------------------------

  function applyConfig(next) {
    var incoming = next || {};
    var hours = Number(incoming.refresh);
    config = {
      window: incoming.window === "daily" || incoming.window === "monthly" ? incoming.window : "weekly",
      refresh: isFinite(hours) && hours >= 1 && hours <= 12 ? Math.round(hours) : 3,
    };
    if (!winPicked) win = config.window;
    syncTicker();
    render();
  }

  function syncTicker() {
    var every = config.refresh * 3600 * 1000;
    if (tickId && tickEvery === every) return;
    var previous = tickId;
    tickId = 0;
    if (previous) call("schedule.clear", { id: previous }).catch(noop);
    call("schedule.every", { every: every })
      .then(function (grant) {
        if (!grant || !grant.id) return;
        tickId = grant.id;
        tickEvery = grant.every || every;
      })
      .catch(noop);
  }

  /** 小时级的一拍：只把**过期的**那件事重查一遍，不顺手调模型。 */
  function onTick() {
    var now = Date.now();
    if (tab === "health") {
      var entry = currentEntry();
      if (entry && !C.fresh(entry, C.REPO_TTL, now) && !healthBusy) {
        var ref = C.parseRepoRef(entry.data.repo.full);
        if (ref) fetchHealth(ref, { interpretFirst: false });
      }
      return;
    }
    var trending = cache.trending[win];
    if (!C.fresh(trending, C.TRENDING_TTL, now) && !trendBusy) refreshTrending();
  }

  // ---------------------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------------------

  function switchTab(next) {
    var target = next === "trending" ? "trending" : "health";
    if (tab === target) return;
    tab = target;
    render();
    if (tab === "trending") {
      var cached = cache.trending[win];
      if (!cached || !C.fresh(cached, C.TRENDING_TTL, Date.now())) refreshTrending();
    }
  }

  function switchWindow(next) {
    var name = next === "daily" || next === "monthly" ? next : "weekly";
    if (win === name) return;
    win = name;
    winPicked = true;
    var cached = cache.trending[name];
    render();
    if (!cached || !C.fresh(cached, C.TRENDING_TTL, Date.now())) refreshTrending();
  }

  function openUrl(url) {
    if (!url) return Promise.resolve();
    return call("shell.open", { url: url }, 8000).catch(function (error) {
      trendNotice =
        error && error.code === "permission_denied"
          ? [t("denied"), t("denied")]
          : [t("netFail"), t("netFail")];
      render();
    });
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  el.form.addEventListener("submit", function (event) {
    event.preventDefault();
    submitQuery();
  });

  el.tabHealth.addEventListener("click", function () {
    switchTab("health");
  });
  el.tabTrending.addEventListener("click", function () {
    switchTab("trending");
  });

  el.seg.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-window]");
    if (button) switchWindow(button.getAttribute("data-window"));
  });

  el.verdict.addEventListener("click", function () {
    var entry = currentEntry();
    if (!entry) return;
    if (healthError || C.judge({ repo: entry.data.repo, weeks: entry.data.weeks, now: Date.now() }).kind === "nodata") {
      var ref = C.parseRepoRef(entry.data.repo.full);
      if (ref) fetchHealth(ref, { interpretFirst: false });
    }
  });

  el.name.addEventListener("click", function () {
    openUrl(el.name.dataset.url);
  });

  el.explain.addEventListener("click", function () {
    interpret(true);
  });

  el.list.addEventListener("click", function (event) {
    var button = event.target.closest(".mo-row");
    if (button) openUrl(button.dataset.url);
  });

  el.openGithub.addEventListener("click", function () {
    openUrl(C.trendingUrl(tab === "trending" ? win : "weekly"));
  });

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
      if (data.payload && data.payload.id === tickId) onTick();
      return;
    }

    if (data.type === "store-changed") {
      if (writing) return;
      if (Date.now() - lastWriteAt < WRITE_ECHO_MS) return;
      var key = data.payload && data.payload.key;
      if (key && key !== KEY) return;
      loadCache();
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

  function applyTheme(payload) {
    if (!payload || typeof payload !== "object") return;
    var root = document.documentElement;
    Object.keys(payload).forEach(function (name) {
      if (typeof payload[name] === "string") root.style.setProperty(name, payload[name]);
    });
  }

  function applyLanguage(info) {
    if (!info || (info.lang !== "zh" && info.lang !== "en")) return;
    lang = info.lang;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    render();
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  // 第一帧：HTML 里那段空态已经画好了，这里只是把控件按默认值摆正（不变量 18）
  render();

  call("lang.get")
    .then(applyLanguage)
    .catch(noop)
    .then(function () {
      return call("config.get");
    })
    .then(function (next) {
      applyConfig(next);
    })
    .catch(noop)
    .then(function () {
      return call("llm.status");
    })
    .then(function (status) {
      llmReady = Boolean(status && status.configured);
      show(el.explain, llmReady);
    })
    .catch(function () {
      llmReady = false;
      show(el.explain, false);
    })
    .then(function () {
      return loadCache();
    })
    .then(function () {
      // 盘上那个仓库已经过了 24 小时：先把旧的画出来，再在后台重查一次
      var entry = currentEntry();
      if (!entry || healthBusy) return null;
      if (C.fresh(entry, C.REPO_TTL, Date.now())) return null;
      var ref = C.parseRepoRef(entry.data.repo.full);
      return ref ? fetchHealth(ref, { interpretFirst: false }) : null;
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    })
    .catch(noop);
})();
