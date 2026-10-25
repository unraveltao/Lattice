---
status: accepted
date: 2026-10-25
code: src/runtime/assistant.ts, src/platform/assistant.ts, src/platform/AssistantPanel.tsx, src-tauri/src/assistant_session.rs, src-tauri/src/assistant_session_policy.rs
---

# 0003 —— 让 agent 有纪律：会话、审批、预算、观察

> **0004 推翻了本文第 3 节「不做」里的两条**（"不给截屏 / 读屏"、"手不扩到装组件/写组件"里的
> 前半句）。审批与预算这两样被 0004 的 P1 吸收并扩展成"按能力组开关 + 写/跑必问"。
> **会话与观察两段已于 2026-10-25 落地**：四份文件一个目录
> （`assistant-sessions/<id>.json`，50 份 / 200 条 / 1 MB，超了从最旧丢并说出来）、
> 面板顶部那条会话条、提示词里组件说明首句（≤120 字 × 8）与商店一段（≤8）。
> 审批档位那一条（`approvalMode` 三档）**也已落地**（2026-10-25，在会话之后）：
> `assistant.json` 顶层 `approvalMode`（`ask` / `auto` / `readonly`，默认 `ask`），
> 三值裁决 `approvalFor(name, mode) → allow | ask | deny` 只在 `runtime/assistant.ts` 一处，
> `readonly` 让工具表**连 schema 都不给**、Rust 的 `assistant_tool` 再拒一次；
> `auto` 仍然问 `DANGEROUS_ACTIONS`（删除组件）。看手之前先看 [0004](./0004-agent-hands.md)。

## 1. 问题

四件具体会坏的事：

- 对话只活在 `AssistantPanel` 的一个 ref 里。关面板再开还在，**退出应用就全没了** —— 第二天想接着调昨天那个布局，只能重说一遍。
- 模型一句话就能 `placement.remove`，唯一的兜底是 8 秒 `Undo`，而那一刻用户很可能正看着别处。
- 一轮最多 6 步，但没有时间和 token 上限。模型绕圈时用户只能等；"停止"要等下一次 IPC 回来才生效。
- 模型只有一份布局快照。问"帮我把天气设成上海"，它不知道装没装、配置有哪些、说明里写了什么 —— 于是它猜，或者反过来调一个不存在的实例。

## 2. 候选

| | A：只加审批 | B：会话 + 审批(ask) + 预算 + 观察 | C：手也扩到装组件/写组件 |
| --- | --- | --- | --- |
| 做法 | `act` 前弹确认条 | 五样一起，但手不动 | 加 `widget.install` / `widget.uninstall` / 写组件文件 |
| 换掉什么 | 只改循环里一行 | 无既有决定 | 不变量 15 的第三道校验与不变量 8 的授权 |
| 新增什么 | 一个危险动作表 | `assistant-sessions/`、4 个命令、提示词两段、预算纯函数 | 一套"模型改信任链"的流程 |
| 代价 | 助手退化成"会说话的删除按钮" | 明文落盘 + 多一次 await + 每轮最多约 1k token 的说明摘要 | 模型可以替用户点"信任这把新钥匙"，`planInstall` 的确认形同虚设 |

C 被否：不变量 15 的三道校验里，第三道是"换钥匙必须由用户点头"，让模型代点等于把信任链交给一段提示词。A 被否：用户要的是"能接着干的助手"，不是"更客气的删除按钮"。

## 3. 决定

**选 B。**

**代价**

- 多一个落盘目录和 4 个命令；会话**明文**存在 `%APPDATA%`，用户粘进对话的敏感内容会落到盘上。不做内容过滤（做不到），靠"删除会话"和数据目录本身 —— 这条要在界面上说出来，不能假装没有。
- 审批多一次 await，模型的一步会被人为拉长；用 `Always this turn` 抵。
- 观察段吃 token：每组件 ≤120 字 × 8 条，最坏约 1k token/轮，必须在提示里标明"截断了"。
- 预算会把"差一步就完成"的轮次砍断，所以错误话必须说清是哪一条（步数 / token / 时间）。

**什么时候该推翻它**

- 用户普遍嫌确认烦 → 把默认档改成 `auto`。那是配置，不是架构，不用重开这份文档。
- 数据平面（v0.8 的空档）落地后，"观察"应该从"help 文本摘要"换成"组件自己声明的工具"，这一段就该删。

**不做（写在这里，免得下次重新讨论）**

- 不给 `widget.install` / `widget.uninstall` / `widget.grant` / `config.set` / `widget_store_write`。理由见上表与不变量 15 / 8 / 5。
- 不做后台自主循环（"每天早上自己换主题"）：人在环和无人环是两套安全模型，v1 只做有人的。
- ~~不给截屏 / 读屏。~~ **已被 [0004](./0004-agent-hands.md) 推翻**：屏幕与键鼠成了六组手里的两组（`screen` / `input`），默认关、调用必问、审计留痕。当年那句"它能看你的屏幕，和'能摆桌面'不是一个授权"仍然成立 —— 所以它才不是"顺手加一个动作"，而是一整组要用户自己拨开的开关。
- 不调模型生成会话标题：多一次 API = 多一次花钱和延迟。

## 4. 接口与数据

**Tauri 命令**

```
assistant_sessions()                       -> [{ id, title, updatedAt, messageCount, usage }]
assistant_session_load({ id })              -> { id, title, createdAt, updatedAt, model, profileId, messages, usage }
assistant_session_save({ id?, title?, model, profileId, messages, usage }) -> { id, title, updatedAt }
assistant_session_delete({ id })
```

- 落盘 `%APPDATA%\com.iron-tom.lattice\assistant-sessions\<id>.json`，`id = s-<unix>-<4 位随机>`；临时文件 + 原子替换（`state.rs` 同一条规矩）。
- 上限：**50 份**（满了拒绝新建并提示删旧的，不自动删用户的东西）、单份 **200 条消息 / 1 MB**（超了从最旧丢，并在会话里插一条"这条会话被截断"的系统行 —— 不静默）。
- 标题 = 首条 user 消息折成一行、截 12 字；没有就 `New chat`。列表按 `updatedAt` 倒序。
- `assistant.json` 顶层加 `approvalMode`（`ask | auto | readonly`，默认 `ask`）。不进 `state.json`，理由和 key 一样：那份是前端整体回写的。

**审批的落点**：`AssistantSurface`。`runAssistantTurn` 在 `surface.act(...)` **之前**调 `options.approve(tool, args)`；实现在面板（抽屉与小窗各自渲染确认条，文案走 i18n）。`DANGEROUS_ACTIONS = new Set(["placement.remove"])`，以后 `widget.install` / `grant` / `uninstall` 进来只改这一处。`readonly` 用 `toolsFor("readonly")` **并且系统提示用同一张表生成** —— 两边不一致的症状是"它能调，但提示里说它做不到"。

> **`readonly` 那一句后来变简单了**：本文写的时候以为能"只留 `state`"之类的只读动作，落地时发现**桌面上那八个动作全都改状态**（布局快照在提示里，不是工具），没有"只读的桌面动作"可留。所以 `toolsFor(name, "readonly")` 现在是**一张空表**：`approvalFor` 逐条过，`deny` 的连 schema 都不给。留成"能调但会被拒"只会让模型试着调、看着它失败、然后开始编。

**预算**：**当时定的是** `MAX_TURN_MS = 180_000`、`MAX_TURN_TOKENS = 120_000`（累计 prompt + completion）、`MAX_STEPS = 6`。`overBudget({ elapsed, tokens })` 是纯函数，循环在每个 delta、每次 `act` 前、每次审批前各看一次。

> **三个数后来都抬了**（0004 §4）：`MAX_STEPS = 24`（有了文件和命令之后"读一眼、改一处、跑一次、再读回来确认"就是四步，6 步连收尾都不够）、`MAX_TURN_MS = 300_000`、`MAX_TURN_TOKENS = 200_000`。三个常量现在住在 `src/runtime/hands.ts`（跟着手一起搬的），`overBudget` 的判断没变。另外多了一个 `MAX_HISTORY = 32`（发给模型的历史条数，比 Rust 那边小，裁的时候保留 system）。

**观察**：`systemPrompt(snapshot, { tools, persona, catalogue })` 加两小段 ——

- "你桌面上装了这些组件"：id / name / `help` 第一节首条 ≤120 字，最多 8 个，超出写"（还有 N 个）"。
- "商店里还能装这个"：仅在目录已加载时给 id + name，最多 8 个，并明说"你没有安装工具，只能建议用户去装"。

**要改的文件**：`runtime/assistant.ts`（危险动作表、`toolsFor("readonly")`、`overBudget`、`sessionTitle`、提示词两段）、`platform/assistant.ts`（`approve` 回调、预算检查）、`AssistantPanel.tsx`（确认条、会话列表、`Always this turn`）、`assistant_session.rs` + `assistant_session_policy.rs`（新）、`lib.rs`（注册 4 个命令）、`runtime/i18n/assistant.ts`、`tests/assistant.html`、`docs/AGENT_ACCESS.md`（把"手不扩"写成陈述）、`ROADMAP` 一行。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 面板重开，前两天聊的没了 | 之前只活在 ref 里 | 启动读最近一份会话，按 `updatedAt` 排 |
| 打开助手报"加载失败"，别的会话也打不开 | 一个坏文件把整份列表读崩 | 列表逐条 try；坏条目显示"损坏的会话"，可删不可加载 |
| 两个窗口同时存同一会话，内容退回十分钟前 | 各持一份内存 | 按 id 串行（once 守卫），返回 `updatedAt`；面板比对后提示"这条会话在别处被改过" |
| 组件已经被删了，确认条才弹出来 | 审批放在 `act` 之后 | 审批必须在 `act` **之前** await；chip 先显示"等待确认" |
| 按了停止还在花钱 | 只在步与步之间查标志 | 每个 delta、每次 `act` 前、每次审批前都查 |
| `readonly` 下模型说"我删了它" | 提示词与工具表不一致 | 同一张表生成提示；`tests/assistant.html` 逐字比 |
| 提示里组件说明占了半页 | help 没有上限 | 每条 ≤120 字、最多 8 条，超了写"（截断）" |
| 会话文件里出现用户粘进去的 key | 对话内容原样落盘 | 不过滤（做不到）；给"删除全部会话"，文档与界面都写明是明文 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/assistant.html` | +18 | `needsApproval(tool, mode)`、`toolsFor("readonly")` 是空表（见 §4 那条注）、`overBudget` 三种触发、`sessionTitle` 折行截断、观察段 8 条上限与截断标记 |
| `assistant_session_policy.rs`（新） | 12 | 标题归一化、坏消息逐条丢、200 条 / 1 MB 裁剪、id 规则、路径不许越出目录（`..` / 盘符）。**现在是 15 条** |

**手工验一次**：真机让模型删一个组件（看确认条三选）、`readonly` 档下同一句话、拔网线、关应用再开看会话在、小窗和抽屉同时开各跑一轮。面板的确认条不做组件断言 —— 它靠上面那些纯函数钉，UI 走真机，和 `AssistantPanel` 现在的取舍一致。
