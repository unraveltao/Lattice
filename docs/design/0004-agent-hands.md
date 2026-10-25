---
status: accepted
date: 2026-10-25
code: src/runtime/assistant.ts, src/runtime/hands.ts, src/platform/assistant.ts, src/platform/hands.ts, src/platform/AssistantPanel.tsx, src-tauri/src/hands.rs, src-tauri/src/hands_policy.rs, src-tauri/src/fs_policy.rs, src-tauri/src/shell_policy.rs, src-tauri/src/web_policy.rs, src-tauri/src/screen_policy.rs, src-tauri/src/input_policy.rs, src-tauri/src/mcp.rs, src-tauri/src/mcp_policy.rs
---

> **落地状态**：P1（纪律）／P2（文件）／P3（命令）／P4（网页）／P5（屏幕与键鼠）／P6（外部服务）全部落地，见 §9。

# 0004 —— 给 assistant 一双手：文件、命令、网页、屏幕、外部服务

## 1. 问题

用户的原话：**"我要给他配置成和其他 agent 一样的效果。能读文件、跑代码、上网查东西、调用各种外部服务，调用屏幕功能都可以。"**

现在的 assistant 只有八只手，而且全是同一个执行器（`runtime/agent.ts` 的 `AGENT_ACTIONS`）：
加/挪/缩放/删/钉/置顶组件、换主题、暂停全部。它能收拾桌面，**不能干活**。

## 2. 这张桌子已经定了什么，以及哪几条要翻

0003 §3 的"不做"里明写过两条：**"手不扩到装组件/写组件"**、**"不给截屏 / 读屏"**。
0004 推翻的是第二条的一半，以及"手不扩"这件事本身。翻的理由不是"用户想要"，是：

> 一个能读文件、跑命令的助手，实用价值和"会摆桌面的助手"不是一个量级；而**危险已经不在"它碰桌面"这一侧** —— 桌面动作最坏是摆歪（8 秒撤销），读文件最坏是把 `~/.ssh` 念出来。也就是说，继续守着"手不扩"并不让平台更安全，只是让它更没用。

保住的四条（不是"以后再说的加固"）：

- **组件侧的手不扩**。`assistant.ask` 永远只有那八个别名里的七个（少删除），新的手**一条都不给组件**。理由是"你信不信任这段代码"和"你敢不敢让它跑命令"是两个问题，`desktop:control` 这一项权限不该顺带变成 shell。`toolsFor("widget")` 是唯一的闸门。
- **桌面动作仍然只有一个执行器**（`AGENT_ACTIONS` + `runAgentAction`），新的手走另一条通道，两张表不合并、不交叉。
- **key 仍然只在 Rust 里**，新工具拿不到它；模型档、审批档、能力的开关都落在 `assistant.json`（前端整体回写 `state.json` 那条路会互相盖）。
- **没有后台自主**。所有新的手都只在"用户说了句话"之后动，且写/跑/点按必过审批。

## 3. 这次探到的三个硬事实

1. **网关认 SSE**（已真机验过：`content-type: text/event-stream`、chunked、`data: [DONE]`），所以流式不需要改。
2. **网关不认图片**：带 `image_url` 的请求直接 400 —— `At most 0 image(s) may be provided in one prompt. (parameter=image)`。所以"截图给模型看"**在现在这条档上是彻底无效的**：它拿不到像素。结论写进设计而不是留给用户发现 —— 截屏只对**声明了 vision 的档**有意义，文本模型那条路要靠 `screen.windows` 读文字。
3. **模型会先吐 `reasoning_content`**（不算 `content`），所以推理期间气泡是空的。流式没问题，但"停在哪一步"的话术要能解释这段空窗。

## 4. 决定

**分六期，每期自己可交付、可回滚；一次只开一组手，默认全关。**

| 期 | 内容 | 为什么在这个位置 |
| --- | --- | --- |
| **P1 纪律** | 工具分区与调度（`desktop` / `rust` 两类执行器）、审批回调、预算（步数/时间/token）、能力开关（`assistant.json` v3） | 没有审批就先给手，等于把"能不能跑命令"交给一段提示词 |
| **P2 文件** | `file.list` / `file.read` / `file.search`（自动）、`file.write`（问） | 收益最高、语义最稳；纯 Rust，不碰 COM 也不碰进程 |
| **P3 命令** | `shell.run`（问） | 有了它才是"能跑代码"；也是风险最大的一只，审批必须先在 |
| **P4 网页** | `web.fetch`（自动，出网单独一道闸） | 只取页面，不做关键词搜索（用户选的就是这条：没有搜索 API） |
| **P5 屏幕** | `screen.windows`（自动）、`screen.capture`（自动，仅 vision 档带图）、`input.click/type/key`（问） | 文本模型只能靠 window 列表 + 坐标，先给它"看得见"的部分，再给手 |
| **P6 外部服务** | MCP：stdio 与 streamable HTTP，工具动态发现，名字 `mcp.<server>.<tool>`，逐次问 | 工具表从静态变动态，前面五期把工具面稳定下来再做它 |

**审批档（用户选的）**：`read` 自动、`write/exec/input` 必问。确认条三选：`Allow` / `Always this turn` / `Deny`。
`Deny` 不是错误：回给模型 `{ok:false, code:"denied"}`，它能改主意再说一句 —— 而不是整轮崩掉。

> 这一段描述的是**后来叫 `ask` 的那一档**。0003 §3 把审批扩成三档之后，"读自动、写/跑/点按必问"
> 只是默认档的语义；`auto` 档下除 `DANGEROUS_ACTIONS` 之外都不再问，`readonly` 档连 schema 都不给。

**文件边界（用户选的）**：读**全盘**（`file.read` / `file.list` / `file.search` 不限目录），
**写要问**，且确认条上写完整路径。`workspace` 只是一个默认 cwd（`shell.run` 与截图落盘的地方），
不是围栏 —— 假装它是围栏比不设更危险。

> **`workspace` 后来多了一个身份**（[0005](./0005-skills-and-workspace.md)）：它成了 `file.write` 的
> **免问区** —— 落在里面不问、外面照旧问，而且**只对 `file.write` 生效**。所以它不再是"只是一个默认
> cwd"，但也仍然**不是围栏**：`shell.run` 一条命令就能写出这棵树，那句"假装它是围栏比不设更危险"
> 一个字都没过期。

**预算**：`MAX_STEPS` 6 → **24**（真 agent 一轮二十来步很正常）；
`MAX_TURN_MS = 300_000`、`MAX_TURN_TOKENS = 200_000`；三者任一触顶都停，并且**说清是哪一条**。

**工具的 schema 与执行分开**（沿用现在的规矩）：schema 在 `runtime/hands.ts`（纯逻辑，能被
`tests/hands.html` 钉），执行在 Rust（`hands.rs`）。Rust 返回的形状和 `AgentReply` 一样
（`{ok, code?, error?, result?}`），循环里不需要认第二种形状。

**调用链**

```
runAssistantTurn → callTools
   ├─ desktop：surface.act(name, args) → runAgentAction（主窗口 store）
   └─ rust    ：invoke("assistant_tool", {requestId, name, args}) → hands.rs
                  ├─ fs / shell / web / screen / input（本期）
                  └─ mcp（P6）
```

`requestId` 带下去是为了"停止"：`llm_chat_cancel` 之外再加一条 `hands_cancel{requestId}`，
`shell.run` 的等待循环每 100ms 看一次标志（进程真的 `kill()`，不是"等它自己结束"）。

## 5. 接口与数据

**`assistant.json`（设计时写的是 v3，落地是 v4）**

```jsonc
{
  "version": 4,
  "activeId": "p-…",
  "mode": "internal",               // internal | everything —— 0009 加的，v3 时还没有这一条
  "approvalMode": "ask",            // ask | auto | readonly —— 见下面那条注
  "hands": { "files": false, "shell": false, "web": false, "screen": false, "input": false, "mcp": false },
  "workspace": "D:\\GitDev\\lattice",
  "skills": { "enabled": [] },      // v4 加的（0005）
  "profiles": [ … ]
}
```

> **`"approval": "read-auto"` 这个写法没有落地。** 本文定的是"固定语义、只有一档、不做开关"，
> 而 0003 §3 的审批三档随后落了地，字段名也就成了 `approvalMode`。上面那张工具表的"批"一栏
> （自动 / 问）读的仍然是 `ask` 档的语义 —— 换成 `auto` 之后，除了 `DANGEROUS_ACTIONS` 那几条，
> "问"都不再问；换成 `readonly`，整张桌面表是空的，手那一半也只给 `deny` 以外的。

- **默认全 `false`**：升级上来的 v1/v2 档一条手都不开，用户自己拨。
- 归类不对的调用（能力关着但模型调了）→ `{ok:false, code:"disabled"}`，并且提示词里**不出现**这张表里的工具 —— 两边必须一致（`toolsFor` 与 `systemPrompt` 用同一份）。

**Tauri 命令（新增）**

```
assistant_tool({ requestId, name, args })  -> String          // AgentReply 形状的 JSON
hands_cancel({ requestId })                -> bool            // 幂等
assistant_hands()                          -> HandsSettings   // 六个开关 + workspace + approvalMode（扁平）
assistant_hands_save(hands)                -> HandsSettings
```

> 设计时想的是 `{ approval, hands, workspace }` 三层包着，落地拍平了：`HandsSettings` 就是
> 六个 `bool` + `workspace` + `approvalMode`（`#[serde(rename_all = "camelCase")]`）。拍平的理由很实在 ——
> 这份载荷整个就是"手那一段设置"，再套一层壳只是让前端多写一次 `.hands`。`mode` 走的是
> 另一对命令（`assistant_mode` / `assistant_mode_set`），因为它不属于手那一段。

**工具表**（名字、审批、能力组）

| 名字 | 批 | 组 | 返回 |
| --- | --- | --- | --- |
| `file.list` | 自动 | files | `{path, entries:[{name,dir,size}], truncated}` |
| `file.read` | 自动 | files | `{path, text, lines, truncated}`（200 行 / 40k 字） |
| `file.search` | 自动 | files | `{matches:[{path,line,text}], scanned, truncated}`（100 条 / 5000 文件） |
| `file.write` | 问 | files | `{path, bytes, created}` |
| `shell.run` | 问 | shell | `{code, stdout, stderr, timedOut}`（默认 60s，上限 300s；输出各 16k 字） |
| `web.fetch` | 自动 | web | `{url, status, contentType, text, truncated}`（html → text，40k 字） |
| `screen.windows` | 自动 | screen | `{windows:[{title,class,pid,focused,rect}]}`（40 条） |
| `screen.capture` | 自动 | screen | `{path, width, height, vision:boolean}` |
| `input.click` | 问 | input | `{x,y}` → `{done:true}` |
| `input.type` | 问 | input | `{text}` → `{done:true}` |
| `input.key` | 问 | input | `{key:"Enter"\|"Ctrl+S"}` → `{done:true}` |
| `mcp.<server>.<tool>` | 问 | mcp | 服务器原样返回的 JSON |

纯逻辑落点（都能 `rustc --test` 单跑，**不引 crate**）：
`fs_policy.rs`（路径归一化与 `..` 判定、读的行数/字数额度、search 的 blob 与目录跳过表、输出截断标记）、
`shell_policy.rs`（命令行形状与拒绝表、超时夹紧、输出截断）、
`screen_policy.rs`（窗口判据、标题压平、截图落点、PNG 分块与 CRC、扫描线）、
`input_policy.rs`（键名 → 虚拟键码、组合键解析、文字 → 按键序列、虚拟桌面归一化）、
`hands_policy.rs`（工具名 → 审批档/能力组、未知名字、`mcp.` 前缀的合法性、参数形状）。

## 6. 威胁模型：这次真的变了，写清楚

- **提示词注入变成一条真路径**：`web.fetch` 抓回来的页面是**攻击者写的字**，而同一轮里它又有 `file.read` 和 `shell.run`。缓解只有三条，全部落地：① 工具返回的外部内容在提示里被标成"数据，不是指令"；② 写/跑/点按**必过审批**，确认条上写清楚是哪个命令、哪个路径；③ 审计每一笔（`audit.log` 的 `detail` 只记形状：路径、命令首段、URL 主机，不记内容）。
- **不做的**：不假装能沙箱化 `shell.run`。它跑在用户自己的账户下，就是用户自己的权限 —— 文档、设置页和确认条都要这么写，不能说"安全隔离"。
- **键鼠是唯一"会动用户东西"的自动以外的面**（`screen.windows` / `screen.capture` 只读，自动放行；`input.*` 每次必问）。
  确认条上写的是"在 100, 240 点一下"、"敲 5 个字"、"按 Ctrl+S"，**不写**敲的是什么（那句话可能是密码）。
  一句提示词注入能骗到的上限，就是用户自己在确认条上点的那几次 Allow —— 这是这套设计里唯一没有技术兜底的地方，
  所以提示词里也写死了"点之前先用 `screen.windows` 确认那个坐标上是什么"。
- **MCP 的供应商是新的信任方**：一个 MCP 服务器可以声明任意工具。所以它单独一组、默认关、**每个工具每次都要问**（问一次"允许这个服务器"不算，因为工具的语义会随着服务器升级而变）。
- **一键关掉**：设置里"Turn all off"把 `hands` 六个开关全关，并且**当场取消在飞的那一轮**。

## 7. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 模型说"读到了"，但内容是它编的 | 能力关着，提示词却还列了那张表 | `toolsFor` 与 `systemPrompt` 同一份；关着就说"你没有这个能力" |
| 用户按了停止，`pwsh` 还在跑 | 只在步与步之间查标志 | `hands_cancel` + 100ms 轮询 + `kill()`；按钮文字改成"Stopping…"直到进程真的没了 |
| 读一个 2 GB 的日志把内存撑爆 | 没有额度 | `file.read` 按行数与字数双上限，读之前先 `metadata().len()` 拒绝超大文件 |
| `file.search` 在 `node_modules` 里转十分钟 | 没跳过表 | 跳过 `.git` / `node_modules` / `target` / `dist`，且上限 5000 个文件、单文件 1 MB |
| 中文输出变乱码 | 按字节切片拼 `String` | 进程输出按 UTF-8 解码，坏字节替换；截断只在**行边界**上切 |
| 确认条还没弹，命令已经跑了 | 审批放在执行之后 | 审批必须在 `assistant_tool` **之前** await |
| 窗口列表里 300 个幽灵窗口 | 没过滤 | 只要 `IsWindowVisible` 且标题非空的顶层窗口，上限 40 |
| 截图存到了 `C:\Program Files` | 默认落在 cwd | 落在 `workspace`（没配就 `%TEMP%`），并在返回里写绝对路径 |

## 8. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/hands.html`（新） | 97 | 工具名 → 审批档/能力组、关掉一组时工具表少哪些、分期没接的组不给 schema、`describeToolCall` 的新标签、工具结果 20k 字截断、`Deny` 的形状、MCP 发现结果合表（`mcpToolSpecs`）与命令行切词 |
| `tests/assistant.html` | 122 | 预算三种触顶、`MAX_STEPS` 改成 24 后那句提示、`toolsFor("widget")` 里一条新工具都没有 |
| `src-tauri/src/fs_policy.rs` | 14 | `..` 与盘符、行/字数额度、跳过表、大文件拒绝、截断标记 |
| `src-tauri/src/shell_policy.rs` | 9 | 超时夹紧、输出截断、空命令、`\0` 拒绝 |
| `src-tauri/src/web_policy.rs` | 21 | 重定向（绝对 / 协议相对 / 根相对 / `../` / 丢片段 / 非 http 不认）、HTML 变文本（脚本样式整段丢、块级换行、实体解码、`<` 不成标签）、按字符截断、`maxChars` 夹紧 |
| `src-tauri/src/screen_policy.rs` | 21 | 窗口判据（不可见 / cloak / 无标题 / 零尺寸）、标题按字符压平与截断、截图落点、PNG 四块与 CRC、每行滤波字节、stored zlib 的分块 |
| `src-tauri/src/input_policy.rs` | 23 | 键名 → 虚拟键码（含 F1–F24 与 OEM 标点）、组合键解析（无键 / 两键 / `Ctrl++`）、文字 → UTF-16 单元（中文 / emoji / `\r\n` 只算一次）、虚拟桌面归一化与越界 |
| `src-tauri/src/hands_policy.rs` | 12 | 名字→组、未知名字、`mcp.` 形状、参数必填 |
| `src-tauri/src/mcp_policy.rs` | 17 | 三段名字的形状与各段字母表、服务 id 撞名去重（`_2`）、工具段压平、`cmd /C` 命令行的引号、换行分隔 JSON 的切帧、三种请求体 |
| `src-tauri/src/mcp.rs` | 8 | 传输与握手（只有 `cargo test` 跑得了，本机跑不了） |

**手工验**（每期一次）：真机读一个真实文件 → 改它（看确认条 → `Deny` 一次 → `Allow` 一次）→
跑一条会睡 5 秒的命令并按停止（进程要真的没了）→ 抓一个页面 → 列出窗口 → 在 pytest 里点一下
（`screen.capture` 在文本档上要明确说"我看不见图"）。

**不做的**（写在这里，免得下次重新讨论）

- 不做"自动批准所有命令"的开关。要快就点 `Always this turn`，它的寿命只有一轮。
- 不做关键词搜索（用户选的是"只抓网页"）：没有搜索 API、没有服务端，抓搜索引擎 HTML 的结果页是随时会坏的外部依赖。
- 不在组件里开任何一只手（见 §2）。
- 不做后台/定时自主执行 —— 人在环和无人环是两套安全模型。

## 9. 落地记录（P1–P6）

已经接上的：`file.list` / `file.read` / `file.search` / `file.write`、`shell.run`、`web.fetch`、
`screen.windows` / `screen.capture`、`input.click` / `input.type` / `input.key`，以及 P6 的动态一族
`mcp.<server>.<tool>`（工具表里出现什么由用户在 `mcp.json` 里配的服务决定）。
前端两道闸在 `runtime/hands.ts`（`handsTools` 裁 schema、`needsApproval` 定审批档），
Rust 侧 `hands.rs::run` 再独立判一次组开关，纯逻辑在 `hands_policy.rs` / `fs_policy.rs` /
`shell_policy.rs` / `web_policy.rs` / `screen_policy.rs` / `input_policy.rs` / `mcp_policy.rs`。

**设计里没写、动手时才撞出来的十二条**（P1–P5 期间；P6 就是照着这张表走的）：

1. **第四道闸：`HAND_READY`**。`HAND_SPECS` 里 P5 / P6 的 schema 已经写好了（写的时候不用再动表），
   但 `hands.rs` 那边还没有执行分支。只按用户的开关裁 schema 的话，拨一下"屏幕"就会把
   `screen.windows` 递给模型，而每次调用都回 `"not implemented yet in this build"` —— 正是 §7 第一条
   那个失败模式。所以 `HAND_READY` 里没接的组**一律不递**（`handsTools` 与 `handsPrompt` 同源），
   设置面板上那几行也拨不动，并挂一个"后续版本"的标记。**每落一期就把那一组改成 `true`**
   （`web` 在 P4、`screen` / `input` 在 P5、`mcp` 在 P6 翻的 —— 六组现在全是 `true`，这道闸留着给下一个组用）。
2. **读大文件是截断，不是拒绝**。§7 写的是"`metadata().len()` 拒绝超大文件"，
   实际做法是 `take(MAX_READ_BYTES)` 读前 4 MB + `truncated: true` + 行/字数双上限 ——
   拒绝一个 2 MB 的日志会让模型永远读不到它，而"读前 200 行、想看更多就加大 offset"是它能自己处理的。
3. **`file.write` 先写临时文件再换名**（和 `state.rs` 同一条规矩）。半个文件比没有文件更糟：
   用户下一次读到的是既不是旧版也不是新版的东西。
4. **`shell.run` 只杀得掉直接子进程**。`kill()` 打在 PowerShell 上，它再起的 `node` / `cargo`
   可能活下来。这是明知的代价（Windows 上没有便宜的 job object 之外的办法），确认条上写的是
   "跑一条命令"，不是"跑一个进程树"。
5. **UTF-8 前置那一段是必须的**：`$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;`
   不加的话 Windows PowerShell 5.1 按控制台代码页（这台机器上是 GBK）编码管道，中文全是问号。
   另外路径按 `pwsh.exe` → `powershell.exe` → `%SystemRoot%\System32\...\powershell.exe` 三级找 ——
   GUI 进程的 PATH 和用户在终端里的那份不一定一样。
6. **取消与超时都真的 `kill()`**：25ms 轮询 + `child.wait()`，输出由两条 `drain()` 线程按 4×字符上限收，
   不读干净的话子进程写满管道就卡死在那儿，`try_wait` 永远等不到退出。
7. **重定向必须自己跟**。`network.rs` 为了组件白名单把 WinHTTP 的自动跟随关了
   （`WINHTTP_OPTION_REDIRECT_POLICY_NEVER`），所以 3xx 会原样回来 —— `web.fetch` 在
   `web_policy::resolve` 里逐跳解 `Location`（绝对 / 协议相对 / 根相对 / `../` / 只换 query），
   最多 5 跳。**相对地址按字符串拼会静默拼错一级**，症状是"取回来的是别人的 404 页面"。
8. **HTML 变文本有两条暗坑**：`<script>` / `<style>` 整段必须丢（它们的字往往比正文长，且是
   提示词注入最好的藏身处）；`<` 后面不是字母 / `/` / `!` / `?` 时**不能当标签**，否则从那个
   `<` 到下一个 `>` 之间的正文会被整段吃掉。实体只认常见的十几个，认不出来就原样留着 ——
   猜错了是把一句正常的话改坏。
9. **网页那只手没有白名单**，这跟组件那条路是**故意的不同**：用户勾"网页"要的是"能看任何页面"，
   再让他逐站列白名单等于把这功能变成配置作业。收窄靠四件事：只认 http/https、逐跳 ≤5、
   正文 40k 字（`maxChars` 夹在 200–200000）、整组默认关且**取回的内容在提示词里被标成数据**。
10. **窗口列表要先过五道筛**。`EnumWindows` 会把桌面上三百个看不见的东西全报一遍：隐藏窗口、
   被 DWM cloak 掉的（切到别的虚拟桌面之后 `IsWindowVisible` **仍然是 true**，屏幕上却没有）、
   没有标题的辅助窗口、最小化之后 `GetWindowRect` 给的 `-32000` 加零尺寸。少任何一条，模型拿到的
   就是一张假地图 —— 它会照着一个在屏幕外的窗口算坐标，然后去点空气。上限 40 条、焦点排第一，
   并且**把虚拟桌面矩形一起回去**（不算出屏幕多大就没法算点哪儿）。
11. **截图自己拼 PNG，不引图像库**。`BitBlt(GetDC(NULL))` 是"屏幕上此刻可见的东西"（这正好是截图的
   定义，和壁纸那条要"没有窗口的桌面"的路刻意相反）。`GetDIBits` 给的第四字节是 **0** —— 直接当
   RGBA 交出去，整张图是全透明的，看图工具里是棋盘格；必须补 255 并换红蓝。PNG 那一半是纯字节运算
   （签名 / IHDR / IDAT / IEND、CRC32、每行一个滤波字节），放进 `screen_policy.rs` 是为了它能在没有
   图像库的机器上被 `rustc --test` 钉住；压缩那一步用 `flate2`（它已经在依赖里）。
   返回里 `vision: false` 是**诚实的常量**：这一版没有任何一条模型档收得到图片（§3），照着它说
   "我看不见图"比编一段画面好；等 `llm.rs` 学会发图再让它按档回答。
12. **`SendInput` 的绝对坐标按虚拟桌面归一化，且中文只能走 `KEYEVENTF_UNICODE`**。分母必须是
   `SM_CXVIRTUALSCREEN` 而不是主屏宽度 —— 用主屏算，副屏上的点会全部落到主屏右侧那一小块里。
   文字按 UTF-16 单元发（emoji 是两个单元，漏一个就是方块），组合键"修饰键先按、后松"，方向键与
   编辑键带 `KEYEVENTF_EXTENDEDKEY`（不带的话 NumLock 开着时 `Home` 会被当成小键盘的 7 —— 这种错
   只在某些机器上出现，本地永远复现不了）。审计只记形状：点击记坐标、**打字记字数**（敲进去的
   可能是密码）、组合键记键名。

### P6 落地 —— 外部服务（2026-10-25）

`mcp.<server>.<tool>` 接上了。设计写的是"stdio + streamable HTTP、动态发现、逐次问"，落地时补记六条：

13. **工具名是三段，`id` 必须由 Rust 生成并复用**。用户只填 `label` / `transport` / `command`+`args` 或 `url`；
    `id` 是 Rust 从 label（没 label 就从命令）压出来的 `[a-z0-9]` ≤32 段，撞名加 `_2`。**id 进了工具名**，
    所以第二次保存必须把已有的 id 带回去 —— 界面只读写其余字段。换一次 id 等于模型记着的老工具名全部失效，
    而它不会报错，只会绕着"工具不存在"重试（§7 第一条那个失败模式的变体）。
14. **两种传输都手写，不引 MCP SDK**。stdio 是 `cmd /C` 起子进程（`CreateProcess` 的引号规则在
    `mcp_policy::quote_arg`，`CREATE_NO_WINDOW` 免得每次调用闪一个黑框）+ 按 `\n` 切的 JSON-RPC 帧；
    HTTP 是 streamable POST —— `Accept` 同时要 `application/json` 与 `text/event-stream`，服务器给的
    `Mcp-Session-Id` 要原样 echo 回去，SSE 的 `data:` 帧按 `id` 认领。为这两百行引一个 SDK，等于把
    "服务器怎么起、帧怎么切"从 17 条 `rustc --test` 换成一份读不完的依赖。
15. **握手顺序不能反**：`initialize`（`PROTOCOL_VERSION = "2024-11-05"`）→ `notifications/initialized` →
    `tools/list`。漏掉中间那条通知，服务器**不报错**，只是对后面的 `tools/list` 保持沉默 ——
    症状是"30 秒超时"，而不是"握手错了"。
16. **一次调用一条连接，不做连接池**。省掉"谁负责重连 / 超时的连接算不算死 / 子进程什么时候杀"三个问题；
    代价写明：`npx` 那类服务每次调用都要重付一次启动（几秒），慢但不会错。`StdioSession` 的 `Drop` 先关 stdin、
    等 300ms 再 `kill()`，给服务端一个自己退出的机会。
17. **发现是用户点出来的，不是启动时**。`mcp_tools(refresh)` 只在那一下被调，结果进进程内缓存（一次运行一份，
    重启重来）。MCP 服务器会起进程、会卡住、会等 `npx` 现下包 —— 放在启动路径上，等于一个配错的服务能把整个
    assistant 拖死。现在一个服务失败只让那一行显示原因，其余照常；`mcp.json` 坏了当"没有服务"，不让它拦住启动。
18. **MCP 是新的信任方：每调必问，而且没有沙箱**。服务器是用户自己配的可执行文件，它跑起来之后读文件、连网络、
    起子进程，平台一样都管不住（`file.write` / `shell.run` 至少还有额度与形状，这里连形状都没有 —— 参数是
    服务器自己定义的）。所以 `needsApproval` 对 `mcp.*` 一律返 `ask`、审计只记工具名本身、返回文本 40k 字截断、
    描述 300 字（它要进提示词和确认条）。这条是**承诺不是缺口**，见 `AGENTS.md` §7 第 15 条。

**P6 留下的缺口**（这一版不补，写在明处）：HTTP 服务的 OAuth / 自定义头（现在只有 URL、无鉴权）、
websocket 传输、连接复用（见第 16 条）、`cmd /C` 被杀之后孙进程 `node` 可能留下（与 `shell.run` 同一条代价）。

验证落点：`tests/hands.html` 97 条、`tests/assistant.html` 122 条、
`mcp_policy.rs` 17 + `input_policy.rs` 23 + `screen_policy.rs` 21 + `hands_policy.rs` 12 + `fs_policy.rs` 14 +
`shell_policy.rs` 9 + `web_policy.rs` 21（都能 `rustc --test` 单跑）、
`hands.rs` 7 条与 `mcp.rs` 8 条只有 `cargo test` 跑得了。

> **上面那些条数是写这份文档时的**。之后 `hands_policy.rs` 21 条（`effectiveHands` / `grantAllHands`
> 进来之后）、`tests/hands.html` 103 条，`tests/assistant.html` 也长了一截 —— 要准确数就看
> `npm run test:browser` 的输出，别照抄这里。

**真机那条后来走了**（2026-10-25，逐只点名跑了一遍，四条和"想当然"不一样的地方记在
[`AGENT_ACCESS.md` §4.9](../AGENT_ACCESS.md)）：读中文路径的文件、`echo 你好`、`Deny` 之后磁盘上
确实没那个文件、Stop 之后子进程真的没了、`web.fetch` 抓真页面并跟一次 302、列窗口 + 截图落盘、
MCP 自建 stdio 探针走完 `initialize` → `tools/list` → `tools/call`、点一下 + 打一行字。
**还没走的**写在 `AGENTS.md` §8（`hands.rs` / `mcp.rs` 那 15 条 `cargo test` 本机跑不了、
截图内容只有人眼能看、`input.key` 只验了 `Enter`）。
