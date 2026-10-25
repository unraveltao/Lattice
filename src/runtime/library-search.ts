/**
 * 组件库的搜索：切词、命中判定、以及"谁排在前面"。
 *
 * 单独成文件而不是写在 `LibraryPanel.tsx` 里，是因为它是**纯函数**：
 * 没有 React、没有 DOM、没有清单校验，所以 `tests/library-search.html`
 * 能直接 import 它跑断言。搜索的边界（大小写、空格、多词、空查询、排序）
 * 全在下面这几行，别在组件里再写一遍。
 *
 * # 为什么要排序
 *
 * 只有"命中 / 不命中"的时候，搜 `clock` 出来的顺序就是**清单原来的顺序**：
 * 名字就叫 Clock 的那个，可能排在"Clockwork"、"World clock"、"TurboClock"
 * 后面 —— 搜到是搜到了，但用户还得自己在结果里找一遍，而"搜索"这个词
 * 承诺的正是"第一个就是你要的"。
 *
 * # 怎么排
 *
 * 每条记录算一个分：**每个词各自找最好的那一处命中，加起来**。
 * 一处命中有两维：
 *
 * - **档位**（`MATCH_TIERS`）：整串相等 > 从头开始 > 词首 > 出现在中间。
 *   档与档之间差一千分，所以档位永远压过字段权重 —— "名字里以它开头"
 *   不该输给"描述里恰好有一模一样的词"。
 * - **字段权重**（`FIELD_WEIGHTS`）：同一档里，名字 > id > 描述 > 作者 > 权限名。
 *   名字是作者给它起的称呼，id 是它的身份，两者最像"用户在找的东西"；
 *   描述和权限名是"顺带提到了"，排前面只是噪音。
 *
 * 三个刻意的边界：
 *
 * - **不做子序列匹配**（`clok` 不命中 `clock`）。它看着像"容错"，实际是把
 *   "没结果"变成"一堆噪音"：短词几乎能穿过任何一个长名字，而这条搜索的
 *   第一性要求是**搜不到就是没有**。拼错了重打一次，比在一屏不相关的结果里
 *   翻找便宜。
 * - **多词仍是 AND**：有一个词哪个字段都不命中，这条记录就不出现。排序只在
 *   命中的那些里做，不用"命中几个词"去放宽判据。
 * - **同分保持原顺序**：`rankWidgets` 是稳定排序。分数一样时谁前谁后不该
 *   取决于排序算法，否则同一份清单在不同浏览器里顺序不同。
 */

import { PERMISSION_LABELS, permissionLabel, type Permission } from "./manifest";
import { textVariants, type LocalizedText } from "./widget-text";

/** 只需要清单里的这几项，测试里给个对象就能跑 */
export interface SearchableWidget {
  manifest: {
    name: LocalizedText;
    id: string;
    description: LocalizedText;
    author: string;
    permissions: Permission[];
  };
}

/**
 * 切成词。空白（含全角空格）都算分隔符，连续空白不产生空词。
 *
 * 多词是"都要命中"（AND），不是"命中一个就行"：搜 `clock 24` 的人是想在时钟里
 * 找 24 小时制那项，把整个库都倒出来对他没用。
 */
export function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 命中档位。差一档就是差一千分 —— 字段权重最大才 80，所以档位永远赢。
 *
 * 数值本身没有含义，只有相对大小有意义；照抄的是一套已经在别处验证过的量级
 * （档间差远大于权重差），换成 4 / 3 / 2 / 1 也一样，但那样每加一个字段就得
 * 重新算一遍权重够不够大。
 */
export const MATCH_TIERS = {
  /** 整个字段就是这个词 */
  exact: 5000,
  /** 字段以它开头 */
  prefix: 4000,
  /** 出现在某个词的开头（前面是空格、标点、路径分隔符这类边界） */
  word: 3000,
  /** 出现在中间 */
  substring: 2000,
} as const;

/**
 * 字段权重：同一档里谁更"像用户要找的东西"。
 *
 * 权限名排最后但**不是 0**：搜 `storage` 出来一堆要存储的包时，顺序不该是随机的，
 * 但也确实不该压过"名字里就有 storage"的那一个。
 */
export const FIELD_WEIGHTS = {
  name: 80,
  id: 60,
  description: 40,
  author: 20,
  permissions: 10,
} as const;

/**
 * 什么算"词的边界"。
 *
 * 只认标点与空白，不认汉字 —— 中文没有词边界，`时钟` 出现在 `小时钟` 里
 * 按这条规则算"中间"（substring 档）。这是有意的：把每个汉字之间都当边界，
 * 等于给中文单独一套排序规则，而中文用户搜两个字的词时"从头开始"已经够用。
 */
const WORD_BREAK = /[\s\-_/\\.,:;·、，。：；！？（）()[\]{}"'`|!?+*=<>@#$%^&~]/;

/** 一个字段在某个词上拿到的最好档位（0 = 没命中） */
function tierOf(value: string, token: string): number {
  if (value === token) return MATCH_TIERS.exact;
  const at = value.indexOf(token);
  if (at < 0) return 0;
  if (at === 0) return MATCH_TIERS.prefix;
  if (WORD_BREAK.test(value[at - 1])) return MATCH_TIERS.word;
  return MATCH_TIERS.substring;
}

interface ScoredField {
  weight: number;
  values: string[];
}

/**
 * 一条记录能搜的五个字段，各带权重，值一律先转小写。
 *
 * 权限名**中英各放一份**：英文名是 `PERMISSION_LABELS`（测试钉着它），
 * 另一份按当前界面语言取 —— 中文界面下搜"网络"要能命中要联网的包，
 * 而英文查询的结果不能被多出来的中文名改变。
 *
 * 作者写的名字 / 描述**所有语言各放一份**（`textVariants`）：用户不记得自己
 * 当初看到的是哪一门，打"鲸鱼"要能搜到大肥鱼，打 "whale" 也要能。
 */
function scoredFields(record: SearchableWidget): ScoredField[] {
  const lower = (value: string) => value.toLowerCase();
  return [
    { weight: FIELD_WEIGHTS.name, values: textVariants(record.manifest.name).map(lower) },
    { weight: FIELD_WEIGHTS.id, values: [lower(record.manifest.id)] },
    { weight: FIELD_WEIGHTS.description, values: textVariants(record.manifest.description).map(lower) },
    { weight: FIELD_WEIGHTS.author, values: [lower(record.manifest.author)] },
    {
      weight: FIELD_WEIGHTS.permissions,
      values: record.manifest.permissions
        .flatMap((permission) => [PERMISSION_LABELS[permission] ?? permission, permissionLabel(permission)])
        .map(lower),
    },
  ];
}

/**
 * 这条记录得多少分；`null` 表示不命中（有一个词哪个字段都没出现）。
 *
 * 空词表得 0 分且**不算不命中** —— 那是"没在搜"，不是"什么都不要"。
 */
export function matchScore(record: SearchableWidget, tokens: string[]): number | null {
  if (tokens.length === 0) return 0;

  const fields = scoredFields(record);
  let total = 0;

  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      for (const value of field.values) {
        const tier = tierOf(value, token);
        if (tier === 0) continue;
        const score = tier + field.weight;
        if (score > best) best = score;
      }
    }
    // 一个词在五个字段里一次都没出现 —— AND 的另一半，整条不出现
    if (best === 0) return null;
    total += best;
  }

  return total;
}

/**
 * 这个包要不要显示。
 *
 * 语义和加排序之前**完全一样**（每页断言里"不做模糊匹配"那几条钉着），
 * 只是实现改成问 `matchScore`：判据只有一处，免得"能搜到"和"排第几"
 * 两套规则慢慢走岔。
 */
export function matchesWidget(record: SearchableWidget, tokens: string[]): boolean {
  return matchScore(record, tokens) !== null;
}

/**
 * 过滤 + 排序。组件库的两段（已安装 / 可安装）各调一次，各自排各自的。
 *
 * 空词表原样返回（**不重排**）：没在搜的时候，清单该按它自己的顺序站着 ——
 * 那个顺序里有"官方包在前"之类的安排，不该被搜索顺手打乱。
 */
export function rankWidgets<T extends SearchableWidget>(records: readonly T[], tokens: string[]): T[] {
  if (tokens.length === 0) return [...records];

  const scored: { record: T; score: number; index: number }[] = [];
  records.forEach((record, index) => {
    const score = matchScore(record, tokens);
    if (score !== null) scored.push({ record, score, index });
  });

  // 同分回落到原下标：`Array.prototype.sort` 在旧引擎上不保证稳定
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.record);
}
