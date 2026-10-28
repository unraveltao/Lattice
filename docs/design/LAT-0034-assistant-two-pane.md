---
status: accepted
date: 2026-10-28
supersedes:
code: src/platform/AssistantPanel.tsx, src/styles.css, src/runtime/assistant.ts, src-tauri/src/assistant_window_policy.rs, src-tauri/src/assistant_session.rs
---

# LAT-0034 —— assistant 改成两栏，落地页从设置改回对话

## 1. 问题

两件事，同一屏：

1. **每次打开都落在设置页。** `AssistantPanel.tsx` 一打开就读模型档，`configured === false` 就 `setView("setup")`。判据本身没错，错的是**用整页表单去回答一个"能不能用"的问题**——用户点开助手是想说话，看到的是模型档、六只手、MCP、技能包四张表，每张都在等他填路径或 key。用户原话是"每次打开都是一堆提问，让用户看到很烦"。
2. **单栏放不下会话列表。** 窗口 `400 × 580`，历史会话只有一条下拉框。下拉框一次只看得见一份，而用户要的是"上周那份周报在哪儿"。

## 2. 候选

| | A：只改样式 | B：两栏 + 落点改对话 | C：设置搬回主窗口 |
| --- | --- | --- | --- |
| 做法 | 保持单栏，压缩设置页的文案与间距 | 左栏会话/设置分区，右栏对话；没有可用模型时只在对话区顶上一行 | 设置并进主窗口的「设置 → Assistant」，小窗只留指路链接 |
| 换掉什么 | 什么都不换 | 下拉框、`setView("setup")` 的自动跳转、窗口尺寸 | 小窗里的设置整块 |
| 新增什么 | 无 | 会话栏、重命名命令、尺寸迁移 | 主窗口设置多一区 |
| 代价 | 长度没变，只是变整齐——治不了"打开就烦" | 动窗口默认尺寸，老用户窗口会变大一次 | 改一个 key 要离开 assistant；主窗口设置已有七区 |

## 3. 决定

**决定**：B。落点改成"永远先给能说话的地方"——没有可用模型时在对话区顶上一行 `No model is set up yet` + 一颗「去设置」，而不是整页跳转。左栏 208 是会话列表（按今天/昨天/更早分组，悬停出「⋯」→ 重命名/删除），底部一颗「设置」；进设置之后**同一条左栏**变成四个分区，一次只渲染一块。

**代价**：

- 窗口出厂尺寸 `400 × 580` → `880 × 640`，最小宽 `320` → `560`。老用户盘上存着的 400 会被**抬一次**（`migrate_size`），之后按他拖的算。这是"用户的东西自己变了个样子"，所以写进本文而不是悄悄改。
- 设置态四块**仍然全部挂载**，靠 `hidden` 挡着（`.lattice-assistant-pane [hidden] { display: none !important }`）。`ModelProfiles` 那三百行状态每次进设置都会跑一遍，换来的是一次都不用重写它的挂载逻辑。
- 侧栏 208 是写死的，没有"收起"按钮——560 宽时对话只剩 352，但那时用户本来也不该看两栏。

**什么时候该推翻它**：如果真机上一半时间窗口被拖到 560 以下，说明"两栏"这个前提不成立，该退回单栏 + 会话抽屉；或者如果用户开始攒到五十份以上会话，208 那一列需要搜索框，那时再谈。

## 4. 接口与数据

**桥方法 / Tauri 命令**

```
方法名：assistant_session_rename
参数：id: string, title: string
返回：落盘之后的标题（可能被 policy::clean_title 清洗过）
错误：会话文件不在 / id 不合法
```

**为什么不复用 `assistant_session_save`**：那条会把 `updatedAt` 写成现在，于是"改个名字"这份会话就跳到侧栏最上面——用户想改的是名字，不是排序。副作用藏在"保存"这个词里，不写下来没人会想到。

**落盘格式与迁移**

`assistant-window.json` **仍是 v2**，字段一个没加。变的只有读盘时的夹紧函数：`clamp_size` → `migrate_size`。差别是判据——`clamp_size` 把"比最小还小"当坏值夹回最小；`migrate_size` 把"比最小还窄"当**旧出厂值**，直接抬到新出厂值。用户拖不到 560 以下（`min_inner_size` 挡着），所以这个判据不会误伤真有人拖出来的窄窗口。

**要改的文件**

- `src/platform/AssistantPanel.tsx`：落点、两栏、会话行、设置分区、空态
- `src/platform/assistant.ts`：`renameSession`
- `src/runtime/assistant.ts`：`sessionBucket` / `groupSessions`（纯逻辑，能单跑）
- `src/styles.css`：`.lattice-assistant-panes` / `.lattice-assistant-rail` / `.lattice-rail-*` / 空态 / 通知条
- `src-tauri/src/assistant_window_policy.rs`：`MIN_W` / `DEFAULT_*` / `migrate_size`（`clamp_size` 删掉，没人用了）
- `src-tauri/src/assistant_session.rs` + `lib.rs`：改名命令与注册

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 打开助手是一片空白，只有一个输入框 | 没有可用模型，但那一行通知被当成"空态的一部分"藏掉了 | 通知在空态**之上**，两者互斥（`entries.length === 0 && !modelMissing`）——空态是"说点什么"，通知是"先说不了" |
| 改完名字，那份会话跳到最上面 | 走了 `saveSession`，`updatedAt` 被写成现在 | 走 `renameSession`；重命名不动时间戳 |
| 升级之后窗口变得很大，用户以为坏了 | `migrate_size` 把 400 抬到 880 | 只抬一次（写回也走这一道），且这是唯一一次能"自己变样子"的窗口改动 |
| 设置里点「技能」，内容还在上面那块 | `hidden` 被 `display: flex` 压掉 | `.lattice-assistant-pane [hidden]` 那条 `!important`；没有它四块会同时显示 |
| 侧栏菜单指向一个已经滚走的行 | 菜单 portal 到 body，侧栏滚动时它留在原地 | 菜单 `position: absolute` 挂在行内，跟着行走 |
| 删掉当前会话，右栏还留着那段对话 | 先删文件后清界面 | 先 `startNewChat()` 再删（和旧的删除按钮同一条顺序） |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/assistant.html` | 188 → 198（+10） | 今天零点怎么算、夏令时、未来时间戳、空桶不出现、组内保序 |
| `src-tauri/src/assistant_window_policy.rs` | 10 | 旧 400×580 抬到 880×640、拖出来的尺寸原样留、坏值落回出厂值 |

**手工验一次**：

1. 删掉（或改名）`assistant-window.json` 里的 `rect`，重开小窗 → 应是 880×640。
2. 把它手改成 400×580，重开 → 应被抬到 880×640，且文件里写回的也是 880×640。
3. 拖窄到极限 → 停在 560，右栏文字不横向溢出。
4. 侧栏点「⋯」→ 重命名 → 回车；再打开列表，顺序**没变**。
5. 断网 / 删掉模型档 → 打开助手应停在对话页，顶上一行「还没有可用的模型」。
