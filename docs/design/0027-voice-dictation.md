---
status: accepted
date: 2026-10-27
supersedes:
code: src-tauri/src/dictation.rs, src-tauri/src/dictation_button.rs, src-tauri/src/dictation_policy.rs, src/platform/dictation.ts
---

# 0027 —— 说话变成字：听写

> **被 [0032](./0032-dictation-session.md) 推翻了两条**：浮钮不再是常驻开关（它跟着一次听写出现和消失），
> 四个入口也不再平权（收成三个入口 + 浮钮当控制器）。这一份里关于识别器、注入路径、焦点判据、
> `WS_EX_NOACTIVATE` 的结论**全部仍然有效**，下面照原样保留。

> **识别引擎从"只有 WinRT"改成"WinRT 起不来就退经典 SAPI"**（2026-10-28，
> `src-tauri/src/dictation_sapi.rs`）。这一份 §7① 的前提是"本地识别 = WinRT `SpeechRecognizer`"，
> 而实测发现 WinRT 会**广告一个它其实跑不了的语言**：它报 `zh-Hans-CN`、约束也编得过，
> 但 `RecognizeAsync` 回 `0x80045509`（语音隐私政策没同意），于是"麦克风能用、说下去没有字"。
> 经典 SAPI 读的是另一份语言库（`Speech\Engines\SR`，本机有 54 MB 中文模型）且不看这个同意位，
> 所以改成"WinRT 还没出声就失败 → 换 SAPI 再试一次"。
> **注入路径、焦点判据、`WS_EX_NOACTIVATE`、事件形状、`reason` 三句话一条都没动**，
> 改的只是"字从哪来"。没有另开设计稿：这次没有动持久化格式，也没有动跨进程契约
> （`lattice:dictation` 的字段一个没加），按 `docs/design/README.md` 的三条判据
> 只够写进 ROADMAP 一行 + 代码注释。

> 状态：**已实现**（2026-10-27）。§6 的断言已经落地并跑绿；下面 §7 末尾记了实现时改掉的三处 ——
> 其中第一处是这份设计的前提之一写错了（`SpeechRecognizer::Create(language)` 是有的）。

## 1. 问题

写中文的输入速度卡在拼音上。具体到三个场景：在 assistant 里提一个长需求、给组件配置框填一段说明、写一封邮件 —— 这三件都是"心里已经有一整句话，但只能一个字一个字敲"。

不做的话，后果不是"少一个功能"，而是**长文本输入在这个应用里永远要切到别的窗口**。而真正难的是第四个场景：**用户在别的应用里** —— 记事本、浏览器的表单、聊天窗口。那才是"任何地方都能输入"这句话指的地方，也是这一份里 §4「浮钮」那一节存在的理由。

Windows 自带的 `Win+H` 能做这件事，但它是系统浮层：不知道字插到了哪、不跟 Lattice 的撤销条联动、说错了也没有"撤掉刚才那句"，而且它要求用户先记住这个组合键。

## 2. 候选

| | A：只做面板内 | B：只做系统级 | C：两步走 | D：不做，叫用户用 `Win+H` |
| --- | --- | --- | --- | --- |
| 做法 | 麦克风按钮只往 `AssistantPanel` 的输入框追加 | 桌面常驻浮钮（点了不抢焦点）+ 全局热键，`SendInput` 打给前台窗口 | 先 A，同一个识别器，第二步加 B | — |
| 换掉什么 | 无 | 无 | 无（A 的那条路保留，B 是新增的目的地） | 无 |
| 新增什么 | WinRT 识别器 + 面板状态 | 一个 GDI 分层小窗 + 热键插件 + 焦点判据 | A 的全部 + 浮钮 + 热键 + 一个 `target` 参数 | 一句文档 |
| 代价 | "任何应用"这个需求没满足 | 多一个常驻窗口；用户没看到自己在说什么，说错了只能手动改 | 多一个常驻窗口、多一个依赖、多一条注入路径、识别质量被本地语法绑死 | 需求没做 |

## 3. 决定

**选 C**。A 是 B 的前置：没有 A，"正在听"这件事没有可见的位置；没有 B，需求只满足一半。两者共用同一个识别器和同一套事件，差别只在**结果送去哪**（`target: "panel"` 交给 JS 追加，`target: "system"` 由 Rust 注入）。

B 有**两个入口**，不是二选一：桌面上一颗常驻的**浮钮**（手在鼠标上时用），加一个**全局热键** `Ctrl+Alt+Space`（手在键盘上时用）。两者共用同一条注入路径，只换触发源 —— 第二个几乎是免费的。顺序上**浮钮先做**，因为它把"焦点"这件事逼出来；热键不涉及窗口，做完浮钮它只是加一次注册。

**代价**（四条，都是真的）：

1. **多一个常驻窗口**。一个 28px 的圆钮要在屏幕上待一整天。所以它**不是** WebView（一个常驻 WebView2 空载几十 MB，而 `ROADMAP` 风险表第一条就是"WebView 数量是内存杀手"），是 GDI 分层窗 + 四张预渲染 PNG（§4）。
2. **多一个 Rust 依赖**：`tauri-plugin-global-shortcut`（官方插件，约 200 行）。不自己写 `RegisterHotKey` + 消息泵 —— 那要和 Tauri 的事件循环抢窗口过程，是"能跑但随时会坏"的一类。
3. **多一条注入路径**：系统级那条要把字打进**别人的窗口**，所以必须判焦点（§5 第 3 行）。面板那条没有这个问题，两条路不能合并成一条。
4. **识别质量被 Windows 本地语法绑死**。`SpeechRecognizer` 的中文模型是系统装的本地语法，**不是** `Win+H` 用的那套在线模型。这一条最贵，而且**没量过**（见 §7）。

**什么时候该推翻它**：第一步真机跑通后，用三句话试（一个短词、一句日常、一句带专有名词）。如果错字率高于两成，说明"本地"这个前提不成立，该换云端 —— `llm.rs` 现在只有 `/chat/completions` 和 `/models`，没有 `/audio/transcriptions`，那是一条新命令。§4 的 `trait Recognizer` 就是为这一天留的：换实现不动面板。

## 4. 接口与数据

### 识别器：一个接口，一个实现

```rust
// src-tauri/src/dictation.rs
enum Availability { Ready { language: String }, WrongLanguage { language: String }, NoMicrophone }

trait Recognizer {
    fn availability(&self) -> Availability;
    fn start(&mut self) -> Result<(), String>;   // 开麦
    fn stop(&mut self) -> Result<(), String>;    // 用户按停 → 出整句
    fn cancel(&mut self) -> Result<(), String>;  // Esc → 丢弃，不出字
    fn level(&self) -> f32;                      // 0..1；0 = 波形这一路没打开
}
```

第一个实现 `WinRtRecognizer`，用 `windows 0.62.2` 里已经投影好的 API（行号是 registry 源码里的位置）：

| 要做的事 | API |
| --- | --- |
| 建识别器（用系统语音语言） | `SpeechRecognizer::new()` · 1286 |
| 挂听写场景（有标点） | `SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, "dictation")` · 1149 |
| 编译约束 | `CompileConstraintsAsync()` · 1326 |
| 停顿 1 秒就收尾 | `Timeouts().SetEndSilenceTimeout(1s)` · 1542 |
| 识别一句 | `RecognizeAsync()` · 1333 |
| 用户按停 | `StopRecognitionAsync()` · 1389 |
| 读系统语音语言 | `SpeechRecognizer::SystemSpeechLanguage()` · 1421 |

**识别语言不能设，只能读** —— 这个 crate 版本的 `SpeechRecognizer` 没有 `SpeechRecognitionLanguage` 的 setter，`new()` 一律用系统的语音语言。所以"没装中文包"的判据不是"枚举里找不到 zh-CN"，而是**`SystemSpeechLanguage()` 的 tag 不是 `zh-*`**。

**为什么 `start` 不返回文本**：`RecognizeAsync()` 要阻塞到用户说完（几秒），而 `StopRecognitionAsync()` 必须从另一个地方调得动。所以 `start` 只回"开麦了"，结果走事件；而且**所有 WinRT 调用都在同一条常驻线程上**（`audio.rs` 的常驻采集线程是现成的形状），`start/stop/cancel` 都投给它 —— 跨线程调 WinRT 要处理 COM 单元亲和性，绕开比解决便宜。

### Tauri 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `dictation_status` | — | `{ available, language, enabled, hotkey, hotkeyError }` |
| `dictation_start` | `{ target: "panel" \| "system" }` | `{ ok }` |
| `dictation_stop` | — | `{ ok }` |
| `dictation_cancel` | — | `{ ok }` |
| `dictation_level` | — | `{ level }` 0..1。**这一版恒 0**：第二路 WASAPI 采集没做，界面据此不画波形（见 §5 那条兜底） |
| `dictation_open_settings` | `{ page: "speech" \| "microphone" }` | `{ ok }`。`ms-settings:` 不在 `open_policy` 的白名单里（不变量 14），所以这是平台自己的一条专用命令，字面量写死在 Rust 里 |
| `dictation_settings` / `dictation_settings_set` | `{ enabled, hotkey }` | 读一次 / 回同形状 |

事件 `lattice:dictation`：`{ phase: "listening" | "partial" | "done" | "error", text?, code?, error? }`。

错误码只有五个，多一个就是没想清楚：`wrong_language` / `no_microphone` / `focus_changed` / `too_long` / `hotkey_taken`。

**没有桥方法。** `bridge.ts` 一个字不改 —— 见 §5 第 6 行。

### 浮钮（`dictation_button.rs`）

一个 28×28 的 GDI 分层窗，**不是 WebView、不是组件、前端一行都不碰**。

窗口样式四件套，缺一件这个需求就不成立：

| 样式 | 为什么 |
| --- | --- |
| `WS_EX_NOACTIVATE` | **点了不激活** —— 前台窗口从头到尾还是那个要插字的窗口。这是整个需求的支点 |
| `WS_EX_TOOLWINDOW` | 不进任务栏、不进 Alt+Tab |
| `WS_EX_TOPMOST` | 永远浮在上面 |
| `WS_EX_LAYERED` | 圆角、半透明、投影靠 `UpdateLayeredWindow` 贴一张带 alpha 的位图。**不用 `SetWindowRgn`** —— 那个要补 `RedrawWindow`，是 `PITFALLS` 里躺着的一条 |

四张 PNG（`idle` / `hover` / `listening` / `error`），56×56 编进二进制（`src-tauri/assets/dictation/`，`include_bytes!`；这个仓库还没有 `include_bytes!` 的先例，但 `icons/` 已经在 `src-tauri/` 下，位置一致）。状态切换 = 换一张位图重贴，不重绘。`listening` 用两张相位图每 400ms 循环 —— 这就是"正在听"的全部动画。

**位置记"相对工作区右下角的偏移"**（`dx` / `dy`，负数向左上），不记绝对坐标。理由：换显示器、改分辨率、接投影仪之后绝对坐标会落到屏幕外，偏移不会。读回来还要**钳进当前工作区** —— 防的是"笔记本拔掉外接屏"那种情况。

拖动：`WM_LBUTTONDOWN` 起拖，`SetWindowPos` 跟手，`WM_LBUTTONUP` 存偏移。**不用 `WM_NCHITTEST` 返回 `HTCAPTION`** —— 那会走系统拖动循环，而系统拖动要求激活。点击的判据是"松手时移动距离 < 4px"，不然"想拖它却触发了一次听写"。

**托盘右键菜单里有"隐藏浮钮"** —— 钮上不再加第二颗小叉，28px 放不下两个命中区。

### 第四个入口：顶栏那颗（实现时加的）

设计写到这里只有三个入口。实现时补了第四个，理由不是"多一个按钮"，而是
**"人已经在这个窗口里、光标停在某个框里"**这一种姿势原先没有入口：

- 面板那颗只在 assistant 的输入框里；浮钮和热键是"人在别处"时用的；
- 而用户经常是在**自己的窗口里**打字：组件配置、设置项、画布上的搜索框。

顶栏那颗（`src/platform/DictationButton.tsx`，摆在 Assistant 与 Theme 之间）走 `target: "system"`：
此刻的前台窗口就是这个窗口，`SendInput` 打进去的字直接落进**光标所在的那个框**。
它和另外三个入口**共用同一份状态与同一套事件**（`reduceDictation` 是唯一的判据），
所以浮钮亮着的时候顶栏这颗也亮着。

三条实现时的取舍：

1. **灰着的时候点它不是"没反应"**：直接把 `ms-settings:speech` 打开 —— 用户想用它却不知道
   差什么，这是唯一有用的一句话。
2. **"刚才那个窗口没了"不许把字吞掉**：那一路 Rust 会把整句交回来，顶栏冒一条提示并给出
   「复制这段」（面板开着时也照样追加进 assistant 的输入框）。
3. **提示是短命的**（6 秒、固定在顶栏下方）：顶栏在各种宽度下都可能靠边，把它挂进布局里
   会把顶栏撑歪。

它不改任何权限、不加任何桥方法 —— 组件仍然够不到麦克风（§8 那条不变）。

### 落盘

`app_config_dir/dictation.json`，四个字段：

```json
{ "schema": 1, "enabled": false, "hotkey": "Ctrl+Alt+Space",
  "button": { "show": true, "dx": -120, "dy": -120 } }
```

默认 `enabled: false`，和 agent 端点同一条规矩：**关着就不建浮钮、不注册热键、不碰麦克风**。`button` 缺了就按默认（显示、右下角偏移 120px）。读坏了回默认、不报错 —— 这份文件只影响"按钮灰不灰、浮钮在不在、热键占不占"，没有一份数据会因为读坏它而丢。

浮钮的开关和位置**不新增命令**，走同一个 `dictation_settings_set`：前端和 Rust 只认这一份。

### 要改的文件（七处，比常规的五处多两处）

1. `src-tauri/src/dictation.rs`、`dictation_button.rs`、`dictation_policy.rs`（新）
2. `src-tauri/src/lib.rs`：三个 `pub mod`、六个命令进 `generate_handler!`、`setup` 里按 `enabled` 建浮钮 + 注册热键
3. `src-tauri/Cargo.toml`：`windows` 加 `Media_SpeechRecognition` / `Globalization`（`Media_Audio` 已有）；加 `tauri-plugin-global-shortcut`。GDI 那套 `windows-sys` feature 已经有了（`Win32_Graphics_Gdi`、`Win32_UI_WindowsAndMessaging`）
4. `src-tauri/assets/dictation/*.png`（四张，`listening` 两张相位）
5. `src/platform/dictation.ts`（新）+ `DictationButton.tsx`（新，顶栏那颗）+ `AssistantPanel.tsx` 输入区那一排
6. `src/runtime/i18n/assistant.ts`
7. 文档：`ROADMAP`（勾掉）、`GLOSSARY`（已有"听写""浮钮"词条）、`PITFALLS`（实测踩到的才写）、`WIDGET_SPEC`（加一句"没有 `speech` 权限"）

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 按钮点得动，说完什么都不出来，两秒后提示"没听到" | 系统语音语言是 `en-US`，`new()` 就用它，中文被识别成英文乱码；或者麦克风静音 | 启动时判 `SystemSpeechLanguage()` 的 tag；不是 `zh-*` 就**置灰**，文案写"把 Windows 的语音语言改成中文(简体)"，链接 `ms-settings:speech` |
| 第一次点麦克风弹系统的隐私授权，点了拒绝之后永远静音 | `RecognizeAsync` 返回 `SpeechRecognitionResultStatus::MicrophoneUnavailable`，**不是异常** | 当成 `no_microphone` 报出来，文案指向 `ms-settings:privacy-microphone`；别写"未知错误" |
| 字打到了错误的窗口 | 识别那两秒里用户切走了 | 开听时记 `GetForegroundWindow()`，出字前再取一次；**不一致就不打字**，把文本交回面板输入框并提示"刚才那个窗口已经不在了，字在下面" |
| 中文出来了但没有标点 | 没挂 `Dictation` 场景约束，或者本地语法本来不产标点 | 先按 §7 实测；实测不产标点就**不加后处理**（拿 LLM 补标点 = 一次网络往返 + 一句话可能被改写），让用户自己点。宁可没有，不可偷偷改 |
| 说了很长一段，只出来前 4000 字 | `input_policy::type_plan` 的上限（`MAX_TYPE_CHARS`） | 超限**拒绝不截断**（`type_plan` 已经这么做了），报 `too_long`，提示分两次说 |
| 组件偷偷开始录音 | — | 结构上不可能：`dictation_*` 不在 `agent_policy::ACTIONS` 里，也不在 `bridge.ts` 的方法表里。**这是要写成断言的**（§6 第 3 行） |
| 热键按了没反应，设置里也没报错 | `Ctrl+Alt+Space` 被别的程序占了，插件注册返回 `Err` | 注册失败存进 `hotkeyError`，设置页显示"这个组合键被占用了，换一个"；**不许静默** |
| 波形是空的，但字照样出来 | 第二路 WASAPI 采集（`eCapture`）打不开 —— 独占驱动的麦克风 | 波形是装饰，不是状态：打不开就 `level()` 一直 0，界面不画波形，**不报错、不影响听写** |
| 按了停止，界面上一直"正在听" | `StopRecognitionAsync` 在没结果时返回空文本 | 空文本当"没听到"走 `done` + 提示，状态必须回到 idle；**任何分支都要回 idle** |
| 浮钮看得见，点上去没反应 | 窗口带上了 `WS_EX_TRANSPARENT`（跟着桌面层那套默认值走的），或者分层窗的 alpha 区域和命中区对不上 | 浮钮**自己一套样式**，不抄 `desktop.rs` 的默认值；`WS_EX_LAYERED` 的命中判定按整个矩形算，别指望按 alpha 抠 |
| 想拖它，结果触发了一次听写 | 拖动和点击没分开 | 松手时位移 < 4px 才算点击；超过就当拖动，一次都不听 |
| 字还是插进了浮钮自己 | 某处调了 `SetForegroundWindow`，或者窗口漏了 `WS_EX_NOACTIVATE` | 浮钮**永远不主动要前台**；判据仍然是"开听时的 HWND == 出字前的 HWND"，浮钮不参与 |
| 拔掉外接屏之后浮钮不见了，找不回来 | 位置记的是绝对坐标，或者记了偏移但没钳进工作区 | 记相对偏移 + 读回钳进当前工作区；托盘菜单里永远有一条"浮钮回到右下角" |
| 全屏游戏 / 放映时浮钮被盖住 | `WS_EX_TOPMOST` 压不过独占全屏 | 这是预期的，不修。提示用户用热键 —— 两个入口存在的意义之一就是这个 |
| 浮钮显示"正在听"，面板里却没有波形（或反过来） | 两个入口各自维护一份状态 | 状态只有一份，在 Rust；浮钮和面板都只是订阅者，谁也不许自己推断 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/dictation.html` | 24 | 桥契约（stub `invoke`）：`start` 带 `target`、`stop`/`cancel` 分开、事件 `listening → done` 追加到输入框、`cancel` 一个字都不落、`error` 之后状态回 idle、`wrong_language` 时按钮灰且文案指向 `ms-settings:speech`、`focus_changed` 时文本进输入框而不是 `SendInput`、`too_long` 不截断 |
| `src-tauri/src/dictation_policy.rs` | 28 | 纯逻辑，`rustc --test`：`zh-*` 才 `Ready`（`zh-CN` / `zh-TW` / `zh-Hans` 过，`en-US` / 空串不过）、文本清洗（首尾空白、纯空白当"没听到"）、`type_plan` 边界（4000 过、4001 拒）、焦点判据（同 HWND 才注入、`0` 不算）、热键字符串校验（复用 `input_policy::parse_chord`）、`dictation.json` 坏值回默认、**浮钮偏移钳进工作区**（右下角偏移在、拔屏之后偏移越界要夹回来）、**点击判据**（位移 3px 算点击、5px 算拖动） |
| `src-tauri/src/agent_policy.rs` | 2 | `ACTIONS` 里没有 `dictation_*`；`DENIED` 里有一条写明理由 |
| `src/runtime/bridge.ts` 的表 | 1 | 方法表里搜不到 `dictation` —— 组件永远够不到麦克风 |

**手工验一次**（自动化测不到的）：

1. 中文语音语言 + 中文麦克风，说"帮我把这句话记下来"，看整句和标点；
2. 同样的句子，把语音语言切成 `en-US` 再说一遍，确认按钮是灰的而不是出一串英文；
3. 开听后立刻 `Alt+Tab` 到记事本，等出字，确认**记事本里没多出字**、面板里多了一句提示；
4. 静音麦克风说一句，确认报的是 `no_microphone` 而不是超时；
5. 把热键故意设成 `Ctrl+Alt+A`（QQ 截图占着），确认设置页报"被占用"；
6. **焦点那条最要紧**：光标点进记事本，**不切窗口**直接点浮钮说话 —— 记事本标题栏必须一直是激活色，字要插进记事本；
7. 拖浮钮到另一个位置，重启应用，确认它回到原处；然后把外接屏拔了再开，确认它在当前屏幕上而不是飞了；
8. 点浮钮说错一个字，在记事本里按 `Ctrl+Z` —— **记下撤了几次**，这条决定 §8 里"不做撤销"要不要改。

## 7. 写这份时改掉的四处

**① 识别语言不能设，只能读。** 原本按"枚举 `SupportedTopicLanguages()` 里有没有 `zh-CN`"设计，写完才发现这个 crate 版本的 `SpeechRecognizer` 没有语言 setter —— `new()` 一律用系统语音语言。于是判据从"列表里有没有"改成"**当前那个是不是 `zh-*`**"，错误文案也从"装一个中文语音包"改成"把语音语言改成中文"。`SupportedTopicLanguages()` 仍要读，但它只用来在设置页里列出"这台机器支持哪些"，不参与放行判断。

**② 不需要 `Media_Capture`。** `RecognizeAsync()` 自己打开默认麦克风，不用 `MediaCapture` 那一套。唯一的第二路采集是**波形**：复用 `audio.rs` 的 WASAPI 形状，把 `eRender` + `AUDCLNT_STREAMFLAGS_LOOPBACK` 换成 `eCapture`（`audio.rs` 第 34–35 行、157–170 行是现成的模板）。两个共享模式客户端在 Win10 1903 之后可以并存，但驱动不保证 —— 所以波形按"能降级"设计（§5 第 8 行）。

**③ 焦点判据不是"结束时看前台窗口"，是"两个时刻比"。** 用户可能切走又切回来，那仍然是对的窗口；也可能切到另一个同类窗口（两个记事本），那仍然是错的。只有"开始时的 HWND == 出字前的 HWND"这一条同时处理了两种。

**④ 第二步从"只有热键"改成"浮钮 + 热键"。** 第一版把系统级听写设计成"按 `Ctrl+Alt+Space`"，前提是用户**记得住**这个组合键 —— 而这恰恰是全局功能最常见的死法。改成一颗常驻的浮钮之后，"任何地方都能输入"这句话才成立：手在鼠标上时不用换姿势。热键没被删掉，它退成了第二条路（手在键盘上时），而且因为共用同一条注入路径，多出来几乎不要钱。

### 实现时改掉的三处

**① 语言能设，不是只能读（这条是本设计的错）。** 上面写的是"这个 crate 版本的 `SpeechRecognizer`
没有语言 setter，`new()` 一律用系统语音语言"。实现时翻了源码：`windows 0.62.2` 有
`SpeechRecognizer::Create(language)`（`Media/SpeechRecognition/mod.rs:1411`）。于是判据改成两段 ——
系统语言是 `zh-*` 就用它，否则在 `SupportedTopicLanguages()` 里挑一个 `zh-*`，都没有才判"做不了"。
纯函数是 `dictation_policy::pick_language`，三条断言钉着。**英文系统 + 装了中文听写包也能用**，
不用逼用户改系统语言 —— 但"没装中文听写"时那句提示仍然是"去 `ms-settings:speech`"。

**② 波形那一路没做，`dictation_level` 恒 0。** §7② 说复用 `audio.rs` 的 WASAPI 形状把
`eRender` 换成 `eCapture`。实现时按 §5 那条兜底先落成"诚实的一半"：命令在、形状对、值恒 0，
界面据此不画波形。要接的是第二路采集 + 面板那行预览的波形，不是新的状态。

**③ 错误码多了两个。** 原文五种。实现时补了 `input_blocked`（`SendInput` 被管理员窗口拦下 ——
这不在原来那五种里，又不能假装成功）和 `cancelled`（用户在面板里按了 Esc：一个字都不落，
但状态要回 idle，面板据此清掉提示而不是显示"没听到"）。

**写这份时没量到、实现时量了的一件事：这台开发机上一条语音识别语言都没有。**

用 `SpeechRecognizer::SupportedTopicLanguages()` 直接读（`.scratch/lang-probe.rs`，MTA 与 STA 各试一次，
结果一致）：`supported = 0`，`SystemSpeechLanguage()` 直接失败。所以 `dictation_status.available` 在这台
机器上恒 `false`：面板那颗麦克风是灰的，点旁边的字跳 `ms-settings:speech`。**这不是 bug，是这台机器的
样子** —— Windows 自带的 `Win+H` 走云端，所以"Win+H 能用"不代表本地识别能用，本机识别要先装「语音识别」
组件（或给中文补一个语音识别语言包）。所以 Rust 侧那两句提示是分开的：`SupportedTopicLanguages()`
回 0 → "去装组件"；非 0 但没有中文 → "去切语言"。

**还剩一件没量**：本地中文语法的准确率与标点（决定 §3 那条"什么时候该推翻它"）。它只能在**装了语音
识别语言**的机器上量，走 §6 的手工第 1 步。

## 8. 明确不做

- **不给组件用**（没有 `speech` 权限）。理由和"agent 当组件但不做聊天窗"是同一条：能听房间的组件离能改布局只差一条桥方法，而权限文案写着"听写"、用户读到的却是"允许它听我说话"。
- **浮钮不是组件**。它不注册到目录、不出现在画布、不进 `state.json` —— 它是平台的一块常驻 UI，跟着应用开关，不跟着布局。
- **浮钮里不放输入框**。`WS_EX_NOACTIVATE` 的窗口永远不能成为前台，键盘事件进不来（`desktop.rs:17` 那条坑）。要放输入框就得放弃"不抢焦点"，那整个需求就没了。
- **不逐字上屏**。`partial` 事件只喂面板里的波形旁那行预览，不往输入框里写字 —— 逐字改是输入法该干的事。
- **不做唤醒词**（"小助手小助手"）。常驻监听 = 一直在用麦克风，代价和收益不成比例。
- **不做后处理**（LLM 补标点、改错字）。见 §5 第 4 行。
- **不自己做撤销**。系统级说错了靠目标应用自己的 `Ctrl+Z`，粒度由它决定；实测要是逐字撤，再补一个"删掉刚才那句"（我们知道发了多少字符，退格数得出来），但那要另开一份设计。
- **不做浮钮右键的历史记录**。最近三条要落盘、要清理、要防泄露，而它解决的是"说错了"这个已经由 `Ctrl+Z` 管着的问题。
