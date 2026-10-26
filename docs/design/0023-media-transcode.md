---
status: draft
date: 2026-10-27
supersedes:
code:
---

# 0023 —— 转码器（`lattice.transcode`）与第六族能力

## 1. 问题

想把手里的 mkv 塞进手机、把录屏压小、把一段视频拆出 mp3 —— 现在只能装 HandBrake 或去背 ffmpeg 命令行。平台里一个能干的都没有：`lattice.convert` 是**单位换算**，和音视频没关系。

**坏结果**：用户为了"换个格式"离开桌面去开一个 200 MB 的 GUI 工具；或者干脆不换。

## 2. 候选

**形态**（决定其余一切）

| | A：组件（选中） | B：独立工具窗口 | C：主窗口里的页签 |
| --- | --- | --- | --- |
| 做法 | 一张卡片：投料 + 参数 + 进度 + 队列 | 像 `assistant.html` 那样自带窗饰的小窗 | 和组件库、设置并列 |
| 换掉什么 | 卡片尺寸要装下队列 | 平台的"一切皆组件" | 平台窗口的职责边界 |
| 新增什么 | 一条能力族 | 第二条分发路径（不可安装、不进目录） | 一个只在这里存在的工具 |
| 代价 | 400×320 里排得紧 | 目录 / 签名 / 安装 / 桌面摆放 / agent 工具全部用不上 | 和"工具要么是组件要么是平台功能"这条打架 |

**引擎与二进制从哪来**

| | A：系统 ffmpeg | B：打包进安装包 | C：首次使用下载（选中） | D：Media Foundation | E：ffmpeg.wasm |
| --- | --- | --- | --- | --- | --- |
| 换掉什么 | 开箱即用 | 2.7 MB 安装包 | 安装包体积 | 格式覆盖 | 平台零改动 |
| 代价 | 新机器上打开是"不可用" | +80~120 MB，且 Windows 静态构建是 GPL，MIT 项目要带 GPL 文本与源码获取方式 | 第一次要下 80 MB；运行时下载可执行文件有供应链与杀软误报风险 | 只有 h264/aac/mp3 一圈，mkv/webm/opus/flac/av1 全没有 | wasm 包 25 MB **超过组件包 16 MB 上限**，无多线程 SIMD，十分钟的视频要转半小时 |

## 3. 决定

**决定**：A（组件）+ A/C 组合（先找系统 ffmpeg，找不到就一键装到 `%APPDATA%`）。

**代价**（具体）：

- **这是第六族能力。** `docs/design/0020` 说五族能力五种装配方式，第六族出现时该做描述符。这一条**先手写第六族**，描述符仍然等 —— 记账：`bridge.ts` 的方法表、`KNOWN_PERMISSIONS`、`manifest.ts` 的 `Permission` 联合类型、Rust 命令 + `generate_handler!`、`WIDGET_SPEC` §3.7、`AGENTS` 一条不变量，六处手写。
- **只支持 9 种目标格式**（mp4 / mkv / webm / mov / mp3 / m4a / flac / wav / opus），不做码率曲线、滤镜、字幕烧录、剪辑。想要那些的人要的是 HandBrake。
- **不做并行**。两个 ffmpeg 抢 CPU 只会让两个都变慢，而进度条会让用户以为卡了。
- **关掉卡片 = 取消作业**。没有"关窗前问一句"的机制（`close-guard.ts` 管的是"这一下算不算点击"，不是"能不能关"），所以卡片在跑的时候把这条写在进度下面，而不是指望拦一下。
- **没有 ETA**。`speed=1.8x` 是实测值，剩下的时间是猜的 —— 猜错的 ETA 比没有更糟。

**什么时候该推翻它**：要支持剪辑/滤镜（那时该接的是一个 ffmpeg 命令构造器，不是再加几个枚举）；或者平台真要做描述符（0020），那时这一族应该被描述符吸收。

**被推翻的**（同一次设计里改过主意的）：

- "复用 `terminal:exec`，零平台改动" → **不行**。`lattice.term` 有一条常驻 PowerShell，转码器只要拼几条命令就能跑起来 —— 但那等于**为了转一个 mp4，把一个完整 shell 交给一个第三方组件**。权限面不成比例，而且 `agent.tools` 一接上，模型就能通过"转换"这个动作跑任意命令。这一条是这次设计里最值钱的决定。
- "组件自己拼 ffmpeg 参数" → **Rust 拼**。参数是注入面：组件传 `format: "mp4"`，枚举之外一律 `bad_params`。
- "组件自己选输出路径" → **Rust 算**：源文件同目录、`<name> (1).<ext>` 递增，`create_new` 独占。组件从头到尾没碰过一个可写路径。
- "用 `storage` 存队列" → **不存**。队列是易失的（重启后"转完了"就是转完了），存在内存里，于是两个实例各有一条队列，也不用处理 `store-changed` 的并发写。
- "转封装/转码让用户自己选" → **组件判断，界面说人话**。

## 4. 接口与数据

**桥方法**（权限只有一条：`media:transcode`）

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `media.tools` | — | `{ ffmpeg: { found, version?, path? }, install: { supported, approxBytes } }` |
| `media.install` | — | `{ jobId }`；进度走同一条推送，`kind: "install"` |
| `media.probe` | `{ path }` | `{ name, size, durationSec, container, video?, audio? }` |
| `media.plan` | `{ path, format }` | `{ plan: "copy" \| "reencode", reason }` |
| `media.start` | `{ path, format }` | `{ jobId, output }` |
| `media.cancel` | `{ jobId }` | `{ ok }` |
| `media.reveal` | `{ jobId }` | `{ ok }` —— 在资源管理器里选中这次输出 |

**推送**（宿主 → 组件，和 `theme` / `store-changed` 同一条通道）

```js
{ __lattice: 1, type: "transcode-progress", payload: {
    jobId, kind: "convert" | "install", percent, speed, state, error?
} }
```

`state` 是 `running` / `done` / `failed` / `cancelled`。**`done` 只认 `progress=end`**，不认退出码（见失败模式表）。

**路径闸门** —— 这是这一族的安全核心

组件拿到的每个 `path` 都必须来自用户**拖进这个实例**的文件。宿主页收到 webview 的 drop 事件后调一条**只在宿主页可用**的命令（不进桥方法表）把路径登记到 Rust 侧的 `HashMap<instanceId, HashSet<path>>`；`media.probe` / `plan` / `start` 只接受登记过的路径，其余回 `not_granted`。

- 组件点名 `C:\Windows\…` 去 probe 是**不可能的**：它没有登记入口，只有"用户拖进来的那个"。
- 输出路径组件同样不能指定：`start` 的返回里给 `output`，`reveal` 只收 `jobId`。
- 这条和 `network.rs` 的"宿主页随请求带 hosts"是同一个形状，别另发明一套。

**格式表**（`media_policy.rs`，Rust 是唯一的事实来源；卡片的副本由 `tests/transcode.html` 逐字对账）

| 目标 | 视频 | 音频 | 能搬流时 |
| --- | --- | --- | --- |
| `mp4` | libx264 crf 23 | aac 192k | 源 h264 + aac/mp3，加 `-movflags +faststart` |
| `mkv` | 复制优先，否则 libx264 | 复制优先，否则 aac | matroska 几乎什么都能装，多数情况是搬流 |
| `webm` | libvpx-vp9 crf 32 | libopus 128k | 源 vp8/vp9 + opus/vorbis |
| `mov` | libx264 crf 23 | aac 192k | 同 mp4 |
| `mp3` | 丢弃 | libmp3lame 192k | 源 mp3 |
| `m4a` | 丢弃 | aac 192k | 源 aac |
| `flac` | 丢弃 | flac | 源 flac |
| `wav` | 丢弃 | pcm_s16le | 源 pcm |
| `opus` | 丢弃 | libopus 128k | 源 opus |

`quality` 三档只动 crf 和码率：`better` 19 / 256k，`balanced` 23 / 192k，`smaller` 28 / 128k。

**清单**：`id: lattice.transcode`，`name: 转码 / Transcode`，400×320（最小 300×240），`layer: desktop`，`interactive: true`，`permissions: ["media:transcode"]`。配置两项：`quality`（select，带 `help`）、`revealAfter`（toggle，默认关）。

**没有 `storage`。** 队列在内存里，设置走 `config`（平台按实例存，不要权限）。

**要改的文件**（六处，按 ARCHITECTURE §3 的"加一个能力要动五处"再多一处）

1. `src/runtime/bridge.ts`：七个 `defineMethod` + `transcode-progress` 推送
2. `src/runtime/bridge.ts` 的 `KNOWN_PERMISSIONS` + `src/runtime/manifest.ts` 的 `Permission` 联合类型与文案（**最容易漏，漏了不报错，症状是"装好了，点授权没反应"**）
3. `src-tauri/src/media.rs`（spawn / 进度解析 / 取消 / 输出命名）+ `media_policy.rs`（格式表、参数构造、路径闸门）+ `lib.rs` 的 `generate_handler!`
4. `src/widgetHost.ts`：drop 事件 → 登记路径 → 推 `{ path, name, size }`；转发 `transcode-progress`
5. `public/widgets/lattice.transcode/`：`manifest.json` / `index.html` / `style.css` / `widget.js` / `transcode-core.js` / `icon.svg`
6. 文档：`WIDGET_SPEC` §3.7 + §4 方法表两行、`AGENTS.md` 一条不变量、`PITFALLS.md` 新坑、`ROADMAP.md` 这一条、`README` 中英两份的权限数 13 → 14

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 拖进一个 200 MB 的 mkv，卡片卡住 | 在前端读了文件 | 拖进来只拿路径和大小；probe 由 Rust 用 ffprobe，异步 |
| 按了转换，什么都没发生 | ffmpeg 不在 PATH 且没装 | 先问 `media.tools`；没找到时那颗按钮换成"装 ffmpeg"，不给按 |
| 转完输出是 0 字节 | 退出码 0 但没写成（磁盘满 / 路径被占） | **以"输出文件存在且 > 0"判成功**，不看退出码 |
| 取消之后后台还在转 | 只把状态标成 cancelled，没杀进程 | cancel 必须 kill 子进程并 `wait`，再删半截输出 |
| 取消之后源文件没了 | 删错路径 | 只删这次创建的 `output`，`input` 一个字节都不碰 |
| 进度条卡在 99% 不动 | `out_time` 到不了 duration（音轨比视频长） | 百分比夹到 99，`progress=end` 才给 100 |
| 中文文件名转出来是乱码 | 经过 shell 拼字符串 | `Command::new(ffmpeg).args([...])`，参数走 `OsStr`，不经 shell |
| ffmpeg 吃了终端输入 | 没加 `-nostdin` | 固定加 `-nostdin -hide_banner` |
| 两个实例同时转同一个文件 | 各自算输出名 | `<name> (1).<ext>` 递增 + `create_new` 独占 |
| 组件点名一个它没拿到的路径 | 没有闸门 | 只认用户拖进来的（`not_granted`），见 §4 |
| 装 ffmpeg 下了 404 | 固定 URL 失效 | 错误里写清"上游地址失效"，并给出"手动放到 `…\tools\ffmpeg\bin\`"这条路 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/transcode.html` | ~40 | 格式表与 Rust 逐字一致、`plan` 的文案、进度百分比夹紧、队列状态机、`not_granted` 的处理 |
| `src-tauri/src/media_policy.rs` | ~20（`rustc --test` 壳子） | 参数构造无注入（`format` 只认枚举）、输出命名递增、路径闸门、`quality` 三档 |

**手工验一次**：拖一个 mkv 进去 → 选 mp4 → 看它说"搬流，不掉画质"且几秒完 → 再选 webm → 这次说"要重编码" → 转一半按取消，确认半截文件被删、源文件还在 → 关掉卡片再打开，队列是空的（这是对的）→ 把 ffmpeg 从 PATH 拿掉，看那颗"装 ffmpeg"的按钮 → 装完再转一次。
