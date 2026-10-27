/**
 * 长势（lattice.momentum）的纯逻辑。
 *
 * 两件事，各占一半：
 *
 * 1. **体检**：把 GitHub 的三个响应算成"这个项目最近还行不行"。52 周提交数
 *    能算出一条曲线，但结论只认三个数字（近 4 周、前 4 周、上次提交距今）。
 * 2. **榜单**：把 trending 页的 HTML 解析成条目。那份页面没有 API，改版就断，
 *    所以解析器只做"能认就认"，认不出来交空数组 —— 由界面去说"页面结构变了"。
 *
 * 这里是纯的：没有 DOM、没有桥、没有计时器、没有 `Date.now()`（`now` 一律当参数
 * 传进来）。`tests/momentum.html` 直接加载这一份测真身，一条逻辑都不复制。
 *
 * # 三条判据最容易写错，都在这儿钉着
 *
 * **近 4 周要跳过最后一桶**：`participation.all` 的最后一项是**本周进行中**，
 * 拿它跟前三周比会系统性偏低（周一查一次能差出 30 个百分点）。
 *
 * **判定顺序不能换**：没数据 → 不下结论；archived → 已归档；刚建的空仓库 →
 * 说"还没有提交"；90 天没推且近 4 周为 0 → 停更；< 5 次 → 很安静；
 * 然后才看趋势。顺序换一下，最先命中的那条就会盖住后面更准确的那条。
 *
 * **发版日期要去重**：monorepo 一天能发五个包，不去重的话"每 0 天一个版本"。
 */
(function (global) {
  "use strict";

  /** 卡片里最多记这么多个仓库（再多就是拿组件存储当数据库用）。 */
  var MAX_REPOS = 20;
  /** 体检结果留一天。 */
  var REPO_TTL = 24 * 3600 * 1000;
  /** 榜单留一小时 —— 那页自己也是按"最近一天"排的。 */
  var TRENDING_TTL = 3600 * 1000;
  var CACHE_VERSION = 1;
  var DAY = 86400000;

  // 判定用的四个数。改它们之前先看 0025 §4 那张表 —— 这几个不是调参调出来的，
  // 是"3 次变 4 次不该叫加速"和"20k star 两年没提交"两侧逼出来的。
  var STALE_DAYS = 90;
  var NEW_DAYS = 30;
  var QUIET_COMMITS = 5;
  var FASTER = 0.2;
  var SLOWER = -0.3;

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  function num(value) {
    var n = typeof value === "number" ? value : Number(value);
    return isFinite(n) ? n : 0;
  }

  function ms(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    var t = Date.parse(value);
    return isFinite(t) ? t : null;
  }

  /** 某一天（UTC）的 `YYYY-MM-DD`。发版日期用它当去重键 —— 时区不该造出两个日期。 */
  function isoDay(t) {
    return new Date(t).toISOString().slice(0, 10);
  }

  function dayMs(day) {
    return Date.parse(day + "T00:00:00Z");
  }

  function daysBetween(from, to) {
    return Math.round((to - from) / DAY);
  }

  function sum(list) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += num(list[i]);
    return total;
  }

  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) {
      return a - b;
    });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function copy(target, extra) {
    Object.keys(extra).forEach(function (key) {
      target[key] = extra[key];
    });
    return target;
  }

  // ---------------------------------------------------------------------------
  // 仓库名
  // ---------------------------------------------------------------------------

  var SEGMENT = /^[A-Za-z0-9_.-]+$/;

  function makeRef(owner, name) {
    var repo = String(name || "").replace(/\.git$/i, "");
    if (!SEGMENT.test(owner || "") || !SEGMENT.test(repo) || !repo) return null;
    return { owner: owner, name: repo, full: owner + "/" + repo, key: (owner + "/" + repo).toLowerCase() };
  }

  /**
   * `tauri-apps/tauri`、`https://github.com/tauri-apps/tauri`、
   * `github.com/tauri-apps/tauri/tree/dev` 都认。
   *
   * 用户粘进来的十有八九是地址栏里那一整条，所以地址这条要认全：中间的
   * `www.`、结尾的 `.git`、`/tree/main` 那种尾巴都得剥掉。认不出来返回
   * `null`（界面自己去说"这是个 owner/repo 吗"），不要猜。
   */
  function parseRepoRef(input) {
    if (typeof input !== "string") return null;
    var text = input.trim();
    if (!text) return null;
    var url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s?#]+)\/([^\/\s?#]+)/i.exec(text);
    if (url) return makeRef(url[1], url[2]);
    var bare = /^([^\/\s?#]+)\/([^\/\s?#]+)$/.exec(text);
    if (bare) return makeRef(bare[1], bare[2]);
    return null;
  }

  // ---------------------------------------------------------------------------
  // 体检
  // ---------------------------------------------------------------------------

  /**
   * `/repos/{o}/{r}` → 卡片要的那几项。
   *
   * `pushed_at` / `created_at` 全折成毫秒数：下游每一次比较都要用，存字符串的话
   * 每个调用点都得自己 `Date.parse` 一遍，错一处就是"全显示成 1970 年"。
   */
  function normalizeRepo(json) {
    if (!json || typeof json !== "object" || typeof json.full_name !== "string") return null;
    return {
      full: json.full_name,
      description: typeof json.description === "string" ? json.description : "",
      language: typeof json.language === "string" ? json.language : "",
      stars: num(json.stargazers_count),
      forks: num(json.forks_count),
      issues: num(json.open_issues_count),
      archived: json.archived === true,
      pushedAt: ms(json.pushed_at),
      createdAt: ms(json.created_at),
      htmlUrl:
        typeof json.html_url === "string" && /^https:\/\//.test(json.html_url)
          ? json.html_url
          : "https://github.com/" + json.full_name,
    };
  }

  /** `/stats/participation` → 52 个数（旧→新）。认不出来给 `null`，不是空数组。 */
  function weeksOf(json) {
    if (!json || !Array.isArray(json.all) || !json.all.length) return null;
    var weeks = json.all.map(num);
    return weeks.length > 52 ? weeks.slice(-52) : weeks;
  }

  /**
   * 近 4 周 / 前 4 周 / 变化。
   *
   * `slice(-5, -1)` 就是"跳过最后那个进行中的桶"。这条是 0025 §3 里被推翻过一次的
   * 那个决定，改回 `slice(-4)` 会让每个项目看起来都在降温。
   */
  function compare(weeks) {
    if (!Array.isArray(weeks) || weeks.length < 5) {
      return { available: false, recent: null, previous: null, change: null };
    }
    var recent = sum(weeks.slice(-5, -1));
    var previous = weeks.length >= 9 ? sum(weeks.slice(-9, -5)) : null;
    return {
      available: true,
      recent: recent,
      previous: previous,
      change: previous == null ? null : (recent - previous) / Math.max(previous, 1),
    };
  }

  /**
   * 发版日期（`YYYY-MM-DD`，升序、**按日期去重**）。
   *
   * 草稿不算发版；`published_at` 缺了就退 `created_at`（有些早期 release 没填）。
   */
  function releaseDates(list) {
    if (!Array.isArray(list)) return [];
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      if (!item || typeof item !== "object" || item.draft === true) return;
      var at = ms(item.published_at);
      if (at == null) at = ms(item.created_at);
      if (at == null) return;
      var day = isoDay(at);
      if (seen[day]) return;
      seen[day] = true;
      out.push(day);
    });
    out.sort();
    return out;
  }

  /** 最新那一条 release（要 tag 名和日期，用于"最新 v2.9.1 · 3 天前"）。 */
  function latestRelease(list) {
    var best = null;
    if (!Array.isArray(list)) return null;
    list.forEach(function (item) {
      if (!item || typeof item !== "object" || item.draft === true) return;
      var at = ms(item.published_at);
      if (at == null) at = ms(item.created_at);
      if (at == null) return;
      if (!best || at > best.at) {
        best = { at: at, tag: String(item.tag_name || item.name || ""), day: isoDay(at) };
      }
    });
    return best;
  }

  /** 发版节奏：去重后的相邻间隔中位数（天）。少于两条 release 就是 `null`。 */
  function cadence(list) {
    var dates = releaseDates(list);
    var gaps = [];
    for (var i = 1; i < dates.length; i++) gaps.push(daysBetween(dayMs(dates[i - 1]), dayMs(dates[i])));
    var latest = latestRelease(list);
    return {
      count: dates.length,
      dates: dates,
      medianGapDays: median(gaps),
      latestTag: latest ? latest.tag : "",
      latestAt: latest ? latest.at : null,
    };
  }

  /**
   * 判定。顺序是这张表唯一重要的东西（0025 §4）：
   *
   *   没数据 → 已归档 → 刚建的空仓库 → 停更 → 很安静 → 加速 / 放缓 / 平稳
   *
   * 返回 `kind` 之外还带着算它用的那几个数，界面照着显示，不用再算一遍 ——
   * "顶上写停更、下面写近 4 周 12 次"这种自相矛盾，只能是两边各算了一次。
   */
  function judge(input) {
    var repo = input && input.repo;
    var now = input && isFinite(input.now) ? input.now : Date.now();
    if (!repo) return { kind: "nodata", reason: "none" };

    var weeks = input.weeks || null;
    var cmp = compare(weeks);
    var createdDays = repo.createdAt == null ? null : Math.floor((now - repo.createdAt) / DAY);
    var pushedDays = repo.pushedAt == null ? null : Math.floor((now - repo.pushedAt) / DAY);
    var total = weeks ? sum(weeks) : null;
    var base = {
      recent: cmp.recent,
      previous: cmp.previous,
      change: cmp.change,
      total: total,
      createdDays: createdDays,
      pushedDays: pushedDays,
    };

    if (repo.archived) return copy({ kind: "archived" }, base);

    // 元数据到了、曲线没到（202 重试也没好）：归档这件事还判得了，长势判不了。
    if (!cmp.available) return copy({ kind: "nodata", reason: "weeks" }, base);

    // 刚建的空仓库不是"停更"：它还没有过东西可停。30 天是"新"的边界。
    if (createdDays != null && createdDays <= NEW_DAYS && total === 0) {
      return copy({ kind: "fresh" }, base);
    }

    if (pushedDays != null && pushedDays > STALE_DAYS && cmp.recent === 0) {
      return copy({ kind: "stalled" }, base);
    }

    // 3 次变 4 次是 +33%，那是噪声。小于这个门槛一律叫"很安静"，不给趋势。
    if (cmp.recent < QUIET_COMMITS) return copy({ kind: "quiet" }, base);

    if (cmp.change != null && cmp.change >= FASTER) return copy({ kind: "faster" }, base);
    if (cmp.change != null && cmp.change <= SLOWER) return copy({ kind: "slower" }, base);
    return copy({ kind: "steady" }, base);
  }

  // ---------------------------------------------------------------------------
  // 榜单
  // ---------------------------------------------------------------------------

  var ARTICLE = '<article class="Box-row"';
  var H2 = /<h2 class="h3 lh-condensed">([\s\S]*?)<\/h2>/;
  var HREF = /href="\/([^"\/]+)\/([^"\/]+)"/;
  var TOTAL_STARS = /\/stargazers"[\s\S]*?<\/svg>[\s\S]*?([\d,]+)/;
  var GAINED = /([\d,]+)\s+stars?\s+(today|this week|this month)/;
  var LANGUAGE = /itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/;
  var DESCRIPTION = /class="col-9 color-fg-muted[^"]*"[^>]*>([\s\S]*?)<\/p>/;

  var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

  function fromCode(code) {
    if (!isFinite(code) || code <= 0 || code > 0x10ffff) return "";
    try {
      return String.fromCodePoint(code);
    } catch (error) {
      return "";
    }
  }

  /**
   * 反转义 HTML 实体。
   *
   * 顺序有讲究：先数字、最后具名。反过来的话 `&amp;#39;` 会先变成 `&#39;`、
   * 再被当成数字实体解成 `'` —— 一层实体变成了两层。
   */
  function unescapeEntities(text) {
    return String(text)
      .replace(/&#x([0-9a-fA-F]+);/g, function (all, hex) {
        return fromCode(parseInt(hex, 16));
      })
      .replace(/&#(\d+);/g, function (all, dec) {
        return fromCode(parseInt(dec, 10));
      })
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, function (all, name) {
        return ENTITIES[name];
      });
  }

  /** 剥标签 + 反转义 + 压空白。描述里既有 `<em>` 也有 `&#39;`，两步都得做。 */
  function plainText(raw) {
    return unescapeEntities(String(raw).replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function count(text) {
    var digits = String(text || "").replace(/[^\d]/g, "");
    return digits ? parseInt(digits, 10) : 0;
  }

  function parseBlock(block) {
    var heading = H2.exec(block);
    if (!heading) return null;
    var href = HREF.exec(heading[1]);
    if (!href) return null;
    var ref = makeRef(href[1], href[2]);
    if (!ref) return null;

    var stars = TOTAL_STARS.exec(block);
    var gained = GAINED.exec(block);
    var language = LANGUAGE.exec(block);
    var description = DESCRIPTION.exec(block);

    return {
      owner: ref.owner,
      name: ref.name,
      full: ref.full,
      key: ref.key,
      url: "https://github.com/" + ref.full,
      stars: stars ? count(stars[1]) : null,
      // 增量是这份页面唯一给得了、"官方 API 永远给不了"的那个数（0025 §3）。
      gained: gained ? count(gained[1]) : null,
      gainedSpan: gained ? gained[2] : "",
      language: language ? plainText(language[1]) : "",
      description: description ? plainText(description[1]) : "",
    };
  }

  /**
   * trending 页 → 条目。
   *
   * 切块用 `split('<article class="Box-row"')` 而不是全局正则：正则要跨块匹配
   * `</article>`，被截断的最后一块（月度页 700 KB，贴着 1 MB 上限）就全丢了；
   * 切块之后最后那一块只是"少几个字段"，前面的照常留下。
   *
   * `truncated` 是桥给的（超 1 MB 被截），不是这里判的 —— 但界面要同时用两个信息：
   * 被截了、并且最后一条明显不完整，这时说"不完整"比说"解析失败"准确。
   */
  function parseTrending(html, truncated) {
    var result = { items: [], truncated: truncated === true, blocks: 0 };
    if (typeof html !== "string" || html.indexOf(ARTICLE) === -1) return result;
    var parts = html.split(ARTICLE);
    parts.shift();
    result.blocks = parts.length;
    for (var i = 0; i < parts.length; i++) {
      var item = parseBlock(parts[i]);
      if (item) result.items.push(item);
    }
    return result;
  }

  function trendingUrl(win) {
    var since = win === "daily" || win === "monthly" ? win : "weekly";
    return "https://github.com/trending?since=" + since;
  }

  // ---------------------------------------------------------------------------
  // 缓存
  // ---------------------------------------------------------------------------

  function emptyCache() {
    return { version: CACHE_VERSION, repos: {}, trending: {} };
  }

  function normalizeNote(note) {
    if (!note || typeof note !== "object") return null;
    if (typeof note.text !== "string" || !note.text.trim()) return null;
    var at = num(note.at);
    if (!at) return null;
    return { text: note.text.trim().slice(0, 400), at: at };
  }

  /**
   * 盘上那份缓存 → 能用的形状。
   *
   * 三条容错，都是"宁可当空缓存，也不要把坏数据画上卡片"：
   * `version` 不认识（将来改了形状）当空的、坏的条目逐条丢、仓库超出 20 个就留最近的。
   * **不认识的版本要当空缓存但不落盘** —— 落盘会把上一版的缓存当场抹掉，用户下次
   * 升级回来就只剩一次冷启动。
   */
  function normalizeCache(raw) {
    var empty = emptyCache();
    if (!raw || typeof raw !== "object" || num(raw.version) !== CACHE_VERSION) return empty;

    var repos = {};
    var source = raw.repos && typeof raw.repos === "object" ? raw.repos : {};
    Object.keys(source).forEach(function (key) {
      var entry = source[key];
      if (!entry || typeof entry !== "object") return;
      var data = entry.data && typeof entry.data === "object" ? entry.data : null;
      if (!data || !data.repo || typeof data.repo.full !== "string") return;
      var at = num(entry.at);
      if (!at) return;
      repos[key] = { at: at, data: data, note: normalizeNote(entry.note) };
    });

    var keys = Object.keys(repos).sort(function (a, b) {
      return repos[b].at - repos[a].at;
    });
    var kept = {};
    keys.slice(0, MAX_REPOS).forEach(function (key) {
      kept[key] = repos[key];
    });

    var trending = {};
    var rawTrending = raw.trending && typeof raw.trending === "object" ? raw.trending : {};
    ["daily", "weekly", "monthly"].forEach(function (win) {
      var entry = rawTrending[win];
      if (!entry || !Array.isArray(entry.items)) return;
      var at = num(entry.at);
      if (!at) return;
      var items = entry.items.filter(function (item) {
        return item && typeof item.full === "string" && typeof item.key === "string";
      });
      if (!items.length) return;
      trending[win] = { at: at, items: items.slice(0, 60), truncated: entry.truncated === true };
    });

    return { version: CACHE_VERSION, repos: kept, trending: trending };
  }

  function fresh(entry, ttl, now) {
    if (!entry || !isFinite(entry.at)) return false;
    return num(now) - entry.at < ttl;
  }

  function ageMs(entry, now) {
    if (!entry || !isFinite(entry.at)) return null;
    return Math.max(0, num(now) - entry.at);
  }

  global.__latticeMomentumCore = {
    MAX_REPOS: MAX_REPOS,
    REPO_TTL: REPO_TTL,
    TRENDING_TTL: TRENDING_TTL,
    CACHE_VERSION: CACHE_VERSION,
    STALE_DAYS: STALE_DAYS,
    NEW_DAYS: NEW_DAYS,
    QUIET_COMMITS: QUIET_COMMITS,
    FASTER: FASTER,
    SLOWER: SLOWER,
    parseRepoRef: parseRepoRef,
    normalizeRepo: normalizeRepo,
    weeksOf: weeksOf,
    compare: compare,
    releaseDates: releaseDates,
    latestRelease: latestRelease,
    cadence: cadence,
    judge: judge,
    unescapeEntities: unescapeEntities,
    plainText: plainText,
    parseTrending: parseTrending,
    trendingUrl: trendingUrl,
    emptyCache: emptyCache,
    normalizeCache: normalizeCache,
    fresh: fresh,
    ageMs: ageMs,
  };
})(window);
