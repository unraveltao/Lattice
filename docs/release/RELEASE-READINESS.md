# Lattice 个人稳定版发布准备报告

> 生成时间 2026-11-02，基线提交 `29043d6`（分支 `docs/source-review-20261102`），源码版本 `0.3.0`。
> 本轮**只执行调查、环境检查和非破坏性测试**：未修改业务代码、未打 tag、未创建 Release、未动 `%APPDATA%` 里的真实用户数据。
> 凡本轮没跑的事，下面一律写「未执行」，不写成通过。

## 1. 当前项目状态

| 项 | 值 |
| --- | --- |
| 路径 | `D:\_dev\own\lattice` |
| 分支 | `docs/source-review-20261102`，跟踪同名远程分支，0 领先 0 落后 |
| HEAD | `29043d6` docs: update architecture and source review |
| 工作区 | 干净（`git status --porcelain` 为空，本轮跑完 `dev` / `build` 也没留下改动） |
| main | `bcf0368`，未合并任何东西进去 |
| 版本三处配置 | `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 全为 `0.3.0` |
| 已发布产物 | GitHub Releases 最新是 **v0.1.3**（2026-10-29 发布）；`v0.2.0`、`v0.3.0` 只有 tag、**没有 release** |
| 本机安装的应用 | 无（注册表残留一条 0.1.2 指向已不存在的 `D:\DevTest\Lattice`） |

**版本号与 tag 的对应关系有问题**：`v0.3.0` 这个 tag 指在 `2f3da0b`（2026-10-29），而当前源码里三处版本号仍写着 `0.3.0`，HEAD 却比 tag 晚了若干提交。也就是说「源码自称为 0.3.0」和「已经存在一个 v0.3.0 的 tag」这两件事已经不能同时成立。发新版必须往前取号，不能复用 `v0.3.0`。

## 2. 环境与依赖

| 依赖 | 状态 |
| --- | --- |
| Node / npm | v26.12.0 / 10.7.0（CI 用的是 22，本机比 CI 新，见 §6 风险 R6） |
| Rust | 1.99.1，只有 `x86_64-pc-windows-gnu`；无 MSVC、无 `cl.exe`、无 `cmake` |
| GNU 工具链补丁 | `.toolchain/` 内 `msys64/mingw64/bin/gcc.exe`、`windres-shim`、`mingw64/bin/windres.exe`、`intl` DLL 全部就位 |
| WebView2 Runtime | 156.0.4314.50 / .58 已装 |
| Chrome / Edge | 都在常见路径，`test:browser` 能自己找到 |
| NSIS | 已被 Tauri 缓存到 `%LOCALAPPDATA%\tauri\NSIS\`（`makensis.exe` 齐备） |
| `node_modules` | 已装 |
| 更新器私钥 | `.keys/updater.key` 在仓库内、被 `.gitignore:58` 忽略；**当前 shell 无 `TAURI_SIGNING_PRIVATE_KEY`** |

**结论：Windows 构建链路在本机是可走的**，前提是必须经 `scripts/tauri.mjs` 包装（它往 PATH 前面塞五个目录），不能直接 `npx tauri`、也不能用 `package.json:40` 那条裸 `"tauri": "tauri"`。这条限制只在**这一台** Windows 上验过，换机器作废。

**本机跑不了 `cargo test`**：安全策略禁止写 `target\debug\deps\*.exe`，换 `CARGO_TARGET_DIR` 也没用。Rust 侧 618 条 `#[test]` 里，约 524 条能走 `rustc --test` 壳子跑，剩下约 50 条（`llm.rs` / `hands.rs` / `mcp.rs` / `protocol.rs` / `widget_store.rs`）**只能 CI**。

## 3. 已执行测试及结果

真跑过的，退出码都在下面：

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（exit 0） |
| 六组 Node 测试 | `test:injection` 9、`test:sdk` 2、`test:agent` 14、`test:tokens` 8、`test:llm-proxy` 28、`test:winget` 11 | **92 通过 / 0 失败** |
| 九个对账门禁 | `check:version`、`check:stats`、`check:bridge`、`check:commands`、`check:csp`、`check:gates`、`check:policy-tests`、`check:tokens`、`check:docs` | 全部通过 |
| 桥方法纯逻辑 | `rustc --test`（由 `check:policy-tests` 驱动） | 33 个文件 **524 条通过**（33 个命中内容哈希缓存，缓存按文件内容判新旧，不是跑旧二进制） |
| 浏览器断言 | `npm run dev` + `npm run test:browser` | **86 页 / 4483 条断言 / FAIL 0**（首轮 `agent` 页 Chrome 冷启动超时；`--filter agent --budget 30000` 重跑 81 条全过） |
| 前端构建 | `npm run build` | 通过（`✓ built in 1.47s`），随后 `check:csp` 在**这份新 `dist/`** 上通过 |
| F2 复现探针 | `.scratch/f2-probe.mjs`（纯内存，`state_write` 只记账） | 三种输入全部符合预期 → **F2 确认**（见 §4） |
| F4 复现探针 | `.scratch/f4-probe.mjs` | 两个客户端请求 id 撞车并串线 → **F4 确认**（见 §4） |

本轮**补上了审查报告在 Linux 上做不到的三项**：`test:browser`（那边找不到 Chrome、退出 1）、Rust policy 测试（那边无 rustc、被跳过）、`vite build` + CSP 在新鲜产物上重验（此前 `dist/` 是 10-27 的旧物，`check:csp` 实际在看过期产物）。

### 未执行（不许当成通过）

| 未执行项 | 原因 |
| --- | --- |
| **主程序真机启动**（`npm run tauri:dev` 或 `tauri:build` 后运行） | 会读写 `%APPDATA%\com.iron-tom.lattice\state.json`（6702 字节，11-01 改过）。本轮范围是「非破坏性」，且 §4 的 F2 正说明启动+一次 UI 变更就可能覆盖它 → 先修 F2 或先做备份，再跑 GUI |
| 桌面窗口 / 投放 / 托盘 / 焦点 / DPI | 只有真机一条路，随上一项一起做 |
| 插件安装与卸载端到端（`store_install` 真调用） | 属于破坏性安装验证，审查报告当时也没跑；本轮改为源码链核对（F1） |
| 应用内更新（旧版本点 Check for updates 真的升上来） | `maturity.md:67` 原话这条一次没走过，需要一个已发布的旧版本在装 |
| Windows NSIS 打包 | 本轮不发版，且缺 `TAURI_SIGNING_PRIVATE_KEY` 时本机行为**文档未描述、未验证** |
| `cargo test` 那约 50 条 | 本机策略跑不了 |
| `state.json` 真实文件迁移（v1/v2 → v3） | `known-gaps.md:30` 已登记为未验；要用副本做，本轮没做 |

## 4. F1–F4 验证情况

| 编号 | 本轮结论 | 证据 |
| --- | --- | --- |
| F1 | **确认存在**（源码链核对，未做故障注入） | `src-tauri/src/store.rs:334` 验签 → `:342` 调 `package::extract` → `:343-348` 才比 id。`src-tauri/src/package.rs:71-79`：先 `backup::save_existing`（失败只 `eprintln!`）→ `fs::remove_dir_all(&target)` → `fs::rename`。破坏发生在身份核对之前，且 store.rs:344 的注释自己承认这点 |
| F2 | **在本机 Windows + Node 26 上复现** | `src/platform/store.ts:47-53` 把 `state_read` 异常吞成 `null`；`:994` 无条件 `hydrated = true`；`:57` 闸门只认 `hydrated` 不认「水合是否成功」。`src-tauri/src/state.rs:43-48` 只 `fs::write` + `rename`，**没有** 组件存储那套 `.bak`。探针三种输入：读错 / 坏 JSON → 一次 `setState({theme:'dark'})` 就写回**空布局**；有效 v3 → `prior` 保留 |
| F3 | **确认存在**（源码核对，未跑 PowerShell/WebView2） | 全仓 grep 撤权路径没有任何 `term` 回收调用；`src-tauri/src/term.rs` 里 **`widget_id` 一次都没出现**，`shells()` 是按 `instance_id` 键的 `HashMap`（`:86-88`），`stop_instance(instance,&)`（`:549`）只认单个实例，而权限按 `widgetId` 授予（INV-4）。要按组件回收，得先补上 `widgetId → instances` 这一维 |
| F4 | **在本机复现** | `packages/sdk/lattice.js:141` 每个 `createLattice` 各自 `let sequence = 0`；`:200` `const id = ++sequence`；`:217` 响应用 `pending.get(data.id)` 关联。同文档两个客户端各自 boot 后都发到 id 4，宿主只回一条 `{id:4, result:ALPHA-ONLY}`，**两个 Promise 都 resolve 成同一个结果**。（探针里 `via` 字段两个都显示 beta，是探针只在全局挂了一个 `parent` 的伪影，不作为路由结论；撞号与串线才是） |

**四个问题在 HEAD `29043d6` 上都还没修**——这一点仓库自己写得很清楚：`docs/ROADMAP.md:17-18` 定的顺序是「F1–F3 优先于扩展新能力，随后 F4，再补 Windows 真机与常驻性能测量」，`docs/reference/known-gaps.md:18-19` 明确「本次只登记问题，未修复，也不改已发布产物的成熟度结论」。

## 5. 待修复问题与修复计划（等待确认，本轮未动代码）

按 `ROADMAP.md:17` 的优先级，且都能在不重构的前提下收口：

**P0-a F2（数据安全，最小改动、最高收益）**
1. 在 `store.ts` 的水合处区分三种结局：文件不存在 / 读取失败 / 解析失败。后两者进入 `hydration_failed`，**`hydrated` 保持 false**（闸门已现成，`:57` 就是它）。
2. `state.rs` 的 `state_write` 复用组件存储已有的 `write_atomic` 思路留一代 `.bak`（`widget_store.rs:104-128` 是现成实现，别新造一套）。
3. 测试：把 `.scratch/f2-probe.mjs` 固化成 `tests/` 断言页或 Node 测试，断言改成「读错/坏 JSON 后 `state_write` 调用数必须为 0」。这是回归网的起点，比先改行为便宜。

**P0-b F1（安装事务边界）**
1. 把 expected id / version 的核对提前到**第一次破坏性写入之前**——在 `store.rs:342` 调 `extract` 之前，先只读包内 `manifest.json` 核对身份（`package.rs` 已解析过 manifest，拆一个「只读不写」的前置步骤出来即可）。
2. 暂存与提交分离：现有 `.incoming` 暂存目录已经是雏形，缺的是「提交失败回滚旧目录」。
3. 测试：在 `%TEMP%` 造隔离 root + 已安装 B，逐项注入 id 不符 / 版本不符 / 坏 manifest / 解压失败 / rename 失败，断言无关组件内容哈希不变、失败后目标目录仍是旧版本。**不碰真实 `widgets/` 目录**。

**P1 F3（撤权回收）**
1. `term.rs` 的 `Shell` 补一个 `widget_id` 字段，加 `stop_widget(widget_id)` 遍历回收其实例。
2. 双宿主在 `lattice:term` 转发前复查当前权限（`WidgetFrame.tsx` / `widgetHost.ts` 两份都要改，INV-2）。
3. 真机验收用报告给的 PowerShell 探针（30 秒逐秒输出），撤权后要求：新请求拒绝、旧 shell 停止、重载后的 iframe 收不到撤权后的输出。

**P2 F4（请求 id 隔离）**
1. SDK 同文档客户端共享一个模块级自增序号，或给每条请求加 client namespace；桥协议两侧同步改（`bridge.ts` 认 `data.id` 的那处）。
2. 测试：两客户端并发不同方法、乱序返回、同方法不同参数、超时与 dispose，结果必须各归各。
3. 注意 `known-gaps.md:183`：SDK 是随包分发的普通文件，改完必须 `npm run sdk:sync`。

## 6. 发布阻塞项

| 编号 | 阻塞项 | 说明 |
| --- | --- | --- |
| B1 | **F2 未修** | 唯一会「静默把用户整个桌面布局归零」的问题，且 `state.rs:26-31` 记录这条**本机已经发生过一次**（BOM 事故）。目标是"个人长期稳定使用"的话，这条不修不该发 |
| B2 | **真机一次没跑过** | §3「未执行」第一行。验收标准第 1 条（Windows 主程序能正常运行）目前**没有证据**，只有静态门禁绿 |
| B3 | **F1 未修** | 装失败会破坏别的已装组件；发版前至少要建立故障注入测试 |
| B4 | **版本号必须往前取** | `v0.3.0` 已被占用且与源码状态脱钩，复用会让一个版本号对应两份东西。建议 **v0.3.1** |
| B5 | **本机没有更新器私钥 env** | `createUpdaterArtifacts: true` 下，本机不带 key 会在哪一步失败**文档没写、本轮没验**。CI 侧则要仓库 Secrets（`release.yml:135-142` 空 key 会在编译前就红） |
| B6 | **自动更新链从未端到端验过** | `maturity.md:67` / `known-gaps.md:42`。用户手里是 v0.1.3，跳到 v0.3.1 跨了 `v0.1.3..HEAD` 的一大段，中间没有任何已发布版本可做"升上来"的对照 |
| B7 | 无 CHANGELOG | 仓库里根本没有 changelog 文件；`release.yml:155-158` 的 release notes 是模板文案「看仓库的提交记录」。个人使用可接受，但要写清 |
| B8 | 安装包装不上 Authenticode 签名 | `known-gaps.md:44-46`：2026 年算过账**不买证书**，SignPath 申请在走 → SmartScreen「未知发布者」照旧。这是有意取舍，不是新缺陷 |
| B9 | winget 清单停在 0.1.1 | `known-gaps.md:49` 卡在 Microsoft 的 CLA，只能作者本人做 |

不构成阻塞但要知道：`check:version` 只管三处配置和入口文档那句话，**它不管"能下载到的是哪版"**（`verify.md:14`），所以 B6 那种漂移不会有人报警。

## 7. 推荐版本号

**v0.3.1**，理由：本轮没发现需要抬 minor 的新能力；F1/F2/F3/F4 都是缺陷收口；`v0.3.0` 这个号已被 tag 占用（B4）。

改版本号要动 6 处（`check:version` 用正则钉着，漏一处就红）：

| 文件 | 位置 | 决定什么 |
| --- | --- | --- |
| `package.json` | `:4` | 给人看的那一份 |
| `src-tauri/Cargo.toml` | `:3` | exe 里的元数据 |
| `src-tauri/tauri.conf.json` | `:4` | **安装包文件名** `Lattice_0.3.1_x64-setup.exe` |
| `README.md` | `:188` | 那句 `the source tree is \`0.3.1\`` |
| `README.zh-CN.md` | `:188` | 那句 `源码是 \`0.3.1\`` |
| `AGENTS.md` | `:34` | 那句 `源码是 \`0.3.1\`` |

## 8. 配置备份与版本回退方案

**当前状态：平台状态没有备份**。`widget-data` 有（`write_atomic` 留一代 `.bak`），`state.json` 没有——这正是 B1 的成因。所以本轮**没有对真实用户配置做任何写入**，只列方式：

1. **发版/真机验证前先手工备份**（这一步是硬前置，成本 1 行）：
   复制 `%APPDATA%\com.iron-tom.lattice\` 整目录到一个带时间戳的位置，重点是 `state.json`、`widget-data/`、`assistant.json`、`widget-backups/`、`widgets/`。
2. **还原**：先确认 `Get-Process lattice` 为空（`verify.md:29`：孤儿进程会用内存里那份旧状态覆盖 `state.json`），再把备份文件放回原路径。
3. **代码版本回退**：`v0.3.1` 未发布前，tag 打错可以重打（`build.md:114` `git push --delete origin` 后重指提交）；**发布之后就绝不能重打**——已经装上的用户手里是另一份二进制，重打等于一个版本号对应两个包。
4. **组件级回退**：只有一代交换备份（`known-gaps.md:63`、`state.md:16`），且「失败时旧版本还在不在」属未证明（F1）。

## 9. 后续执行顺序

1. 手工备份 `%APPDATA%\com.iron-tom.lattice\`（B1 的安全网，先于一切 GUI 操作）。
2. **修 F2**（P0-a）：写保护 + 一代 `.bak`，先把 `.scratch` 探针固化成回归测试。
3. 跑真机：`npm run tauri:dev` → 主窗口、投放、桌面窗口、托盘、布局重启不丢、终端权限生效与撤销。这一步同时补 B2 和 §3 那一整列「未执行」。**跑之前确认没有其他 agent 的 `lattice.exe` / `cargo` 在动**（`AGENTS.md` §12）。
4. **修 F1**（P0-b）：身份前置 + 暂存/提交分离，配 `%TEMP%` 隔离目录的故障注入测试。
5. **修 F3**（P1）：`widgetId → instances` 那一维 + 转发前复查权限，然后才做 §4 要求的 PowerShell 撤权真机验收。
6. **修 F4**（P2）：SDK 序号隔离 + `npm run sdk:sync` + 多客户端断言页。
7. 每步收尾都过一遍 `npm run typecheck`、`npm run check:guards`、`npm run test:browser`（需另开 dev server）、`node scripts/check-docs.mjs`。
8. bump 到 v0.3.1（6 处），`npm run tauri:build` 前先决定本机要不要更新器 key（B5），产出 NSIS 并核对文件名↔tag。
9. 干净机器装一遍 → 打 tag `v0.3.1` → CI 出**草稿** release（`release.yml` 会再跑一遍完整门禁）→ 核对产物与 SHA-256 → 人工点 Publish，**别勾 pre-release**（`build.md:112`，勾了更新器地址 404）。
10. 发完后补 B6：拿 v0.1.3 或 v0.3.1 装好的机器点一次 Check for updates，验「真的升上来了」，然后才把 `maturity.md:67` 那一行从「未验证」挪走。

## 10. 本轮限制与没做的事

没有修改任何业务代码；没有 `git add`/`commit`/`push`；没有打 tag；没有创建或修改 GitHub Release；没有动 `%APPDATA%` 下的任何文件；没有 `reset`/`stash`/删除操作。

临时产物：`.scratch/f2-probe.mjs`、`.scratch/f4-probe.mjs`（`.scratch/` 已被 `.gitignore:37` 忽略，随时可删）；`dist/` 被本轮 `npm run build` 重写为 `29043d6` 的产物（此前是 10-27 的旧物）。启动过的 dev server 已停，端口 1420 已释放。

一个环境层面待办：这台机器 `http.sslCAInfo` 指向不存在的 `D:/Code_enve/Git/ucrt64/etc/ssl/certs/ca-bundle.crt`，所以 **git over HTTPS 全坏**，本轮所有远程操作走 SSH。它不影响发版（CI 用 token），但会让任何想用 HTTPS 的工具链踩坑，属可修但未修。

**本报告的落地代价（改了两个文档文件，请一并过目）**：按仓库规矩，一份文档必须有一个坐标，新文件要在 `docs/catalog.json` 登记一条、并在 `docs/README.md` 第一节表里占一行，否则 `check:docs` 判红。本轮因此改了 `docs/catalog.json`（+1 条 `past`）和 `docs/README.md`（+1 行表项），没碰任何业务代码。

这里有一个**设计张力**值得你定夺：`docs/README.md:97` 写着「三个月后还有人要照着它做吗？没有 → 放 `docs/reference/`」，而「每个版本当时怎么做的、验到什么程度」这一格**已经**有 `reference/history.md` 认领。本报告按你指定的路径放在新建的 `docs/release/` 下，于是同一条事实（某版本当时的验证状态）现在有两个可能的家。要么把 `docs/release/` 定为「发布准备快照」的正式归属并在 `history.md` 里指向它，要么下次直接写进 `history.md`。别两边各写一半。
