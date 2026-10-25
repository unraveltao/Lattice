---
name: verify
description: 棂（Lattice）的验证阶梯——改完代码按顺序跑 typecheck、对应断言页、纯逻辑壳子单测，并分清哪些只有真机能验。
whenToUse: 在这个仓库改完前端 / Rust / SDK / 打包 / 商店代码，准备说"做完了"或提交之前。
---

# 验证阶梯

判断依据都在 [AGENTS.md](../../../AGENTS.md) 第 11 节；这里只给**执行顺序**和**哪一条管哪种改动**。别凭印象说"应该没问题"——每一条都对应一个能红的命令。

## 0. 开工前和收尾前都看一眼现场

```bash
git status --short
```

有别人未提交的改动时，只 `git add <你改的那几个文件>`。`git add -A` / `git stash` / `git reset --hard` / `git checkout -- .` 一律禁用（会静默吃掉别人的活）。

## 1. 必跑：类型

```bash
npm run typecheck     # tsc --noEmit，当前是干净的
```

TypeScript 6 + React 19。它不检查 `.html` 里的断言，也不碰 Rust。

## 2. 按改动挑断言页（不要每次都跑全量）

全量是 40 页 / 1709 条，慢；先用 `--filter` 命中相关页，交付前再考虑全量。

```bash
npm run dev                                   # 另一个终端；断言页要 dev server 才能 import .ts/.tsx
npm run test:browser -- --filter close-guard  # 只跑匹配的页
npm run test:browser                          # 全量
```

`test-browser.mjs` 用 headless Chrome 的 `--dump-dom` 读 `<pre id="out">`，**只认 `PASS ` / `FAIL ` 开头的两行式断言**。它把 `--lang=en-US` 钉死了，所以中文机器上红的文案断言是真的红。

| 改了什么 | 跑哪些页 |
|---|---|
| 关窗判定、✕ 的命中 | `close-guard` |
| 拖动吸附 / 参考线 | `align-guides`、`window-move` |
| 跨屏夹紧、缺组件占位 | `screen-fit` |
| 桥 / 组件存储 | `bridge-storage`（并发写不丢键、跨窗口读到最新）、`note-save`（保存顺序与载入竞态） |
| 每实例配置 | `config`（归一化、默认值、夹紧、未知键、`config.get`）、属性面板 |
| agent 动作 / assistant 工具 | `agent`（57 条）、`assistant`（114 条，名字集合与 `EXECUTOR_KEYS` 对比） |
| 商店 / 签名 / 更新 | `semver`、`catalogue`、`store-ui`、`catalogue-cache`、`updater` |
| 界面文案 / 双语 | `i18n`（同一句只有一种译法）、`widget-text`、`help`（内置组件两门齐全 + 源码里既要 `lang.get` 又要 `language` 推送） |
| 错误通道 / 兜底页 | `diagnostics`（识别边界、两条通道不撞、去重指纹） |
| 组件库搜索 | `library-search`（判定规则只在 `runtime/library-search.ts` 写一份） |
| 调度时间轴 | `schedule` |
| SDK | `sdk`（47 条，自带假宿主）＋ `npm run test:sdk` |

断言页的坑：**不要等 iframe**。`--virtual-time-budget` 会把虚拟时钟快进到 9 秒，而 iframe 的 `load` 走真实网络——快进赢了就 dump 到空的 `<pre>`，脚本报"0 条 —— 一条断言都没跑完"。改 budget 只是把赌局挪个位置。正确做法是纯逻辑挂在 `window.__latticeXxx` 上、用普通 `<script src>` 同步引入。

## 3. 不需要 dev server 的三条 node:test

```bash
npm run test:sdk         # 内嵌副本与源字节一致、SUPPORTED_SDK 版本对齐
npm run test:injection   # 上报脚本注入规则（9 条，fixture 与 Rust 单测同一批）
npm run test:agent       # agent CLI 的请求形状与退出码（起假端点）
npm run check:docs       # 文档一致性
```

改了 `src/runtime/widget-reporter.js` 或注入那条路，`test:injection` 必跑。

## 4. Rust 纯逻辑：`cargo test` 在这台机器上跑不了

安全策略拦 `target/debug/deps` 下新写的 exe。绕法是只有一行的壳子：

```rust
#[path = "../src-tauri/src/network_policy.rs"] mod network_policy;
```

```bash
rustc --edition 2024 --test 壳子.rs -o 壳子.exe && ./壳子.exe
```

- **先看 `rustc` 的退出码**。编不过时旧的 `.exe` 还在，`&&` 会跑那个旧二进制并显示全绿——这是最坏的情况，不是"通过了"。
- 要 `serde_json` / `flate2` / `ed25519_dalek` 的，补 `-L src-tauri/target/debug/deps --extern serde_json=<rlib>`（rlib 从 `target/debug/deps/libserde_json-*.rlib` 找）。只给 `--extern` 不给 `-L` 会报 `can't find crate`。
- `csp.rs` 的壳子要把 `protocol::SCHEME` 桩成 `"lattice-widget"`（不是 `"lattice"`）。
- 断言只有一份（模块内的 `#[cfg(test)] mod tests`），壳子不许复制断言。

能这么跑的是 136 条；剩下 21 条（`protocol.rs`、`widget_store.rs`、`backup.rs`、`egress.rs`、`media.rs`、`store.rs`）只有 review + 真机。

改了 **window / tray / 注入 / 协议 / 安装** 这些带 `tauri` 依赖的模块，壳子编不进来——直接说"只能真机验"，别假装跑过。

## 5. 只有真机能验的，明确说出来

- 窗口行为（置底、圆角裁剪、拖拽、点击穿透、`lattice:window-visible`）：`npm run tauri:dev` 实机看。
- **重启前先 `Get-Process lattice` 确认为空。** 孤儿实例会用内存里那份盖掉 `state.json`，还会占着 WebView2 用户数据目录让新进程在 `setup` 里 panic（`0x800700AA`）——症状像"改完 Rust 起不来了"，其实跟代码无关。
- **这台机器的 CDP（`--remote-debugging-port`）开不出来**：加了之后应用会起、标题也在，但一个 `msedgewebview2` 子进程都没有，端口不监听。判据是 `Get-Process msedgewebview2` 里没有带 `com.iron-tom` 的那个。别在这上面耗时间。
- 替代验法：把"点一下才出现"的状态临时默认成打开（`useState(false)` → `useState(true)`），HMR 生效后截窗口，**然后改回去**。合成点击在这台机器上进不了 WebView2 渲染进程。
- 改了宿主页（`widget-host.html`）的样式：不用起 Tauri，塞一个假的 `__TAURI_INTERNALS__` 就能在普通浏览器里调。

## 6. 汇报格式

- 只说：**跑了什么命令 → 哪一页 / 哪一条红了 → 文件:行 → 失败原文**。
- 不贴整页输出，不说"全部通过"而不给数字（`N 页 / M 条，FAIL 0`）。
- 没跑的写"没跑，原因"，不要含糊成"已经验证"。

## 7. 这个仓库里别做的事

- 别加 ESLint / Prettier / 格式化钩子。既有验收线是 `typecheck` + `tests/*.html` + `rustc --test`，再叠一层规则只会和上面的流程打架。
- 别调 `--virtual-time-budget` 来"修"0 条断言的页。
- 别 `taskkill /IM node.exe`、别杀不是自己起的 `lattice.exe` / 1420 上的 vite / `cargo`（第 12 节第 3 条）。要独占端口就 `npm run dev -- --port 1421`。
- 别把纯逻辑塞回带依赖的模块里——搬回去等于那些断言从此没人跑。
