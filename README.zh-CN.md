<!-- 改这一份就改 README.md。两份逐节对齐，check:docs 只校验数字，结构靠人守。 -->

<div align="center">

<img src="design/logo/png/appicon-256.png" width="92" height="92" alt="Lattice 图标：3×3 窗棂，落位的格子拼出字母 L">

<h1>棂 · Lattice</h1>

<p><strong>在 Windows 桌面上摆你自己的小组件。组件就是网页。</strong><br>
写的人只写 HTML / CSS / JS；真窗口、沙箱、权限、安装与更新，平台来做。<br>
没有账号，没有服务端。</p>

<p>
<a href="https://github.com/unraveltao/Lattice/actions/workflows/ci.yml"><img src="https://github.com/unraveltao/Lattice/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6.svg" alt="MIT license"></a>
<a href="#安装"><img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D4.svg" alt="Windows 10 / 11"></a>
</p>

<p><a href="./README.md">English</a> · 中文</p>

<p><a href="docs/screenshot-desktop.png"><img src="docs/screenshot-desktop.png" width="900" alt="干净壁纸上的三个组件：时钟、待办、书签"></a></p>

<p><sub>时钟、待办、书签，从运行中的应用按 2× 截下来，摆在干净的壁纸上。<br>
画面里没有别人真实桌面的东西。</sub></p>

</div>

---

## 这是什么

Lattice 在你桌面上摆几扇小窗口：时钟、待办、系统监控、正在放的音乐。都是真窗口，不是贴图。没有边框，不进任务栏，点它不会把你正在打字的地方抢走。可以钉在所有窗口上面，也可以压在普通窗口底下、贴着壁纸。位置按屏幕记，重启回来还在原处。

跟别的桌面小工具比，最不一样的地方是：**平台不带组件。** 24 个官方组件和第三方的走同一条安装链路，一个都不预装。组件能有多少种，取决于你写的 HTML。

中英双语管到最后一层：平台界面、组件的名字和配置项、卡片里面画的字。切换不用重启，也不用重载组件。

名字来自棂（líng），窗户里那层木格栅。每一块玻璃都嵌在它里面。

## 你能用它做什么

| 你想要 | 用哪个组件 | 它给你什么 |
| --- | --- | --- |
| 抬眼就知道几点、还剩多久 | 时钟 · 日历 · 课表 · 倒计时 | 当前时间；月视图加自己的日程；本周课表带一条当前时间线；到某一天还剩几天 |
| 别让事情漏掉 | 待办 · 便签 · 书签 · 习惯 | 桌面上的清单；随手记，自动保存；常去的链接；能连着打勾的连续天数 |
| 知道机器现在怎么样 | 系统 · 终端 | CPU、内存、GPU、电池各一个数，带一分钟曲线；每核负载、显存、磁盘、网络、开机时长；一条能敲命令的 shell |
| 专心干一会儿活 | 专注 · 秒表 | 番茄钟，合上盖子再回来时间还是对的；计时 |
| 别把查过的词忘掉 | 背单词 | 一行一张卡贴进去，四档打分，下次复习按天排 |
| 顺手算一下 | 计算器 · 单位换算 | 四则运算，结果能一键复制；长度 / 质量 / 温度 / 数据 / 时间 / 速度双向换算 |
| 想画个架构图 | 架构图 | 一块能平移缩放的图面：矩形、圆、箭头；assistant 一句话就能画完一整张 |
| 脑子里的东西想理成树 | 思维导图 | 一段缩进大纲长成右向的树，位置自己排。折叠、平移、缩放，整张能复制成 Markdown / Mermaid / OPML |
| 音乐、天气，还有一条鱼 | 音乐 · 天气 · 大肥鱼 | 在放什么、跟着声音起伏；一个城市的天气，定时刷新、断网也读得出来；一条在屏幕底下走来走去的桌宠 |
| 让 AI 替你动手 | `Ctrl+K` assistant | 模型你自己配，key 不离开 Rust；它能开合桌面，也能调组件自己声明的工具。脚本也能走同一条路，一个只绑回环地址的端点，`npm run agent` |
| 二十个组件里找某一个 | `Ctrl+Shift+F` 全局搜索 | 已装的、能装的、商店里的一屏搜（名称、id、说明、作者、权限）。选中之后去画布上那张卡，或者去组件库里那一行 |
| 上面这些都不够 | 自己写一个 | 四个文件、没有构建步骤，[见下](#写一个组件) |

## 安装

**只想用。** 从 [Releases](https://github.com/unraveltao/Lattice/releases) 取 `*-setup.exe` 双击装。第一次启动会被 SmartScreen 拦成"未知发布者"，安装包还没做代码签名，点 **更多信息 → 仍要运行** 就行。这是采购问题，不是技术问题，写在 [AGENTS.md](./AGENTS.md) 的已知缺口表里。

**想改代码。** Node 22、Rust（`windows-gnu` 工具链）、WebView2 运行时，就是标准的 [Tauri 2 前置条件](https://v2.tauri.app/start/prerequisites/)。

```bash
npm install
npm run dev          # 只跑前端，http://localhost:1420，除了"投放到桌面"之外都有
npm run tauri:dev    # 真应用
npm run tauri:build  # NSIS 安装包 + 更新产物
```

用包装脚本，别用 `npx tauri`：`scripts/tauri.mjs` 会把自带的 `mingw64` 和 `gcc` shim 塞进 `PATH`，绕过它编译会在 `resource.rc` 里失败，而且不告诉你为什么。

提交之前，把 CI 跑的那几条自己跑一遍：`npm run typecheck`、`npm run check:tokens`、`npm run check:docs`，然后对着起着的 dev server 跑 `npm run test:browser`。完整顺序和每道闸拦什么，在 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 写一个组件

四个文件，没有构建步骤：

```
demo.mine/
  manifest.json    id（反向域名）、version（semver）、权限、尺寸、配置、说明
  index.html       入口，透明背景
  widget.js        你的代码，SDK 是复制过去的一个文件，不是 npm 安装
  style.css        只用 token，不写死颜色
```

```js
import { createLattice } from "./lattice.js";

const lattice = createLattice();

// 先用默认值画第一帧。永远不要等桥回来才画。
render({ text: "新便签", size: 16 });

const note = await lattice.storage.get("note");
if (note) render(note);

lattice.storage.onChange(async () => render(await lattice.storage.get("note")));
```

有三件事平台会跟你计较：

- 用 `schedule.every`，不要 `setInterval`。裸定时器在组件看不见时照样跑，整套"看不见就停"就废了。
- 那颗胶囊浮在你的内容上，还挡点击。留出 `padding-right: 120px`，否则第一行会被关掉按钮压住。
- 配置项写在清单里。属性面板会按实例渲染它们；在卡片里自己画一套设置界面，那套界面没人用得上。

```bash
npm run create:widget -- demo.mine    # 起个头，已经避开窗饰遮挡
npm run pack:widget -- demo.mine      # 目录 → .lattice，直接拖进窗口
```

[`examples/counter`](./examples/counter) 是能跑的最小实现。[docs/WIDGET_SPEC.md](./docs/WIDGET_SPEC.md) 是契约：方法表、配置类型、清单规则，还有"组件真跑起来之后才会撞到"的那些坑。

## 它是怎么做到的

组件从头到尾碰不到 Windows。它跑在一个源不透明、CSP 钉死在自己文件上的沙箱 iframe 里，拥有的每一项能力都是一次过桥请求。十五项权限，默认全不给，装一个组件也不会顺带给它什么：每项按组件批一次，撤掉一项，开着的窗口当场生效。

<p align="center"><a href="docs/screenshot-editor.png"><img src="docs/screenshot-editor.png" width="880" alt="主窗口：左边组件库、中间画布、右边属性面板"></a></p>

<p align="center"><sub>主窗口：左边组件库、中间画布、右边属性面板。画布上的预览是近似值，窗口里没有壁纸可采样。</sub></p>

下面三件事让它不太像个桌面小玩具，代价也都不小。

平台出厂是空的。第一次运行是空桌面，加一个要自己填的库。预装六个组件在截图里更好看，可那样扩展模型第一天就死了。

没有服务端。目录是 GitHub Pages 上一份静态 `registry.json`，包是签过名的文件，更新是一个 release 附件。评分因此永远汇总不成一个数，举报一个坏组件也只能把文件自己发给作者。

一切都过同一座桥。没有 `localStorage`，没有 `fetch`，也不直接调 Win32。API 就这么小，所以它必须够用：官方组件用的就是它。

<p align="center">
<a href="docs/screenshot-chrome.png"><img src="docs/screenshot-chrome.png" width="300" alt="桌面上的组件和它的窗饰"></a>
<a href="docs/screenshot-backplate.png"><img src="docs/screenshot-backplate.png" width="520" alt="同一个时钟的三种背板"></a>
</p>

<p align="center"><sub>左：宿主画的窗饰，拖动、层级、别针、刷新、关闭。右：同一个时钟的三种背板，颜色、填充、模糊都按实例调。</sub></p>

每个决定的推理、试过又扔掉的东西，在 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。不能破的规矩在 [AGENTS.md](./AGENTS.md)。

## 走到哪了

最新的里程碑是 v0.13：assistant 有了自己的桌面小窗。代码已经落地，还差一次真机验收，前面那四个"进行中"也卡在同一处。安装包报的版本是 `0.1.3`；`v0.x` 是里程碑标签，不是发布版本号。

<details>
<summary>每个版本加了什么</summary>

| 版本 | 加了什么 |
| --- | --- |
| v0.1 | 骨架：Tauri + React 外壳、画布、沙箱 iframe、桥 |
| v0.2 | 真桌面：`desktop` / `top` 两层、按摆放位置的窗口、窗饰、数据落盘 |
| v0.3 | 平台行为：托盘、开机自启、全部暂停、实时重载、崩溃恢复、遮挡检测、DPI 夹紧、吸附参考线 |
| v0.4 | 作者体验：`@lattice/sdk`、`create:widget`、`pack:widget`、媒体会话、`Ctrl+Shift+D` 调试抽屉 |
| v0.5 | 分发：静态目录、三道签名检查、更新与回滚、本地评分与举报、新权限复核 |
| v0.6 | 目录上 GitHub Pages：磁盘缓存、`If-None-Match`、断网时诚实的兜底 |
| v0.7 | 交付：NSIS 安装包、应用内更新、先草稿再发布的 release、SmartScreen 问题写下来而不是藏起来 |
| v0.8 | Agent 接入：默认关的回环端点、令牌、审计日志、8 个白名单动作 |
| v0.9 | `lattice.music`、`audio:level`、`lattice.bookmarks`、`shell:open` |
| v0.10 | 内置 assistant：自备 OpenAI 兼容模型、key 只在 Rust 里、组件侧的 `llm:chat` |
| v0.11 | 手：六组能力、审批档、模型多档配置、会话落盘、`agent:tools` |
| v0.12 | 技能包、工作区免问区、两个模式：内部 / 完全访问 |
| v0.13 | assistant 上桌面：自己的窗口，不是主窗口里的一个面板 |

</details>

<details>
<summary>数字</summary>

| 项目 | 数值 |
| --- | --- |
| 官方组件 | 24 |
| 权限 | 15 |
| Tauri 命令 | 117 |
| 浏览器断言 | 78 页 4 051 条 |
| Rust 单测 | 504 |
| 记下来的坑 | 128 |

这些数是跑出来的：浏览器断言在 CI 里起真的 dev server 和真的 Chrome，Rust 单测分成纯逻辑的和要跑完整 `cargo test` 的两批。坑也是真咬过人的那些，每条都写着为什么不会再犯。

**代码量，大致**

| 部分 | 行数 |
| --- | --- |
| TypeScript | 27 914 行 |
| CSS | 7 111 行 |
| Rust | 30 635 行 |
| SDK | 961 行 |
| 官方组件 + 示例 | 38 545 行 |
| 脚本 | 5 776 行 |

</details>

## 接着读

| 文档 | 它回答什么 |
| --- | --- |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 各个部件怎么拼在一起，以及为什么 |
| [docs/WIDGET_SPEC.md](./docs/WIDGET_SPEC.md) | 组件契约 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 走到哪了、接下来做什么、哪些决定被现实推翻过 |
| [docs/PITFALLS.md](./docs/PITFALLS.md) | 所有的坑，按你眼前的症状分 |
| [docs/FAQ.md](./docs/FAQ.md) | "装完怎么什么都没有"，以及头一个小时会问的那些 |
| [docs/reference/build.md](./docs/reference/build.md) | 工具链、构建、发版，操作手册 |
| [docs/AGENT_ACCESS.md](./docs/AGENT_ACCESS.md) | agent 端点的威胁模型 |
| [docs/CODE_SIGNING.md](./docs/CODE_SIGNING.md) | 钥匙、信任锚，以及什么**没有**被签名 |
| [AGENTS.md](./AGENTS.md) | 22 条不变量，写给下一个动这份代码的人 |

改代码之前只读一样东西的话，读 [AGENTS.md](./AGENTS.md) 里那 22 条不变量。那不是风格偏好，每一条背后都有一个发出去过的 bug。

## 致谢

这个仓库里有些最好的决定，来自一行代码都没提交过的人。记他们的规矩，以及那份名单本身（目前还是空的）：[CREDITS.md](./CREDITS.md)。

## 许可

MIT，见 [LICENSE](./LICENSE)。
