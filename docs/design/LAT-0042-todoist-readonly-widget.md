---
status: accepted
date: 2026-10-29
supersedes:
code: public/widgets/lattice.todoist/*, tests/todoist.html, public/widgets/index.json, docs/ROADMAP.md
---

# LAT-0042 —— Todoist 只读镜像（`lattice.todoist`）

> 2026-10-29 追记：这份写的是 0.1.0。同一天定的 0.2.0（没有账号也能用、改名 + 免责声明、`shell:open`、断开入口）在 [0043](./LAT-0043-todoist-local-scratch-list.md)，它推翻了 §3 的"token 门槛是唯一首屏"和 §4 的"不申请 `shell:open`"。正文按规矩不改 —— 那两处的推理仍然是 0.1.0 当时的理由；§6 的 103 条也是 0.1.0 的数字，0.2.0 是 150 条。

## 1. 问题

用户的任务记在 Todoist 里，桌面上那块待办记的是另一份。想看"今天要干什么"得开浏览器 —— 于是桌面这块对这批人永远是**第二份要维护的清单**，而两份清单并存的结果是挑一份用、另一份变装饰。

不做会怎样：`lattice.todo` 已经把"摆着就能看见"做完了，但它看不见用户在别处记的事。而这个平台唯一能给的差异是"摆着" —— 一个要你切窗口才能看的镜像没有意义。

## 2. 候选

| | A 只读镜像（选中） | B 双向同步 | C 只写不读 |
| --- | --- | --- | --- |
| 换掉什么 | 卡片只展示 | 卡片变成第二个客户端 | 加一颗"推上去" |
| 代价 | **点不掉**：看到过期的一条红着，唯一的动作是去 Todoist | 冲突、`temp_id` 映射、失败回滚；两边同时改时"谁是真相"要有答案 | 只搬一次，搬完两边还是会分叉 |

另两个岔路（是前提，不是候选）：

- **改 `lattice.todo` 还是新建 `lattice.todoist`** → 新建。加 `network` + `secret` 会触发已装用户的**新权限复核**（目录那条权限差集），而"本地清单"和"别人的清单的视图"是两种语义 —— 挤进一个组件，help 里必然出现一段自相矛盾的话。
- **token 放哪** → 见 §3 第三条。

## 3. 决定

**A + 新建组件 + 卡片内一道"第一次用"的门槛。**

代价，具体的：

1. **勾不掉。** 这是这一版最大的体验缺口，help 第一句就写"这是镜像"，不藏着。
2. **视觉约定维护两份。** 优先级三色、26px 行高、给窗饰让位的 120px，`lattice.todo` 和这里各写一遍（不是复制代码 —— 只读版没有拖拽、勾选、右键菜单，只有约 300 行）。改颜色要改两处，这是明知而选的。
3. **token 不进 `config`。** `config` 是 per-instance 的（两个实例各一份），`secret` 是 per-widget-id 的；而且 `config` 落 `state.json` 是明文，`config.ts` 也只有 toggle / number / text / select / date 五种类型，没有 password。三个候选：
   - a) 塞 `config`：明文落盘，等于把 token 交给任何能读 `%APPDATA%` 的进程 —— 否决。
   - b) 卡片内做一道门槛界面（选中）：只在没有 token 时出现，不是"设置页"。
   - c) 给 `config` 加 `type: "secret"`：属性面板渲染密码框、值进密封库、预览镜像（0015）要跳过它、目录权限差集要认它。**这是给"第二个也要 token 的组件"准备的机制**，现在只有一个（momentum 想接 GitHub PAT，但匿名额度也能跑）。

   **什么时候推翻 b**：出现第二个要 token 的组件时，c 就该做了 —— 那时"卡片里各画一套 token 输入框"才开始真的重复。

## 4. 接口与数据

清单：`permissions: ["network", "secret", "storage"]`，`network.hosts: ["api.todoist.com"]`（精确匹配，不支持通配符）。**不申请 `shell:open`** —— 为了 help 里一个链接多一项权限不值。

桥：全是既有方法，没有新增契约。`secret.get/set` 用名字 `token`；`network.fetch` 发 `GET https://api.todoist.com/api/v1/tasks`，带 `Authorization: Bearer`；缓存走 `storage` 的键 `cache`。

落盘格式（`widget-data/lattice.todoist.json`）：

```
{ "cache": { "v": 1, "at": <ms>, "tasks": [{ "id", "text", "priority", "due" }] } }
```

- `tasks` ≤ 120 条、`text` ≤ 160 字（上限在 `normalizeTask`，缓存不会再长）。
- `v` 对不上整份作废 —— 缓存是加速不是真相，迁移一份"只是缓存"的东西不值得。
- **token 不在这份文件里，一个字节都没有。**

分页：跟 `next_cursor`，最多 3 页 / 120 条；还有下一页却停了，头部写 `40+ 项`。

不写回：没有 POST，没有 `close` / `move`。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| "联网要在桌面应用里" | 浏览器预览里 `network.fetch` 抛 `internal` + "desktop app" | 不重试、不报网络错 —— 这本来就不是错 |
| "token 失效了，换一个"，列表还在 | 401 | 保留缓存，齿轮换 token |
| "被限流了，42 秒后重试" | 429 + `Retry-After` | 读出秒数，夹到 1..600（服务端给 86400 也不照抄） |
| "返回太大，被截断了" | 200 + `truncated`（桥的响应上限 1MB） | 不当成 JSON 错误；**被截断的 401 仍然说 token** —— 先判状态码再判截断 |
| "返回的不是任务列表" | 形状不认识（既不是数组也没有 `results`） | 保留缓存，不白屏 |
| 头部 `40+ 项` | 跟满 3 页还有下一页 | 不把 40 条说成"一共 40 条" |
| 换 Windows 账户后要重填 token | DPAPI 解不开 → `secret.get` **抛错**（不是返回 `null`） | 说"密钥读不出来，重新填一次"，不静默清空 |
| 两个实例各拉一遍 | 没有跨实例通知 | 十分钟一次 × 2，接受 |

## 6. 验收

`tests/todoist.html` **103 条**，两段：

- **纯逻辑（直接加载 `todoist-core.js` 真身）**：优先级是反的（4 最高、1 是没设）、两种响应形状（裸数组 / `results` + `next_cursor`）、状态码分类（401/403/404/429/5xx/3xx）、截断优先于 `JSON.parse`、`Retry-After` 夹紧、缓存形状（`text` / `"high"` / `"2026-10-28"`）来回一趟不丢字段、日期本地化。
- **把组件挂进假宿主**（`secret` / `network` / `storage` 全打桩）：**token 一次都没出现在 `storage.set` 里**、缓存先画后换、401 / 429 / 截断 / 坏形状 / 不在桌面里 / 缺权限时**列表都不清空**、分页封顶带 `+`、刷新与换 token。

真机还没走：填真 token、断网、把 token 在 Todoist 里重置一次，看三种底栏。
