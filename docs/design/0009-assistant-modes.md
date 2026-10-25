---
status: accepted
date: 2026-10-25
supersedes: 0006
code: src-tauri/src/hands.rs, src-tauri/src/hands_policy.rs, src-tauri/src/llm.rs, src/runtime/hands.ts, src/runtime/assistant.ts, src/platform/AssistantPanel.tsx, src/platform/assistant.ts
---

# 0009 —— 两个模式：内部 / 全部（推翻 0006 的"定时授权"）

> 用户的原话：**"开全权（我希望有个开关可以打开）……它有两个模式，一个只是管理内部的，一个是管理全部的，像我一样。"**
> 0006 定的是"一次 30 分钟的定时授权，到点自动关，没有开关"。它防住了"忘在 `auto` 上"，
> 却没回答"我就是要把它当正常 agent 长时间用" —— 每半小时回来点一次，等于把它当实验品。
> 这一份把 0006 的**定时**换成**一个能一直看见、随时能切的模式开关**。

## 1. 问题

0006 之后摆着的事实是：用户要的不是"这半小时随便动"，而是"**这个助手有两种人格**"——

- **内部**：管桌面。挪组件、改主题、开关手、装好的组件互相通气（组件声明的工具）。它不该碰 `C:\` 上的任意文件，因为那是"平台的事"之外。
- **全部**：像我这样。读文件、跑命令、抓网页、点键鼠 —— 一个正常的 agent。

而"开关"这个词本身就是答案：用户要的是**一个状态**，不是一个倒计时。倒计时解决的是"我忘了关"，
但代价是"我一直被打断"。这两件事可以用**可见性**换掉，不必用中断换。

## 2. 候选

| | A：定时授权（0006） | B：持久模式开关 | C：每轮开场选一次 |
| --- | --- | --- | --- |
| 长任务 | 每 30 分钟打断一次 | 不打断，一直在那个模式下 | 每轮都要选，最烦 |
| 忘记关 | 不存在 | 存在 | 不存在 |
| 心智模型 | "一次授权" | **"两种模式"（用户原话）** | "每轮临时决定" |
| 代价 | 把它当实验品 | 需要一个一直看得见的标识 | 会话文件多一个字段 + 每次多点一下 |

选 B。风险用**常驻可见 + 一次性确认 + 审计**兜，不用中断兜 —— 这也是桌面软件里"模式"的通用做法（代理开关、飞行模式）。
C 被否得再补一句：它把"我刚才干到哪了"和"我现在是什么模式"混在一份文件里，而这两个问题的生命周期不一样。

## 3. 决定

**一个开关，两种模式，存盘。**

| | 内部（默认） | 全部 |
| --- | --- | --- |
| 工具表 | 8 个桌面动作 + 组件声明的工具 + **你拨开的那几组手**（默认六组全关） | 再加六组手（文件 / 命令 / 网页 / 屏幕 / 键鼠 / MCP），不管你存的是什么 |
| 审批 | 照 `approvalMode`（默认每次问） | **不问**（问就不叫全部了） |
| 六组开关 | **照存的开关**：内部 = 你开哪几组就有哪几组；一条「给 agent 权力」可一次全开 | 忽略存的开关，**临时全开**（不写盘、不改那六个值） |
| 预算 | 24 步 / 5 分钟 / 20 万 token | **一模一样**（模式是权限，不是预算） |

- **模式管"要不要问"，开关管"能不能"**。内部不是"一只都不给"，而是"给的就是你在面板上
  拨开的那几组" —— 所以内部模式里也有两条给权力的路：一组一组拨，或者点一下「给 agent 权力」
  六组全开。**两条路都只写开关**（`grantAllHands`），`mode` / `approvalMode` / `workspace`
  一概不碰：用户按完还能逐组拨回去，面板上看得见自己开了什么。切模式那条路（`saveMode`）
  和它必须分开，否则用户分不清哪些手是他开的、哪些是模式替他开的。
- 存进 `assistant.json` **v4**：`mode: "internal" | "everything"`。坏值落 `internal`
  —— 和所有坏值同一条：**不许扩大权限**。
- 切到 `everything` 弹**一次**确认，把四条硬线印在上面；切回 `internal` 不问（往安全方向走不用点头）。
- **常驻可见**：面板顶部一条模式条（`Everything` 用警示色 + 一行
  "Files, commands, the web, the screen, input and MCP servers. Approvals are not asked."），
  窗口标题栏那个点跟着变色。切换本身进审计：`assistant.mode` 一条。
- 四条硬线沿用 0006 §3（不因为换成开关就松）：
  1. 装 / 卸 / 授权 / 钉钥匙**不在工具表里**；
  2. 改平台自身配置（`assistant.json` / `mcp.json` / `state.json` / `skills/**`）**永远要问**；
  3. 组件借手那一轮（`caller === "widget"`）拿不到 `everything`；
  4. agent 的 HTTP 端点不受影响。
- 审计：每次调用行尾 ` · everything`；**写不进去就不执行**（fail-closed），别的模式照旧。
- 和审批档的关系：模式管"能碰什么"，档管"要不要问"。`everything` 下不问，但 **`readonly` 仍然优先**
  —— 用户在只读档里，模式条显示"被只读档压住"，调用照拒。
  **不做"切模式顺手把档改掉"**：一个设置不该偷偷改另一个设置（0006 也守着这条）。

## 4. 接口与数据

```json
// assistant.json v4（v3 读到就地升级：mode = "internal"，手全关，不替用户开门）
{ "version": 4, "mode": "internal", "activeId": "…", "hands": { … }, "approvalMode": "ask", "workspace": "", "profiles": [ … ] }
```

```
assistant_mode()                 → { mode, effective }     // effective 已经算过 readonly 压制
assistant_mode_set(mode)         → 同上（写盘 + 审计一条）
```

- Rust：`llm::hands_state` 多一个 `mode`；`hands::run` 用 `mode == "everything"` 判（**替换**
  `full_access_view` / `full_access_overrides` / `assistant_full_access*` 那一套 —— 0006 的骨架还没接线，删掉没有兼容负担）；
  `shape_of` 的后缀换成 ` · everything`。
- 前端：`runtime/hands.ts` 的 `effectiveHands(hands, mode)` / `modeIgnoresSwitches(mode)` /
  `grantAllHands(hands)`（只写开关那六个值，是「给 agent 权力」那颗按钮的唯一实现）；
  `runtime/assistant.ts` 的 `approvalFor(name, mode, ctx)` 里 `ctx.fullAccess` 改名 `ctx.everything`；
  `AssistantPanel.tsx` 模式条 + 确认框 + 手那一段的两颗按钮（「给 agent 权力」/「全关」）；
  `runtime/i18n/assistant.ts` 新文案。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 忘了还在「全部」模式 | 开关是持久的（这是它的价格） | 启动后第一次打开面板时，若存的是 `everything` 就提示一次；之后靠常驻模式条，不再打断 |
| 以为切回「内部」就安全了，但它还能读文件 | 会话里正在飞的一轮拿的老工具表；或那几个开关本来就是开的 | 每次调用现查模式（Rust 那一层），不是每轮开头查一次；内部模式**不替用户关手**（一个设置不该改另一个），要全关按「全关」 |
| 以为「内部」等于一只新手都没有 | 第一版文档就这么写的，代码一直是照开关 | 内部 = 你拨开的那几组，面板上手那一段写明它，模式条悬停也写明；要有权力就一颗按钮全开 |
| 只读档 + 全部模式 | 两个状态冲突 | `readonly` 优先，模式条写明"被只读档压住" |
| 文件被手改成乱码 | 坏值 | 落 `internal`，手全关；**绝不**因为一个坏值变成全开 |
| 审计写不进去 | 磁盘 / 权限 | 全部模式下 fail-closed（`code: "audit"`），内部模式照旧 |
| 组件借手那一轮想要全部 | 那条路没有确认条 | 硬拒：`caller === "widget"` 一律 `internal` |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/hands.html` | 103 条 | `effectiveHands` 按模式给表、`internal` 照开关（原样返回）、`grantAllHands` 六组全开且不碰档位与工作目录、坏值落 `internal` |
| `src-tauri/src/hands_policy.rs` | 改 | `normalize_mode`（`internal` / `everything`，坏值落 internal）、`mode_overrides_approval`（只读优先）、`effective_hands` 内部照开关 |
| `tests/assistant.html` | +4 | `approvalFor(..., { everything: true })` 的三条例外 |
| 手工 | — | 切到「全部」→ 写 `C:\` 下临时文件**不问** → 审计行尾带 ` · everything` → 切回「内部」→ 同一操作**弹确认条** → 让它改 `assistant.json`（**仍然弹**）→ 重启（模式记得住，这次是**故意**的） |
