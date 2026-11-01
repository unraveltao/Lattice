/**
 * Todoist 组件（lattice.todoist）的纯逻辑。
 *
 * 这里是纯的：没有 DOM、没有桥、没有 `Date.now()`（`now` / `today` 一律当参数
 * 传进来），`tests/todoist.html` 直接加载这一份测真身，一条逻辑都不复制。
 *
 * # 四件事，每件都有一个"写错了不会报错、只会静静说错话"的地方
 *
 * **优先级是反的**。Todoist 的 `priority` 是 1..4，**4 最高**（p1 红、p4 无）。
 * 照着字面读会把最要紧的那条画成空心圈，而界面上一片"都没设优先级"看起来
 * 完全正常。
 *
 * **列表响应有两种形状**。v1 的列表接口回 `{ results, next_cursor }`，老 v2 回
 * 裸数组。只认一种的话，另一种会被当成"不是任务列表"，而用户看到的是一张
 * 空卡片 —— 和"今天真的没任务"一模一样。
 *
 * **响应会被截断**。桥那边响应上限 1MB，超了直接切（`truncated: true`）。切点
 * 多半落在 JSON 中间，`JSON.parse` 抛错 —— 报"返回的不是任务列表"就把人引到
 * 了错的方向（接口没变，是返回太大）。
 *
 * **状态码不是布尔**。`ok` 只说明 2xx；401 / 429 / 3xx 各有各的话要说，混成
 * 一句"请求失败"等于让人去查网络。
 */
(function (global) {
  "use strict";

  var CACHE_VERSION = 1;

  /** 卡片里最多画这么多行 —— 再多滚起来就不是"扫一眼"了。 */
  var MAX_ROWS = 40;
  /** 缓存留这么多条：存储是组件自己的 JSON 文件，不是数据库。 */
  var MAX_CACHE = 120;
  /** 一条正文最多留这么多字。任务描述可以几千字，卡片只有一行。 */
  var MAX_TEXT = 160;
  /** 最多跟两跳 cursor。第 3 页之后剩下的用 "+" 说明，不假装是全部。 */
  var MAX_PAGES = 3;
  /** 心跳间隔。和 `schedule.every` 用同一个数。 */
  var TTL = 10 * 60 * 1000;

  var API = "https://api.todoist.com/api/v1";
  var MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** 本地草稿本最多留这么多条 —— 它是草稿，不是第二份待办清单。 */
  var MAX_LOCAL = 100;

  function clip(value, limit) {
    var text = typeof value === "string" ? value : "";
    return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  }

  /** 换行和连续空白压成一个空格：行高固定 26px，多一行就把布局撑歪 */
  function collapse(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  /**
   * 换成一个卡片认识的优先级：high / med / low / null。
   *
   * 收两种输入，因为两个调用方给的东西不一样：
   *   - **API** 给的是数字 4..1（4 最高），所以 4 → high、3 → med、2 → low、
   *     **1 → 没设**。照着字面读会把最要紧的那条画成空心圈。
   *   - **缓存** 里存的已经是 `"high"` 这样的字符串（`normalizeTask` 的产物），
   *     再过一遍 `Number()` 会变成 NaN，整份缓存的圆点会全部退化成空心圈。
   *
   * 认不出来（undefined、脏值、未来多出来的一档）也当没设 —— 和 todo 的
   * `readPriority` 同一个写法：认不出就画空心圈，不抛、不猜。
   */
  function priorityKey(value) {
    if (value === "high" || value === "med" || value === "low") return value;
    var n = typeof value === "number" ? value : Number(value);
    if (n === 4) return "high";
    if (n === 3) return "med";
    if (n === 2) return "low";
    return null;
  }

  /**
   * 只留 `YYYY-MM-DD`。
   *
   * Todoist 的 `due.date` 有时带时间（`2026-10-30T09:00:00`），有时只是一个
   * 日期。卡片只关心"哪天到期"，所以一律切前 10 位 —— 留着时间会让同一天
   * 的两条比较出大小，而它们其实是同一天。
   *
   * 也收裸字符串：缓存里存的是归一化之后的 `"2026-10-30"`，不是 `{date}`。
   *
   * `due.string`（"Today" / "10月30日"）**不用**：它是服务端按账号语言给的，
   * 界面语言是另一回事，直接拿会出现中文界面里写着 "Today"。
   */
  function dueOf(value) {
    var date = typeof value === "string" ? value.slice(0, 10) : "";
    if (!date && value && typeof value === "object") {
      date = typeof value.date === "string" ? value.date.slice(0, 10) : "";
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  }

  function normalizeTask(raw) {
    if (!raw || typeof raw !== "object") return null;
    // API 给 `content`，缓存里叫 `text`（同一件事在两个形状里的两个名字）。
    // 分成两个函数的话，缓存那条路迟早会漏掉一处校验
    var source = typeof raw.content === "string" ? raw.content : raw.text;
    var text = clip(collapse(source), MAX_TEXT);
    // 空标题的任务在 Todoist 里不合法，但一份"读坏了"的响应里会出现。
    // 画一行空白等于让人以为列表错位了
    if (!text) return null;
    return {
      id: raw.id === undefined || raw.id === null ? "" : String(raw.id),
      text: text,
      priority: priorityKey(raw.priority),
      due: dueOf(raw.due),
    };
  }

  function normalizeTasks(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var task = normalizeTask(list[i]);
      if (task) out.push(task);
      if (out.length >= MAX_CACHE) break;
    }
    return out;
  }

  /**
   * 一页响应 → 任务 + 下一跳的 cursor。
   *
   * `shape` 只用来区分"认出来了"和"没认出来"：`array` / `page` 都是认出来了
   * （`page` 只是多了分页），`bad` 才是真没认出来 —— 界面上那句话不一样。
   */
  function parsePage(body) {
    var empty = { tasks: [], nextCursor: null, shape: "bad" };
    if (typeof body !== "string" || !body) return empty;
    var parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return empty;
    }
    if (Array.isArray(parsed)) {
      return { tasks: normalizeTasks(parsed), nextCursor: null, shape: "array" };
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.results)) {
      var cursor = typeof parsed.next_cursor === "string" && parsed.next_cursor ? parsed.next_cursor : null;
      return { tasks: normalizeTasks(parsed.results), nextCursor: cursor, shape: "page" };
    }
    return empty;
  }

  function tasksUrl(cursor) {
    return cursor ? API + "/tasks?cursor=" + encodeURIComponent(cursor) : API + "/tasks";
  }

  /** `Retry-After` 是秒数，夹到 1..600 —— 服务端给个 86400 也不该让文案这么写 */
  function retryAfterOf(headers) {
    if (!headers || typeof headers !== "object") return 0;
    var raw = headers["retry-after"];
    var n = typeof raw === "number" ? raw : Number(raw);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(600, Math.max(1, Math.round(n)));
  }

  /**
   * 一次响应该怎么说。
   *
   * 顺序有讲究：**先看状态码，再看 truncated**。被截断的 200 是"返回太大"，
   * 但被截断的 401 仍然是"token 不对" —— 反过来判的话，一个错误的 token
   * 会得到一句"返回太大，看不懂"。
   */
  function classify(response) {
    if (!response || typeof response !== "object") return { kind: "offline", status: 0 };
    var status = typeof response.status === "number" ? response.status : 0;
    if (status === 401) return { kind: "token", status: status };
    if (status === 403) return { kind: "forbidden", status: status };
    if (status === 404) return { kind: "notfound", status: status };
    if (status === 429) return { kind: "limit", status: status, retryAfter: retryAfterOf(response.headers) };
    if (status >= 500) return { kind: "server", status: status };
    // 桥不跟随重定向（network.rs 关了自动跳转），3xx 是原样回来的。
    // 当成成功会拿一段空 body 去 JSON.parse
    if (status >= 300 && status < 400) return { kind: "redirect", status: status };
    if (status < 200 || status >= 300) return { kind: "bad", status: status };
    if (response.truncated) return { kind: "truncated", status: status };
    return { kind: "ok", status: status };
  }

  /**
   * 桥调用被拒时该怎么说。
   *
   * 桥的失败只有 `code` 可靠；`message` 是给人看的一句话（Rust 侧拼的），
   * 只能当线索用 —— 所以这里挑的是"最不可能认错"的两个词，其余一律归到
   * 离线。宁可让一个罕见的错说成"连不上"，也不要让"没装桌面应用"说成
   * "检查你的网络"（后者会让人真的去查网络）。
   */
  function classifyError(error) {
    var code = error && error.code ? String(error.code) : "";
    var message = error && error.message ? String(error.message) : "";
    if (code === "permission_denied") return { kind: "permission", status: 0 };
    if (/desktop app/i.test(message)) return { kind: "nodesktop", status: 0 };
    if (code === "unknown_method" || code === "bad_params") return { kind: "bad", status: 0 };
    return { kind: "offline", status: 0 };
  }

  /** 本地日期的 `YYYY-MM-DD`。过期是"本地意义上的今天"，不是 UTC */
  function todayOf(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
  }

  /** 本地时间的 `HH:MM`，给"上次同步"用 */
  function clockOf(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m);
  }

  /** ISO 日期串直接比大小就是对的（定长、高位在前），不用 Date */
  function isOverdue(due, today) {
    return typeof due === "string" && typeof today === "string" && due < today;
  }

  function dueLabel(due, lang) {
    if (typeof due !== "string" || due.length < 10) return "";
    var month = Number(due.slice(5, 7));
    var day = Number(due.slice(8, 10));
    if (!month || !day) return "";
    return lang === "en" ? MONTHS_EN[month - 1] + " " + day : month + "月" + day + "日";
  }

  /**
   * 磁盘上那份缓存。
   *
   * 认不出来就当没有缓存 —— 缓存是加速不是真相，读坏的后果应该是照常走
   * 网络，不是界面上冒一堆怪行。版本号对不上也一样（格式变过就整份作废，
   * 迁移一份"只是缓存"的东西不值得）。
   */
  function normalizeCache(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.v !== CACHE_VERSION) return null;
    if (typeof raw.at !== "number" || !isFinite(raw.at) || raw.at <= 0) return null;
    return { v: CACHE_VERSION, at: raw.at, tasks: normalizeTasks(Array.isArray(raw.tasks) ? raw.tasks : []) };
  }

  function cacheFresh(cache, now) {
    return Boolean(cache && typeof cache.at === "number" && now - cache.at < TTL);
  }

  /*
   * ---------- 本地草稿本 ----------
   *
   * 没有 Todoist 账号的人也要能用（0043 §3）。它是**草稿**，不是第二份待办：
   * 只有 `text` / `done`，没有档位、没有优先级、没有拖拽顺序 —— 那些是
   * `lattice.todo` 的事。字段少一个，两边的数据就永远不会互相冒充。
   *
   * 三个操作都返回**新数组**而不是就地改：就地改的话，调用方要先 clone 才能
   * 判断"内容真的变了没"，而判断那一步正是 store-changed 回声的来源。
   */

  function normalizeLocalItems(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!raw || typeof raw !== "object") continue;
      var text = clip(collapse(raw.text), MAX_TEXT);
      // 空条目在列表里就是一行空白 —— 画出来等于让人以为列表错位了
      if (!text) continue;
      out.push({
        id: raw.id === undefined || raw.id === null ? "" : String(raw.id),
        text: text,
        // 只认 `true`：脏值（"1"、1、"true"）一律当没做完，不猜
        done: raw.done === true,
      });
      if (out.length >= MAX_LOCAL) break;
    }
    return out;
  }

  /** 新的落在最上面：和 lattice.todo 一样，刚记的那条要立刻看见 */
  function addLocal(list, item) {
    var next = Array.isArray(list) ? list.slice() : [];
    if (!item || typeof item.text !== "string") return next;
    var text = clip(collapse(item.text), MAX_TEXT);
    if (!text || next.length >= MAX_LOCAL) return next;
    next.unshift({
      id: item.id === undefined || item.id === null ? "" : String(item.id),
      text: text,
      done: false,
    });
    return next;
  }

  function toggleLocal(list, id) {
    var next = Array.isArray(list) ? list.slice() : [];
    for (var i = 0; i < next.length; i++) {
      if (next[i].id !== id) continue;
      // 勾掉**不删**，只是翻一个布尔 —— 误点还有一次后悔的机会（0043 §3）
      next[i] = { id: next[i].id, text: next[i].text, done: !next[i].done };
      break;
    }
    return next;
  }

  function removeLocal(list, id) {
    var next = Array.isArray(list) ? list : [];
    return next.filter(function (item) {
      return item.id !== id;
    });
  }

  global.__latticeTodoistCore = {
    CACHE_VERSION: CACHE_VERSION,
    MAX_ROWS: MAX_ROWS,
    MAX_CACHE: MAX_CACHE,
    MAX_TEXT: MAX_TEXT,
    MAX_PAGES: MAX_PAGES,
    TTL: TTL,
    MAX_LOCAL: MAX_LOCAL,
    API: API,
    clip: clip,
    collapse: collapse,
    priorityKey: priorityKey,
    dueOf: dueOf,
    normalizeTask: normalizeTask,
    normalizeTasks: normalizeTasks,
    parsePage: parsePage,
    tasksUrl: tasksUrl,
    retryAfterOf: retryAfterOf,
    classify: classify,
    classifyError: classifyError,
    todayOf: todayOf,
    clockOf: clockOf,
    isOverdue: isOverdue,
    dueLabel: dueLabel,
    normalizeCache: normalizeCache,
    cacheFresh: cacheFresh,
    normalizeLocalItems: normalizeLocalItems,
    addLocal: addLocal,
    toggleLocal: toggleLocal,
    removeLocal: removeLocal,
  };
})(window);
