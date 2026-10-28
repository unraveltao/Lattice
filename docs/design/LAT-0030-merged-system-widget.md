---
status: accepted
date: 2026-10-28
supersedes:
code: src-tauri/src/gpu.rs, src-tauri/src/gpu_policy.rs, public/widgets/lattice.sysmon/, src/platform/store.ts
---

# LAT-0030 —— 把电池并进系统组件，并给系统加 GPU

## 1. 问题

桌面上想看全"这台机器现在怎么样"，得摆两个组件：`lattice.sysmon`（CPU / 内存 /
磁盘 / 网络）和 `lattice.battery`（电量 / 充电）。两张卡都是 240 上下宽、都停在同一
个角落，用户实际会做的事是把它们摞在一起 —— 而摞起来之后，标题占两行、窗饰挡两
次、底边距多一份，同样的信息多花掉一百多像素高度。更要紧的是：**它们本来就是同
一件事**（"这台机器现在的状态"），只是当初按"数据源"拆的包，不是按"用户想知道什
么"拆的。

同时缺一块：GPU。任务管理器首屏有它，这里没有；一台在跑游戏的机器上，"CPU 30%、
内存 60%"会让人以为很闲。

第三个问题不是用户提的，是做这件事时冒出来的：**"显示哪几块"没有地方可调**。六块
内容（走势 / 逐核 / GPU / 电池 / 磁盘 / 网络）对所有人全开，而有人只想要那两行数字。

## 2. 候选

| | A：保留两个组件，只给 sysmon 加 GPU | B：并进 sysmon，`lattice.battery` 下架 | C：并进 sysmon，但电池组件留着 |
| --- | --- | --- | --- |
| 做法 | sysmon 加 GPU 行 + 六个开关；battery 原样不动 | 电池成为 sysmon 的一行；删掉 battery 包，老的电池卡迁移成"只显示电池"的系统卡 | 同 B，但 `lattice.battery` 继续在商店里 |
| 换掉什么 | 什么都没换，只是变多 | 少一个组件包；少一个"只有电量"的独立形态 | 少一个"只有电量"的独立形态，但包还在 |
| 新增什么 | GPU 采样（PDH）+ 清单 `config` 六项 | 同左，外加一条 `STATE_VERSION` 3 迁移 | 同 B |
| 代价 | 用户仍然要摆两张卡；两块卡的电量口径将来会漂 | **动用户的桌面**：迁移要替他把电池卡改写成系统卡；`installedIds` / 回收站 / 桌面矩形都要跟着清 | 商店里两个能看电量的组件，其中一个永远停在 0.1.0；以后每次改电池都要改两处 |

## 3. 决定

**B。** A 没有解决"两张卡摞在一起"这件事，只是让其中一张更长；C 把一个已知的死
角留着（下架的组件没人维护，而它还在商店里教用户"电量可以单独看"）。

**代价**（具体）：一次 `state.json` 迁移，改的是用户摆好的东西 —— 老的电池卡会被
改写成系统卡（`trace/cores/gpu/disk/network` 全关，只留电池），尺寸从 240×146 抬到
240×176；老的系统卡高度不足 280 的会被抬到 328。回收站里那几条电池快照直接丢掉
（它们指向一个不存在的包）。**迁移是单向的**：用户看到的是"我的电量卡换了个样子"，
不是"我的卡没了"。

**什么时候该推翻它**：如果以后有人真的需要"一张只有电量的迷你卡"，正确的做法不是
把 battery 包复活，而是给清单加一个 `preset`（预置开关组合），让用户一键把系统卡
切成"只看电池"。那时 176 高、只有一行的形态仍然在，只是入口从"装另一个组件"变成
"改一个开关"。

## 4. 接口与数据

**桥方法 / Tauri 命令**

没有新命令。GPU 挂在 `system.metrics` 的返回上（它已经有一秒的缓存窗口，PDH 那
一条查询正好跟着这个节拍走）：

```
方法名：system.metrics（不变）
参数：无
返回：{ cpu, memory, disk, network, system, gpu: Gpu | null, sampledAt }
      Gpu = { name: string, usage: 0..1, used: u64, total: u64 }
错误：不变（permission_denied / internal）
```

`gpu: null` 是**"读不到"**，不是 0%：没有独显、驱动没装、计数器被策略关掉，三种
情况在 PDH 眼里长得一样（都是 `PdhAddCounter` 失败），分不开，所以只能说"没有"。
组件据此把整行收起来。

**落盘格式与迁移**

`state.json` 的 `STATE_VERSION` 从 2 抬到 3。判据只有版本号，不猜内容：

- `placements[]` 里 `widgetId === "lattice.battery"` 的，改写成 `lattice.sysmon`
  加一个新的 `instanceId`，`configs[新 id]` 写 `{trace:false, cores:false,
  gpu:false, disk:false, network:false}`，`configs[老 id]` 删掉；
- `widgetId === "lattice.sysmon"` 且 `h < 280` 的，`h = 328`（0.2 的默认是 240，
  而 0.3 的内容从 190 涨到 278，不抬就是把底栏挤到卡片外面）；
- `trash[]` 里指向 battery 的条目丢掉；`desktopRects` / `selectedInstanceId` 跟着
  改指向；`installedIds` 里去掉 `lattice.battery`。
- **`desktopRects` 里那份尺寸也一起抬**（只往上不往下）：桌面窗口是按那次摆放的
  尺寸开的（`buildSpecs` 里 `placed.h` 优先于 `placement.h`），只抬 `placement.h`
  的话，画布里看着正好、桌面上底栏还是被切掉半行 —— 而这条只有真机看得见。

**要改的文件**

- `src-tauri/src/gpu.rs`（PDH 查询 + DXGI 枚举）、`gpu_policy.rs`（分组取 max，纯逻辑）
- `src-tauri/src/metrics.rs`（多一个 `gpu` 字段）、`Cargo.toml`（两个 feature）
- `public/widgets/lattice.sysmon/`（清单 `config` + 六块内容 + 第二条心跳）
- `src/platform/store.ts`（`STATE_VERSION` 3）
- 删 `public/widgets/lattice.battery/`、`tests/battery.{html,ts}`

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| GPU 那行一直不出现，机器明明有独显 | 中文系统上 `PdhAddCounterW` 拿英文对象名会 `PDH_CSTATUS_NO_OBJECT` | 先 `PdhAddEnglishCounterW`（按英文名反查本地化名），失败再退回原名。反过来的顺序在中文机器上永远失败 |
| GPU 显示 0%，但风扇在转 | 第一次 `PdhCollectQueryData` 只是基线，速率型计数器要两次 collect | 第一拍返回 `None`（行不出现），第二拍起才有数 |
| GPU 数字飙到 300% | 把 3D / Copy / VideoDecode 几条引擎加起来了 | 同引擎内求和，**跨引擎取最大**，再夹到 100 |
| 混合显卡上数字对不上风扇声 | 取到了核显 | 按 LUID 分组，挑最忙那块；一样忙挑显存大的 |
| 驱动更新之后 GPU 行消失 | 计数器实例集合被换掉，老查询一直回空 | 连续三拍失败就重建查询；加不上计数器时 30 秒退避重试一次 |
| 关掉"网络"之后底栏剩一条横线 | 底栏两行都藏了，`.sys-foot` 的 `border-top` 还在 | 两行都关时整条底栏一起收 |
| 拨了开关没反应 | `.sys-metric { display: flex }` 把 `[hidden]` 压掉了 | 显式写一遍 `.sys-metric[hidden] { display: none }`（这条真踩过） |
| 老用户升级后底栏被切掉半行 | 0.2 的卡是 240 高，0.3 的内容要 278 | 迁移里把 `h < 280` 的抬到 328 |
| 画布里好好的，桌面上还是切掉半行 | 迁移只抬了 `placement.h`，桌面窗口按 `desktopRects[].h` 开 | 两份都抬（只往上不往下）——这条真踩过，且只在真机上看得见 |
| 升级后回收站里恢复出一张破卡 | 快照里的 `widgetId` 还是 `lattice.battery` | 迁移时丢掉那几条 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/sysmon.html` | 104 | 六块内容的显隐、GPU 行的格式化与"读不到就不画"、电池状态与告警、两条心跳各自认领 |
| `tests/catalogue-cache.html` | 47（其中 17 条是这次加的） | `STATE_VERSION` 2 → 3：电池卡改写而不是删掉、只留电池的配置、尺寸与 `desktopRects` 一起抬、回收站与已装列表清干净、v3 再读一遍不变 |
| `src-tauri/src/gpu_policy.rs` | 9 | 实例名解析、同引擎求和 / 跨引擎取最大、夹 100、LUID 分组、混合显卡挑哪块 |
| `src-tauri/src/metrics_policy.rs` | 5 | （未改动）CPU 差分那条口径 |

**手工验一次**：

装 `lattice.sysmon` → 卡片上应该有 GPU 行（有独显的机器）和电池行（笔记本）→
属性面板关掉"走势"和"逐核"，卡片内容上移、不留白 → 关掉全部六个，只剩 CPU 和内存
两行 → 再全开，折线宽度重新量过 → 重启应用，开关还在。

**迁移要拿一份真的 0.2 状态验**（浏览器里那 17 条只证明函数对，证明不了真机上长什么样）：
退出应用（别留孤儿进程，它会用内存里的旧状态盖回 `state.json`）→ 把
`%APPDATA%\com.iron-tom.lattice\state.json` 换回 0.2 那份（`version: 2`，桌面上有
`lattice.battery` 和 `lattice.sysmon` 各一张）→ 启动 → 期望三件事：**电量卡还在原位置**
（变成"只剩电池那一行"的系统卡，240×176 而不是消失）、**系统卡底栏完整**（桌面上的
高度是 328，不是 240）、回收站里没有恢复不出来的电池条目。
