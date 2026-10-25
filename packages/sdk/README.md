# @lattice/sdk

棂（Lattice）组件的桥客户端。**一个文件，零依赖**，没有构建步骤。

```js
import { createLattice } from "./lattice.js";

const lattice = createLattice();
await lattice.ready;                       // 配置和主题已经就位

lattice.schedule.every(1000, () => render());
await lattice.storage.set("lastSeen", Date.now());
```

## 为什么是"拷进你的目录"，不是 `npm install`

平台的设计前提之一是**组件不需要构建**：一个目录、一个 `index.html`、几个 `.js`，拖进窗口就能跑。一旦 `import "@lattice/sdk"` 成了必需，每个组件都得配一套打包工具 —— 那等于把平台的复杂度转嫁给每个写组件的人。

所以 `lattice.js` 是**随包分发的普通文件**：

```
my-widget/
  lattice.js        ← 从模板或示例目录里拷过来
  lattice.d.ts      ← 编辑器补全用，运行时不需要
  manifest.json
  index.html
  widget.js
```

`npm run create:widget` 会自动拷好这两份。手写组件的话，从 `examples/counter/` 拷。

代价是**版本会漂**：平台的桥改了，拷出去的副本不会自己更新。两道保险：

- `npm run sdk:sync` —— 把所有内嵌副本刷成最新
- `npm run test:sdk` —— 任何一份和 `packages/sdk/lattice.js` 不一致就失败

组件的 `manifest.json` 里写 `"sdk": "^0.1"`，平台据此判断"这个组件期望的桥版本"，不匹配时会在组件库里提示。

## 这个包不做什么

- **不替你决定 UI**。没有组件、没有样式、没有状态管理。
- **不绕过权限**。每一次调用都还是走桥，用户没授权的照样 `permission_denied`。
- **不重试**。失败了就把错误交给你 —— 该降级还是该提示授权，只有组件自己知道。

## API

### `createLattice(options?)`

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `timeout` | `3000` | 单次桥调用的超时（毫秒） |
| `bootTimeout` | `1200` | 启动时拉配置 / 主题 / 语言各自的最长等待 |
| `autoTheme` | `true` | 自动把主题令牌写成 CSS 变量 |
| `autoReady` | `true` | 启动完成后自动向宿主报 `ready` |

返回的对象：

| 成员 | 说明 |
| --- | --- |
| `hosted` | 是否真的在宿主页里。顶层窗口（直接打开 HTML）为 `false` |
| `ready` | `Promise`，配置和主题已经应用过一次 |
| `call(method, params?)` | 调任意桥方法。失败 reject 一个 `LatticeError` |
| `on(event, fn)` / `off(event, fn)` | 订阅宿主推送，返回退订函数 |
| `theme` | 当前主题令牌（`--lattice-*` 长名） |
| `applyTheme(tokens)` | 手动应用一份令牌 |
| `language` | 当前界面语言 `{ lang: "zh" \| "en", locale }`，见下面"双语组件" |
| `config` | 当前实例配置，已合并出厂值 |
| `reloadConfig()` | 重新拉一次配置 |
| `storage.{get,set,remove,onChange}` | 组件私有存储，需要 `storage` 权限 |
| `schedule.every(ms, fn)` | 挂一条心跳，返回 `{ id, stop }` |
| `schedule.clear(id)` | 退掉一条心跳 |
| `system.metrics()` | CPU / 内存 / 磁盘 / 网络，需要 `system:monitor` |
| `media.{get,playPause,next,previous,stop}` | 系统媒体会话，需要 `media:control` |
| `network.fetch(input)` | 代发 HTTP，需要 `network` + 清单白名单 |
| `now()` | 系统时间，需要 `clock` |
| `copy(text)` | 写剪贴板，需要 `clipboard:write` |
| `open(url)` | 用默认浏览器打开 http/https 链接，需要 `shell:open` |
| `close()` | 关掉自己这个窗口（不删用户的 placement） |

### 错误

所有失败都是 `LatticeError`，带 `code`：

```js
import { isPermissionDenied } from "./lattice.js";

try {
  await lattice.storage.set("draft", text);
} catch (error) {
  if (isPermissionDenied(error)) {
    hint.textContent = "Needs the Storage permission";
    return;
  }
  throw error;
}
```

| `code` | 含义 |
| --- | --- |
| `permission_denied` | 用户没授权。`error.permission` 是缺的那一项 |
| `unknown_method` | 方法名写错了，或者平台版本太老 |
| `bad_params` | 参数形状不对 |
| `internal` | 平台侧出错，或者这个文档根本不在宿主里 |

**不要只写 `catch (e) {}`。** 权限被拒时静默失败，组件会表现成"功能不见了"，用户只会觉得是 bug。

### 主题

宿主推过来的令牌是 `--lattice-text`、`--lattice-surface` 这种长名，`applyTheme` 会顺手写一份短别名：

| 长名 | 别名 |
| --- | --- |
| `--lattice-text` | `--fg` |
| `--lattice-surface` | `--surface` |
| `--lattice-text-muted` | `--muted` |
| `--lattice-accent` | `--accent` |
| `--lattice-border` | `--border` |
| `--lattice-radius` | `--radius` |
| `--lattice-font` | `--font` |

两个名字都能用。别名是为了让组件 CSS 短一点，长名是为了和平台文档对得上。

### 双语组件

平台界面可以中英切换。**组件自己的字由组件自己挑** —— 平台不认识你写的那句话，不会替你翻。两件事要做：

```js
const lattice = createLattice();
await lattice.ready;                       // 这之后 lattice.language 就是准的

const pick = (zh, en) => (lattice.language.lang === "zh" ? zh : en);
title.textContent = pick("说点什么…", "Say something…");

// 用户在设置里换了界面语言：重画一遍
lattice.on("language", () => {
  title.textContent = pick("说点什么…", "Say something…");
});
```

清单里也是同一套规矩：`name` / `description` / `config` 的 `label` / `help` / `changelog` 都可以写 `{ "zh": …, "en": … }` 两种语言，老的单字符串写法永远有效（写一种就是两种语言都显示它）。细节见 `docs/WIDGET_SPEC.md` §3.1。

## 不用这个包也可以

桥就是 `postMessage`，协议在 `docs/WIDGET_SPEC.md` §4 写着。`public/widgets/` 下的内置组件全部是手写的，一个都没有 import 这个包 —— 它们就是"不装 SDK 也能写"的证明。

什么时候值得装：组件有存储、有心跳、要处理权限失败。什么时候不必：只有一个 `clock.now` 的纯展示组件。
