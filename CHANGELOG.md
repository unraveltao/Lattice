# 更新日志

这个文件只记**发出去的版本**。三件事先分清，否则数字会骗人（见 [AGENTS.md](./AGENTS.md) 第 1 节「三个数不是一个数」）：

- **源码版本**写在 `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 三处，意思是"下一次构建会这么叫自己"，由 `npm run check:version` 钉着。
- **能下载到的版本**只在 GitHub Releases 上，就是本文件里那些带日期的一节。
- **里程碑 `v0.1 … v0.13`** 是 [ROADMAP](./docs/ROADMAP.md) 的进度标签，永远不会出现在安装包里。

## v0.4.0 — 待发布

自上一个**已发布**版本 v0.1.3（2026-10-29）以来的 65 个提交、408 份文件（31 个 `feat` / 7 个 `fix`）。`v0.2.0` 与 `v0.3.0` 只在 2026-10-28、10-29 打过 tag、从未发布，所以这一版把中间整段一起带上。

### 新增

- **听写**：说话变文字。两套后端 —— WinRT 的本地语音识别与经典 SAPI 5（**不是同一个语言库**），四个入口（属性面板的麦克风、桌面浮钮、全局热键、卡片内），一次会话一条完整轨迹；设置里有独立一页，缺语言包与没装组件是两句不同的话。
- **密钥密封库**：模型 key 与组件要用的 token 统一进 `secrets.bin`（DPAPI 封的单个文件），组件侧新增 `secret.set` / `secret.get` / `secret.delete` 与权限 `secret`。明文只当迁移兜底（INV-21）。
- **组件保存**：新桥方法 `file.save` + 新权限 `file:save` —— 组件只能递给平台一个名字，落点由用户在系统保存框里选（INV-22）。便签据此导出三种形状，图片走正文里的 base64。
- **桌面宠物搬进平台**：不再是组件。素材走平台资源，独立入口 `pet.html` + `src-tauri/src/pet*.rs`，有自己的平台窗口，不占布局、不走组件桥。
- **能力诊断面板**：把"这个能力此刻到底能不能用"和**为什么不能用**摆到界面上，判据在 `capability_policy.rs`（INV-23：灰掉的东西必须说得出为什么）。
- **画板 / 总览 / 全局搜索**：画板贴满窗口（世界尺寸换成 16:9）；`Ctrl+Shift+O` 退一步看全画布；`Ctrl+Shift+F` 一屏搜组件与商店。
- **assistant**：两栏布局与输入卡重做、会话与观察落盘（一条会话一个文件）、审批三档 `ask` / `auto` / `readonly`、技能包与免问区、两个模式（内部 / 完全访问），以及桌面上那个可拖、可锁、可缩放的小窗（`Ctrl+K`）。
- **agent 端点**：白名单动作到 9 个（`config.set` 成为第九个）、审计日志、六组"手"默认全关（文件 / shell / 网页抓取 / 屏幕 / 键鼠 / MCP）。
- **系统指标**：GPU 占用与显存走 PDH 与 DXGI（`PdhAddEnglishCounterW`，中文系统上也能按英文名反查）。
- **官方组件 +6**：`lattice.mindmap`（节点可拖，摆位存成偏移）、`lattice.almanac`（农历、干支、节气与节日）、`lattice.ambience`（四种背景声现场合成）、`lattice.deadline`、`lattice.momentum`、`lattice.todoist`（只读）。补强：时钟加模拟表盘与其他时区、日历粘 `.ics` 就能导入、专注加每日目标、便签加 Markdown 预览与"清空之后找回上一版"、卡片右键菜单。
- **工程**：`scripts/guards/` 七个守门人接进 `pre-push` 与 CI —— 数字、桥、命令、CSP、纯逻辑能不能单跑、守门人自己有没有被接进来，全部对账（INV-24 那两份 CSP 也有一条命令盯着）。文档加了 `docs/catalog.json` 坐标表、锚点校验与 `npm run docs:query`。
- **契约面**：桥方法 27 → 31，权限 13 → 15（新增 `secret`、`file:save`），Tauri 命令 99 → 128。没有移除任何一项。

### 修复

- 置顶只发意图，别再让"已应用"撒谎；拖动不再等 IPC。
- 置顶按钮和窗口说的不是同一件事 —— 平台改层级要推给宿主页。
- 空态那颗按钮真鼠标点不动：`pointer capture` 把 `click` 抢走了。
- 三条主题各自的收尾；助手那批越界的圆角与间距归回刻度；读数行别再写 `10.5px`。
- 听写的两句提示分开（没装语言包 ≠ 没切语言），并记下本机量到的结果。

### 破坏性变化

- **`lattice.pet` 不再是官方组件**：改由平台自带。盘上装着旧宠物组件的机器，那份组件还在、但不再随目录更新；桌面上要宠物请用它自己的入口，别再投放组件。
- **`lattice.battery` 下架**：电池并进 `lattice.sysmon` 0.3.0。已装的电池卡升级后会变成"只剩电池那一行的系统卡"。
- **窗口层级由两档改三档**（桌面 / 普通 / 置顶）：旧的两档值在迁移里归位，但置顶的语义变了 —— 现在由平台推给宿主页，而不是组件自己声明。
- **平台状态 `STATE_VERSION` 2 → 3**：从 v0.1.3 升上来会跑一次迁移，落盘字段有变（谁写、怎么升见 [reference/state.md](./docs/reference/state.md)）。
- **Rust 侧多三个 crate**（`tauri-plugin-global-shortcut`、`tauri-plugin-dialog`、`png`）+ `windows` crate 若干 feature（语音识别、DXGI、PDH、DPAPI）。npm 依赖自 v0.1.3 **零新增**，`package-lock.json` 未变。

### 已知问题（本版**没有**修）

源码审查的四条结论，证据链与验收标准在 [reference/review-2026-11-02.md](./docs/reference/review-2026-11-02.md)，修复顺序在 [ROADMAP](./docs/ROADMAP.md)：

- **F1（高）** 安装时身份与版本核验晚于目录覆盖：包先解、先删旧目录，之后才比 id / version —— 装失败可能改动另一个已装组件的目录。
- **F2（高）** 水合失败后仍可写回默认状态：`state_read` 抛错或 JSON 坏掉时 `hydrated` 照样置真，之后任意一次界面改动都可能把空布局写进 `state.json`，而这条写盘**没有**一代 `.bak`。这是唯一会静默清空桌面布局的路径。
- **F3（高）** 撤销 `terminal:exec` 不回收已有 shell：新请求会被拒，但已经跑起来的终端继续输出并继续转发。
- **F4（中）** 同一文档里两个 SDK 客户端请求 id 会撞：响应只按 `data.id` 关联，串线发生在同页多客户端时。

另外三条不是 bug，是边界：安装包不带 Authenticode（2026 年算过账不买证书，SignPath 申请在走，SmartScreen 的"未知发布者"照旧）；自动更新链至今**没有端到端验过**一次；winget 清单卡在 Microsoft 的 CLA。

### 升级注意

- **装法**：双击 `Lattice_0.4.0_x64-setup.exe` 覆盖安装，装完必须走应用内重启（不是退出）。用户数据在 `%APPDATA%\com.iron-tom.lattice\`，安装不碰它。
- **先备份**：真机验证或升级前，整目录复制一份 `%APPDATA%\com.iron-tom.lattice\`（重点 `state.json`、`widget-data/`、`assistant*.json`、`widgets/`、`widget-backups/`）。F2 那条风险就是这份备份的理由。
- **老用户第一次会看到**：一次"发布者钥匙变了"的确认（内置演示目录用仓库里那把**公开的** `scripts/dev-publisher.key` 签，线上目录用另一把）—— 别把它当成被攻击，但也别拿公开钥匙去签公开发布的包。
- **宠物与电池**：见上面「破坏性变化」两条。
- **权限不会自动多出来**：`secret` 与 `file:save` 是新增项，已装组件要用户在属性面板里重新授权才会拿到。
- **本版没验过的部分**：窗口 / 焦点 / 托盘 / DPI / 输入法这类只能真机看（见 [reference/verify.md](./docs/reference/verify.md) 第 4 条）；本版发布说明里的"通过"指的是静态门禁、72 条 Node 测试与 87 页 / 4483 条浏览器断言。

## 已发布的版本

| 版本 | 发布 | 安装包 | 说明 |
| --- | --- | --- | --- |
| [v0.1.3](https://github.com/unraveltao/Lattice/releases/tag/v0.1.3) | 2026-10-29 | 7.9 MB | 交付线上的最新一版；带 `latest.json` 与三份 winget 清单 |
| [v0.1.2](https://github.com/unraveltao/Lattice/releases/tag/v0.1.2) | 2026-10-27 | 8.1 MB | 同上 |
| [v0.1.1](https://github.com/unraveltao/Lattice/releases/tag/v0.1.1) | 2026-10-26 | 8.0 MB | tag 重打过一次（草稿期允许），第一次走完"打 tag → 草稿 → API 发布 → 线上端点核对" |
| [v0.1.0](https://github.com/unraveltao/Lattice/releases/tag/v0.1.0) | 2026-10-24 | 2.7 MB | 第一个包；那一版勾了 pre-release，更新器地址 404，随后改掉 |

## 只有 tag、从未发布的版本

`v0.2.0`（tag → `808437b`，2026-10-28）与 `v0.3.0`（tag → `2f3da0b`，2026-10-29）。两次 `release.yml` 都构建成功并出了草稿，但没有任何一版被 Publish，所以**用户手里从来没有过 0.2.x 或 0.3.x 的二进制**。这两个号不再复用：一个版本号对应两份二进制，自动更新与人工排查都会认错（规矩见 [reference/build.md](./docs/reference/build.md) 第五节）。
