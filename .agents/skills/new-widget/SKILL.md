---
name: new-widget
description: 在棂（Lattice）里加一个官方组件或第三方示例的完整配方：脚手架、清单、双语文案、窗饰留白、配置项、发版前索引与商店签名。
whenToUse: 要在 public/widgets/ 下新增组件、改内置组件的行为或清单、或者照着官方组件写一个示例给第三方看。
---

# 加一个组件

规范正文在 [docs/WIDGET_SPEC.md](../../../docs/WIDGET_SPEC.md)，"为什么这样"在 [AGENTS.md](../../../AGENTS.md) 第 7 节「加一个官方组件」。这里只给顺序和最容易漏的判据。

## 1. 脚手架

```bash
npm run create:widget -- demo.weather --name "Weather" --permissions network
```

- `id` 必须是多段形式（`a.b` / `a-b`），单段（`hello`）会被 `manifest.ts` 的 `ID_RE` 拒掉。
- 默认生成到 `public/widgets/<id>/`；`--out` 换目录，`--layer desktop|top` 选贴桌面还是置顶，`--interactive` 用于需要键盘输入的组件。
- 生成的是**会动的真组件**（跳秒 + 一个能在属性面板改的标题），不是空壳。先跑起来看，再改。

四个文件：`manifest.json` / `index.html`（名字与 `manifest.entry` 一致）/ `widget.js` / `style.css`，`icon.svg` 可选但内置组件都带。

## 2. 写之前先对一遍这七条硬约束

1. **`html, body` 保持透明，组件里不写死任何颜色。** 字色 / 强调色 / 描边全部取 `--lattice-text` / `--lattice-accent` / `--lattice-border`。底板变浅时平台会整体翻转令牌，写死的值不会跟着翻。
2. **第一帧先按默认值同步画出来，再等桥。** `config.get` / `storage.get` 各 3 秒超时，最坏 6 秒空白。顺序是：同步渲染 → 发请求 → 回来再改。
3. **存档迟到时用 `touched` 闸门挡住**：桥回来之前用户可能已经点过分类，这时再盖存档等于撤销他的操作。宁可这次不恢复。
4. **定时器一律 `schedule.every({ every })`，不要 `setInterval`。** 最小间隔 250ms（刷百分秒会每帧跳 25 个数）。`tick` 消息带订阅号，认准自己那条；卸载 / 重载时 `schedule.clear(id)`。靠两次采样做差的（速率类）在 `every()` 之后自己先调一次建基线——Rust 第一次采样返回 0 是设计。
5. **不要用原生表单控件。** 沙箱文档的 `color-scheme` 被强制成 `normal`，原生 checkbox 会按浅色主题画。用 `appearance: none` 自绘。
6. **卡片顶上给窗饰让位。** 桌面窗口右上角那排按钮浮在内容之上且能点：标题栏留 `padding-right: 96px`（待办），或顶上一条 24px 状态条（便签）。
7. **组件拿不到 `localStorage`、读不到 `parent` 的 DOM，一切能力走桥。** 落盘全部走 `storage`（`widget-data/<widgetId>.json`，写入经过 `write_atomic`，每次写完平台推 `store-changed`）。

"整行可拖"和"整行可点"要分得开：4px 阈值 + 吃掉抬手那次补发的 `click`（`setTimeout(…, 0)` 复位）。别用 HTML5 拖放——沙箱是不透明源，跨文档 `dataTransfer` 靠不住。

## 3. 文案：内置组件必须真双语

- 清单里的 `name` / `description` / `config` 标签 / `help` / `changelog` 写成 `{ zh, en }` 对象，平台按当前语言挑（`runtime/widget-text.ts` 的 `pickText`）。
- 组件里画出去的字：**两件事都要做**——`lang.get` 拉一次（"zh" | "en"）+ 收 `language` 推送。只读一次 = 换语言卡片不动；只听推送 = 热重载后停在旧语言。
- 首帧先按一门画（HTML 里写死一份，通常是中文），`lang.get` 回来再换。等桥那几十毫秒画"加载中"是把等待画得更久。
- 用 SDK 的话这两件事已经包好了：`lattice.language` + `lattice.on("language")`。**官方组件刻意不用 SDK**——它们是"不装 SDK 也能写"的证明，也是 SDK 的唯一回归基准。

## 4. 要用户调的参数写进清单的 `config`

不在卡片里画设置 UI（卡片只有 240×140，而且组件存储按 `widgetId`，两个实例会共享偏好；属性面板按实例，那才是用户期望的粒度）。

五类字段：`toggle` / `number` / `text` / `select` / `date`，真源是 `runtime/config.ts` 的 `ConfigField`。每条都要有交代：**字段自带 `help`，或在说明正文里被提到**（`tests/help.html` 会红）。

改组件行为时：`config.get` 读一次 + 处理 `config-changed` 推送，两件都要。配置变化**不重载**组件，只有权限变化才重载。

## 5. 清单里的 `help` / `changelog`

- 说明写在 `manifest.json` 的 `help`，不是 README——包是纯静态目录，平台没有 Markdown 渲染器，写进清单才能跟着包走、离线能看、同签名。
- 上限是真截断：6 节 × 6 条 × 160 字；变更 12 条 × 8 项。坏条目逐条丢，包照常加载。
- **改了行为，同一次提交里补当前版本那条 changelog**（`version === manifest.version`），写用户能看懂的话。
- **改了组件就要抬 `version`**（三段，`1.2` 会被拒）。`planInstall` 判的是版本号不是文件内容——忘了抬，商店里永远显示"已是最新"。

## 6. 生成索引 / 打包 / 签名

```bash
npm run widgets:index    # 写 public/widgets/index.json（dev / build 会自动跑）
npm run store:index      # 打包 + 签名所有内置组件，写 public/store/
npm run pack:widget -- examples/counter   # 单个目录 → dist-packs/<id>.lattice
```

- 打包要验**确定性**：连打两次 `sha256` 必须一样。
- 签名只有一份实现：Node 侧 `scripts/sign-widget.mjs`（`crypto.sign(null, …)`），Rust 侧 `signature.rs`（`ed25519-dalek`）。动任一边先跑 `npm run sign:widget -- --selftest`。
- 内置目录是 `npm run dev` / `build` 现场用仓库里那把**公开**的 `scripts/dev-publisher.key` 签的——这把钥匙**故意进仓库**，别当身份。`isDemoPublisherKey` 把它排除在钉子之外。
- 图标只当形状用（CSS 遮罩 + `currentColor`），所以 SVG 里写什么色都行。**永远不要**把组件的 SVG 内容直接塞进主窗口 DOM。

## 7. 验收

```bash
npm run typecheck
npm run test:browser -- --filter help        # 清单 / 双语 / changelog 的契约
npm run test:browser -- --filter <相关页>
```

- 组件 UI 要肉眼看：`npm run dev` 后打开 `http://localhost:1420/widgets/<id>/index.html`。
- 固定尺寸截图用 Edge headless，`--virtual-time-budget` 必须给（否则截到 transition 中间态）：

```bash
msedge --headless=new --disable-gpu --force-device-scale-factor=2 \
  --virtual-time-budget=2000 --window-size=340,300 \
  --screenshot=out.png "http://localhost:1420/widgets/<id>/index.html"
```

- 新增断言页时：夹具页（只被别的页面加载、一条 PASS 都不写）要加进 `scripts/test-browser.mjs` 的 `FIXTURES`，否则脚本报"0 条断言"。
- 发公共目录：`npm run publish:widget -- <组件目录> --key ../lattice-registry/.keys/publisher.key`，验收标准是**幂等**（连跑两次 registry 的 `git status` 为空）。
