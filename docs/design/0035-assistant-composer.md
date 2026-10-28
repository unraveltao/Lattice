---
status: accepted
date: 2026-10-28
supersedes: 0034（窗口尺寸那一条：880×640 → 800×600；会话栏"不可收起"那一条）
code: src/platform/AssistantPanel.tsx, src/styles.css, src/runtime/assistant-window.ts, src-tauri/src/assistant_window.rs, src-tauri/src/assistant_window_policy.rs, src-tauri/src/lib.rs
---

# 0035 —— 输入卡重做、会话栏可收起、窗口再小一号

## 1. 问题

四件事，都出在 0034 落地之后的那一屏上：

1. **输入卡的按钮顺序不是人手的顺序。** 现在是 `＋` 没有、模式药丸、元信息、麦克风、一颗写着 `Send` 的文字钮。用户原话是"麦克风可以放在 Send 旁边，然后那个 Send 就可以变为一个三角箭头的符号，就和 WorkBuddy 一样"——说一句然后发出去是**同一个动作**，中间隔着一串 token 计数就是把它拆成两件事。
2. **"这一轮加什么"没有入口。** 附件只能靠拖（`@path` 是个内部约定，界面上没说过）、审批档在设置第三格、技能与服务在设置第一格。为了"这一轮换个审批档"离开对话去翻设置，回来草稿还在但上下文得重新找。
3. **会话栏 208 是写死的。** 560 宽时对话只剩 352，用户原话"左侧的新任务。可以收起来"——他要的是"看完会话就把它收走，把宽度还给对话"。
4. **880×640 太大。** 1080p 上占 41% × 59%，用户原话"可以让整体的对话框变得小一点"。

另有一件更早报的：**窗口外面那圈灰边**（"为什么这个窗口做出来会有一个灰色的边框"）。查下来是两道边叠在一起——CSS 的 `box-shadow: inset 0 0 0 1px` 加 DWM 自己那 1px 系统边框。

## 2. 候选

| | A：只调 CSS | B：照 WorkBuddy 的形状重做输入卡 | C：加号做成"新建" |
| --- | --- | --- | --- |
| 做法 | 保留文字 `Send`，把麦克风挪到它左边，间距压小 | `＋` / 模式药丸 / 元信息 / 麦克风 / 圆形三角发送；`＋` 里放现有能力 | 顶部那颗 `＋` 就是"新对话"，不做菜单 |
| 换掉什么 | 只换间距 | 文字发送钮、麦克风位置、输入卡的左半边 | 不换什么，只是省一个菜单 |
| 新增什么 | 无 | `＋` 菜单（附件 / 审批档 / 技能 / 服务）、拖放接附件 | 无 |
| 代价 | "麦克风贴着发送"这件事做不到——中间永远有 token 计数 | 一个浮层菜单要处理 Esc、点外面、和输入框抢焦点 | 用户点 `＋` 想加东西，得到的是一个空对话 |

窗口尺寸那件是另一组：A 保持 880×640；B 800×600；C 760×560。选 B：800 是 208 的会话栏 + 592 的对话，592 刚好放下 12px 的四十来个字（一条普通长度的提问不折行），560 高减掉顶栏、输入卡和标题栏还剩约 430 给对话。C 的 560 宽刚好等于最小宽度，等于"出厂就是最小"。

## 3. 决定

**决定**：B + B。输入卡从上到下是"输入位"和"一排按钮"两段，但它们**同一张卡片**（`.lattice-assistant-field` 一个圆角一个边框）：左边 `＋`、然后完全访问那颗警示色药丸、元信息，右边麦克风贴着圆形发送。`＋` 菜单只放**现有**能力，技能与服务是"带你去那一格"（`→`），因为那些东西要一列才看得清，塞进菜单就是第二份设置页。会话栏加一颗 ☰（`Ctrl+B`），收起之后 `＋` 和 `⚙` 落到顶栏——侧栏一走，那两颗按钮不能跟着消失。窗口 800×600，最小 560×420 不变。

**代价**：

- `assistant-window.json` **升到 v3**，多一个 `sidebar: boolean`。老 v2 文件缺这个字段，读盘时当 `true`（那时候侧栏还不能收，缺字段只可能是"从没写过"）。写回走同一道迁移，所以升级只发生一次。
- 800×600 比 880×640 小一圈：880 宽时能并排放下的两栏，800 宽时对话区少 80。这是用户要的"小一点"，代价是长回答更早折行。
- `＋` 菜单是**浮层**，得自己管 Esc、管点外面、管和输入框抢焦点（`role="dialog"` 但不用 `<dialog>`：那个会把背景变惰性，而用户下一步就是要往输入框里打字）。
- 拖放从"小窗专属"变成"两个容器都要判落点"：抽屉和画布共用一个 webview，两份 `onDragDropEvent` 同时听（见 §5 第一行）。
- 灰边要靠 Win32 才能真去掉（`DwmSetWindowAttribute(DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE)`），这是**平台侧**的事，纯 CSS 做不到——`decorations(false)` 之后 DWM 仍然画一圈 1px。

**什么时候该推翻它**：如果真机上用户反复把窗口拖到 560（`min_inner_size` 的下限）并且照样开着会话栏，说明 208 太贵，那时会话栏该默认收起；或者如果 `＋` 菜单里的项超过 7 条，它就不该是菜单，该是一块可滚动的面板。

## 4. 接口与数据

**Tauri 命令**

```
方法名：assistant_window_sidebar
参数：sidebar: boolean
返回：落盘之后的整份 WindowState（v3）
错误：无（写盘失败时返回内存里那份，界面照用）
```

**为什么不复用 `assistant_window_save_rect`**：那条收的是矩形，语义是"拖完了，存一下"。侧栏开合和位置、模式、底板是同一类东西（**窗口状态**），但它不是矩形的一部分；塞进 rect 里会让"位置"这个结构多一个和坐标无关的布尔。

**落盘格式与迁移**

`assistant-window.json` v2 → **v3**：

```jsonc
{ "version": 3, "mode": "floating", "rect": {...}, "appearance": {...},
  "locked": false, "sidebar": true }   // 新增，缺省 true
```

Rust 侧 `#[serde(default = "sidebar_open")]`，TS 侧 `sidebar: input.sidebar !== false`——两边都"缺了就当展开"，因为 `false` 是个有意义的取值，不能靠 `??` 兜。

**尺寸判据要两边一字不差**（`clampAssistantSize` / `migrate_size`）：`width < MIN_W` 时**整份取出厂**，不是夹到 560。理由是老记录只可能出自 0034 之前（那时出厂 400 宽），那是"从没调过"而不是"想要 560"；而真拖到过 560 以上的人记录里就是 560 以上，`min_inner_size` 拦着拖不到更窄。两边对同一份文件给出不同尺寸的后果很具体：窗口按 Rust 的 800 开出来，前端记着 560，下一次拖动直接缩回去。

**要改的文件**

- `src/platform/AssistantPanel.tsx`：顶栏 ☰ / `＋` 菜单 / 输入卡重排 / `grow()` / `attachPath()` / `toggleRail()` / 拖放落点判定
- `src/styles.css`：`.lattice-assistant-topbar`、`.lattice-assistant-plus`、`.lattice-plus-menu`、`.lattice-assistant-send`、模式条 → 胶囊、输入卡居中 40px 边距
- `src/runtime/assistant-window.ts`：`MIN/DEFAULT`、v3、`sidebar` 迁移
- `src-tauri/src/assistant_window_policy.rs`：`DEFAULT_W/H` → 800/600
- `src-tauri/src/assistant_window.rs`：`sidebar` 字段、v3、`hide_system_border()`、`assistant_window_sidebar` 命令
- `src-tauri/src/lib.rs`：命令注册

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 往画布上拖一个组件包，输入框里多出一行 `@C:\...`，组件也装了 | 抽屉和画布**同一个 webview**，`App.tsx` 的"装组件"和这里的"加附件"两份处理器都在听 | 抽屉里先判落点：`position / devicePixelRatio` 落进面板矩形才收；小窗不用判（独立 webview） |
| 窗口外面还有一圈灰边，只是颜色变淡了 | CSS 那道 `inset box-shadow` 去掉了，DWM 那 1px 还在；`decorations(false)` 管的是标题栏，不管边框 | `DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE)`，且要在 `clip_rounded` 之后调（先设色再裁圆角，重绘会把色带回来） |
| 收起会话栏之后，新对话和设置都没了 | 那两颗按钮原本长在会话栏里 | 收起时 `＋` 和 `⚙` 落到顶栏；`Ctrl+B` 也一直在 |
| 升级之后会话栏不见了 | v2 文件没有 `sidebar`，`??` 或 `!` 把它当 `false` | `input.sidebar !== false`（Rust 侧 `serde(default = "sidebar_open")`），缺字段一律当展开 |
| 窗口按 800 开出来，拖一下就缩成 560 | 前端 `clampAssistantSize` 夹到最小、Rust `migrate_size` 抬到出厂，两边判据不同 | 两边同一判据：`width < MIN_W` → 整份出厂 |
| 输入框越写越长，把对话挤没了 | 自动高度没有上限 | `Math.min(scrollHeight, 18 * 6)`，超过 6 行内部滚（18px = 12px × 1.5，写死是为了不依赖不同 DPI 下的 computedStyle） |
| 草稿是空的，发送钮还能点，点下去什么都不发生 | 只用 `onClick` 判空 | `disabled={!draft.trim()}`；忙碌时那颗钮变成方块（Stop），不是"灰着但还能点" |
| `＋` 菜单开着，按 Esc 没关 | Esc 的处理器挂在输入框上，焦点在菜单里 | 菜单内的输入框自己也接 Esc；点外面关（同一份 `plusOpen`） |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/assistant-window.html` | 39 | 老 400×580 抬到 800×600（不是夹到 560）、v2 缺 `sidebar` 当展开、写明了 `false` 照收、屏外拉回 |
| `tests/assistant.html` | 198 | 今天零点 / 夏令时 / 未来时间戳 / 空桶不出现 / 组内保序（0034 那 10 条没动） |
| `src-tauri/src/assistant_window_policy.rs` | 10 | `migrate_size` 的同一判据（`rustc --test` 单跑） |

**手工验一次**：

1. 关掉助手再打开 → 外面不该有灰边，四角是圆的（`clip_rounded` 和 DWM 那条要一起生效）。
2. `Ctrl+B` → 会话栏收走、对话变宽、顶栏多出 `＋` 和 `⚙`；重启应用还是收着的。
3. 空输入时看发送钮是灰的；打一个字变亮；发出去之后变成方块（Stop）。
4. 输入框连打六行以上 → 到 108px 停住，框内滚动，对话区高度不变。
5. 点 `＋` → 菜单从卡片下方浮出；Esc 关、点外面关；在里面贴一个路径回车 → 草稿里多一行 `@路径`，焦点回到输入框。
6. 抽屉开着时往**画布**拖一个组件包 → 只装组件，输入框不变；往**抽屉**上拖一个文件 → 只加 `@path`。
