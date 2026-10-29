---
status: draft
date: 2026-10-29
supersedes:
code:
---

# LAT-0040 —— 一块 assistant 也能画的画板（`board` 窗口）

## 1. 问题

桌面上的三个"画东西"的组件都**有结构**：`lattice.diagram` 的框和线是排出来的，`lattice.mindmap` 的位置由树算出来，`lattice.note` 只有字。想圈住一句话、在截图边上画个箭头、随手写一个公式，这三样都不干 —— 它们要你先想清楚"这是什么结构"。

**坏结果**：讲一件事时"这块"指不出来，只能截图 + 开外部工具；assistant 能改桌面（9 个动作、能跑命令、能点键鼠），但解释"我为什么这么摆"时只能写字，画不了一张图。

用户给的形态是一张整窗画布：工具栏居中在顶、粗细滑杆贴左边、色板在左下、确认在右下、关闭在左上。

**为什么不能做成组件**（三条都能当场验证）：

1. 组件的右上角 120×28 是窗饰（拖动 / 层级 / 别针 / 重载 / 收回），真的能点（[`WIDGET_SPEC`](../WIDGET_SPEC.md) §5.1）—— 而截图里右上角是撤销 / 重做。同一块地方两套按钮。
2. 组件默认 240×140、最小 160×110，画板天生是整窗的东西。
3. assistant 要能往上写。走组件桥意味着先造一个组件工具族、还要组件常驻实例；而画板是平台自己的窗口，和 assistant 小窗同级。

## 2. 候选

**形态**

| | A：组件 `lattice.sketch` | B：独立窗口 `board`（选中） | C：桌面覆盖层 |
| --- | --- | --- | --- |
| 做法 | 一个官方组件，`agent.tools` 声明画图工具 | 平台窗口 + 一组 Tauri 命令，和 `assistant` 窗口同级 | 全屏透明窗口 + 点击穿透，能在任何应用上画 |
| 换掉什么 | 不动平台 | 平台多一个窗口 | 多一种窗口类型（穿透 + 覆盖层） |
| 新增什么 | 一个组件 + 一个工具族 | 一个窗口 + 8 条命令 + 3 个动作 | 以上全部 + 穿透与热键钩子 |
| 代价 | 窗饰与工具栏抢右上角；240×140；要占一个实例 | 一个 webview 的内存与启动路径；白名单 9 → 12 | 像素级透明撞 DWM；"画在别人窗口上"是另一个产品问题 |

**状态归属**

| | A：React 内存 | B：Rust 持有（选中） |
| --- | --- | --- |
| 做法 | 笔画在 `BoardWindow` 的 ref 里，落盘走 `storage`/命令 | 笔画在 `board.json`，Rust 是唯一真源，前端只画 |
| agent 那条路 | 要跨窗口请求/响应（`callId` + 超时），和组件工具那套一样重 | 直接调命令，改完发一条事件让窗口重画 |
| 代价 | 两个写者（人 / agent）抢同一份内存，谁赢看时序 | 每次 pointerup 一次 IPC（一条笔画一次，不是一帧一次） |

**世界坐标**

| | A：窗口 px | B：固定 1600×1000 + fit（选中） | C：归一化 0..1 |
| --- | --- | --- | --- |
| 做法 | 画在哪就是哪，窗口变大 = 多出空白 | 世界固定，窗口是视口，等比缩放居中 | 坐标除以窗口尺寸 |
| 代价 | 窗口缩小后画被裁掉 | 窗口比例不是 16:10 时有留白 | 改窗口大小会把圆拉成椭圆 |

## 3. 决定

**决定**：B（独立窗口）+ B（Rust 持有）+ B（固定世界 1600×1000）+ **矢量笔画** + assistant 的**桌面动作族第 10–12 条**。

四条理由：

1. **一个写者**。人和 agent 走同一条命令、同一份状态、同一个撤销栈。组件那条路要两个宿主同步，`LAT-0022` 的失败模式表里"两个宿主各持一份内存副本"就是那个坑。
2. **矢量**，不是位图。位图存进 JSON 会 base64 膨胀 4/3，没法撤销、没法擦除单条、没法让 agent 读回"上面画了什么"。
3. **进桌面动作族**，不新开一族。画板动作和 `placement.move` 一样是"改平台自己的状态、可撤销、用户看得见"，走同一条 `approvalFor`。新开一族要动 [`0020`](./LAT-0020-capability-descriptor.md) 那套合表，那是另一件事。
4. **不做覆盖层**。它要的点击穿透 + 全局热键 + 画在别人窗口上，是独立的一个功能；先做"一块自己的板"，覆盖层以后可以把它当工具集。

**代价**（具体）：

- 平台多一个常驻 webview（关窗口 = 藏起来，不销毁）。空载内存要进 [`ARCHITECTURE`](../ARCHITECTURE.md) §9 那本账 —— 那一格今天还写着"每组件内存：未测"。
- 动作白名单 **9 → 12**，`AGENTS.md` §1 / 不变量 14 / `README` 两份 / `WIDGET_SPEC` 里凡写"9 个动作"的地方都要改，`agent_policy.rs` 的 28 条断言要加 3 条。
- **窗口不是 16:10 时有留白**。全屏（16:9）上下各留 5%，这是"板是一张纸"的代价。想贴满窗口就得用归一化坐标，那会把圆拉扁。
- **线宽存世界单位**，所以窗口缩小时线也跟着细。这是矢量板的通病，不修。
- **撤销栈只在内存**，关掉应用就没了（和平台"撤销是内存里那一条"一致，回收站才落盘）。
- **橡皮擦整条笔画，不擦像素**。矢量数据没有"半个笔画"。

**什么时候该推翻它**：

- "要圈住别的窗口"成为真需求 → 做覆盖层（C），画板退成它的一个工具集。
- 板上常态超过 2000 条笔画 → 需要分页/图层，那是另一个数据模型。
- assistant 开始需要"看"这张板（视觉理解）→ 那是截图 + 多模态，不是这里的文本 `read`。

## 4. 接口与数据

**窗口**

```
label: "board"        （和 "main" / "assistant" / "widget-*" 都不同）
interactive: true     （要键盘：文字工具、Ctrl+Z）
层级: floating        （不贴桌面 —— 画画时它要在最前面，但不是 top）
关闭: hide()，不销毁   （状态在 Rust，重开就在）
入口: Ctrl+Shift+B（B 未被占用：D/F/O/K 已用）
```

**Tauri 命令**（8 条）

```
board_state()                              → { version, world: {w,h}, shapes: [...] }
board_add(shapes: Shape[])                 → { added, total }
board_erase(x, y, r)                       → { removed }           // 世界坐标
board_undo() / board_redo()                → { total, canUndo, canRedo }
board_clear()                              → { total }
board_text(index, text)                    → { ok }                // 双击改文字
board_export(format: "svg" | "png")        → { ok, cancelled?, path? }
```

**语法在 TS，上限与夹取在 Rust。** 这条分工不是随手分的：

- **`src/runtime/board.ts` 拥有文本语法**（agent 传进来的 `spec` 是 `string`，因为工具参数只能是 `string / number / boolean`）。解析出来的形状它本来就要拿去渲染，所以"能画什么"和"能传什么"是同一份代码 —— 和 `LAT-0008` 的 `spec` 同一个道理。
- **`board_policy.rs` 拥有上限与夹取**（200 形状 / 500 点 / 120 码点 / 2000 总量 / 坐标夹到世界框）。理由只有一个：状态在 Rust，写在哪儿就在哪儿守。前端那层是"早报错"，不是"唯一一道闸"。

于是 `board_add` 收的是**已经解析好的形状数组**，Rust 不认文本语法 —— 语法改了不用动 Rust，Rust 也不会成为第二个语法家。

**形状语法**（一行一个，坐标是世界坐标，超出会被夹到 `0..1600 / 0..1000`）

```
pen   10,10 20,15 30,12        折线，点越多越平滑
line  20,20 300,20
arrow 100,100 400,300
rect  40,40 200,120
ellipse 300,200 60,40          中心 + 半径
text  60,90 hello world
```

行尾可选两个修饰：`#rrggbb`（颜色）和 `w=3`（线宽 1–12）。`# 开头`是注释，空行忽略。上限：**一次 200 个形状 / 单条 pen 500 个点 / text 120 码点 / 板上共 2000 个形状**；超了**拒绝并回一句人话**，不截断。

**落盘**（`board.json`，`widget-store` 同级的 appdata 目录）

```json
{
  "version": 1,
  "world": { "w": 1600, "h": 1000 },
  "shapes": [
    { "kind": "pen", "points": [10,10,20,15], "color": "#1b1b1b", "w": 2 },
    { "kind": "text", "x": 60, "y": 90, "text": "hello", "size": 18, "color": "#1b1b1b" }
  ]
}
```

- `version` 不认识 → **当空板显示，但不落盘**（读坏不等于没有数据，`LAT-0022` 同一条）。
- 撤销栈不落盘。`redo` 栈在任一次新写入后清空。
- 颜色存 `#rrggbb`，不存主题名 —— 板是用户画的东西，不该跟着主题翻转。

**assistant 的工具**（3 条，`TOOL_SPECS` 里和另外 9 条并排）

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `board.draw` | `{ spec: string }` | `{ added, total }` |
| `board.read` | `{}` | `{ total, text: "…" }` —— 文字内容 + 各类数量，压到 3500 字符以内 |
| `board.clear` | `{}` | `{ total: 0 }` |

- 一次调用 = **一步撤销**。
- `board.read` 不硬塞整份：超过 3500 字符只回计数（平台那边 4000 是拒绝，半截比没有更糟）。
- 审批：`board.draw` / `board.clear` 在 `auto` 档问一次（它们改用户看得见的东西），`everything` 放行，`readonly` 剪掉（只读档连桌面表一起剪空）；`board.read` 任何档都放行。
- **`WIDGET_DENIED_ACTIONS` 要加这三条**：组件借手那条路不能往板上画 —— 板和桌面一样是"用户自己的东西"，不该被第三方组件间接改。

**快照**：`describeDesktop` 末尾加一行"画板开着，上面有 N 个形状"（没开就不出现）。这是 assistant 知道"要不要画"的唯一依据 —— 没有这行，它只能猜。

**导出**：`file.save` 带 `base64` 一律打 zip（[`export_policy.rs`](../../src-tauri/src/export_policy.rs) `:98`），所以：

- **SVG 优先**（`{ name: "board.svg", text: … }`，单文件纯文本 → 不打包，用户拿到的就是 `.svg`）。
- PNG 走 `base64`，用户拿到的是 `board.zip` 里一张 PNG。**这是已知的丑**，要么接受，要么单独改 `export_policy` 的判据 —— 那条会动到 note 图片导出的现有行为，不在这份里做。

**要改的文件**

- `src-tauri/src/board.rs`（窗口 + 状态 + 8 条命令）、`board_policy.rs`（夹取 / 上限 / 命中 / 撤销 / 迁移，`rustc --test` 可单跑）
- `board.html`、`src/boardMain.tsx`、`src/platform/BoardWindow.tsx`、`src/board.css`
- `src/runtime/board.ts`（文本语法解析 + 渲染几何：形状 → SVG path、文字度量注入）
- `src/runtime/assistant.ts`（3 条 `ToolSpec` + `approvalFor` 三条 + `WIDGET_DENIED_ACTIONS`）
- `src/platform/assistant.ts`（`AssistantSurface.board()` + `executeCall` 的第四个执行者）
- `src-tauri/src/agent_policy.rs`（`Action::BoardDraw` / `BoardClear` / `BoardRead`，9 → 12）
- `src-tauri/src/lib.rs`（`mod board;` + `generate_handler!` 八条）—— **这一处和另一个会话冲突**，见 §8
- `src/App.tsx`（`Ctrl+Shift+B`）
- `tests/board.html`（渲染几何）、`board_policy.rs` 的 `--test`
- 文档：`GLOSSARY.md` 加「画板」词条（明确它不是「画布」也不是「图面」）、`AGENTS.md` 的动作数、`README` 两份、`ROADMAP`、`WIDGET_SPEC` §3.6 那句工具族清单

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 画到一半窗口被拖走了 | 拖动走的是宿主胶囊，而板是整窗 —— 用户在板中间按下想拖窗口 | 板窗口**只允许拖标题栏**（`data-tauri-drag-region`），画布区不拖 |
| 画完关掉，重开是空的 | 关窗口销毁了 webview，状态只在内存 | 状态在 Rust；`hide()` 不销毁；落盘在每次写入之后 |
| agent 画的东西看不见 | 板没开着，命令写进了状态但没窗口 | 命令先 `show()` 再写；返回里带 `opened: true` |
| 窗口拉大，画全跑到左上角 | 用了窗口 px 存坐标 | 世界坐标 + fit 变换，窗口尺寸只影响 `scale` |
| 全屏后上下留白，用户以为画丢了 | 16:9 窗口放 16:10 的板 | 留白画成比纸略深的底（不是白），并允许 `w=1600 h=1000` 以外的板尺寸以后再加 |
| 擦一条线，整片都消失了 | 命中测试用了包围盒 | 用"点到折线的最近距离"，阈值 12 世界 px；`rect`/`ellipse` 用描边命中 |
| 中文输入法打字，回车没上屏却提交了文字 | 没判 `isComposing` | `compositionstart/end` 期间不响应 `Enter` / `Esc` |
| 撤销退掉的是 agent 那一笔，不是自己刚画的 | 两个写者共用一个栈但语义不同 | 共用一个栈**就是设计**：一次写入一步，谁写都算一步 |
| 板上的字在深色主题下看不见 | 颜色跟了主题 | 颜色存死值，板自己永远是浅色纸 |
| 一次 `board.draw` 传 500 行，界面卡死 | 没有上限 | 200 / 500 / 120 / 2000 四个上限，超了拒绝 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `board_policy.rs`（`rustc --test`） | ≥ 14 | 坐标夹到世界框、四个上限各拒绝一次、撤销/重做（新写入清空 redo）、`version` 不认识时不落盘、命中测试（折线最近距离 / 描边命中 / 阈值边界） |
| `tests/board.html` | ≥ 18 | 六种形状各解析一遍、修饰符 `#hex` 与 `w=`、`#` 注释与空行、坏行整行丢弃不连坐、`pen` 的平滑不改变端点、形状 → SVG path 的确定性（同输入同输出）、文字宽度用注入的 `measure` 而不是猜 |
| `agent_policy.rs`（`rustc --test`） | +3 | 三条新动作在 `ACTIONS` 里、`readonly` 剪掉 draw/clear、`board.read` 任何档都在 |
| `tests/assistant.html` | +4 | 三条 `ToolSpec` 进了 `allTools`、`WIDGET_DENIED_ACTIONS` 含这三条、`approvalFor` 三档各一条 |

**手工验一次**：

1. `Ctrl+Shift+B` 开板 → 用鼠标画一条曲线 → 关窗口 → 再开，线还在。
2. 窗口从 960×680 拉到全屏，线跟着等比放大、不变形。
3. 让 assistant 说"在左上角画一个红框，写上 发布流程" → 板自动弹出、框和字出现在正确位置 → 一次 `Ctrl+Z` 全退掉。
4. 关掉板，再说一次"画一个框" → 板自己弹出来，画完不消失。
5. 导出 SVG，用浏览器打开，和板上一模一样。

## 7. 截图逐项对应

| 截图里的东西 | v1 | 说明 |
| --- | --- | --- |
| 左上 × | ✅ | 藏起来（不销毁），状态还在 |
| 顶部工具栏：指针 / 笔 / T / 形状 / 橡皮 | ✅ | 形状是二级菜单（矩形 / 椭圆 / 线 / 箭头） |
| 右上 撤销 / 重做 | ✅ | 和 `Ctrl+Z` / `Ctrl+Shift+Z` 同一个栈 |
| 左侧竖直粗细滑杆 | ✅ | 1–12 世界 px；文字工具时它变成字号 12–36 |
| 左下色板（彩虹 + 10 色） | ✅ | 彩虹格是"自定义"，展开一行 12 个扩展色；不引原生 `<input type=color>`（它带系统外观） |
| 右下 ✓ | ✅ | "存好并收起"，和 × 的区别只在文案 |
| （截图没有）移动 / 缩放画布 | ❌ | 世界固定 1600×1000，fit 到窗口；平移缩放留给"板变大"那一天 |
| （截图没有）图层 / 图片 / 形状填充 | ❌ | 填充要区分"描边"和"面"，那是 diagram 的活 |

## 8. 分两步落地（以及当前为什么只能做第一步）

**第一步（纯 TS，不碰任何共享文件）**：`src/runtime/board.ts` + `tests/board.html`。语法解析和渲染几何都能单跑，`typecheck` 与 `test:browser` 就是它的验收，不需要 Rust、不需要窗口。

**第二步（要动 `lib.rs`）**：`board.rs` / `board_policy.rs`、窗口、八条命令、assistant 那三条工具、`Ctrl+Shift+B`、文档数字。**`src-tauri/src/lib.rs` 现在有另一个会话的未提交改动**（`capability_probe` / `audio` / `hands`），而 `mod board;` 和 `generate_handler!` 都在那个文件里 —— 混进去就是两件事一个提交。

`board_policy.rs` 刻意放在第二步：一个不进 `lib.rs` 的 `.rs` 文件在 `cargo` 眼里不存在，先写出来只是让树里多一份没人编译的代码。

所以：第一步做完先停在能验的地方，等那棵树干净了再动第二步。这不是拖延，是这个仓库同时有两个会话在同一个工作树里时的唯一安全顺序。
