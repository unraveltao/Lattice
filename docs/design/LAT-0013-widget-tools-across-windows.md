---
status: accepted
date: 2026-10-26
code: src/platform/widget-tools.ts, src/platform/assistant.ts, src/platform/agent.ts, src/runtime/widget-tools.ts, src-tauri/src/agent.rs
---

# 组件工具在小窗那一轮也能用（清单与执行都问宿主）

## 1. 问题

数据平面（0003 的 B 一类，落地在 v0.11）的前提是"模型能调组件自己声明的工具"。它做出来了，也有一条官方用户（`lattice.diagram`）——但**在装好的应用里没人能用**。

原因不在数据平面本身，在 assistant 住哪儿：

- 桌面应用里 assistant 是**一个独立小窗**（0007），`Ctrl+K` 开关它。主窗口里那个抽屉只在浏览器预览里出现（`App.tsx` 里那句 `!isTauri()`）。
- 小窗**不加载平台外壳**：它没有 `records`（组件清单），`useLattice` 那份 store 里既没有 `placements` 也没有 `grants`。
- 组件工具清单当时是在面板里用 `useLattice` 现算的。于是小窗算出来的**永远是一张空表**——模型看不见 `widget.lattice.diagram.draw`，用户问"帮我画个图"它只会说"我没有这个工具"。
- 就算它看见了也调不动：答话的是**画布上的 iframe**，而那些 iframe 只在主窗口的 React 树里（小窗自己 `callWidgetTool` 只会拿到 `not-running`）。

所以这条不是"少一个功能"，是**功能在唯一会用到它的窗口里是空的**，而且没有任何报错——看起来像"这个能力还没做"。

## 2. 候选

| 做法 | 为什么不行 |
| --- | --- |
| **A. 给小窗一份只读清单**（AGENTS §8 当时写的两个选项之一） | 只能让它**知道**有这些工具，执行仍然敲不动 iframe。结果更糟：模型会调、每次都失败，它没有任何办法从失败里学到"这个小窗做不到" |
| **B. 小窗自己执行** | 不可能：`registerCanvasWidgetTools` 的处理器绑在画布的 `WidgetFrame` 上，另一个 webview 碰不到 |
| **C. 清单与执行都收进 `AssistantSurface`**（选中） | 宿主（主窗口 / 小窗）自己回答"这一轮能调什么、怎么调"。小窗那条走 IPC 问主窗口要，主窗口那条就地算 |
| **D. 把数据平面挪进 agent 端点（HTTP）** | 等于给"调组件"多开一扇只需 token 的门，而它本来该只存在于平台自己的界面里（威胁模型见 AGENT_ACCESS §2）。走 IPC 不扩大暴露面 |

C 还顺手修掉一个**结构问题**：清单的拼装原来在面板里，而面板跑在两个窗口里——"同一份东西两个地方拼"正是这个仓库反复踩的那类坑（判据散开会漂，0011 / 0004 §5 都是同一句话）。

## 3. 决定

1. **清单的拼法是纯逻辑，只有一份**：`runtime/widget-tools.ts::widgetToolCandidates`（清单 × 摆放）+ `widgetToolSources`（装了 / 授了 / 真声明了）。前者**只拼不筛**，筛只发生在后者——预先筛一遍等于把判据变成两份。
2. **平台那一侧只做"读状态"**：`platform/widget-tools.ts::listWidgetTools(records)` 把 store 的 `placements` / `installedIds` / `grants` 喂进上面那个纯函数。两个窗口都调它——但**小窗调的是自己那份空 store**，所以小窗走第 3 条。
3. **`AssistantSurface` 加两个方法**：
   - `widgetTools(): Promise<WidgetToolSource[]>`：这一轮能调什么。主窗口 → `listWidgetTools`；小窗 → `assistant_widget_tools`（IPC 转给主窗口）。
   - `callWidget({instanceId, widgetId, tool, args})`：真去敲一份实例。主窗口 → `callWidgetTool`；小窗 → `assistant_widget_call`。
4. **两个新 op，两个新命令**（Rust 侧只是转发，不解释）：
   - `op: "widget-tools"` → 同步，回 `{ok: true, result: {tools: WidgetToolSource[]}}`。
   - `op: "widget-call"` → 异步，回 `{ok: true, result: WidgetToolReply}`。**外层 `ok` 说的是"送到了没有"，里层那个 `ok` 才是"组件答成没答成"**——两者的区别模型要看得到（`not-running` 时它该换一句话说，不是重试）。
5. **执行前第二道校验**（`runWidgetCall`）：`instanceId` / `widgetId` / `tool` 三个都非空；那份实例必须是 `listWidgetTools` 里的一条（装了 + 授了 + 摆着）；这条工具必须是它**真声明过**的。小窗是平台自己的界面，但"平台自己的界面"不是跳过校验的理由（和 `assistant_act` 同一条）。
6. **超时分层**：组件那条是 8 秒（`WIDGET_TOOL_TIMEOUT`，"组件没答话"），IPC 那条 **12 秒**（`WIDGET_CALL_TIMEOUT`，"主窗口没答话"）。必须后者更长——两条撞在一起时用户看到的会是后者，而它指向完全错的地方。

面板不再自己拼清单：每一轮开始时向 `surface` 现问一次（清单会随装 / 卸 / 授权 / 摆放变，缓存一份就等于让模型拿着过期的表）。问不到就当没有——这一轮少几条工具，比整轮报错好（和 MCP 发现失败同一条规矩）。

## 4. 接口与数据

| 接口 | 形状 | 谁答 |
| --- | --- | --- |
| `AssistantSurface.widgetTools()` | `WidgetToolSource[]` | 主窗口 / 小窗（IPC） |
| `AssistantSurface.callWidget(input)` | `WidgetToolReply` | 同上 |
| op `widget-tools` | 请求 `{op}`；应答 `{ok, result: {tools}}` | `runAgentRequest`（同步） |
| op `widget-call` | 请求 `{op, args: {instanceId, widgetId, tool, args}}`；应答 `{ok, result: WidgetToolReply}` | `startAgentBridge` → `runWidgetCall`（异步） |
| `assistant_widget_tools` | `() -> Result<String, String>`，8 秒 | `agent.rs` |
| `assistant_widget_call` | `(instance_id, widget_id, tool, args) -> Result<String, String>`，12 秒 | `agent.rs` |

**没有落盘格式变化**：`state.json` / `assistant.json` 一个字段都没动，两个 op 都是读与即时调用。所以没有迁移，也没有"旧文件读到会怎样"。

## 5. 失败模式

| 坏法 | 用户看到什么 | 兜底 |
| --- | --- | --- |
| 主窗口还没接上 `lattice:agent` 桥 | 这一轮没有组件工具，模型说它看不到 | `remoteSurface().widgetTools()` 捕获异常 → `[]`，**不挡这一轮** |
| 组件没装 / 没授 `agent:tools` | 同上（清单里没有它） | 判据仍在 `widgetToolSources`；`widgetToolCandidates` 不预先筛 |
| 画布上那份是破卡 / 已经卸了 | 模型收到 `not-running`，换个说法告诉用户 | `callWidgetTool` 的注册表查不到处理器 |
| 小窗递来一个它自己编的 `instanceId` | `not_found`，不执行 | `runWidgetCall` 的第二道校验 |
| 组件忙着（一次长网络请求） | 8 秒后 `not-running` | 组件那条超时；IPC 那条 12 秒不会先喊 |
| 小窗关掉 / 主窗口被销毁 | `assistant_widget_call` 报 `timeout: the main window did not answer in time` | 平台不猜、不重试 |

## 6. 验收

- `tests/widget-tools.html` 48 → **55**：候选表只拼不筛（一个 placement 一条、`title` 用 id、`installed` / `granted` 照实标、拼完再过一遍判据、没摆的不进表）。
- `tests/agent.html` 59 → **70**：`op: "widget-tools"` 在没授权时是空表、授权后带着实例与工具声明；`op: "widget-call"` 的四种拒法（缺参数 / 不是这个组件的实例 / 没声明过的工具 / 画布上没有）与"登记了处理器就原样答话"。
- `npm run typecheck`、`cargo check --all-targets` 干净。
- **真机那一段没验**（记在 AGENTS §8）：小窗 ↔ 主窗口这条 IPC 只在桌面应用里跑得起来。要走的顺序是：装 `lattice.diagram` 并授 `agent:tools` → 摆一张到画布 → `Ctrl+K` 问"帮我画个流程图" → 它该调 `widget.lattice.diagram.draw` 并在卡片里画出来 → 撤掉 `agent:tools` 再问，它该说没有这个工具（而不是调了失败）。
