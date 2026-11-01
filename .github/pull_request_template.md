<!--
  这个模板只给格式，不给规矩 —— 规矩在 CONTRIBUTING.md。
  三件事决定这个 PR 能不能合：行为变了什么、证据在哪、没跑的是什么。
  删掉不适用的小节可以，删掉"没跑的"那一栏不行。
-->

## 行为

谁在什么场景下会看到什么变化。只改文档就说清改的是哪一份、为什么改。

## 验证

| 跑了什么 | 结果 |
| --- | --- |
| `npm run typecheck` | |
| `npm run check:docs` / `check:stats` / `check:guards` | |
| `npm run test:browser -- --filter <页>` | |
| `cargo test`（跑得动才填） | |

**没跑的，和为什么**：

## 真机

- [ ] 不涉及 Windows 行为（窗口、焦点、进程、麦克风、终端）
- [ ] 涉及，证据：步骤 / 期望 / 实际 / 日志或截图路径

## 兼容与回退

动没动 `state.json`、桥方法、权限、组件包格式；要退怎么退。

---

完整门禁清单与"什么会被拒"：[CONTRIBUTING.md](https://github.com/unraveltao/Lattice/blob/main/CONTRIBUTING.md)
