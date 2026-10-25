/**
 * 使用记录的纯函数：日键、强度分档、周年网格、连续天数。
 *
 * 为什么单独一层：热力图的每一格都能用"日期 + 分钟数"算出来，而算错了
 * 不会报错 —— 只会把某一天画到隔壁那一列。所以这一层不碰 DOM、不碰桥，
 * 由 `tests/usage.html` 逐条钉住。
 *
 * 时间一律按**本地日**：用户看到的"10 月 25 日"是这台电脑上的 25 号，
 * 不是 UTC 的。Rust 侧也用本地时间生成日键（`usage.rs` 的 `GetLocalTime`），
 * 两边必须一致 —— 一边本地一边 UTC，跨时区就会错一格。
 */

/** 一条记录：本地日 + 这一天有交互的分钟数 */
export interface UsageDay {
  date: string;
  minutes: number;
}

/** 读回来的使用记录。`days` 的键是 `YYYY-MM-DD` */
export interface UsageData {
  days: Record<string, number>;
  totalMinutes: number;
  /** 第一条记录的日期；一次都没记过就是 null */
  since: string | null;
}

/** 热力图只画最近 53 周 —— 一年，和 GitHub 的那张一样 */
export const HEAT_WEEKS = 53;

/** 保留多少天。和 Rust 的 `MAX_DAYS` 一致，多出来的旧数据在读取时裁掉 */
export const MAX_DAYS = 400;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 严格认 `YYYY-MM-DD`，并且这一天真的存在（2 月 30 日不算） */
export function isDayKey(value: string): boolean {
  const match = DAY_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  );
}

/** 日键 → 本地日期。不合法返回 null（别拿 `new Date("2026-10-25")`：那按 UTC 解析） */
export function fromDayKey(key: string): Date | null {
  if (!isDayKey(key)) return null;
  const date = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 本地日的 `YYYY-MM-DD`。不要用 `toISOString()` —— 那会切到 UTC */
export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 把 Rust 交回来的东西归一化。
 *
 * 两种形状都认：`{ days: { "2026-10-25": 42 } }`（新）和
 * `{ days: [{ date, minutes }] }`（早期快照）。坏键、负值、非整数一律丢 ——
 * 热力图是锦上添花，不该有让档案页打不开的权力。
 */
export function parseUsage(raw: unknown): UsageData {
  const empty: UsageData = { days: {}, totalMinutes: 0, since: null };
  if (!raw || typeof raw !== "object") return empty;

  const source = raw as { days?: unknown; since?: unknown };
  const days: Record<string, number> = {};

  const take = (date: unknown, minutes: unknown) => {
    if (typeof date !== "string" || !isDayKey(date)) return;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) return;
    days[date] = (days[date] ?? 0) + Math.min(minutes, 24 * 60);
  };

  if (Array.isArray(source.days)) {
    for (const item of source.days) {
      if (!item || typeof item !== "object") continue;
      const entry = item as { date?: unknown; minutes?: unknown };
      take(entry.date, entry.minutes);
    }
  } else if (source.days && typeof source.days === "object") {
    for (const [date, minutes] of Object.entries(source.days as Record<string, unknown>)) {
      take(date, minutes);
    }
  }

  // 只留最近的 MAX_DAYS 天：键是 ISO 日期，字典序就是时间序
  const keys = Object.keys(days).sort();
  while (keys.length > MAX_DAYS) {
    const drop = keys.shift();
    if (drop) delete days[drop];
  }

  const totalMinutes = Object.values(days).reduce((sum, minutes) => sum + minutes, 0);
  const since = typeof source.since === "string" && isDayKey(source.since) ? source.since : null;
  return {
    days,
    totalMinutes,
    since: since ?? keys[0] ?? null,
  };
}

/**
 * 一格的颜色档。阈值是**固定分钟数**，不是四分位 ——
 * 四分位会让同一张图在"用得少的一年"和"用得多的一年"里颜色含义不同。
 * 0 / <15 / <45 / <120 / ≥120 分钟。
 */
export function levelFor(minutes: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  if (minutes < 15) return 1;
  if (minutes < 45) return 2;
  if (minutes < 120) return 3;
  return 4;
}

export interface HeatCell {
  date: string;
  minutes: number;
  level: 0 | 1 | 2 | 3 | 4;
  /** 还没到的那几天：画成空格，不是"0 分钟" */
  future: boolean;
}

export interface HeatWeek {
  cells: HeatCell[];
  /**
   * 这一列里出现"某月 1 号"时记下那天，组件据此在列头写月份。
   * 第一列永远给一个（哪怕是半个月），否则图的最左边没有月份。
   */
  monthStart: string | null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** 这一周的周一（本地零点）。行是周一 → 周日，和中文习惯一致 */
export function startOfWeek(date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const shift = (day.getDay() + 6) % 7;
  return addDays(day, -shift);
}

/**
 * 生成 `weeks` 列 × 7 行的网格，最后一列是今天所在的这一周。
 * 未来的格子也保留（`future: true`），这样网格永远是完整的 53 列。
 */
export function buildHeatmap(
  days: Record<string, number>,
  today: Date,
  weeks = HEAT_WEEKS,
): HeatWeek[] {
  const end = startOfWeek(today);
  const first = addDays(end, -(weeks - 1) * 7);
  const todayKey = dayKey(today);
  const result: HeatWeek[] = [];

  for (let w = 0; w < weeks; w += 1) {
    const cells: HeatCell[] = [];
    let monthStart: string | null = w === 0 ? dayKey(first) : null;
    for (let d = 0; d < 7; d += 1) {
      const date = addDays(first, w * 7 + d);
      const key = dayKey(date);
      const future = key > todayKey;
      const minutes = future ? 0 : Math.max(0, days[key] ?? 0);
      if (date.getDate() === 1) monthStart = key;
      cells.push({ date: key, minutes, level: levelFor(minutes), future });
    }
    result.push({ cells, monthStart });
  }

  return result;
}

/**
 * 两个月份标签之间至少隔几列。
 *
 * 一列 11px（格子 9 + 缝 2），而 `Oct` 在 11px 字号下约 20px 宽、
 * `10月` 约 24px —— 挨着放必然叠字。3 列是两种语言都够用的最小值；
 * 真实的月份起点之间至少隔 4 列，所以这个值不会误伤正常标签。
 */
export const HEAT_MONTH_MIN_GAP = 3;

/**
 * 哪几列该写月份标签（不写的给 null）。
 *
 * 只有一处会挤：第一列的标签是"开头那个**不完整**的月份"（画布从 10 月
 * 20 日开始，那 10 月只剩 12 天），而 11 月 1 日可能就落在第 2 列 ——
 * 两个标签只隔 1 列，于是渲染成 `Oct!ov`。
 *
 * 让位的是**开头那个残月**，不是真实月份起点：残月本来只盖住一两列，
 * 而"11 月从这里开始"是读这张图的人真正需要的信息。反过来的话，
 * 图上会写着 10 月却几乎看不到 10 月。
 */
export function heatMonthLabels(
  weeks: HeatWeek[],
  minGap = HEAT_MONTH_MIN_GAP,
): (string | null)[] {
  const columns: number[] = [];
  weeks.forEach((week, index) => {
    if (week.monthStart) columns.push(index);
  });

  for (let i = 0; i < columns.length - 1; i += 1) {
    if (columns[i + 1] - columns[i] < minGap) {
      columns.splice(i, 1);
      i -= 1;
    }
  }

  const out: (string | null)[] = weeks.map(() => null);
  for (const index of columns) out[index] = weeks[index].monthStart;
  return out;
}

/** 有记录的天数 */
export function activeDays(days: Record<string, number>): number {
  return Object.values(days).filter((minutes) => minutes > 0).length;
}

/**
 * 当前连续天数。
 *
 * 今天还没记过时从**昨天**往回数 —— 上午打开档案页看到"连续 0 天"，
 * 会把昨天以前的记录全抹掉，那才是让人不想再看的数字。
 */
export function currentStreak(days: Record<string, number>, today: Date): number {
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!(days[dayKey(cursor)] > 0)) cursor = addDays(cursor, -1);
  let streak = 0;
  while (days[dayKey(cursor)] > 0) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** 把分钟数说成人话：`18 小时 20 分` / `18h 20m` */
export function describeMinutes(minutes: number, lang: "zh" | "en"): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return lang === "en" ? `${rest}m` : `${rest} 分钟`;
  if (rest === 0) return lang === "en" ? `${hours}h` : `${hours} 小时`;
  return lang === "en" ? `${hours}h ${rest}m` : `${hours} 小时 ${rest} 分`;
}
