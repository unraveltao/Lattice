/**
 * 技能包的**纯逻辑**（0005 §4）。目录归 Rust（`skills/<id>/SKILL.md`），这里只做
 * 三件事：认得清一份技能、算得出上限、拼得出提示词那一段。
 *
 * 三件不肯让步的事：
 *
 * 1. **技能是说明书，不是权限。** 正文只进系统提示，不新增任何执行通道 ——
 *    技能里让"跑一下 scripts/build.ps1"，仍然走 `shell.run`、仍然要审批、仍然进审计。
 *    所以这个文件里没有一条执行逻辑，只有文字。
 * 2. **超上限时拒绝，不截断。** 截断过的步骤等于半份说明书，模型会照半份做，
 *    而那比"这件事没做成"更难查（0005 §3）。
 * 3. **正文按码点数，不按字节。** 4 000 字的中文是 12 KB 的 UTF-8：
 *    按字节算，中文技能会在 1 300 字时就被判超限，而它其实还没写完。
 */
import { HAND_GROUPS, type HandGroup } from "./hands";

/** 上限（0005 §3）。**在启用时判**，不在渲染时判 —— 渲染时判等于静默截断 */
export const SKILL_MAX = 4;

/** 单份正文的字数上限 */
export const SKILL_BODY_MAX = 4_000;

/** 启用的几份加起来的字数上限 */
export const SKILL_TOTAL_MAX = 8_000;

/**
 * Rust 递过来的一份技能（`assistant_skills` 的载荷）。
 *
 * `body` 也在里面：前端的提示词要用它，而渲染进程没有文件系统 —— Rust 不递，
 * 这一轮就只能"知道有这么个技能"却读不到它写的步骤。`bytes` 是磁盘上的体积
 * （面板上显示给人看），`damaged` 是"这个目录里有 SKILL.md，但读不成一份技能"。
 */
export interface SkillView {
  id: string;
  name: string;
  description: string;
  /** front matter 里声明的组名。**只用于面板上标"缺 Files"**，不决定给不给工具 */
  tools: string[];
  body: string;
  bytes: number;
  enabled: boolean;
  damaged: boolean;
}

/** 进提示词的那一份：只有渲染要用的字段 */
export interface SkillPrompt {
  id: string;
  name: string;
  description: string;
  body: string;
}

/** 字 = 码点。`[...text].length` 和 `Array.from(text).length` 是同一件事 */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * front matter 的 `tools:` 归一化 —— 认不出来的组丢掉，不拦整份技能。
 *
 * 它只影响面板上那句"这个技能要用 Files，而 Files 关着"，所以一个拼错的组名
 * 不值得让整份技能打不开（和清单里坏条目逐条丢同一条规矩）。
 */
export function normalizeTools(raw: unknown): HandGroup[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const seen: HandGroup[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const name = item.trim().toLowerCase();
    const group = HAND_GROUPS.find((known) => known === name);
    if (group && !seen.includes(group)) seen.push(group);
  }
  return seen;
}

/** 这一份技能**声明**要用、但当前关着的组。面板据此标一句"缺 Files" */
export function missingGroups(skill: SkillView, on: readonly HandGroup[]): HandGroup[] {
  return normalizeTools(skill.tools).filter((group) => !on.includes(group));
}

/**
 * 启用这几份会不会超上限。**返回原因和数字**，话由界面说 ——
 * 这个文件不 import i18n，"超了 12 字"这句要跟着界面语言走。
 */
export type SkillBudget =
  | { ok: true; total: number }
  | { ok: false; reason: "count" | "body" | "total"; total: number; limit: number };

export function checkBudget(skills: readonly SkillPrompt[]): SkillBudget {
  let total = 0;
  for (const skill of skills) total += charCount(skill.body);
  if (skills.length > SKILL_MAX) {
    return { ok: false, reason: "count", total: skills.length, limit: SKILL_MAX };
  }
  for (const skill of skills) {
    if (charCount(skill.body) > SKILL_BODY_MAX) {
      return { ok: false, reason: "body", total: charCount(skill.body), limit: SKILL_BODY_MAX };
    }
  }
  if (total > SKILL_TOTAL_MAX) {
    return { ok: false, reason: "total", total, limit: SKILL_TOTAL_MAX };
  }
  return { ok: true, total };
}

/**
 * 从 `assistant_skills` 的清单里挑出这一轮要带的几份。
 *
 * 只挑**启用了、且没坏**的：一份读不成的技能进提示词，模型看到的是半份步骤，
 * 它会照半份做 —— 那比没有这份技能更糟。顺序按清单来（Rust 按 id 排序），
 * 所以同一组技能每轮拼出来的提示词是同一段字，上下文缓存才有意义。
 */
export function promptsOf(skills: readonly SkillView[]): SkillPrompt[] {
  return skills
    .filter((skill) => skill.enabled && !skill.damaged)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      body: skill.body,
    }));
}

/**
 * 提示词里那一段。**空表返回空数组**（一句废话都不加）。
 *
 * 两句话不能省：
 * - "先照它，再照你自己的习惯"：不写这句，模型会把技能当成背景资料，仍然按
 *   自己的路子做（0005 §5 的第一条症状）；
 * - "技能不给你新工具"：不写这句，它会在技能正文里见到"跑个脚本"就去调一个
 *   它没有的工具，然后开始编结果。
 */
export function skillsPrompt(skills: readonly SkillPrompt[]): string[] {
  if (skills.length === 0) return [];
  const lines = [
    "",
    "下面这几份是用户交代过的做法。遇到它们说的事，**先照它们写的步骤做**，再照你自己的习惯：",
    "（这些只是步骤说明，不给你任何新工具。里面要做的事仍然走同样的工具、同样要用户点过头。）",
  ];
  for (const skill of skills) {
    lines.push("");
    const hint = skill.description.trim() ? ` —— ${skill.description.trim()}` : "";
    lines.push(`### ${skill.name}（${skill.id}）${hint}`);
    lines.push(skill.body.trim());
  }
  return lines;
}
