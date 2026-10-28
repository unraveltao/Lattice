---
status: accepted
date: 2026-10-26
code: src/runtime/onboarding.ts, src/platform/LibraryPanel.tsx, src/platform/CatalogueSection.tsx, src/platform/SettingsMenu.tsx, src/platform/store.ts, src/App.tsx, tests/onboarding.html
---

# LAT-0011 —— 首次引导：把"没有别的了"变成"从哪儿加"

> 需求原文在 [`../ROADMAP.md`](../ROADMAP.md) 的 v0.6 第四条：**"组件库『可安装』那一段现在只有
> 6 个官方包，装完就空了。冷启动的死结在这儿：新用户打开，装完 6 个，发现『没有别的了』，
> 然后关掉。给一条预置的官方源 + 一句『这里可以加别人的目录』，比多写 4 个官方包更值。"**
> 预置官方源那半在 [0010](./LAT-0010-multi-source-catalogue.md) 已经落了；这一份只做另外半句。

> **现在的状态：落地完成。** 库面板顶上那张三步卡、`Got it` 落盘、`Add another source` 直接
> 打开 Settings → Widgets、目录区见底时那一句，都已经进了代码：`runtime/onboarding.ts` 的
> `firstRunVisible` / `catalogueDeadEnd`、`store.ts` 的 `onboarded` + `dismissOnboarding`、
> `SettingsMenu.tsx` 的 `openAt`、`LibraryPanel.tsx` 的卡与 `CatalogueSection.tsx` 的那句。
> `tests/onboarding.html` **22 条**、`tests/store-ui.tsx` 63 → **75 条**。
> **还剩的**只有第 6 节那段手工验收（要人点一次：清空已安装看卡、点加源落到 Widgets、
> 装一个卡消失、按 `Got it` 重启不再出现）。`status` 因此从 `draft` 抬成 `accepted`。

## 1. 问题

新机器上 `installedIds` 是空的，而商店里第六个包装完之后，**屏幕上没有任何一处告诉用户
"还有别的目录可以订"**。具体坏在三处：

- **空机器上，引导只有一行字**（`Canvas.tsx:104` "Empty — exactly as intended" + 库面板
  `LibraryPanel.tsx:457` "The platform is empty"）。"组件从哪儿来"这件事，界面上看不出来 ——
  看起来像"平台自带这些"，而不是"平台订阅了这份目录"。
- **装完那一刻，是死路**。`Available` 段见底、目录区所有条目落进静默统计
  （`CatalogueSection.tsx:382` "Already installed — 6 up to date…"）。因果在用户眼里是
  "装完了 → 没了"，实际是"**这个源**装完了 → 还有别的源"。
- **空源那句说的是目录，用户读成应用**。`This catalogue is empty.`（`CatalogueSection.tsx:330`）
  在有源但源里没东西时出现 —— 这是"你的源没内容"，读起来却是"这软件里没东西"。

设置里其实已经有一张源列表（0010）。问题不是它不存在，是**没有任何一条路把人送到它面前**。

## 2. 候选

| | A：一张一次性引导卡 + 目录见底时一句带按钮的话 | B：只加文案，不加按钮、不记状态 | C：阻塞式欢迎向导（模态三步） |
| --- | --- | --- | --- |
| 做法 | 库面板顶部三步卡（装一个 / 摆上去 / 加源），`Got it` 记 `onboarded`；目录区"没得装"时说一句 + `Add a source` 直接开设置 | 把 `This catalogue is empty.` 改长一点，写明"可以去设置里加源" | 打开时弹一个三步模态，下一步下一步 |
| 把人送到动作上 | 是（按钮直接到 Widgets 页） | 否（只是知道，不落地） | 是 |
| 挡不挡画布 | 不挡（它是面板里的一段） | 不挡 | 挡 —— 第一次打开最想做的事是"装一个看看" |
| 要记什么 | 一个布尔 | 无 | 一个游标（走到第几步） |

## 3. 决定

选 **A**，四条边界：

1. **只在"一件都没装"时出现**。判据是 `!onboarded && installedCount === 0`，不是只看
   `onboarded`。理由不是洁癖：`onboarded` 缺省是 `false`，只看它的话，**这台装了 14 个组件的
   老机器升级上来会突然被问"要开始吗"** —— 这正是"新字段默认值"最容易犯的错。
2. **它会自己退场，也有一个手动出口**。装了第一件之后条件不再成立，卡自己消失；`Got it`
   写 `onboarded: true`，给"我就是要空着"的人一个干净的出口。反过来，**卸载光之后它会回来** ——
   这是对的：此刻界面真的又空了，而它说的正是"怎么不空"。两个条件都只在"空"时成立，
   所以它不可能变成一块常驻广告。
3. **"加别人的目录"是一步到位的动作，不是一句说明**。按钮直接打开 Settings → Widgets
   （源列表就在那一页）。**不把源编辑器复制一份到组件库**：源列表的事实家在 `SettingsMenu.tsx`
   （不变量 19 的"一个东西一个名字"，也是 0010 §4 已经定下的家）。实现是一条
   `openAt: { section, nonce }` prop —— 带 `nonce` 是因为"从引导点一次、关掉、再点一次"这
   两次要都生效，而 `setSection` 收到同一个值什么都不会发生。
4. **"没得装"的两种情形都说同一句，但都不删原有信息**。① 源里真的一条没有（`rows === 0`）；
   ② 有，但全都装过了（`shown === 0`）。前者原来那句 "This catalogue is empty." 保留成标题
   再加提示与按钮；后者的统计行（"Already installed — 6 up to date."）**一字不动**，只在它
   后面补一句 —— 统计说的是"你装过什么"，建议说的是"还能从哪儿拿"，两件事不能互相顶掉。

## 4. 接口与数据

**落盘**：`state.json` 加一个 `onboarded: boolean`（默认 `false`）。

- **不抬 `STATE_VERSION`**。加的字段可缺省，v2 的迁移逻辑一行都不用改；旧版本读新文件时
  `persist` 的合并只取它认识的键，`onboarded` 会被忽略 —— 后果只是"下次升级回来引导又出现
  一次"，而判据第 4 条（装了东西就不显示）让那次出现几乎不可见。
- 进 `partialize`（和 `sources` 一起），否则这个标记永远只在内存里。

**纯逻辑**（`src/runtime/onboarding.ts`，`tests/onboarding.html` 钉着）：

```ts
export type CatalogueDeadEnd = "none" | "empty" | "all-installed";

/** 引导卡显示不显示：只认"没按过知道了"且"一件都没装"这两件事 */
export function firstRunVisible(input: { onboarded: boolean; installedCount: number }): boolean;

/** 目录区"没得装"该说哪一种 */
export function catalogueDeadEnd(input: { rows: number; shown: number; filtering: boolean }): CatalogueDeadEnd;

/** 三步的顺序（文案在界面里，这里只定"有哪几步、按什么顺序"） */
export const FIRST_RUN_STEPS = ["install", "place", "extend"] as const;
```

`shown` 是"还有东西要给你看"的条数（能装 / 能更新 / 装不了的都算，等于现有 `visible`），
`rows` 是过滤后还剩几条。搜索过滤中且一条都没剩时返回 `"none"` —— 那种空由"没有匹配"
那句话负责，再说一遍"加个源"是答非所问。

**界面改动**

- `LibraryPanel.tsx`：面板体最上面那张卡（三步 + `Install the official pack ({count})` +
  `Add another source` + `Got it`）。它出现时**顶掉**原来那段 "The platform is empty"（同一颗
  安装按钮不出两次）；搜索中、加载中、一个包都发现不到时不出现。
- `CatalogueSection.tsx`：`deadEnd !== "none"` 时在统计行后面补一段提示 + `Add a source`。
- `SettingsMenu.tsx`：新增可选 prop `openAt`；`Section` 类型导出成 `SettingsSection` 供 `App` 用。
- `App.tsx`：`settingsAt` 状态 + `openSourceList()`（`nonce` 自增），一份回调同时递给
  `LibraryPanel`（转给 `CatalogueSection`）与 `SettingsMenu`。
- `src/runtime/i18n/library.ts`：新句子（中文一份）。`settings.ts` 里 `Add a source` 已有，复用。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 老用户（装了一堆）升级上来忽然看到"从这里开始" | 判据只有 `!onboarded`，缺字段默认 false | 判据必须同时要 `installedCount === 0`；`onboarded` 只记"我按过知道了" |
| 卡里两颗安装按钮 | 引导卡出现时原来的 "The platform is empty" 段还铺着 | 两段互斥：引导在就只画引导 |
| 点"加一个源"毫无反应 | `openAt` 按值传 / `nonce` 不变，effect 认不出来 | `nonce` 每次点都自增；effect 只认 `nonce` 变化 |
| 点"加一个源"停在 Account 页 | 只 `setOpen(true)` 没换页 | 走现成的 `openPanel(section)`，它同时做两件事 |
| 全装完之后那句"还能加源"不出现 | dead-end 判据只认 `rows === 0` | "全装过"也算（`shown === 0`），且统计行留着 |
| 搜索不到东西时冒出"加个源" | 没排除过滤态 | `filtering && rows === 0` → `"none"` |
| 一个组件都发现不到（用户目录空、内置也没有）时卡里写着"装官方那包" | 卡在 `widgets.length === 0` 时也出现 | 卡只在**有东西可装**时出现；那种情况留给 "No widgets at all" |
| 按了 `Got it` 重启又来 | `dismissOnboarding` 写了但 `partialize` 漏字段 | 和 `sources` 一起列进 `partialize` |
| 引导把已装的组件挤到看不见 | 卡里塞了四步以上 / 每步一段解释 | 三步各一行、共三颗按钮；`Got it` 立刻收掉 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/onboarding.html`（新） | 22 | `firstRunVisible`：没按过且空 → 显示；装过 → 不显示；按过 → 不显示；按过且卸光 → 不显示；`catalogueDeadEnd`：空源 / 全装过 / 还有得装 / 搜索无匹配 / 搜索命中；`FIRST_RUN_STEPS` 三步且顺序与文案 key 稳定 |
| `tests/store-ui.tsx` | 63 → 75 | 空机器上面板顶部出现引导卡（三步都在、`Add another source` 在、`Got it` 在、旧的"平台还是空的"不再铺）；点两颗按钮真的调到了那两个回调；搜索中不铺；装了一件之后不出现；按过 `Got it` 之后不出现；空目录时那句 + 那颗"加一个来源"在 |
| 其余页 | 不变 | `LibraryPanel` 多一个必填 prop，`store-ui` 的默认 props 补一个空函数 |

**手工验一次**（`npm run tauri:dev`）：把 `state.json` 的 `installedIds` 清空重启 → 库面板顶部
看到三步卡 → 点 `Add another source` 落到 Settings 的 Widgets 页（源列表展开着）→ 回来装第一个
包，卡消失 → 把官方 6 个全装完，目录区出现"这就是全部了 + 加一个源"→ 点 `Got it`（先卸光）
重启，卡不再出现。
