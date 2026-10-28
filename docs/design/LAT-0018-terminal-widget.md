---
status: accepted
date: 2026-10-26
supersedes:
code: src-tauri/src/term.rs, src-tauri/src/term_policy.rs, src-tauri/src/lib.rs,
      src-tauri/src/runner.rs, src/runtime/term.ts, src/runtime/bridge.ts,
      src/runtime/manifest.ts, src/runtime/catalogue.ts, src/runtime/i18n/misc.ts,
      src/platform/WidgetFrame.tsx, src/widgetHost.ts,
      public/widgets/lattice.term/{manifest.json,index.html,style.css,widget.js,icon.svg},
      tests/term.html, tests/term.ts, docs/WIDGET_SPEC.md, AGENTS.md
---

# LAT-0018 —— 终端组件：一条常驻 shell 的皮肤

> 2026-10-26 从 0010 改为 0018：0010 已被同日先写的《目录源从一个变成一排》占用。
> 正文一字未改 —— 这一页当初就是按 0010 写的，改的只是编号。

> 用户原话：**"我要开发一个小组件可以作为终端使用……我希望他是来调用你展示你本机的 powershell、cmd，就像是个镜像的皮肤，但是我怕这样的效率不高。"**
>
> 他同时定了三条：**下载这个软件的人都能用**（官方组件，不是自用工具）；**字符网格，但只锁字号不锁列数**；**跟主题走，只在正文区用等宽字体**。
>
> 这一份只回答"怎么跑命令、跑到什么程度"，不写界面细节 —— 界面按上面三条约束做就行。

## 1. 问题

桌面角落想跑一条命令（`git status`、`npm run dev`、`dir`），现在只能切到 Windows Terminal —— 一切走，桌面就散了。而"顺手看一眼"正是这个平台其他十九个组件在做的事。

不做的话：用户装了这个平台，还是要开一个真终端窗口。**平台缺一块"能跑命令的卡片"，而这是开发者桌面上最常开的那扇窗。**

## 2. 候选

| | A：每条命令起一个进程 | B：一条常驻 shell（stdin 管道） | C：ConPTY + 终端仿真 |
| --- | --- | --- | --- |
| 做法 | `powershell -Command <cmd>`，跑完读输出 | `powershell -Command -`，stdin 写、stdout 读，哨兵切分 | `CreatePseudoConsole` + xterm.js |
| 换掉什么 | — | 每条命令的启动开销 | A、B 都换掉，UI 也换 |
| 新增什么 | 一个命令 + 一次读输出 | 常驻进程管理 + 读线程 + 哨兵 + 事件流 | 上面全部 + `portable-pty` + xterm.js（~300KB） |
| 代价 | **每条 480ms 固定开销**（实测），`cd` 不保留，输出只能等跑完 | 跑不了 `vim`/`ssh`，没有 ANSI 颜色，`Ctrl+C` 只能杀进程 | 工期一周起，组件目录里塞一个第三方库 |

**实测数据**（这台机器，2026-10-26，四次取整）：

- 新起一个 `powershell -NoProfile -NonInteractive -Command "Write-Output hi"`：**489 / 472 / 469 / 501 ms**
- 同一个常驻进程跑三条（含启动，含 `Set-Location C:\Windows` 保留）：**607 ms**，输出里 `Get-Location` 回的就是 `C:\Windows`

也就是**启动成本只付一次，之后每条命令约 40ms**。三条命令：1.4 秒 vs 0.6 秒；敲十条差 4 秒。**用户担心的效率问题在 B 里不存在，在 A 里是硬伤。**

## 3. 决定

**B。** 三条理由：

1. **效率**：数据见上。A 的 480ms 是"每敲一条命令等半秒"，而终端最不能忍的就是这个。
2. **"镜像的皮肤"这个说法 B 已经满足**：shell 是真的、状态是真的（`cd`、`$env:` 都留着）、输出是真的。它不是"模拟一个终端"，是**给一条真 shell 装一块我们画的界面**。
3. **C 的能力上限高，但它要的东西和组件定位冲突**：`vim` 要的是"待在里面干活"，而桌面组件是"扫一眼"。为一个 260×180 的卡片引入 xterm.js，等于把组件目录变成一个小型终端模拟器项目。

**代价**（写具体，别写"暂时不完美"）：

- **跑不了交互式程序**。`vim` / `top` / `ssh` / `python` 的 REPL 会挂住或者吐乱码。这是能力边界，界面上要写出来。
- **没有 ANSI 颜色**。PS 5.1 非交互模式不吐颜色；我们自己给 stderr 上红、给命令回显上弱色。
- **`Ctrl+C` 不能只杀当前命令**（没有控制台就没有 `CTRL_C_EVENT` 的路）。停止 = 杀掉 shell 再起一条，代价是丢掉 `cd` 和变量。
- **每个终端实例一条常驻进程**。开三个就是三个 `powershell.exe`。

**什么时候该推翻它**：如果真机上"跑不了 vim/ssh"变成主要抱怨（而不是"卡片太小"），就该上 C —— 那时候 xterm.js 的代价才值得。反过来，如果一个月里没人碰这个组件，就别升级它。

## 4. 接口与数据

> 术语先定死：**叫「shell」，不叫「会话」**。面板里的「会话」已经是聊天会话（`AssistantPanel` 的会话条），一个词两个意思会让后面所有对话都打结。

**桥方法**

```
term.write     权限 terminal:exec
参数: { command: string }
返回: { id: string }              // 这一条命令的编号，事件里带着它回来
错误: permission_denied / bad_params / internal

term.stop      权限 terminal:exec
参数: {}
返回: { ok: true }                // 杀掉当前 shell，下一条命令自动起新的

term.state     权限 terminal:exec
参数: {}
返回: { running: boolean, cwd: string, shell: "powershell" | "pwsh" | "cmd", seq: number }
```

**事件**（Rust → 宿主页 → iframe，走 `lattice:term`，和 `lattice:widget-config` 同一条路；桥是一问一答的，所以输出走事件不走 promise）

```
{ instanceId, id, seq, kind: "chunk", stream: "stdout" | "stderr", text }
{ instanceId, id, seq, kind: "done",  code: number | null, truncated: boolean }
{ instanceId, id, seq, kind: "lost" }            // shell 死了：崩溃 / 被 stop / 应用要退出
```

**哨兵**：没有 PTY 就没有 prompt，"这条命令跑完了"只能靠命令自己说。每条命令执行时在末尾追加一句：

```
; Write-Output "`u{1E}LATTICE:<id>"
```

读到 `\x1eLATTICE:<id>` 就切分 —— 之前的是输出，之后的是下一条。用 U+001E（记录分隔符）是因为正常输出里不会出现它。`cmd` 那边用 `echo <RS>LATTICE:<id>`。

**权限面**：`terminal:exec` 和别的权限一样发放 —— **不设"只给内置组件"的例外**。第二套规则（谁能拿到哪个权限）总有一天会被绕过，而绕过它的方式不需要任何人犯错。防线放在三处：

1. 默认不授，授予是一个显式动作；
2. 授权那一屏把后果写成正文（"能执行任意命令、能读写你的文件"），不是一行灰字；
3. `KNOWN_PERMISSIONS` 里的文案写明后果 —— 商店卡片读的就是它。

判不了"这条命令危不危险"（`shell_policy` 开头已经写过为什么），所以这里只能靠"用户看得见完整命令"。审计沿用 `LATTICE_NET_TRACE` 那套：`LATTICE_TERM_TRACE=1` 把每条命令和退出码打到 stderr。

**落盘**：无。命令历史进组件的 `storage`（按 `instanceId`），上限 200 条 —— 不进 `state.json`，那是整份覆盖的，两边一起写会打架。

**要改的文件**（一条能力五处，一处都不能漏）

1. `src/runtime/bridge.ts` —— 三个方法 + 事件订阅
2. `src/runtime/manifest.ts` —— `Permission` 联合加 `"terminal:exec"`、`PERMISSION_READY` 加一项、权限文案；`src/runtime/catalogue.ts` 的 `KNOWN_PERMISSIONS` 同步（**漏这里不报错**，症状是"装好了，点授权没反应"）
3. `src-tauri/src/term.rs`（进程 + 读线程 + 事件）+ `src-tauri/src/term_policy.rs`（纯逻辑：哨兵切分、输出截断、环形缓冲）+ `lib.rs` 的 `generate_handler!`
4. 落盘：无
5. `tests/term.html` + `term_policy` 的 Rust 单测 + `docs/WIDGET_SPEC.md` §3 权限表 + `AGENTS.md` 的不变量

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 卡片一直转圈，一个字都没有 | `powershell -Command -` 起不来（PATH 上没有 / 被杀软拦） | `internal` + 一句人话；卡片显示"shell 起不来"，带重试 |
| 中文全是问号 | PS 5.1 按控制台代码页（GBK）编码管道输出 | 启动时拼 `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8`（`hands.rs` 已有先例，照抄） |
| 命令跑完了卡片还在转 | 哨兵没回来：命令自己 `exit` 了，或者改掉了输出重定向 | 进程退出 = 所有在飞的命令发 `lost`，卡片提示"shell 退出了，点一下重开" |
| 敲过 `cd ..`，下一条命令还在原地 | 每条命令起了新进程（A 的错），或者 `Set-Location` 被 `-Command` 的作用域吃掉 | 常驻进程里 `cd` 天然保留 —— **这是回归测试第一条** |
| 输出刷屏，卡片卡死 | 无限输出（`dir /s`）灌进 DOM | Rust 侧 64KB 截断 + 前端只留最后 2000 行；截断处显示"（已截断）" |
| 删掉组件之后任务管理器里还有 `powershell.exe` | 没挂 `Drop`，或者没在 `RunEvent::Exit` 里杀 | 实例销毁、应用退出两条路都要杀；真机数一遍 |
| 窗口藏起来之后输出不动了 | 组件被 `visibility` 停摆，事件在 iframe 里排队 | Rust 侧持续缓冲，重新可见时按 `seq` 补齐（`term.state` 里带 `seq`） |
| 画布上一份、桌面上一份 | 两个宿主，两个 `instanceId` | 一个 `instanceId` 一条 shell，不共享 |
| 某一条命令开始，卡片**再也不动**：没有输出、停止按钮一直转，而 shell 还活着（`term.state.running: true`、`seq` 冻住不动），正文里还冒出一行 `LATTICE:c3:0:C:\Windows` | PowerShell 把"一行字 + 它的 `\r\n`"**分两次写**。于是缓冲里第一次只有整行哨兵、没有换行：`find_done` 要同一段缓冲里有 `\n` 才认，而 `safe_prefix_len` 当时只留"**半个**哨兵"的尾巴 —— 整行都算安全前缀，被当输出发了出去，哨兵从此离开缓冲区 | `safe_prefix_len` 里补一条：缓冲里出现**整段**这一条自己的 marker（`\x1eLATTICE:<id>:`，只认当前这条，别人的照旧当输出发掉，免得永远卡住）就从 marker 起留住，等下一次 read 把换行补齐（`term_policy` 的 `a_whole_sentinel_without_its_newline_is_not_output` 钉着这个到达顺序） |
| 组件里"发一条命令、等结果"的写法偶尔整条命令**一个字都没显示**（那条的事件全被当成"不认识的主人"丢掉），换个命令又好了 | `term.write` 的**回话比输出慢**：Rust 先写 stdin 再回编号，真机上快命令（`cd C:\Windows`）的输出比回话早到 5ms，组件那一刻还不知道 `id` | 组件必须**从第一条事件里认领编号**（`if (event.id && !next.active) next.active = event.id`），回话只在 `active` 还空着时填。别把"先拿到 id 再挂监听"当成契约 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/term.html` | 70 | 哨兵切分、多段 chunk 拼接、截断标记、历史去重与上限、提示符渲染、`\r` 归一、**回话没到也要从事件里认领编号** |
| `src-tauri/src/term_policy.rs` | 16 | 同上（Rust 侧那一份）；命令形状复用 `shell_policy::command_ok`，不另写一套。含**整行哨兵等到换行再切**（`a_whole_sentinel_without_its_newline_is_not_output`） |

**手工验一次**（自动化测不到的那部分）：

1. 真机敲 `cd C:\Windows` → `dir` → 输出的是 `C:\Windows` 的内容（**`cd` 保留了**）
2. 敲 `ping -n 10 127.0.0.1`，输出**一行一行**冒出来，不是等十秒一次性出现
3. 敲一条不存在的命令：stderr 是红的、退出码非 0
4. 任务管理器：删掉组件后 `powershell.exe` 少一个；退出应用后一个不剩
5. 把卡片拉到最宽：长行折行、不横向滚动；拉到 `minW` 时不出现横向滚动条

**2026-10-26 真机走到的位置**（探针组件摆在桌面上，把每条事件与时刻写进组件 `storage`，所以不用盯屏幕也能对账）：第 1 条里"`cd` 保留"与第 3 条已经验过（`cd C:\Windows; Get-Location` 回出 `C:\Windows`、`term.state.cwd` 也是它；不存在的命令三段 stderr + `code=1`），逐行流也验过（四次 350ms 的 tick 到齐在 322 / 696 / 1053 / 1416 / 1775ms），中文、哨兵不外泄、`term.state { since }` 重放、`term.stop` 之后 id 从 `c1` 重数、退出应用后进程没了 —— 都过了。**还差四处**：点一次卡片上的 Stop 按钮本身、删掉卡片（`term_dispose` / `WindowEvent::Destroyed` 这两条收尸路）、`dir` 那种长输出与 240px 窄卡的折行、`ping` 的真实节奏（这次用 `Start-Sleep` 循环代替）。
