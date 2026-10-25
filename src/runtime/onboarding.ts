/**
 * 首次引导的纯逻辑（0011）。
 *
 * 只回答两个问题：**引导卡该不该出现**、**目录区"没得装"该说哪一种**。
 * 文案不在这里 —— 界面那一侧用 `t()` 写，这里只给判据，方便 `tests/onboarding.html`
 * 把"什么时候出现"钉成表，而不是靠点界面点出来。
 */

/** 目录区"没得装"的三种情形。`none` = 不用说话 */
export type CatalogueDeadEnd = "none" | "empty" | "all-installed";

/** 引导卡的三步，按这个顺序写 */
export const FIRST_RUN_STEPS = ["install", "place", "extend"] as const;

export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

/**
 * 引导卡显示不显示。
 *
 * 两个条件都要：**没按过 `Got it`**，且**一件组件都没装**。
 *
 * 只看 `onboarded` 是不够的 —— 它在盘上缺省是 `false`，于是这台装了一堆组件的老机器
 * 升级上来会被问一次"要开始吗"。反过来只看"一件都没装"也不行：用户可能就是想空着。
 *
 * 装过再卸光会让它回来，那是**故意**的：此刻界面真的又空了，而它说的正是"怎么不空"。
 */
export function firstRunVisible(input: { onboarded: boolean; installedCount: number }): boolean {
  return !input.onboarded && input.installedCount <= 0;
}

/**
 * 目录区该说哪一种"没得装"。
 *
 * - `rows`：搜索过滤之后还剩几条
 * - `shown`：其中"还有东西要给你看"的条数（能装 / 能更新 / 装不了的都算）；
 *   等于 0 就是"全都装过了、没有新东西"
 * - `filtering`：是不是在搜索
 *
 * 搜索中且一条都没剩时不说话 —— 那种空由"没有匹配"那句负责，再加一句"去加个源"是答非所问。
 */
export function catalogueDeadEnd(input: {
  rows: number;
  shown: number;
  filtering: boolean;
}): CatalogueDeadEnd {
  if (input.rows <= 0) return input.filtering ? "none" : "empty";
  if (input.shown <= 0) return "all-installed";
  return "none";
}
