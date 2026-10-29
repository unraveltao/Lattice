---
name: invariants
description: 改棂（Lattice）代码前的一道闸——按"我要动什么"查出必须遵守的不变量、会连带改的文件，以及几条一踩就静默坏的坑。
whenToUse: 在这个仓库动手写代码之前，尤其是改桥、事件、权限、关闭窗口、CSP、联网、签名、配置、文案中的任何一条。
---

# 改动前闸门

不变量全文在 [AGENTS.md](../../../AGENTS.md) 第 4 节 —— 那一页很长，但改代码前只有这一段必须读。这里只做一件事：**你正要改的东西，对应哪几条，会连带改哪些文件**。其中五条（2、7、8、11、17）踩一次的代价是"静默坏"，不是报错。

**一次改动命中好几行是常态 —— 取并集，别挑一行。** 按"这次算哪一类任务"只挑一行必漏：加一条 `terminal:exec` 同时动了清单的联合类型、桥、两个宿主、Rust、i18n、能力体检和四处测试，横跨下面五行。组合起来的漏项在这个仓库里几乎全是**静默**的（`LABELS` 少一行只显示内部 id、i18n 少一句只永远说英文），所以宁可多读一行。

## 先回答两个问题

1. **这段代码属于哪个宿主？** 画布（`WidgetFrame.tsx`）和桌面（`widgetHost.ts`）都要走 `runtime/bridge.ts` 的同一张方法表。任何"只在预览能用"或"只在桌面能用"的分叉都是 bug，不是特性。
2. **这个状态属于哪一层？** `grants` 的键是 `widgetId`（信不信任这段代码），`configs` 的键是 `instanceId`（这一份怎么显示）。两者互相借用的后果分别是"两个时钟共享 12/24 小时制"和"同一个组件要授权两遍"。

## 按改动类型查

| 你要动的 | 必读 | 连带必改 / 必查 |
|---|---|---|
| 加桥方法 | 2 | 权限要新增的话**五处一起改**：`runtime/manifest.ts` 的 `Permission`、`PERMISSION_READY`、`PERMISSION_LABELS`、`runtime/catalogue.ts` 的 `KNOWN_PERMISSIONS`、`docs/WIDGET_SPEC.md` 权限表。碰系统就写 Rust 命令并注册进 `lib.rs` 的 `invoke_handler`。权限未授予时**返回结构化错误**，不抛异常 |
| 发一个"给某个窗口"的事件 | **9** | `emit_to` 是**广播**：JS 侧监听器 target 是 `Any`，任何 emit 都会送到每个窗口。所以载荷必须带 `instanceId` 或 `label`，收件人自己比一次。不带的后果是串味不是报错（拖 A 的底板滑杆四张卡一起变色、撤 A 的权限四个组件一起重载）。`lattice:theme` 是唯一故意全局的 |
| 权限生效 / 撤销 | **8** | 四条同时满足：① 比对**先排序去重**（顺序变了不算变，否则点一下开关就重载一次）；② 载荷带 `instanceId`；③ 宿主收到后既换集合**也** `reloadWidget()`；④ `create()` 登记 `HostConfig` 时也用排好序的那份。画布卡片上那句 `Needs …` 要按最新 `grants` 过滤 |
| 加平台状态字段 | — | 一路加到底：`store.ts`（interface + 初始值 + action）→ `partialize`（不加 = 不持久化）→ `buildSpecs` → `WidgetWindowSpec`(TS) → `WidgetWindowSpec`(Rust) → `HostConfig` → **`Applied`**。最后那个最容易漏，不在里面的字段永远不触发窗口更新 |
| 关窗口 / 删 placement | **11** | `widget_close` 的 `reason` **必须显式传**，只有 `reason == "user"` 才让主窗口删 placement；其余只关窗口并记进 `Runner.suppressed`。那行 `eprintln!` 不许删。别在 `removePlacement` 之外直接 `filter` 掉 placement——那等于绕开 8 秒 `Undo` |
| 组件 CSP / 出网 | **12**、14 | `'self'` 在沙箱里是废的（文档源 opaque）；协议源必须显式写，且与 `runtime/registry.ts::widgetSchemeBase` 一字不差（Windows 是 `http://lattice-widget.localhost`）。`connect-src` 收在组件自己的 origin 上，不是 `'none'`。CSP 管不了自我导航，那一半在 `egress.rs` |
| 加联网主机 / 改白名单 | 14 | 三道闸顺序不能换：权限 → `manifest.network.hosts` → 请求形状。**没有通配符，这是故意的**；端口算身份；重定向必须关（否则白名单失效）；组件桥上的 `shell.open` 也只开 http/https（`open_policy.rs`） |
| 组件渲染 / 底板 / 主题 | 6、18 | 组件里不写死颜色，全取 `--lattice-*`；宿主页三层顺序（`canvas` z0 / `veil` z1 / `iframe` z2 / 内描边 `body::after` z5）。外观变更只有两条路：`widget_set_appearance`（拖滑杆）+ `sync_widget_windows`（兜底） |
| 错误通道 / 注入 | **7** | `__lattice_diag` 与 `__lattice` 两条消息，两个宿主要**先认错误再认桥**，且来源校验在 `isWidgetErrorReport` 之前。改 `runtime/widget-reporter.js` 的 `tag` 要同步改 `runtime/diagnostics.ts` 的 `REPORT_TAG`（`tests/diagnostics.html` 钉着字面量） |
| 清单 `help` / 配置项 | **17** | 说明写清单不写 README；坏条目逐条丢；**改了行为同一次提交补当前版本那条 changelog**；每个 `config` 字段要么自带 `help` 要么在正文被提到（`tests/help.html` 两种情况都钉着） |
| 界面文案 | 19 | 英文原句就是 key，中文进 `runtime/i18n/*.ts` 的对应分片（纯数据，一个 import 都不许有）。组件里用 `useT()`，模块级用 `t()`；模块顶层常量数组**不能**在初始化时 `t()` |
| 装包 / 签名 / 更新 | **15**、16 | 三道校验顺序：`sha256` → ed25519 签名 → 钥匙等于**首次安装钉住**的那把。**先验签名再看版本**（反过来换钥匙的包会被当成普通更新静默装进去）。换钥匙要用户点头并印两把指纹。平台更新与组件更新是两套（`.keys/updater.key` 保密，`scripts/dev-publisher.key` 故意公开） |
| 引入新名字 | 19 | 仓库里已有名字就用那个；没有就当场定一个写进 [GLOSSARY.md](../../../GLOSSARY.md) 再写代码。撞名先裁再写——"靠上下文能分清"的代价是猜错不会报错 |

## 五条一踩就静默坏的

1. **不变量 2**：分叉的宿主。症状是"预览好、桌面不对"或反过来。
2. **不变量 7**：错误通道和桥混在一起。症状是组件能靠伪造"错误"骗到宿主一次回话，或者每次加载弹一张错误卡。
3. **不变量 8**：权限是活快照。症状是撤了权限，已经开着的窗口还在用。
4. **不变量 11**：`reason` 省略。症状是用户的布局被静默删掉（真实发生过三次）。
5. **不变量 17**：`help` 与 `changelog` 与行为脱钩。症状是用户看到的说明是上一版的。

## 另外三条不是不变量、但同样硬的

- **落盘不用 `localStorage`**（这台机器上 WebView2 把它放内存，进程一退就没）。走 `state.json` / `widget-data/*.json`，临时文件 + 原子替换。
- **`store.ts` 有 `hydrated` 闸门**：水合完成前不许写盘，否则默认空状态会盖到磁盘上。
- **`sync_widget_windows` / `close_widget_windows` / `widget_close` 必须 `async fn`**：同步命令占着主线程等 `build()`，而 `build()` 要把建窗口投递回主线程——直接死锁。`assistant_window_*` 三个同理。

## 收尾

改完先跑 `verify` 这个 skill 的阶梯（`typecheck` + 对应断言页 + 纯逻辑壳子）。这条闸放行不等于验过。
