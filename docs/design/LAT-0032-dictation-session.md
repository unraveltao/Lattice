---
status: accepted
date: 2026-10-28
supersedes:
code: src-tauri/src/dictation.rs, src-tauri/src/dictation_button.rs, src-tauri/src/dictation_policy.rs, src/platform/dictation.ts, src/platform/SettingsMenu.tsx
---

# LAT-0032 —— 听写改成一次会话：浮钮按需出现

> 推翻 0027 的两条：**"四个入口平权"** 和 **"浮钮是一个常驻开关"**。0027 里关于识别器、
> 注入路径、焦点判据、`WS_EX_NOACTIVATE` 那几条结论一条都不动。

## 1. 问题

用户点顶栏那颗麦克风，屏幕上**什么都没出现**。三件事叠在一起，读起来就是"这个功能是坏的"：

1. 浮钮是 `dictation.json` 里的一个常驻开关（`button.show`），**跟点不点麦克风无关**。
   开着的机器上它是常驻的一颗圆点，关着的机器上它永远不出现 —— 而"我刚点了麦克风，
   它在哪儿"这个念头，两种情况下都得不到回答。
2. 这台开发机上 `available: false`（`SupportedTopicLanguages()` 回 0），面板那颗
   麦克风是 `disabled`：**点了完全没反应**，连"你缺什么"都不说。设置页那行只写一句
   `Needs a Chinese speech language`，没有任何能点的地方能把人送到系统设置。
3. 打开那个常驻开关会让整个进程 abort（`dictation_button.rs:696` 的 RefCell 重入，
   已修）。也就是说"把浮钮打开"这条路，用户一次都没走通过。

结果：一个已经实现了 80% 的能力（分层窗、拖动、焦点判据、`SendInput`），
在用户那里等于不存在。

## 2. 候选

| | A：现状（0027） | B：浮钮跟着听写走（本份） | C：浮钮只在热键时出现 |
| --- | --- | --- | --- |
| 做法 | 4 个入口平权，浮钮一个常驻开关 | 3 个入口（面板 / 顶栏 / 热键），**任何一次开始听都会把浮钮叫出来**，它就是停止/取消面 | 热键叫出浮钮，鼠标路径不变 |
| 换掉什么 | — | `button.show` 删掉；浮钮从"入口"降成"控制器"；设置页多一区 | 不换 |
| 新增什么 | — | 浮钮的显隐跟着听写状态走；右键 = 丢弃；`dictation_status.reason` | 一套"热键专用"的显隐 |
| 代价 | 用户永远找不到浮钮；`button.show` 和"点了麦克风"两套心智互相打脸 | 想"常驻一颗钮"的人没得选；重画 5 张 PNG（另算） | 鼠标用户仍然看不到它；两套显隐要各写一遍 |

## 3. 决定

**选 B。** 浮钮的语义从"我要不要一颗常驻的钮"变成"**这一轮听写现在长什么样**"：
开始听 → 出现在上次的位置（正在听）→ 停止或取消 → 消失。这恰好是用户描述的流程，
而且它把"可见的控制面"和"有没有在听"绑成同一件事 —— 看见钮就等于在录，
看不见就等于没录，没有第三种状态可猜。

**代价**（三条，都是真的）：

1. **没有常驻选项了。** 想一直看到一颗钮的人得不到。真要它回来，是"再加一个 `pin`
   字段"的事，但那要另一份设计（它得回答"常驻时它是 idle 还是就是装饰"）。
2. **每次开始听都要 `SetWindowPos` 一次**（窗口在启动时就建好、只是藏着，所以不是
   建窗开销）。可接受：一次听写本来就要开麦、识别、注入，多一次窗口定位是零头。
3. **旧配置里的 `button.show` 变成死字段。** 不迁移、不报错，下次保存时自然消失
   （`normalize` 不认它）。代价是"我明明开过它"的用户会发现开关不见了 —— 见 §4 的迁移说明。

**什么时候该推翻它**：如果用户反复要求"让它一直待着"，或者出现"听写中浮钮被全屏
应用盖住、而没有任何别的地方能按停"的反馈 —— 那时该补的不是常驻，是**一个不依赖
窗口的停止手势**（热键的 toggle 已经是一条，需要的是让它在听写中优先）。

## 4. 接口与数据

**Tauri 命令**（只有两条形状变了，不新增命令）

```
dictation_status  →  { available, reason, language, enabled, hotkey, hotkeyError }
                      reason: "no_engine" | "no_chinese" | null
                      no_engine  = SupportedTopicLanguages() 回 0（要装「语音识别」组件）
                      no_chinese = 有组件但没有 zh-*（要加中文语音语言）
                      null       = 能用（和 available: true 同义）

dictation_settings / dictation_settings_set
                   →  { enabled, hotkey, dx, dy }      // show 去掉
```

`reason` 不参与任何判断（判据仍然只有 `available`），它只决定**设置页和 tooltip 说哪句话**。
三种原因对应三个不同动作，一句通用文案做不到这件事。

**落盘格式与迁移**

```json
// 旧（0027）
{ "schema": 1, "enabled": true, "hotkey": "Ctrl+Alt+Space",
  "button": { "show": true, "dx": -120, "dy": -120 } }

// 新
{ "schema": 1, "enabled": true, "hotkey": "Ctrl+Alt+Space",
  "button": { "dx": -120, "dy": -120 } }
```

`schema` 不动（还是 1）：去掉一个**不影响语义**的字段不算格式变更 —— 读旧文件时
`show` 被忽略，`dx/dy` 照常生效，用户的钮下次出现在它该在的地方。不写迁移代码：
写了反而要维护一个"v1 有 show / v2 没有"的判据，而这个字段从来没被任何判据读过。

**浮钮的消息表**（`dictation_button.rs`，跨线程）

```
Park { dx, dy }   记住位置并藏起来（启动、关掉听写时）
Show              按记住的位置出现（开始听时）
Hide              藏起来（收尾时）
Listening(bool)   换"正在听"那两张相位图
Error             红两秒，然后自己藏
```

`Move` 删掉（从来没被发过）。右键（`WM_RBUTTONUP`）= `dictation_cancel()`：丢弃这一轮。

**设置页**

`Assistant` 区里那三行搬进新的 **`Dictation`** 区（左导航第 8 项）。那一区回答四件事：
能不能用（`reason` 三句话之一）、开关、热键、浮钮回到右下角。外加两颗按钮：
**重新检测**（重读 `dictation_status`）和**打开 Windows 语音设置**（`ms-settings:speech`）。

**要改的文件**

1. `src-tauri/src/dictation_policy.rs`：`Settings` 去掉 `show`，`normalize` 少一个参数
2. `src-tauri/src/dictation.rs`：`Status.reason`、`SettingsPatch/View` 去掉 `show`、
   `boot` 改成 Park、`finish` 里成功/空文本/取消三条路各调一次 `dismiss()`
3. `src-tauri/src/dictation_button.rs`：消息表、`Ctx` 记 `dx/dy`、右键取消、错误计时器到点自己藏
4. `src/platform/dictation.ts`：`DictationStatus.reason`、`DictationSettings` 去掉 `show`
5. `src/platform/SettingsMenu.tsx`：新分区 + 两颗按钮
6. `src/platform/AssistantPanel.tsx`：麦克风不再 `disabled`，点了打开系统设置
7. `src/runtime/i18n/assistant.ts`：新文案
8. 文档：`GLOSSARY`（浮钮词条改语义）、`PITFALLS`（RefCell 那条已记）、`ROADMAP` 一行

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 点顶栏麦克风，浮钮没出现，但字照样打进了前台窗口 | `Park` 没发出去（启动时 `enabled: false`，线程都没建） | 开始听前先 `apply()` 一次，把线程和位置补上；线程建不起来就**拒绝开始**并报出来，不要"悄悄在后台听" |
| 说完最后一句，浮钮一直亮着 | `finish` 的某条分支没走到 `dismiss()` | `finish` 是唯一出口，三条路（成功 / 空 / 取消）都必须收尾；断言钉住"每一轮结束按钮都藏了" |
| 取消之后浮钮还红了两秒才走 | `flash_error` 和 `dismiss` 都发了，错误计时器把已经藏掉的窗口又亮回来 | 错误计时器到点时**只藏不亮**；`dismiss` 顺手 `KillTimer(TIMER_ERROR)` |
| 拖完浮钮，下一轮它又从右下角冒出来 | 拖动只写了盘，没更新 `Ctx.dx/dy` | `WM_LBUTTONUP` 里同时更新内存和磁盘 |
| 设置页说"没有语音组件"，用户去装完回来还是灰的 | 只在启动时读过一次 `probe()` | `probe()` 已经 `get_or_init` 缓存了 —— 设置页的「重新检测」必须**清掉那份缓存**再读，否则按钮是骗人的 |
| 关掉总开关，浮钮还挂在桌面上 | `apply` 只在 `enabled` 为真时发 `Park` | `enabled: false` 一律发 `Hide` |
| 右键取消，结果字还是打出去了 | `WM_RBUTTONUP` 只在 `listening` 时才有意义，别的状态调 `dictation_cancel()` 会空转 | 空转是对的（`cancel` 自己判 phase）；**不要**在窗口过程里判状态，那是第二份状态 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/dictation.html` | 24 → 28 | `reason` 三种取值各自对应哪句话（`no_engine` 与 `no_chinese` 必须不同）、`reason` 缺省时也要给一句通用解释、`dictation_recheck` 是另一条命令 |
| `src-tauri/src/dictation_policy.rs` | 28 → 29 | `unavailable_reason` 的四种组合（`0/false` → `no_engine`、`3/false` → `no_chinese`、`3/true` 与 `0/true` → `None`）；`normalize` 不再产出 `show` |

**手工验一次**：

1. 打开顶栏麦克风 → 桌面上浮钮出现且是"正在听" → 说一句 → 浮钮消失、字进了记事本；
2. 同一轮里右键浮钮 → 浮钮消失、记事本**一个字都没多**；
3. 把浮钮拖到屏幕中间，重启 app，再听一次 → 它出现在中间；
4. 设置 → Dictation：这台机器上写的是"没有语音识别组件"，点「重新检测」不报错，
   点「打开 Windows 语音设置」跳到 `ms-settings:speech`；
5. 关掉总开关 → 浮钮立刻消失、热键按了没反应。
