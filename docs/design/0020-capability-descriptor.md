---
status: draft
date: 2026-10-26
supersedes:
code: src/runtime/assistant.ts, src/runtime/hands.ts, src/runtime/skills.ts, src/platform/hands.ts, src/platform/assistant.ts, src/platform/AssistantPanel.tsx, src-tauri/src/hands_policy.rs, src-tauri/src/llm.rs
---

# 0020 —— 五族能力，一张描述符

> **这一份是 `draft`，用途不是动手，是判断依据。** 触发条件写在 §3 末尾。
> 在那之前读它的人该带走的结论只有一句：**下一族能力不该再手写第六套装配代码。**

## 1. 问题

平台现在有五种"能给出去的能力"，每种的装配方式都不一样：

| 族 | 闸门 | 表在哪 | 数量 |
| --- | --- | --- | --- |
| 桌面动作 | 无（永远在表里） | `runtime/assistant.ts` 的 `TOOL_SPECS` | 8 |
| 手 | 六组开关 + 审批档 | `runtime/hands.ts` 的 `HAND_SPECS` | 11 |
| 组件声明的工具 | `agent:tools` 权限 | 运行时从清单算 | 随组件数 |
| MCP | 用户配的服务 + 一律问 | 运行时发现 | 随服务数 |
| 桥方法 | 按 `widgetId` 的权限 | `runtime/bridge.ts` | 27 |

[`ARCHITECTURE.md`](../ARCHITECTURE.md) §3 的标题是「一条能力落地的五处」—— 那是在招供。加**一组手**
（不是一族，是一组）实测要动八处：`runtime/hands.ts` 六张表（`HAND_GROUPS` /
`HANDS_OFF` / `HAND_SPECS` / `HAND_LABELS` / `HAND_READY` / `handGroup`）、
`runtime/skills.ts` 的 `missingGroups`、`platform/hands.ts` 的 IPC 序列化、
`platform/AssistantPanel.tsx` 的六个开关与完全访问的 `grantAllHands`、
`src-tauri/src/hands_policy.rs` 的结构体与 `effective_hands`、
`src-tauri/src/llm.rs` 的 `assistant.json` 形状。漏掉其中任何一处，症状都不是报错：

- 漏 `HANDS_OFF` → 新组默认是开还是关说不清，升级上来的用户读到 `undefined`；
- 漏 `handGroup` → 工具在表里，但审批认不出它属于哪组，`needsApproval` 退回 `true`（安全，但等于那组永远要问）；
- 漏 `skills.ts` → 技能包写"这个技能要用 X"，界面上永远不提示去开它；
- 漏 Rust 那半 → 界面拨了开关，存盘丢掉，重启回到默认。

所以真正的问题不是"代码重复"，是**同一条事实有六个家，而它们不一致时不报错**。
这个仓库最贵的一课就是这个形状（[`docs/README.md`](../README.md) 第四节）。

## 2. 候选

| | A：继续逐族加 | B：一张描述符，装配全派生 | C：B + 代码生成 |
| --- | --- | --- | --- |
| 做法 | 现状。每加一族，抄一遍上一族的七处 | 一条 `CapabilitySpec` 数组是唯一真源；工具表、审批默认档、审计形状、界面文案 key 都从它派生 | 描述符 → 生成桥方法骨架、JSON Schema、文案表 |
| 换掉什么 | 什么都不换 | 换掉"每族一套手写装配"；`allTools` 从"四路合并"变成"遍历一张表" | 再换掉"读源码才知道有哪些能力"，代价是构建多一步 |
| 新增什么 | 第七套装配代码 | 一个必须填满的字段集（填不满就是没想清楚） | 生成物要进版本库，否则每次构建都变 |
| 代价 | 第六族之后，`approvalFor` 的入参要靠约定而非类型；每族一条 `AGENTS` 不变量、若干 `PITFALLS` | 一次横切重构；五族的断言全要重跑；**描述符自己会变成新的"必须遵守"**，有长成第二个 `WIDGET_SPEC` 的风险 | B 的代价 + 生成器要维护；改字段要重新生成，`git diff` 会变大 |

C 先否掉：这个仓库的构建脚本已经 5 600 行，而生成器唯一的收益是"零漂移" —— B 的
一条遍历断言就能拿到同样的保证，不必再养一个生成器。

## 3. 决定

**B。** 描述符只放"这一族有什么、归谁管、默认问不问、审计记什么形状"，
**判断仍然只有 `approvalFor` 一个入口**。这一条是硬边界：描述符供默认值，
不许在里面写第二个 `if` 去决定"要不要问" —— 那会立刻变成第二份判据，
而两份判据对不上的时候，错的是不报错的那一份。

**代价**（真的代价，不是"暂时不完美"）：

1. 一次横切重构，`tests/assistant.html` 188 条、`tests/skills.html` 55 条、
   `tests/agent.html` 70 条全部要重跑；重构期间"工具表少了一条"不会红，
   只会让模型说"我没有这个工具"。
2. 描述符会把"加一组手"从八处变成一处 —— 但它同时把**那八处的知识**收进一个文件，
   于是那个文件成为冲突高发区（[`AGENTS.md`](../../AGENTS.md) §12 第 7 条那一类）。
3. 新增一道"完备性"断言，等于新增一种红法。写不出这条断言，说明字段集还没定对。

**什么时候该推翻它 / 什么时候该动手**：

- **现在不动手。** 第 6 族能力（剪贴板 / 通知 / 音频采集这类）真的出现时才做 ——
  到那时它带来的八处改动正好是这次重构的验收样本。
- 如果第 6 族能**完全**塞进现有的"手"（即：一组开关 + 一张 `HAND_SPECS` 就够了），
  说明这次重构没必要，把这一份标 `superseded` 并写清为什么。
- 如果第 6 族带来的是**新的闸门种类**（例如"按应用授权"而不是按组），B 仍然成立，
  但 `gate` 那一栏要从三个变体扩成四个 —— 扩不动就说明该拆成两份描述符。

## 4. 接口与数据

**没有跨进程契约的改动**：描述符是前端的纯数据，落盘格式（`assistant.json` v4）
一个字段都不动。这一点是刻意的 —— 一次重构如果要顺带迁移用户数据，就不该和它一起做。

```ts
type CapabilitySpec = {
  name: string;                 // "shell.run"，和现在工具表里的键一字不差
  family: "desktop" | "hand" | "widget" | "mcp";
  gate:
    | { kind: "always" }                                  // 桌面动作
    | { kind: "switch"; group: HandGroup }                // 手
    | { kind: "permission"; permission: Permission };     // 组件工具 / 桥方法
  defaultApproval: "allow" | "ask";                       // 只是默认值，判据仍在 approvalFor
  lifecycle: "once" | "stream" | "process" | "connection";
  audit: "action" | "shape-only";                         // 记不记参数（今天一律 shape-only）
  spec: ToolSpec;                                         // 今天 TOOL_SPECS / HAND_SPECS 的内容
};
```

**描述符里没有人话，一个字段都没有。** 界面上那些句子按**组**（`HAND_LABELS`）
和**权限**（`runtime/manifest.ts` 的文案表）走，它们的家在那里 —— 把 `label` 塞进
描述符，等于让"这个开关叫什么"有第二个家，而它漂了不会报错，只会让同一组开关
在面板和提示词里叫两个名字。这条是 [`docs/README.md`](../README.md) 第四节直接推出来的，不是口味。

一条真实的条目（`shell.run`，字段值全部来自今天的代码，不是设想）：

```ts
{
  name: "shell.run",
  family: "hand",
  gate: { kind: "switch", group: "shell" },
  defaultApproval: "ask",
  lifecycle: "once",
  audit: "shape-only",
  spec: HAND_SPECS["shell.run"],
}
```

`allTools` 变成一次遍历 + 一个 `filter`（按 `gate` 是否打开、`approvalFor` 是否 `deny`），
`toolsFor` 里那段"按 caller 剪表"变成 `gate.kind === "permission"` 的一个分支。
**`WIDGET_DENIED_ACTIONS` 保留**：它是"组件借手时砍掉删除"这条语义，
不是能力属性，硬塞进描述符会让那条不变量变成数据。

**要改的文件**（动手时）：上面 `code:` 那八个 + `runtime/i18n/assistant.ts`（新组要两条文案）
+ [`AGENTS.md`](../../AGENTS.md) §4 不变量 14/20 的措辞 + 本文件的 `status`。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 模型调了一条用户从没授权的能力，而且成功了 | 描述符漏填 `gate`，被当成 `always` | `gate` 是必填字段；完备性断言遍历每个 `name`，`gate` 为空即红 |
| 界面上勾开了某组，模型还是说"没有这个工具" | 描述符与 Rust 的 `HandsSettings` 漂移（前端多一组，Rust 不认，存盘丢掉） | 两边的组名清单由一条测试对账，红在 CI 而不是红在用户机器上 |
| MCP 的工具绕过了审批 | MCP 是运行时发现的，塞不进静态表，于是走了旁路 | MCP 在描述符里只占一条**模板**（`gate` 是"用户配的服务"），每个发现出来的工具都实例化它 |
| 同一组开关在面板和提示词里叫两个名字 | 有人往描述符里加了 `label`，而 `HAND_LABELS` 还留着一份 | 描述符不带人话（§4）；界面只读 `HAND_LABELS` |
| 重构之后一切正常，但少了一个工具没人发现 | 工具表是数据，少一条不会报错 | 断言钉**总数**（今天 8 + 11 + 动态），不是钉"包含某几条" |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/assistant.html` | 188（现有，全跑） | `approvalFor` 的三档判据不变 —— 重构不许改判据 |
| `tests/skills.html` | 55（现有，全跑） | `missingGroups` 仍然按组名报"这个技能要用 X" |
| `tests/agent.html` | 70（现有，全跑） | 8 个桌面动作的名字与 schema 一字不差 |
| 新增（并入 `tests/assistant.html`） | ≥3 | ① 每个 `name` 的 `gate` 非空；② 描述符的 `name` 集合 = 合表后的键集合；③ 总数 = 8 + 11 + 动态 |

**手工验一次**：真机上 `Ctrl+K` 拨开一组手、问一件该组的事，确认能调；关掉再问，
确认模型说"没有这个工具"而不是"调用失败"。这条验的是 `gate` 与提示词同源 ——
断言只钉得住表，钉不住"模型看到的是同一张表"。

---

> 写这一份的时候没有量任何东西，也没有改一行代码。它现在的价值是：下次有人想加一族能力，
> 先读 §3 的触发条件，再决定是"按描述符填一行"还是"这次真的该重构"。
