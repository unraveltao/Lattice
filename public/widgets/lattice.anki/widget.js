/**
 * 背单词组件（lattice.anki）
 *
 * 三块：一张词表、一个排程器、一个"现在该背哪张"的队列。
 *
 * # 为什么排程要单独写成纯函数
 *
 * 间隔重复最容易写错的地方不是界面，是"按一下之后这张卡什么时候回来"。
 * 那个数算错了没人会报错 —— 用户只会觉得"怎么老是这几张"或"怎么一个月
 * 都不出现"，而这两种感受都不会被任何断言抓到。所以 `schedule()` / `pickDue()`
 * / `parseDeck()` 都写成不碰 DOM 的纯函数，并在文件末尾挂到 `window` 上给
 * `tests/anki.html` 对答案 —— 和 `lattice.convert` 挂换算表是同一个理由。
 *
 * # 为什么状态是 `state` 而不是"间隔等于 0 就算新卡"
 *
 * 新卡和学习中的卡间隔都是 0 天，但它们的下一次间隔完全不同（新卡按
 * 1/4 天起步，学习中的卡只是几分钟后再来一遍）。用间隔推断状态，会在
 * "重来"之后把一张卡变回"新卡"——于是 `newPerDay` 又把它数一遍，队列
 * 里开始出现已经背过的词。所以状态单独存一份，两个字段各管一件事。
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 桥
  // ---------------------------------------------------------------------------

  var seq = 0;
  var pending = new Map();

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __lattice: 1, type: "request", id: id, method: method, params: params }, "*");
      // 没有宿主时这条会一直挂着；3 秒后放弃，界面照常能用
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
   * 界面语言。两件事都要做：启动时 `lang.get` 问一次，用户中途换语言再收
   * 推送 —— 只读一次，换语言卡片不动；只听推送，热重载之后就停在旧语言。
   * 首帧按 HTML 里写死的中文画。
   */
  var lang = "zh";

  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("背单词", "Word Drill");
    paintStatic();
    render();
  }

  // ---------------------------------------------------------------------------
  // 纯逻辑：排程
  // ---------------------------------------------------------------------------

  var MINUTE = 60 * 1000;
  var DAY = 24 * 60 * MINUTE;
  var EASE_START = 2.5;
  var EASE_MIN = 1.3;
  var EASE_MAX = 3.0;
  var MAX_IVL_DAYS = 3650;

  var GRADES = ["again", "hard", "good", "easy"];

  /** 难度系数是给"间隔 × ease"用的乘数，夹在 1.3–3.0：太低会把卡压成死循环，太高会把卡推到几年后 */
  function clampEase(value) {
    var eased = Number.isFinite(value) ? value : EASE_START;
    return Math.min(EASE_MAX, Math.max(EASE_MIN, Math.round(eased * 100) / 100));
  }

  function clampInterval(days) {
    var value = Number.isFinite(days) ? Math.round(days) : 0;
    if (value < 0) return 0;
    return Math.min(value, MAX_IVL_DAYS);
  }

  /**
   * 按一次档位，算出这张卡下一次什么时候出现。
   *
   * 返回**新对象**，不改入参 —— 断言"按了之后原卡没变"才有意义，界面那边
   * 也能拿旧对象对比出"到底变了几个字段"。
   */
  function schedule(card, grade, now) {
    var next = {
      id: card.id,
      word: card.word,
      ipa: card.ipa || "",
      tag: card.tag || "",
      meaning: card.meaning,
      example: card.example || "",
      state: card.state === "review" || card.state === "learning" ? card.state : "new",
      ivl: clampInterval(card.ivl),
      ease: clampEase(card.ease),
      reps: (card.reps || 0) + 1,
      lapses: card.lapses || 0,
      due: Number.isFinite(card.due) ? card.due : 0,
    };

    var learning = next.state !== "review" || next.ivl < 1;

    if (grade === "again") {
      next.lapses += 1;
      next.ease = clampEase(next.ease - 0.2);
      if (learning) {
        // 还没上岸：几分钟后再来一遍，别把它算进明天的队列
        next.state = "learning";
        next.ivl = 0;
        next.due = now + MINUTE;
      } else {
        // 遗忘了：间隔缩回 1 天，但今天还会再撞一次 —— 当天补一遍比"等明天"有用
        next.state = "review";
        next.ivl = 1;
        next.due = now + 10 * MINUTE;
      }
    } else if (grade === "hard") {
      next.ease = clampEase(next.ease - 0.15);
      if (learning) {
        next.state = "learning";
        next.ivl = 0;
        next.due = now + 6 * MINUTE;
      } else {
        next.state = "review";
        next.ivl = clampInterval(Math.max(next.ivl + 1, next.ivl * 1.2));
        next.due = now + next.ivl * DAY;
      }
    } else if (grade === "good") {
      if (learning) {
        next.state = "review";
        next.ivl = 1;
      } else {
        next.state = "review";
        next.ivl = clampInterval(Math.max(next.ivl + 1, next.ivl * next.ease));
      }
      next.due = now + next.ivl * DAY;
    } else {
      next.ease = clampEase(next.ease + 0.15);
      next.state = "review";
      next.ivl = clampInterval(learning ? 4 : Math.max(next.ivl + 2, next.ivl * next.ease * 1.3));
      next.due = now + next.ivl * DAY;
    }

    next.ivl = clampInterval(next.ivl);
    return next;
  }

  /**
   * 现在该背哪几张。
   *
   * 顺序是"到期的旧卡先、新卡后"：旧卡是已经花过时间的投资，先还；
   * 新卡有每天的上限，不设上限的话，一份 5000 词的词表第一天就会把
   * 队列塞死。
   */
  function pickDue(cards, now, newLimit, tagFilter) {
    var pool = (cards || []).filter(function (card) {
      return !tagFilter || card.tag === tagFilter;
    });
    var reviews = pool
      .filter(function (card) {
        return card.state !== "new" && card.due <= now;
      })
      .sort(function (a, b) {
        return a.due - b.due;
      });
    var limit = Math.max(0, Math.round(Number(newLimit) || 0));
    var news = pool
      .filter(function (card) {
        return card.state === "new";
      })
      .slice(0, limit);
    return reviews.concat(news);
  }

  /** 下一次间隔给人看的写法；传的是毫秒差，不是天数 */
  function formatInterval(ms, which) {
    var minutes = Math.max(1, Math.round(ms / MINUTE));
    if (minutes < 60) return minutes + (which === "en" ? " min" : " 分钟");
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (which === "en" ? " h" : " 小时");
    var days = Math.round(ms / DAY);
    if (days < 30) return days + (which === "en" ? " d" : " 天");
    var months = Math.round(days / 30);
    if (months < 12) return months + (which === "en" ? " mo" : " 个月");
    return Math.round(months / 12) + (which === "en" ? " y" : " 年");
  }

  /** 本机日期，用来判断"今天"过了没有。用本地时区，跨时区的人看到的是自己的今天 */
  function dayKey(date) {
    var at = date instanceof Date ? date : new Date();
    var month = at.getMonth() + 1;
    var day = at.getDate();
    return at.getFullYear() + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day;
  }

  function newCard(word, ipa, tag, meaning, example) {
    return {
      id: String(word).toLowerCase(),
      word: String(word),
      ipa: ipa || "",
      tag: tag || "",
      meaning: String(meaning),
      example: example || "",
      state: "new",
      ivl: 0,
      ease: EASE_START,
      reps: 0,
      lapses: 0,
      due: 0,
    };
  }

  /**
   * 词表文本 → 卡片数组。
   *
   * 分隔符认竖线和 Tab，列数决定怎么认：
   *   2 列  单词 | 释义
   *   3 列  单词 | 第二列 | 释义 —— 第二列像音标（`/…/` 包着）就当音标，
   *         否则当词性/标签。"apple | n. | 苹果" 和 "apple | /ˈæpl/ | 苹果"
   *         两种写法都很自然会有人写，靠列数分不开，只能看形状。
   *   4 列  单词 | 音标 | 词性 | 释义
   *   5 列+ 单词 | 音标 | 词性 | 释义 | 例句（第 5 列之后都算例句 —— 例句里
   *         本来就可能带竖线，"A | B" 那种引文）
   *
   * 认不出来的行**逐行丢掉并记账**：贴一份带表头的词表是最常见的手滑，
   * 因为一行表头就把整份词表拒掉，用户只会看到"什么都没发生"。
   */
  function parseDeck(text) {
    var cards = [];
    var seen = Object.create(null);
    var skipped = 0;
    var duplicates = 0;

    String(text == null ? "" : text)
      .split(/\r?\n/)
      .forEach(function (line) {
        var raw = line.trim();
        if (!raw || raw.charAt(0) === "#") return;
        var parts = raw.split(/\s*[|\t]\s*/);
        var word = (parts[0] || "").trim();
        var ipa = "";
        var tag = "";
        var meaning = (parts[1] || "").trim();
        var example = "";

        if (parts.length === 3) {
          var second = (parts[1] || "").trim();
          meaning = (parts[2] || "").trim();
          if (/^\/.*\/$/.test(second)) ipa = second;
          else tag = second;
        } else if (parts.length >= 4) {
          ipa = (parts[1] || "").trim();
          tag = (parts[2] || "").trim();
          meaning = (parts[3] || "").trim();
          example = parts.slice(4).join(" | ").trim();
        }

        // 两个必备列缺一个就不算一张卡；"单词按三列写"的常见错法（缺释义）也走这条
        if (!word || !meaning) {
          skipped += 1;
          return;
        }
        var id = word.toLowerCase();
        if (seen[id]) {
          duplicates += 1;
          return;
        }
        seen[id] = true;
        cards.push(newCard(word, ipa, tag, meaning, example));
      });

    return { cards: cards, skipped: skipped, duplicates: duplicates };
  }

  /** 卡片数组 → 词表文本（编辑器打开时用，往返必须稳定） */
  function formatDeck(cards) {
    return (cards || [])
      .map(function (card) {
        return [card.word, card.ipa || "", card.tag || "", card.meaning, card.example || ""].join(" | ");
      })
      .join("\n");
  }

  /**
   * 重新贴词表时保住进度。
   *
   * 排程状态跟着**单词**走，不跟着行号走：改一下释义、补一条例句，不该
   * 让这张卡退回"没背过"。反过来，**从词表里删掉一行就是删掉那张卡** ——
   * 留着它会让"我删了怎么还在"变成一个查不出来的 bug。
   */
  function mergeDeck(existing, incoming) {
    var byId = Object.create(null);
    (existing || []).forEach(function (card) {
      if (card && card.id) byId[card.id] = card;
    });

    return (incoming || []).map(function (card) {
      var old = byId[card.id];
      if (!old) return card;
      return {
        id: card.id,
        word: card.word,
        ipa: card.ipa,
        tag: card.tag,
        meaning: card.meaning,
        example: card.example,
        state: old.state,
        ivl: old.ivl,
        ease: old.ease,
        reps: old.reps,
        lapses: old.lapses,
        due: old.due,
      };
    });
  }

  /** 盘上的数据可能是老版本、手改过、别的组件写的 —— 认不出来的一律降级，不整份丢 */
  function normalizeCard(raw) {
    if (!raw || typeof raw !== "object") return null;
    var word = typeof raw.word === "string" ? raw.word.trim() : "";
    var meaning = typeof raw.meaning === "string" ? raw.meaning.trim() : "";
    if (!word || !meaning) return null;

    var state = "new";
    if (raw.state === "review" || raw.state === "learning") state = raw.state;
    var ivl = clampInterval(raw.ivl);
    if (state === "review" && ivl < 1) ivl = 1;
    if (state !== "review") ivl = 0;

    return {
      id: String(word).toLowerCase(),
      word: word,
      ipa: typeof raw.ipa === "string" ? raw.ipa.trim() : "",
      tag: typeof raw.tag === "string" ? raw.tag.trim() : "",
      meaning: meaning,
      example: typeof raw.example === "string" ? raw.example.trim() : "",
      state: state,
      ivl: ivl,
      ease: clampEase(raw.ease),
      reps: Number.isFinite(raw.reps) && raw.reps > 0 ? Math.round(raw.reps) : 0,
      lapses: Number.isFinite(raw.lapses) && raw.lapses > 0 ? Math.round(raw.lapses) : 0,
      // due 只认合理的时间戳；坏值当成"现在就该背"，而不是"永远不出现"
      due: Number.isFinite(raw.due) && raw.due > 0 ? raw.due : 0,
    };
  }

  function emptyDeck() {
    return { v: 1, day: dayKey(), newDone: 0, reviewed: 0, cards: [] };
  }

  function normalizeDeck(raw) {
    var deck = emptyDeck();
    if (!raw || typeof raw !== "object") return deck;
    if (Array.isArray(raw.cards)) {
      var seen = Object.create(null);
      raw.cards.forEach(function (entry) {
        var card = normalizeCard(entry);
        if (!card || seen[card.id]) return;
        seen[card.id] = true;
        deck.cards.push(card);
      });
    }
    if (typeof raw.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)) deck.day = raw.day;
    deck.newDone = Number.isFinite(raw.newDone) && raw.newDone > 0 ? Math.round(raw.newDone) : 0;
    deck.reviewed = Number.isFinite(raw.reviewed) && raw.reviewed > 0 ? Math.round(raw.reviewed) : 0;
    return deck;
  }

  /** 跨过午夜就把今天的额度还回去。放在每次读写之前，省一个定时器 */
  function rollDay(deck, now) {
    var today = dayKey(now);
    if (deck.day === today) return false;
    deck.day = today;
    deck.newDone = 0;
    deck.reviewed = 0;
    return true;
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  var metaEl = document.getElementById("meta");
  var tagsEl = document.getElementById("tags");
  var cardEl = document.getElementById("card");
  var emptyEl = document.getElementById("empty");
  var emptyTitleEl = document.getElementById("empty-title");
  var emptyTextEl = document.getElementById("empty-text");
  var faceEl = document.getElementById("face");
  var tagEl = document.getElementById("tag");
  var wordEl = document.getElementById("word");
  var ipaEl = document.getElementById("ipa");
  var meaningEl = document.getElementById("meaning");
  var exampleEl = document.getElementById("example");
  var doneEl = document.getElementById("done");
  var doneTitleEl = document.getElementById("done-title");
  var doneTextEl = document.getElementById("done-text");
  var revealEl = document.getElementById("reveal");
  var pasteEl = document.getElementById("paste");
  var gradesEl = document.getElementById("grades");
  var gradeEls = Array.prototype.slice.call(document.querySelectorAll(".anki-grade"));
  var editEl = document.getElementById("edit");
  var editorEl = document.getElementById("editor");
  var textareaEl = document.getElementById("textarea");
  var hintEl = document.getElementById("hint");
  var sampleEl = document.getElementById("sample");
  var cancelEl = document.getElementById("cancel");
  var saveEl = document.getElementById("save");

  var GRADE_LABEL = {
    again: { zh: "重来", en: "Again" },
    hard: { zh: "困难", en: "Hard" },
    good: { zh: "记得", en: "Good" },
    easy: { zh: "容易", en: "Easy" },
  };

  var SAMPLE = [
    "abandon | /əˈbændən/ | v. | 放弃；抛弃 | He abandoned his car in the snow.",
    "abundant | /əˈbʌndənt/ | adj. | 充足的；大量的 | The region has abundant rainfall.",
    "diligent | /ˈdɪlɪdʒənt/ | adj. | 勤勉的 | She is a diligent student.",
  ].join("\n");

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  var STORAGE_KEY = "deck";

  var deck = emptyDeck();
  var config = { direction: "w2m", newPerDay: 10, showIpa: true, showExample: true };
  var view = { phase: "empty", card: null, revealed: false, tag: "" };

  /*
   * 三个刹车，对付"自己写自己读"的回声：
   *   touched       本地已经改过数据 → 迟到的读盘结果不许盖掉它
   *   writing       自己的写入还在飞 → 这时候读到的可能是旧文件
   *   pendingReload 在飞期间收到的 store-changed，落地后补一次
   */
  var touched = false;
  var writing = 0;
  var pendingReload = false;
  var saveError = "";

  function newLimit() {
    var perDay = Number(config.newPerDay);
    if (!Number.isFinite(perDay)) return 10;
    return Math.max(0, Math.min(100, Math.round(perDay)));
  }

  function quota() {
    return Math.max(0, newLimit() - deck.newDone);
  }

  function queue() {
    return pickDue(deck.cards, Date.now(), quota(), view.tag);
  }

  /** 从当前队列里挑一张当"手里这张"。都不该背了就进入 done / empty */
  function takeNext() {
    rollDay(deck, new Date());
    if (deck.cards.length === 0) {
      view.phase = "empty";
      view.card = null;
      view.revealed = false;
      return;
    }
    var next = queue();
    if (next.length === 0) {
      view.phase = "done";
      view.card = null;
      view.revealed = false;
      return;
    }
    view.phase = "ask";
    view.card = next[0];
    view.revealed = false;
  }

  function findCard(id) {
    for (var index = 0; index < deck.cards.length; index += 1) {
      if (deck.cards[index].id === id) return index;
    }
    return -1;
  }

  function gradeCurrent(grade) {
    if (!view.card || GRADES.indexOf(grade) < 0) return;
    var index = findCard(view.card.id);
    if (index < 0) return;

    var before = deck.cards[index];
    var wasNew = before.state === "new";
    deck.cards[index] = schedule(before, grade, Date.now());
    if (wasNew) deck.newDone += 1;
    deck.reviewed += 1;

    touched = true;
    takeNext();
    render();
    commit();
  }

  // ---------------------------------------------------------------------------
  // 落盘
  // ---------------------------------------------------------------------------

  function commit() {
    writing += 1;
    call("storage.set", { key: STORAGE_KEY, value: deck })
      .then(function () {
        saveError = "";
      })
      .catch(function (error) {
        // 存不下去不等于这一轮白背：数据在内存里继续用，等下次能写再存
        saveError = (error && error.message) || "write failed";
      })
      .then(function () {
        writing -= 1;
        paintMeta();
        if (pendingReload && writing === 0) {
          pendingReload = false;
          reload();
        }
      });
  }

  /**
   * 重读磁盘上的词表。
   *
   * 这里的闸门只管**写入在飞**和**编辑器开着**两件事，不看 `touched` ——
   * `touched` 只用来挡第一趟读盘（见启动那段）。每次都拿 touched 挡住的后果
   * 是"用户按过一下之后，两个窗口就再也不同步了"：画布上的实例换了张卡，
   * 桌面上那张还在背旧词，而且不会报错。
   */
  function reload() {
    if (writing > 0 || view.phase === "editor") {
      pendingReload = true;
      return;
    }
    call("storage.get", { key: STORAGE_KEY })
      .then(function (raw) {
        deck = normalizeDeck(raw);
        rollDay(deck, new Date());
        takeNext();
        render();
      })
      .catch(function () {
        // 读失败 ≠ 没有数据：什么也不做，绝不用默认值盖回去
      });
  }

  // ---------------------------------------------------------------------------
  // 绘制
  // ---------------------------------------------------------------------------

  function paintStatic() {
    revealEl.textContent = say("显示答案", "Show answer");
    pasteEl.textContent = say("粘贴词表", "Paste a deck");
    editEl.title = say("词表", "Deck");
    editEl.setAttribute("aria-label", say("词表", "Deck"));
    emptyTitleEl.textContent = say("还没有词表", "No deck yet");
    emptyTextEl.textContent = say("一行一张卡：单词 | 释义", "One card per line: word | meaning");
    doneTitleEl.textContent = say("今天这一批做完了", "Nothing left for today");
    gradeEls.forEach(function (button) {
      var label = button.querySelector(".anki-grade-label");
      var grade = button.dataset.grade;
      if (label && GRADE_LABEL[grade]) label.textContent = GRADE_LABEL[grade][lang];
    });
    // 词表的写法两种语言共用：列顺序和分隔符是格式，不是文案
    textareaEl.placeholder = "apple | /ˈæpl/ | n. | 苹果 | An apple a day.";
    sampleEl.textContent = say("示例", "Example");
    cancelEl.textContent = say("取消", "Cancel");
    saveEl.textContent = say("保存", "Save");
  }

  var importNote = "";

  function paintMeta() {
    if (saveError) {
      metaEl.textContent = say("未保存", "Not saved");
      metaEl.title = saveError;
      metaEl.classList.add("is-warn");
      return;
    }
    metaEl.classList.remove("is-warn");
    // 「跳过 2 行」这种一次性的账没地方常驻，挂在计数的 title 上 —— 它比一闪而过的 toast 好查
    if (importNote) metaEl.title = importNote;
    else metaEl.removeAttribute("title");
    if (view.phase === "empty") {
      metaEl.textContent = "";
      return;
    }
    var left = view.phase === "done" ? 0 : queue().length;
    metaEl.textContent = say("剩 " + left + " · 今天 " + deck.reviewed, left + " left · " + deck.reviewed + " today");
  }

  /** 正面：按朝向显示；翻面之后两边都显示 */
  function frontSide(card) {
    if (config.direction === "m2w") return "m2w";
    if (config.direction === "mix") return (card.reps || 0) % 2 === 0 ? "w2m" : "m2w";
    return "w2m";
  }

  function setText(el, text) {
    el.textContent = text;
    el.hidden = !text;
  }

  function paintCard() {
    var card = view.card;
    if (!card) {
      faceEl.hidden = true;
      return;
    }
    faceEl.hidden = false;

    var side = frontSide(card);
    var showWord = view.revealed || side === "w2m";
    var showMeaning = view.revealed || side === "m2w";
    var showIpa = Boolean(config.showIpa) && Boolean(card.ipa);
    var showExample = Boolean(config.showExample) && Boolean(card.example);

    setText(wordEl, showWord ? card.word : "");
    setText(meaningEl, showMeaning ? card.meaning : "");
    setText(ipaEl, showWord && showIpa ? card.ipa : "");
    setText(exampleEl, view.revealed && showExample ? card.example : "");
    setText(tagEl, card.tag || "");
    // 例句那一行会被省略号截断，只有真截断了才挂 title —— 小卡片上原生提示框很扎眼
    exampleEl.title = view.revealed && showExample && exampleEl.scrollWidth > exampleEl.clientWidth ? card.example : "";
  }

  function paintTags() {
    var seen = Object.create(null);
    var tags = [];
    deck.cards.forEach(function (card) {
      if (!card.tag || seen[card.tag]) return;
      seen[card.tag] = true;
      tags.push(card.tag);
    });

    // 只有一种标签时筛选没有意义，画出来只是多一行噪音
    if (tags.length < 2) {
      tagsEl.hidden = true;
      tagsEl.textContent = "";
      return;
    }

    tagsEl.hidden = false;
    tagsEl.textContent = "";
    var all = [""].concat(tags);
    all.forEach(function (tag) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "anki-chip";
      chip.dataset.tag = tag;
      chip.textContent = tag || say("全部", "All");
      chip.classList.toggle("is-active", view.tag === tag);
      tagsEl.appendChild(chip);
    });
  }

  function paintGradeHints() {
    var card = view.card;
    var now = Date.now();
    gradeEls.forEach(function (button) {
      var grade = button.dataset.grade;
      var when = button.querySelector(".anki-grade-when");
      if (!when) return;
      if (!card) {
        when.textContent = "";
        return;
      }
      var next = schedule(card, grade, now);
      when.textContent = formatInterval(next.due - now, lang);
    });
  }

  function render() {
    paintStatic();
    paintTags();

    emptyEl.hidden = view.phase !== "empty";
    faceEl.hidden = view.phase !== "ask" && view.phase !== "answer";
    doneEl.hidden = view.phase !== "done";
    pasteEl.hidden = view.phase !== "empty";
    revealEl.hidden = view.phase !== "ask";
    gradesEl.hidden = view.phase !== "answer";

    if (view.phase === "done") {
      var waiting = deck.cards
        .filter(function (card) {
          return card.state !== "new";
        })
        .sort(function (a, b) {
          return a.due - b.due;
        })[0];
      if (waiting) {
        doneTextEl.textContent = say(
          "下一张 " + formatInterval(Math.max(0, waiting.due - Date.now()), "zh") + "后再来",
          "Next card in " + formatInterval(Math.max(0, waiting.due - Date.now()), "en"),
        );
        doneTextEl.hidden = false;
      } else if (deck.cards.length > 0) {
        doneTextEl.textContent = say(
          "今天的额度用完了，明天再来",
          "Daily quota used up — come back tomorrow",
        );
        doneTextEl.hidden = false;
      }
    }

    paintCard();
    paintGradeHints();
    paintMeta();
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  function reveal() {
    if (view.phase !== "ask") return;
    view.phase = "answer";
    view.revealed = true;
    render();
  }

  cardEl.addEventListener("click", function (event) {
    // 编辑器是卡片外面的一层，不在这里
    if (event.target && event.target.closest && event.target.closest(".anki-btn")) return;
    reveal();
  });

  revealEl.addEventListener("click", function (event) {
    event.stopPropagation();
    reveal();
  });

  gradesEl.addEventListener("click", function (event) {
    var button = event.target.closest(".anki-grade");
    if (!button) return;
    gradeCurrent(button.dataset.grade);
  });

  tagsEl.addEventListener("click", function (event) {
    var chip = event.target.closest(".anki-chip");
    if (!chip) return;
    view.tag = chip.dataset.tag || "";
    takeNext();
    render();
  });

  document.addEventListener("keydown", function (event) {
    if (!editorEl.hidden) {
      if (event.key === "Escape") closeEditor();
      return;
    }
    // 焦点在文本框里时不抢键（属性面板不会把焦点给我们，但输入法会）
    if (event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;

    if (event.key === " " || event.key === "Spacebar") {
      if (view.phase === "ask") {
        event.preventDefault();
        reveal();
      }
      return;
    }
    var index = "1234".indexOf(event.key);
    if (index >= 0 && view.phase === "answer") {
      event.preventDefault();
      gradeCurrent(GRADES[index]);
    }
  });

  // ---------- 词表编辑器 ----------

  function openEditor() {
    textareaEl.value = formatDeck(deck.cards);
    hintEl.textContent = "";
    editorEl.hidden = false;
    view.phase = "editor";
    textareaEl.focus();
    textareaEl.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
  }

  function closeEditor() {
    editorEl.hidden = true;
    textareaEl.value = "";
    takeNext();
    render();
    // 编辑期间收到的 store-changed 被压住了，这里补一次
    if (pendingReload) {
      pendingReload = false;
      reload();
    }
  }

  function applyDeckText(text) {
    var parsed = parseDeck(text);
    if (parsed.cards.length === 0) {
      hintEl.textContent = say("一行都没认出来", "Nothing recognised");
      return false;
    }
    var merged = mergeDeck(deck.cards, parsed.cards);
    deck.cards = merged;
    touched = true;
    editorEl.hidden = true;
    textareaEl.value = "";
    takeNext();
    render();
    commit();

    var extra = [];
    if (parsed.skipped) extra.push(say("跳过 " + parsed.skipped + " 行", parsed.skipped + " skipped"));
    if (parsed.duplicates) extra.push(say(parsed.duplicates + " 行重复", parsed.duplicates + " duplicates"));
    importNote = extra.join(" · ");
    paintMeta();
    return true;
  }

  pasteEl.addEventListener("click", function (event) {
    event.stopPropagation();
    openEditor();
  });

  editEl.addEventListener("click", function (event) {
    event.stopPropagation();
    if (view.phase === "editor") closeEditor();
    else openEditor();
  });

  saveEl.addEventListener("click", function () {
    applyDeckText(textareaEl.value);
  });

  cancelEl.addEventListener("click", function () {
    closeEditor();
  });

  sampleEl.addEventListener("click", function () {
    var existing = textareaEl.value.trim();
    textareaEl.value = existing ? existing + "\n" + SAMPLE : SAMPLE;
    textareaEl.focus();
    hintEl.textContent = say("照着改，保存就生效", "Edit it, then save");
  });

  // ---------------------------------------------------------------------------
  // 自检入口（tests/anki.html 用；没有宿主时界面靠这些才驱动得动）
  // ---------------------------------------------------------------------------

  window.__latticeAnki = {
    // 纯逻辑
    schedule: schedule,
    pickDue: pickDue,
    parseDeck: parseDeck,
    mergeDeck: mergeDeck,
    formatDeck: formatDeck,
    normalizeDeck: normalizeDeck,
    formatInterval: formatInterval,
    dayKey: dayKey,
    newCard: newCard,
    GRADES: GRADES.slice(),
    MINUTE: MINUTE,
    DAY: DAY,
    EASE_MIN: EASE_MIN,
    EASE_MAX: EASE_MAX,
    MAX_IVL_DAYS: MAX_IVL_DAYS,

    snapshot: function () {
      return {
        phase: view.phase,
        word: view.card ? view.card.word : "",
        tag: view.tag,
        left: view.phase === "done" ? 0 : queue().length,
        meta: metaEl.textContent,
        revealLabel: revealEl.textContent,
        gradeLabels: gradeEls.map(function (button) {
          return button.querySelector(".anki-grade-label").textContent;
        }),
        gradeHints: gradeEls.map(function (button) {
          return button.querySelector(".anki-grade-when").textContent;
        }),
        lang: lang,
        cards: deck.cards.length,
        newDone: deck.newDone,
        reviewed: deck.reviewed,
        saveError: saveError,
      };
    },

    /** 直接换成一份词表（等同"贴词表 + 保存"，但不经过宿主） */
    seed: function (text) {
      var parsed = parseDeck(String(text == null ? "" : text));
      deck.cards = mergeDeck(deck.cards, parsed.cards);
      touched = true;
      takeNext();
      render();
      return parsed;
    },
  };

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  // 先画第一帧：默认值是空词表，这一步不依赖任何一次桥往返（不变量 18）
  render();

  call("lang.get")
    .then(applyLanguage)
    .catch(function () {
      /* 拿不到就按中文画 */
    });

  call("config.get")
    .then(function (values) {
      applyConfig(values);
    })
    .catch(function () {
      /* 拿不到就用出厂值 */
    });

  call("storage.get", { key: STORAGE_KEY })
    .then(function (raw) {
      if (touched) return;
      deck = normalizeDeck(raw);
      rollDay(deck, new Date());
      takeNext();
      render();
    })
    .catch(function () {
      /* 读失败 ≠ 没有数据：保持内存里这份，别用默认值盖回去 */
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });

  function applyConfig(values) {
    if (!values || typeof values !== "object") return;
    config = {
      direction: values.direction === "m2w" || values.direction === "mix" ? values.direction : "w2m",
      newPerDay: Number.isFinite(values.newPerDay) ? values.newPerDay : 10,
      showIpa: values.showIpa !== false,
      showExample: values.showExample !== false,
    };
    takeNext();
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
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (!key || key === STORAGE_KEY) reload();
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
})();
