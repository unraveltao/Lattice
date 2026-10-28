---
status: accepted
date: 2026-10-25
code: src/platform/SettingsMenu.tsx, src/platform/ProfilePanel.tsx, src/platform/Avatar.tsx, src/runtime/usage.ts, tests/profile.tsx, tests/usage.html, src-tauri/src/usage.rs, src-tauri/src/usage_policy.rs, src-tauri/src/lib.rs, src-tauri/src/runner.rs, src/styles.css, src/runtime/i18n/settings.ts
---

# LAT-0001 —— 设置面板与个人档案页

## 1. 问题

设置已经长到一列十六行，全部塞在 300px 的浮层里（`.lattice-menu`）。再加一项语言或目录来源，只能往下挤；而"这台电脑上我用它多久了"这种只属于用户自己的记录，平台一条都没有——今天不开始记，明年这张图还是空的。

具体坏结果三个：

- 想改语言，要在一列同形的行里找到 Language；想开调试，得先知道它藏在这一列的哪个位置。
- 档案只有名字和邮箱，没有能回看的东西；"用了 XX 天"是编不出来的。
- 导航里同时出现 Profile 和 Sign in：已登录的人看到"登录"，会以为还有另一个账号。

## 2. 候选

形态：

| | A：浮层加子页 | B：居中设置面板（选） | C：独立设置窗口 |
| --- | --- | --- | --- |
| 做法 | 沿用 300px 菜单，Profile 做第二页 | 880×620 面板，左导航 7 项，右内容 | 新 Tauri 窗口 + `settings.html` 入口 |
| 换掉什么 | 只换内容 | 设置形态（浮层 → 面板） | 形态 + store |
| 新增什么 | 一个子页 | 面板壳、档案页、`usage.json`、Rust 计数 | 第二个前端入口、capabilities、跨窗口转发 |
| 代价 | 53×7 热力图放不下，只能砍成 12 周 | 约 600 行 UI/CSS、一个 Rust 模块、一种新落盘格式 | 和 assistant 小窗同一笔账（无 store、命令转发、窗口生命周期），为一个一年打开几次的页面付不起 |

数据：

| | A：活跃天 0/1 | B：活跃分钟（选） | C：桥调用次数 |
| --- | --- | --- | --- |
| 数据源 | 主窗口每天首次交互 | Rust 每 60s 看有没有 Lattice 窗口在前台 | 两个宿主每次桥调用上报 |
| 换掉什么 | 不用 Rust | 加 `usage.json` + 焦点事件 | 改 `bridge.ts` 和两个宿主 |
| 代价 | 只有两档，看不出强度 | 每分钟滴答一次，最多丢 5 分钟 | 时钟每秒问一次时间，每分钟都会满格，图失去意义 |

## 3. 决定

**决定**：B + 活跃分钟。设置从浮层升成面板；Profile 是面板里的一页；活跃分钟由 Rust 按窗口焦点自己数，前端不上报。导航里**不再并列** Sign in 与 Profile：未登录时"档案"那一项本身就是创建入口，登录后它显示 Profile，Sign out 沉到页面底部。

**代价**：一次 UI 大改，现有十几行必须原样搬进分组，一个入口都不能漏（刷新只有设置里那一份）；Rust 多一个模块和一种文件格式；热力图数据从上线当天才开始，历史补不回来，页面上必须直说"从今天开始记录"。

**什么时候该推翻它**：三个月后如果设置项仍不到八行、Profile 也没人打开，面板退回浮层即可（档案页可以不要）；如果采集被反馈"多余 / 不安"，砍掉采集与热力图，只留资料编辑，`usage.json` 一起删。

## 4. 接口与数据

**Tauri 命令**

```
usage_read()  -> { days: { "YYYY-MM-DD": minutes }, totalMinutes, since }
usage_clear() -> ()
```

没有 `usage_bump`：计数在 Rust 内部完成，前端不上报，桥方法表和权限都不动。

**落盘**

`%APPDATA%\com.iron-tom.lattice\usage.json`

```json
{ "version": 1, "days": { "2026-10-25": 42 } }
```

- 临时文件 + 原子替换；内存累加，每 5 分钟或退出时 flush。退出这条路走 `RunEvent::Exit` 一次兜住 —— 托盘那份 Quit 直接 `app.exit(0)`，不经过设置里的 `quit_app`。
- 超过 400 天的键在读写时裁掉；一天最多 1440 分钟。
- **不进 `state.json`**：那份是前端整体回写的，桌面窗口又没有 store，两边的计数会互相盖。

**profile**

这一轮不改 `state.json` 的形状：档案仍然只有 `name / email / since`。"完善资料"落地为可编辑的名字与邮箱；头像颜色留到以后（改它要动 `Profile` 的归一化和 picker，属于另一件事）。

**要改的文件**：`SettingsMenu.tsx`（浮层 → 面板）、`ProfilePanel.tsx`（新）、`Avatar.tsx`（从菜单里提出来的共用组件）、`runtime/usage.ts`（纯函数）、`usage.rs` / `usage_policy.rs`、`lib.rs`（注册命令、退出 flush）、`runner.rs`（组件窗口的焦点）、`styles.css`、`runtime/i18n/settings.ts`、`tests/profile.tsx`、`tests/usage.html`。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 热力图整年全空 | 采集上线晚，历史不存在 | 写"从今天开始记录"，不伪造 |
| 每天都是满格 | 用"组件可见"当活跃 | 只算前台焦点，常驻可见不算 |
| 关应用前最后一分钟丢了 | 批量落盘 | 退出路径 flush；最多丢 30 秒 |
| 某天多一格 / 少一格 | 跨时区、改系统时间 | 按本地日键，接受并在文档写明 |
| 旧 `state.json` 少字段 | 严格校验 | 未知键丢弃、缺字段走默认；档案页不因一个坏键打不开 |
| 面板打开后画布还能被点到 | 没做焦点陷阱 | `aria-modal` + 焦点锁 + Esc + 归还焦点 |
| 用户以为 Sign in 是云账号 | 措辞 | 每处写"只保存在这台电脑" |
| 桌面组件不进热力图 | 只统计主窗口 | 统计所有 `widget-*` 窗口的焦点 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/profile.tsx` | 28 | 有档案 / 没档案只有一套入口；统计数字；热力图 53×7 与未来格；编辑、清除记录、Sign out 的回调；危险区在最后 |
| `tests/usage.html` | 36 | 日键、闰年、固定阈值分档、两种读回形状、400 天裁剪、53 周网格、连续天数跨年、说人话 |
| `src-tauri/src/usage_policy.rs` | 8 | 合法日键、非法日期、分钟累加、一天封顶、裁剪最旧、总量 |

**手工验一次**：面板的焦点陷阱与 Esc；热力图在明暗两套主题下；桌面组件在前台时热力图当天 +1；关掉应用再打开，最后半分钟还在。
