---
status: accepted
date: 2026-10-29
supersedes:
code: src/runtime/widget-tools.ts, src/platform/widget-tools.ts, src/platform/agent.ts, src/runtime/assistant.ts, src/runtime/config.ts, src/runtime/i18n/assistant.ts, src/platform/AssistantPanel.tsx, src-tauri/src/agent.rs, src-tauri/src/agent_policy.rs
---

# LAT-0037 —— 完全访问接管组件工具，`config.set` 成为第 9 个动作

## 1. 问题

用户原话："我希望我的 Agent 的操控的权限可以更大，起码掌控我所有的组件，提高权限后就像一个全能的 Agent。"

具体的坏结果：画布上摆着 6 个组件，其中 4 个在清单里声明了 `agent.tools`，但用户只在属性面板里给 2 个勾过 `agent:tools`。他切到「完全访问」，说"把待办里没做完的三条列出来"—— 模型回"我没有访问待办的能力"。**不是被拒，是表里根本没有**：算表那一步就把那两份滤掉了，所以模型连"我该请用户授权"这件事都学不到，只会开始猜键名。

两处根因，缺一不可：

1. `widgetToolSources`（`src/runtime/widget-tools.ts:296`）的判据是 `installed && granted && tools.length > 0`，`granted` 读 `grants[id].includes("agent:tools")`。**模式不在这条判据里**。
2. `allTools`（`src/runtime/assistant.ts:316`）收到的 `widgets` 是**已经筛过的表**，`approvalFor` 只按 `readonly` 再过滤一遍 —— 模式在第二道闸上无能为力。改第二道闸没有用，第一道才是门。

第二件事（"全能"的另一个缺口）：`config.set` 现在是桥权限里明令不给 agent 的那一档，而八个动作（`agent.ts:186-272`：`placement.add/move/resize/remove/pin/front`、`theme.set`、`widgets.pause`）里没有"改组件配置"。所以"把便签字号调大"这种事，模型只能请用户自己去点。

## 2. 候选

### 2.1 组件工具那一轴

| | A：模式接管 | B：批量授权写盘 | C：保持逐组件，只在快照里列未授权的 |
| --- | --- | --- | --- |
| 做法 | 算表时把 `everything` 视同全授（一个 `assumeGranted` 入参），**不写盘** | 面板加一颗"全部授权"，一次写 `grants` | `grants` 不动，`agentSnapshot` 多一段 `blocked`，列出"装了、声明了、没授权"的组件 |
| 换掉什么 | 逐组件授权在完全访问期间的效力 | 逐组件授权本身（永久） | 什么都不换 |
| 新增什么 | 一个入参、两条调用点、确认条一句话 | 一颗按钮 + 一次批量写盘 | 快照一段 + 提示词一句 |
| 代价 | 用户在完全访问期间**失去**逐组件的区分能力 | 退出完全访问也回不来，所有组件永久全授 | 模型知道"有这个组件"，但每用一次都要请用户去勾 —— 一轮对话变三轮 |

### 2.2 `config.set`

| | A：不解锁 | B：只在 `everything` 下解锁 | C：任何档都解锁 |
| --- | --- | --- | --- |
| 做法 | 维持现状 | 新动作 `config.set`：`everything` 放行、`auto` 问、`readonly` 拒 | 同 B，且 `auto` 也放行 |
| 换掉什么 | 无 | "八个动作"这个数字（变九个） | 同 B，外加 `auto` 档"删除之外全放行"的边界 |
| 新增什么 | 无 | 一条 op、一条 schema、一条审计 | 同 B |
| 代价 | "全能"少一块：改配置仍要人点 | 配置写坏 = 组件打不开，而用户看不出是谁改的 | 同 B，外加"模型在你睡着时改了便签字号" |

## 3. 决定

**决定 1**：A。`everything` 期间把 `agent:tools` 视同已授 —— 但**不写盘**，和 `effectiveHands`（`runtime/hands.ts:126`）同构：那个也是"这一轮不看开关"，`modeIgnoresSwitches` 的注释写着"不是替你打开，是不看它"。退出完全访问，用户原来没勾的仍然是没勾。

**决定 2**：B。`config.set` 只在 `everything` 下放行，`auto` 照问。

**代价**：

- 确认条必须写死一句"完全访问会打开**所有**组件的工具调用，包括你没逐个授权的"。不写这句，用户会以为自己只开了六组手。
- `widgetToolSources` 多一个入参，两条调用点（主窗 `agent.ts:293`、小窗经 `assistant_widget_tools`）都要传对。漏一条的症状是"小窗里看不到、主窗里看得到"。
- "八个动作"这个数字变成九个：`docs/AGENT_ACCESS.md`、`AGENTS.md` §1、`README` 两份都要改，`check:docs` 会盯着。

**什么时候该推翻它**：如果某个组件把敏感数据只放在工具里、指望"用户不授 `agent:tools` 就安全"，那 `agent:tools` 就不只是"能不能调"，还是**数据边界** —— 模式代开就破了它。届时退回 B（批量授权写盘，让用户自己确认一次）。判据：出现第一个在 `help` 里写"授权后模型能看到你的 XX"的组件。

## 4. 接口与数据

**桥方法 / Tauri 命令**

`assistant_widget_tools` 的签名**不变**（`src-tauri/src/agent.rs:656` 无参）。模式不走参数，走 op：

```
op: "widget-tools"
→ { op: "widget-tools", everything: bool }   // Rust 从 hands_state 读 mode 塞进来
← { tools: WidgetToolSource[] }
```

理由：小窗没有 store，模式只有一个真源（`assistant.json`），而 Rust 已经在读它（`hands::hands_state`）。让前端再猜一次，就有两个真源。

新增动作走既有 `agent.ts` 的 switch，不新增 Tauri 命令：

```
op: "config.set"
参数: { instanceId: string, patch: Record<string, unknown> }
返回: { ok, config }        // 归一化之后的完整配置，不是 patch
错误: not_found（没有这一份）/ bad_args（未知键、越界、类型错、空 patch）
```

只读档不会走到这里 —— `toolsFor` 把 `deny` 的动作连 schema 一起拿掉了，模型调不到。

用 `instanceId` 而不是 `widgetId`：同一个组件摆两份、配置不同是正常用法（`instanceIdFor`），按 widgetId 改会改到错的那一份 —— 和 `callWidgetTool` 同一条判据。

**落盘格式与迁移**

无新文件。`config.set` 写的是既有的每实例配置（`runtime/config.ts` 的归一化 + 合并），**写前归一化、写后回读一次**再返回，避免非法值落盘之后面板打不开。

**要改的文件**

| 文件 | 改什么 |
| --- | --- |
| `src/runtime/widget-tools.ts` | `widgetToolSources(candidates, opts?)` 多一个 `assumeGranted` |
| `src/platform/widget-tools.ts` | `listWidgetTools(records, everything)` 透传 |
| `src/platform/agent.ts` | `op: "widget-tools"` 读 `request.everything`；新增 `config.set` |
| `src-tauri/src/agent.rs` | `assistant_widget_tools` 把 mode 塞进 op |
| `src/runtime/assistant.ts` | `approvalFor` 认 `config.set`；`TOOL_SPECS` 加一条；**`WIDGET_DENIED_ACTIONS` 也加**（组件借手那条路不能改别的组件的配置，和 `placement.remove` 同一条理由） |
| `src/platform/AssistantPanel.tsx` | 确认条加那句"包括你没逐个授权的" |
| `docs/AGENT_ACCESS.md` / `AGENTS.md` / `README*` | "8 个动作" → "9 个"，补 `config.set` 的威胁模型 |

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 完全访问下模型仍说"没有 X 组件的工具"，主窗里明明有 | 小窗那条路没把 mode 塞进 op（`assistant_widget_tools` 还是旧形状） | 模式只有一个真源，两个宿主都从 Rust 读；补一条断言钉住"小窗拿到的表和主窗一样" |
| 退出完全访问后，模型还能调某个没授权的组件工具 | 把 `assumeGranted` 顺手写进了 `grants` | 只在算表时看不看，绝不写盘 |
| 模型改完配置，组件白屏 / 面板打不开 | `config.set` 直接浅合并，没过归一化 | 写前归一化、写后回读；非法值当场拒绝而不是落盘 |
| 用户不知道是谁改了配置 | 审计只记形状（`at/op/detail/status/ms`） | 审计记 `instanceId` + **改了哪几个键**（不记值 —— 值可能是隐私） |
| 两个实例，模型改了错的那一份 | 按 `widgetId` 定位 | 必须 `instanceId` |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/widget-tools.html` | +4 | `assumeGranted` 把"装了 / 声明了 / 没授权"的放进表；不传时行为与今天逐字节一致；"没装"仍被滤掉；"没声明工具"仍被滤掉（62 → 66） |
| `tests/assistant.html` | +7 | `config.set` 在 `everything` allow、`auto` ask、`readonly` deny；`readonly` 下它不在表里；组件借手那条路（`caller === "widget"`）拿不到它（199 → 206） |
| `tests/agent.html` | +11 | 第 9 个动作走真 store；未知键 / 越界 / 类型错 / 空 patch 各拒一次；`instanceId` 不存在时报 `not_found` 而不是静默成功；回的是归一化后的完整配置（70 → 81） |

**手工验一次**：装两个组件（一个授了 `agent:tools`、一个没授）→ 切完全访问 → 让模型"列出两个组件各自的数据" → 两份都答得出来 → 退出完全访问 → 同一个问题，没授权那份**答不出来** → 审计里那几行带 ` · everything`，且 `config.set` 那行记了键名不记值。
