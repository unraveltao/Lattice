---
status: accepted
date: 2026-10-27
supersedes:
code: 49ea0b2..HEAD
---

# LAT-0029 —— 把窗口层级从两档改成三档

## 1. 问题

用户在两天里报了三次"置顶有问题"：先是"置顶应该和 layer 的按钮绑定"，然后是"这里的置顶是没有用处的，我点了也没效果，我在面板里调节 layer 才有用"，最后是"我小组件的 layer 调节与相应的属性是没有关联的"。

前两轮修的都是**同步**：宿主页手里那份 `HostConfig.layer` 副本没人更新、`patch_layer` 谎报"已应用"。修完之后的构建（`lattice.exe` 12:40:25，`runner.rs` 12:39:55）确实包含全部修复，dev server 也在发新代码 —— 用户还是说没用。

所以问题不在同步。真机上一问就清楚了：**他能选的只有"沉到最底下"和"压在所有东西上面"两档**，而他要的那个状态是"浮在资源管理器上面，但不压全屏视频"。这个状态在模型里不存在。他点来点去，看到的是"一会儿在下面、一会儿在上面"，说不出哪一档是他要的，于是描述成"调节和属性没有关联"。

另一件事把问题放大了：`desktop` 这一档在 Win32 里是**两种不同的东西**，而界面上只有一句话。纯展示组件（时钟）真的挂进 WorkerW，沉在壁纸那一层；可输入的组件（便签）只能退成 `HWND_BOTTOM` 的普通窗口 —— 因为挂进 WorkerW 之后拿不到键盘焦点。检查器却对两者都说"Sits above desktop icons and below normal windows"。屏幕上写的和窗口做的是两件事，用户当然觉得"属性没有关联"。

## 2. 候选

| | A：只改文案 | B：三档 | C：五档（对齐 Windows 的 z 序带） |
| --- | --- | --- | --- |
| 做法 | 保持 `desktop` / `top`，把说明写准 | 加 `normal`，按 z 序从下到上排 | `bottom` / `desktop` / `normal` / `top` / `topmost` 五档 |
| 换掉什么 | 用户对"属性"的误解 | 两档模型、`state.json` 的两个旧值要兼容 | 全部枚举 + 属性面板要能解释五档的区别 |
| 新增什么 | 一段更长的说明 | 一个枚举值、一条 `HWND_NOTOPMOST` 分支、一行真话读数 | 三档没人分得清的档位 |
| 代价 | 用户想要的那一档**还是不存在**，第四次报同样的 bug | `WindowLayer` 加值要动 Rust / TS / 存档兼容 / 检查器 / 窗饰 / 文档六处 | 用户要在五个词里挑，其中两个（`bottom` / `desktop`）在交互组件上根本不可区分 |

## 3. 决定

**决定**：B。三档，顺序就是 z 序：`desktop` → `normal` → `top`。

**代价**：
- `WindowLayer` 加一个值，要动六处：`desktop.rs` 的枚举与 `apply` 分支、`runner.rs` 的 `diff` 语义（不用改，但得确认）、`runtime/layer.ts`、`layerLook` / `nextLayer`、检查器那排分段按钮、`WIDGET_SPEC` 与 `GLOSSARY`。
- 存档**不需要迁移**：旧的两个值 `"desktop"` / `"top"` 照旧解析，新值是纯增量。反过来说，**新版本写出的 `"normal"` 被旧版本读到会降级成 `"desktop"`** —— 单向兼容，可接受（用户不会拿旧版打开新存档）。
- 宿主页那颗箭头从"切换"变成"循环"，连点三下回原处。两档时用户能靠"再点一下"猜出另一半，三档时猜不出来，所以提示语必须**先说现在在哪、再说点一下去哪儿**。
- 多一个 Tauri 命令（`widget_layer_probe`）和一行检查器读数。

**什么时候该推翻它**：如果用户接下来要的是"每个组件单独记住自己在某个具体窗口的上/下"（真正的 z 序排序，而不是档位），那三档也不够，得走窗口枚举 + 相对定位那条路。到那时候这份文档的"档位"模型整个作废，不是加第四档。

## 4. 接口与数据

**Tauri 命令**

```
方法名：widget_layer_probe
参数：instanceId: String
返回：{ actual: "workerw"|"bottom"|"normal"|"topmost"|"unknown", parented: bool, topmost: bool, sunk: bool, found: bool }
错误："this widget has no window right now"（画布上摆着、桌面上没开）/ "window <label> is gone"
```

由**主窗口**调用并带 `instanceId`：主窗口手里只有 store 主键，而探针必须问组件那个窗口 —— 问主窗口自己只会得到主窗口的层级。所以先 `Runner::label_of(instance_id)` 反查 label。只读、幂等，不碰 `Applied`。

**`WindowLayer`**

```rust
pub enum WindowLayer { Desktop, Normal, Top }   // serde lowercase
```

`normal` 的 Win32 落法：`reparent(null)` 摘出 WorkerW，再 `SetWindowPos(HWND_NOTOPMOST)`；收尾的 `set_always_on_top(layer == Top)` 保留（tao 自己记着 topmost 那一位，只改 Win32 会被它下一次样式重排按回去）。底层守卫只给 `Desktop + interactive`。

**落盘格式与迁移**

`state.json` 的 `placements[].layer` 从两值扩到三值，**无迁移**。旧值原样可读；新值 `"normal"` 被旧版本读到会落到默认档 `"desktop"`（`asLayer` 的兜底），单向兼容。

**要改的文件**

| 处 | 文件 |
| --- | --- |
| 枚举 + Win32 落法 + 探针 | `src-tauri/src/desktop.rs` |
| 命令 + 反查 | `src-tauri/src/runner.rs`、`src-tauri/src/lib.rs` |
| 联合类型唯一的家 | `src/runtime/layer.ts`（新）、`src/runtime/manifest.ts`、`src/platform/desktop.ts` |
| 窗饰循环 | `src/runtime/chrome-state.ts`、`src/widgetHost.ts` |
| 检查器 + 读数 | `src/platform/InspectorPanel.tsx`、`src/platform/LayerProbeLine.tsx`（新）、`src/styles.css` |
| 文案 | `src/runtime/i18n/shell.ts`、`src/runtime/i18n/panels.ts` |
| 文档 | `WIDGET_SPEC` §2.8、`GLOSSARY`、`AGENTS` §8.4、`ROADMAP`、`PITFALLS` |

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 选"普通窗口"之后组件还是被浏览器盖住 | 守卫没摘，`HWND_NOTOPMOST` 被 `bottom_proc` 改写成 `HWND_BOTTOM` | `apply_to` 里 `set_sink(target, guard)` 必须先于 `apply_layer`，且 `guard` 只认 `Desktop + interactive` |
| 选"置顶"之后层级读数说 `normal` | `set_always_on_top(true)` 被后面的 `strip_frame` 的 `SWP_FRAMECHANGED` 抹掉 | 顺序必须是 `apply_layer` → `strip_frame` → `clip_rounded` → `set_always_on_top` |
| 读数一直是 `workerw`，怎么点都不变 | 窗口挂在 WorkerW 下，`SetWindowPos` 动不了父窗口的子窗口 z 序 | 切档时必须先 `reparent(null)`，`Normal` 和 `Top` 两个分支都有 |
| 读数说 `bottom`，用户要的是"贴桌面" | 组件 `interactive: true`，WorkerW 那条路走不了 | 这不是 bug，是取舍。界面上必须按 `interactive` 换文案，别承诺做不到的事 |
| 改完层级要等半秒才生效 | 命令只发意图，走 120ms 防抖的同步 | 预期行为。探针 400ms 后再问一次（`SETTLE_MS`），别在挂载那一刻下结论 |
| 检查器那行永远显示"这一份还没开窗" | 组件只摆在画布上，桌面上没有窗口 | 正确行为，不是错误。`widget_layer_probe` 的 `Err` 一律当"没开窗"处理，别画成红字 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/chrome-state.html` | 71 | 三档三图标 / 三句提示语、循环顺序、`adoptLayer` 拒绝不认识的值、`expectedProbe` 按 `interactive` 分档、`probeLabelKey` 五种状态五句话、`layerHintKey` 三档三句 |
| `src-tauri/src/desktop.rs` | 0（本机跑不了 `cargo test`） | `probe()` 的判据顺序只能真机验 |

**手工验一次**：

1. 重启 `npm run tauri dev`（Rust 改了，光热更新不够）。
2. 把一个**便签**（`interactive: true`）投到桌面，检查器点「普通」，打开资源管理器最大化 —— 便签应该**被盖住**；点「置顶」—— 应该浮在资源管理器上面。读数行依次显示 `Plain window ✓` / `On top ✓`。
3. 同一个便签点「桌面」—— 读数应该是 `Bottom of the stack ✓`，**不是** `On the desktop`。这是取舍，不是失败。
4. 把一个**时钟**（`interactive: false`）投到桌面，点「桌面」—— 读数应该是 `On the desktop ✓`（`workerw`）。若报 `Bottom of the stack`，说明这台机器上 `find_worker_w()` 没找到 WorkerW，属于降级 —— 这时候红字那句"要的是「贴在桌面上」，系统实际报的是「压在最底层」"就是它该说的话。
5. 宿主页那颗箭头连点三下：桌面 → 普通 → 置顶 → 桌面，每次悬停提示都先说现在在哪。
