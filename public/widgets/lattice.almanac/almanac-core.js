/**
 * 农历 / 节气 / 节日的纯逻辑。
 *
 * # 三样东西三个来源
 *
 * - **农历**（月名、日、闰月、干支、生肖）：浏览器内置的 ICU 中国历法
 *   （`Intl.DateTimeFormat` + `-u-ca-chinese`）。Chromium 从 2015 年起就带着它，
 *   Windows WebView2 也一样。自己抄一张 1900–2100 的农历表要 200 多行、还得
 *   校对闰月，而 ICU 已经在系统里了 —— 这里用它是"少一条要维护的数据"，
 *   不是"引了一个库"：零依赖、零网络、离线可用。
 * - **二十四节气**：太阳黄经到了每 15° 就是一个节气，所以这里算的是天文学
 *   （低精度太阳位置公式 + 牛顿迭代），不是查表。好处是任意年份都能算、
 *   也不会因为表抄错而在某一年差一天。误差约 0.01°（≈ 15 分钟），定日期
 *   足够；两个节气贴午夜的那一年会看到"差一天"，说明写在 help 里。
 * - **节日**：七个法定节日的日期规则，农历那三个用 ICU 反查（扫一小段窗口），
 *   公历那几个直接构造，清明直接用算出来的节气时刻。
 *
 * # 一律用"本地日期"
 *
 * 用户问的是"我这一天"，所以每个函数吃的都是本地时间的 Date，日期差也按
 * 本地午夜算。天文学上节气以北京时间（UTC+8）定义，机器不在东八区时，
 * 贴着午夜的那个节气可能和国内看到的差一天 —— 那正是"按你的时钟"该有的
 * 样子，不为了对齐北京时间把它挪走。
 */
(function () {
  "use strict";

  var DAY_MS = 86400000;
  var RAD = Math.PI / 180;

  // ---------- 本地日期小工具 ----------

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  /** 两个本地日期之间差几天（按午夜算，夏令时也不会差出 0.96 天） */
  function dayDiff(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
  }

  function dateKey(date) {
    var month = date.getMonth() + 1;
    var day = date.getDate();
    return date.getFullYear() + "-" + (month < 10 ? "0" + month : month) + "-" + (day < 10 ? "0" + day : day);
  }

  // ---------- 太阳黄经 ----------

  /**
   * 视太阳黄经（度，0..360）。低精度公式（Meeus 的那套简化式），
   * 误差 ≈ 0.01° —— 折算成时间约 15 分钟，比"差一天"小两个数量级。
   */
  function sunLongitude(epochMs) {
    var jd = epochMs / DAY_MS + 2440587.5;
    var n = jd - 2451545.0;
    var mean = 280.46 + 0.9856474 * n;
    var anomaly = (357.528 + 0.9856003 * n) * RAD;
    var lambda = mean + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly);
    var value = lambda % 360;
    return value < 0 ? value + 360 : value;
  }

  // ---------- 二十四节气 ----------

  /* 日历顺序（小寒 → 冬至）。month / day 只是牛顿迭代的起点，不是结论。 */
  var TERMS = [
    { deg: 285, zh: "小寒", en: "Minor Cold", month: 1, day: 5 },
    { deg: 300, zh: "大寒", en: "Major Cold", month: 1, day: 20 },
    { deg: 315, zh: "立春", en: "Start of Spring", month: 2, day: 4 },
    { deg: 330, zh: "雨水", en: "Rain Water", month: 2, day: 19 },
    { deg: 345, zh: "惊蛰", en: "Awakening of Insects", month: 3, day: 5 },
    { deg: 0, zh: "春分", en: "Spring Equinox", month: 3, day: 20 },
    { deg: 15, zh: "清明", en: "Clear and Bright", month: 4, day: 4 },
    { deg: 30, zh: "谷雨", en: "Grain Rain", month: 4, day: 20 },
    { deg: 45, zh: "立夏", en: "Start of Summer", month: 5, day: 5 },
    { deg: 60, zh: "小满", en: "Grain Full", month: 5, day: 21 },
    { deg: 75, zh: "芒种", en: "Grain in Ear", month: 6, day: 5 },
    { deg: 90, zh: "夏至", en: "Summer Solstice", month: 6, day: 21 },
    { deg: 105, zh: "小暑", en: "Minor Heat", month: 7, day: 7 },
    { deg: 120, zh: "大暑", en: "Major Heat", month: 7, day: 22 },
    { deg: 135, zh: "立秋", en: "Start of Autumn", month: 8, day: 7 },
    { deg: 150, zh: "处暑", en: "End of Heat", month: 8, day: 23 },
    { deg: 165, zh: "白露", en: "White Dew", month: 9, day: 7 },
    { deg: 180, zh: "秋分", en: "Autumn Equinox", month: 9, day: 23 },
    { deg: 195, zh: "寒露", en: "Cold Dew", month: 10, day: 8 },
    { deg: 210, zh: "霜降", en: "Frost's Descent", month: 10, day: 23 },
    { deg: 225, zh: "立冬", en: "Start of Winter", month: 11, day: 7 },
    { deg: 240, zh: "小雪", en: "Minor Snow", month: 11, day: 22 },
    { deg: 255, zh: "大雪", en: "Major Snow", month: 12, day: 7 },
    { deg: 270, zh: "冬至", en: "Winter Solstice", month: 12, day: 21 },
  ];

  /**
   * 某个节气在某一年的时刻。
   *
   * 从"往年大约哪天"起步，用黄经误差直接修正时间：太阳每天走 0.9856°，
   * 差几度就挪几天，四到六轮就收敛到分钟级。跨 0°/360° 时把差角折回
   * (-180, 180]，否则春分那一次会往反方向跑一整年。
   */
  function termTime(year, index) {
    var term = TERMS[index];
    var ms = Date.UTC(year, term.month - 1, term.day, 12);
    for (var step = 0; step < 8; step += 1) {
      var delta = term.deg - sunLongitude(ms);
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      ms += (delta * DAY_MS) / 0.9856474;
      if (Math.abs(delta) < 1e-6) break;
    }
    return ms;
  }

  var termCache = {};

  /** 一年的 24 个节气（按日期升序），带各自的时刻与本地日期 */
  function termsOfYear(year) {
    if (termCache[year]) return termCache[year];
    var list = TERMS.map(function (term, index) {
      var ms = termTime(year, index);
      return {
        index: index,
        deg: term.deg,
        zh: term.zh,
        en: term.en,
        ms: ms,
        date: new Date(ms),
      };
    }).sort(function (a, b) {
      return a.ms - b.ms;
    });
    termCache[year] = list;
    return list;
  }

  /** 今天（含）之后的下一个节气；今天正好是节气时返回今天那个 */
  function nextTerm(now) {
    var year = now.getFullYear();
    var list = termsOfYear(year).concat(termsOfYear(year + 1));
    for (var i = 0; i < list.length; i += 1) {
      if (dayDiff(now, list[i].date) >= 0) return list[i];
    }
    return list[0];
  }

  /** 这一天是不是节气（只比本地年月日） */
  function termOnDay(now) {
    var list = termsOfYear(now.getFullYear());
    for (var i = 0; i < list.length; i += 1) {
      if (dayDiff(now, list[i].date) === 0) return list[i];
    }
    return null;
  }

  // ---------- 农历 ----------

  /*
   * ICU 的中国历法表。`formatToParts` 直接给出干支年名（yearName，如「丙午」）、
   * 月名（「正月」/「闰六月」/「腊月」）和日号，闰月就在月名前多一个字 ——
   * 不用自己判断哪一年闰哪个月。
   *
   * 拿不到（极端裁剪过的运行时）就整块降级：卡片只画公历和节气，不画农历。
   */
  var lunarFormat = null;
  try {
    lunarFormat = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch (error) {
    lunarFormat = null;
  }

  var MONTH_NUMBERS = {
    正月: 1,
    二月: 2,
    三月: 3,
    四月: 4,
    五月: 5,
    六月: 6,
    七月: 7,
    八月: 8,
    九月: 9,
    十月: 10,
    十一月: 11,
    十二月: 12,
    冬月: 11,
    腊月: 12,
  };

  var MONTH_PINYIN = {
    1: "Zhengyue",
    2: "Eryue",
    3: "Sanyue",
    4: "Siyue",
    5: "Wuyue",
    6: "Liuyue",
    7: "Qiyue",
    8: "Bayue",
    9: "Jiuyue",
    10: "Shiyue",
    11: "Shiyiyue",
    12: "Layue",
  };

  /* 初一到三十。写死一张表是因为 1..30 的中文写法不规律（廿一、三十），
     拼不出来。 */
  var DAY_NAMES = [
    "初一",
    "初二",
    "初三",
    "初四",
    "初五",
    "初六",
    "初七",
    "初八",
    "初九",
    "初十",
    "十一",
    "十二",
    "十三",
    "十四",
    "十五",
    "十六",
    "十七",
    "十八",
    "十九",
    "二十",
    "廿一",
    "廿二",
    "廿三",
    "廿四",
    "廿五",
    "廿六",
    "廿七",
    "廿八",
    "廿九",
    "三十",
  ];

  var STEM_PINYIN = {
    甲: "Jia",
    乙: "Yi",
    丙: "Bing",
    丁: "Ding",
    戊: "Wu",
    己: "Ji",
    庚: "Geng",
    辛: "Xin",
    壬: "Ren",
    癸: "Gui",
  };

  var BRANCH_PINYIN = {
    子: "zi",
    丑: "chou",
    寅: "yin",
    卯: "mao",
    辰: "chen",
    巳: "si",
    午: "wu",
    未: "wei",
    申: "shen",
    酉: "you",
    戌: "xu",
    亥: "hai",
  };

  var ZODIAC = {
    子: { zh: "鼠", en: "Rat" },
    丑: { zh: "牛", en: "Ox" },
    寅: { zh: "虎", en: "Tiger" },
    卯: { zh: "兔", en: "Rabbit" },
    辰: { zh: "龙", en: "Dragon" },
    巳: { zh: "蛇", en: "Snake" },
    午: { zh: "马", en: "Horse" },
    未: { zh: "羊", en: "Goat" },
    申: { zh: "猴", en: "Monkey" },
    酉: { zh: "鸡", en: "Rooster" },
    戌: { zh: "狗", en: "Dog" },
    亥: { zh: "猪", en: "Pig" },
  };

  var lunarCache = {};

  /** 某个本地日期的农历：{ year, yearName, month, monthNumber, leap, day, ... } */
  function lunarOf(date) {
    if (!lunarFormat) return null;
    var key = dateKey(date);
    if (lunarCache[key] !== undefined) return lunarCache[key];

    var parts = lunarFormat.formatToParts(date);
    var yearName = "";
    var month = "";
    var day = 0;
    var year = 0;
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (part.type === "yearName") yearName = part.value;
      else if (part.type === "month") month = part.value;
      else if (part.type === "day") day = Number(part.value);
      else if (part.type === "relatedYear") year = Number(part.value);
    }

    var leap = month.charAt(0) === "闰";
    var bare = leap ? month.slice(1) : month;
    var number = MONTH_NUMBERS[bare] || 0;
    var branch = yearName.charAt(1) || "";
    var stem = yearName.charAt(0) || "";
    var zodiac = ZODIAC[branch] || { zh: "", en: "" };

    var info = {
      year: year,
      yearName: yearName,
      month: month,
      monthNumber: number,
      leap: leap,
      day: day,
      dayName: DAY_NAMES[day - 1] || "",
      stem: stem,
      branch: branch,
      zodiac: zodiac,
      /* 「丙午马年」/ 英文「Bingwu year · Horse」 */
      label: month + (DAY_NAMES[day - 1] || day),
      gzPinyin: (STEM_PINYIN[stem] || "") + (BRANCH_PINYIN[branch] || ""),
    };
    lunarCache[key] = info;
    return info;
  }

  /** 英文写法：「Zhengyue 1」/「Leap Liuyue 1」（闰月带 Leap 前缀） */
  function lunarLabelEn(lunar) {
    if (!lunar) return "";
    return (lunar.leap ? "Leap " : "") + (MONTH_PINYIN[lunar.monthNumber] || "") + " " + lunar.day;
  }

  /** 反查：农历某月某日落在公历哪一天（只扫那一小段窗口，找不到就 null） */
  function findLunarDate(year, month, day) {
    var windows = {
      "1-1": [1, 15, 3, 10], // 春节：1/21 – 2/20 之间
      "5-5": [5, 15, 7, 10], // 端午：5/28 – 6/25 之间
      "8-15": [8, 25, 10, 20], // 中秋：9/8 – 10/8 之间
    };
    var window = windows[month + "-" + day];
    if (!window) return null;
    var start = new Date(year, window[0] - 1, window[1]);
    var end = new Date(year, window[2] - 1, window[3]);
    for (var cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + DAY_MS)) {
      var info = lunarOf(cursor);
      if (info && !info.leap && info.monthNumber === month && info.day === day) return startOfDay(cursor);
    }
    return null;
  }

  // ---------- 节日 ----------

  /*
   * 七个法定节日。农历那三个用反查，清明用算出来的节气时刻（它的公历日期
   * 每年在 4/4 – 4/6 之间晃），其余三个是固定公历日期。
   */
  var FESTIVALS = [
    { id: "new-year", zh: "元旦", en: "New Year's Day", solar: [1, 1] },
    { id: "spring", zh: "春节", en: "Spring Festival", lunar: [1, 1] },
    { id: "qingming", zh: "清明", en: "Qingming", term: "清明" },
    { id: "labour", zh: "劳动节", en: "Labour Day", solar: [5, 1] },
    { id: "dragon-boat", zh: "端午", en: "Dragon Boat Festival", lunar: [5, 5] },
    { id: "mid-autumn", zh: "中秋", en: "Mid-Autumn Festival", lunar: [8, 15] },
    { id: "national", zh: "国庆", en: "National Day", solar: [10, 1] },
  ];

  var festivalCache = {};

  /** 某一年的七个节日，按日期升序（算不出来的那条直接跳过） */
  function festivalsOfYear(year) {
    if (festivalCache[year]) return festivalCache[year];
    var list = [];
    FESTIVALS.forEach(function (entry) {
      var date = null;
      if (entry.solar) {
        date = new Date(year, entry.solar[0] - 1, entry.solar[1]);
      } else if (entry.lunar) {
        date = findLunarDate(year, entry.lunar[0], entry.lunar[1]);
      } else if (entry.term) {
        var terms = termsOfYear(year);
        for (var i = 0; i < terms.length; i += 1) {
          if (terms[i].zh === entry.term) date = startOfDay(terms[i].date);
        }
      }
      if (!date) return;
      list.push({ id: entry.id, zh: entry.zh, en: entry.en, date: date });
    });
    list.sort(function (a, b) {
      return a.date - b.date;
    });
    festivalCache[year] = list;
    return list;
  }

  /** 今天（含）之后的下一个节日 */
  function nextFestival(now) {
    var year = now.getFullYear();
    var list = festivalsOfYear(year).concat(festivalsOfYear(year + 1));
    for (var i = 0; i < list.length; i += 1) {
      if (dayDiff(now, list[i].date) >= 0) return list[i];
    }
    return list[0];
  }

  // ---------- 卡片模型 ----------

  var WEEKDAYS = [
    { zh: "周日", en: "Sun" },
    { zh: "周一", en: "Mon" },
    { zh: "周二", en: "Tue" },
    { zh: "周三", en: "Wed" },
    { zh: "周四", en: "Thu" },
    { zh: "周五", en: "Fri" },
    { zh: "周六", en: "Sat" },
  ];

  /**
   * 一张卡片要画的全部东西，一次算完。
   *
   * 组件那一侧只做排版 —— 日期差、下一个节气、下一个节日都在这里定死，
   * 断言页因此不用碰 DOM 就能验"今天是哪天、还差几天"。
   */
  function cardModel(now) {
    var lunar = lunarOf(now);
    var term = nextTerm(now);
    var festival = nextFestival(now);
    var todayTerm = termOnDay(now);
    var termDays = dayDiff(now, term.date);
    var festivalDays = dayDiff(now, festival.date);

    return {
      key: dateKey(now),
      gregorian: {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        weekday: now.getDay(),
        weekdayZh: WEEKDAYS[now.getDay()].zh,
        weekdayEn: WEEKDAYS[now.getDay()].en,
      },
      lunar: lunar,
      term: {
        zh: term.zh,
        en: term.en,
        date: term.date,
        days: termDays,
        today: termDays === 0,
        /* 今天的节气就是它自己的话，上面那行该说「今天」而不是「还有 0 天」 */
        activeToday: !!todayTerm && todayTerm.zh === term.zh,
      },
      festival: {
        id: festival.id,
        zh: festival.zh,
        en: festival.en,
        date: festival.date,
        days: festivalDays,
        today: festivalDays === 0,
      },
    };
  }

  window.__latticeAlmanacCore = {
    TERMS: TERMS,
    FESTIVALS: FESTIVALS,
    WEEKDAYS: WEEKDAYS,
    DAY_NAMES: DAY_NAMES,
    sunLongitude: sunLongitude,
    termTime: termTime,
    termsOfYear: termsOfYear,
    nextTerm: nextTerm,
    termOnDay: termOnDay,
    lunarOf: lunarOf,
    lunarLabelEn: lunarLabelEn,
    findLunarDate: findLunarDate,
    festivalsOfYear: festivalsOfYear,
    nextFestival: nextFestival,
    cardModel: cardModel,
    dayDiff: dayDiff,
    startOfDay: startOfDay,
    hasLunar: !!lunarFormat,
  };
})();
