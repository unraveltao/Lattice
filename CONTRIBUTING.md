# 给这个仓库提东西

> 这份文件用中文写 —— 和 `docs/` 一样，这个仓库给"要改它的人"看的正文都是中文（分工见 [`docs/README.md`](./docs/README.md) 第一节末）。英文入口是 [`README.md`](./README.md)。

这份文件只管**从 clone 到你按下 push 之间的顺序**，以及什么会被拒。

规矩本身不在这里，别在别处找：

| 你要做的事 | 去哪 |
| --- | --- |
| 改平台代码 | [`AGENTS.md`](./AGENTS.md)（先读第 4 节那二十条不变量） |
| 写一个组件 | [`docs/WIDGET_SPEC.md`](./docs/WIDGET_SPEC.md) |
| 某个词到底指什么 | [`GLOSSARY.md`](./GLOSSARY.md) |
| 新内容该写成哪份文档 | [`docs/README.md`](./docs/README.md) 第三节 |
| 手上有个说不通的症状 | [`docs/PITFALLS.md`](./docs/PITFALLS.md)（`Ctrl+F` 搜现象，别搜原因） |
| 帮了忙但不是代码（提建议、报 bug、指出错字） | [`CREDITS.md`](./CREDITS.md)（判据只有一条：能在仓库里指出一处"因你而改"的东西） |

## 一、动手之前

- **平台是 Windows-only。** 整个窗口层是 Win32 的，macOS / Linux 上只能跑前端那一半（画布、组件沙箱、桥、权限），桌面那一层跑不起来。
- **Node 22**（CI 用的就是这个）。`npm install` 之后 `npm run dev` 就有界面，不需要 Rust；`npm run tauri:dev` 才要工具链，那条路的坑写在 [`docs/reference/build.md`](./docs/reference/build.md)。
- 先读 [`AGENTS.md`](./AGENTS.md) 第 4 节。那二十条不是风格偏好，每条背后都有一段"违反之后坏了什么"。

## 二、交付之前：按一个陌生人的顺序走一遍

这是这个仓库唯一接受的验证方式 —— 不是"我这儿是好的"，是"换台机器照文档走一遍也对"。

1. `npm run typecheck` —— 静态的那一半，30 秒。
2. `npm run check:tokens && npm run check:docs` —— 样式三张表，以及文档对账（相对链接、组件数、命令数、坑数、行数）。
3. `npm run dev` 起 dev server，另一个终端 `npm run test:browser` 跑全量断言。改过的页必须全绿。**新加的断言页不用登记**，脚本按 `tests/*.html` 自动收；只被别的页当夹具加载的，加进脚本里那个 `FIXTURES`。
4. 只有 `npm run tauri:dev` 才看得见的那一半 —— WorkerW 置底、圆角裁剪、鼠标穿透、拖拽、开机自启 —— **浏览器里跑通不算通过**。

判据只有一条：**"看起来对"不是证据。** 这个仓库最贵的一类 bug 是"注释写着 30px、实测 36px"，被 `overflow: hidden` 静默切了半年没人发现。任何结论都要落到一条断言，或者一次量出来的数字上。

## 三、一次 PR 只做一件事

反例是把"修一个排版"和"加一个桥方法"塞进同一个 PR —— review 的人没法只否掉一半。同一个 PR 里那些"顺手改了"的东西，通常就是三个月后没人能解释的那几行。

## 四、会动到哪几个地方

按你改的东西找，别凭印象：

- **行为** → 去 `tests/` 找现成的页补一条断言；没有就新开一页。
- **用户看得见的字** → `src/runtime/i18n/` 对应分片。**同一句话只许一种译法**，`tests/i18n.html` 会查"两种译法"、占位符不一致、首尾空白。
- **字号 / 圆角 / 间距** → 只许用那三张表里的值，`npm run check:tokens` 会拦越界并给行号。真要用表外的值，行尾写 `/* token-ok 理由 */`，理由不写会被报。
- **文档** → 按 [`docs/README.md`](./docs/README.md) 第三节那三问决定放哪一份。同一件事别在两份里各写一半。
- **数字**（组件数 / 权限数 / 命令数 / 断言数 / 坑数）→ 只改 `README.md` 与 `README.zh-CN.md` 里那张表。别处提到它就给链接，不要顺手再抄一个数。

## 五、提交信息

`git log --oneline -20` 看三行就懂：`type(scope): 一句话`，中文，说"改了什么"。

- type 只用这几个：`feat` / `fix` / `perf` / `docs` / `chore` / `test` / `refactor` / `ci` / `style`。
  `ci` 是 `.github/workflows/` 与发版脚本；`style` 只指**不改行为**的排版收敛 ——
  改了看起来什么样，那是 `feat`。
- scope 是目录或模块名：`ui`、`term`、`store`、`credits`、`release`。
  **scope 不是 type。** `credits:` / `settings:` / `release:` 是把 scope 顶到了 type 的位置，
  写成 `docs(credits):` / `feat(settings):` / `chore(release):` 才对 —— 这类写法在历史里
  出现过几处（`git log --grep` 能搜到），不再改历史，但新提交别再添。
- body 写**为什么** —— "怎么做"diff 里已经有了。
- 不写 `update file`、`fix bug`、`修改一下`。

这一条**有钩子拦着**，不靠自觉：`npm install` / `npm ci` 会把 `core.hooksPath` 指到
`scripts/git-hooks/`（装不上只是不装，不会让安装失败）。

| 钩子 | 做什么 | 什么时候红 |
| --- | --- | --- |
| `commit-msg` | 校验上面那个形状 | type 不在表里、`feat:` 后面空着、`credits:` 这种 scope 当 type |
| `pre-push` | `npm run typecheck` + `npm run check:docs` | 类型错、相对链接死了、README 的数字和代码对不上 |

只拦格式和"本机能验的那一半"，不拦内容。真绕过去用 `--no-verify` —— 但 `pre-push`
那两条正是 CI 会红的两条，绕过去只是把红推迟到别人的机器上。

钩子换了机器要重装：`npm run hooks:install`（不用重装依赖）。

## 六、不会被合的东西

- **为了"完整"而复制代码或复制别的文档的段落。** 抄过来的那一刻就开始过期。
- **新开第三份契约文档。** 契约现在只有 `WIDGET_SPEC.md` 和 `AGENTS.md` 两份，这个数目是故意的。
- **未经商量的依赖。** 依赖表刻意短：多一个包，就多一条"它在 Windows 上会不会挂"。
- **把 `public/widgets/` 下的官方组件改成用 SDK。** 它们刻意不用 —— 那是"组件只需要桥"的证明。
- **把纯逻辑塞回带依赖的模块里。** 那些 `*_policy.rs` 是为了能单独 `rustc --test` 才拆出去的，搬回去等于那批断言从此没人跑。

## 七、报问题

先看 [`docs/FAQ.md`](./docs/FAQ.md) —— 按"卡在哪一步"分组，多半已经有答案。真要开 issue，最后一节写了该带哪三样东西。

## 八、许可

MIT（见 [`LICENSE`](./LICENSE)）。提 PR 就是同意以同一许可发布 —— 没有 CLA，没有版权转让。
