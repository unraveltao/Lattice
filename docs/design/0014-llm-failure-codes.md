---
status: accepted
date: 2026-10-26
code: src-tauri/src/llm_policy.rs, src/runtime/llm-errors.ts, src/runtime/i18n/assistant.ts, src/platform/AssistantPanel.tsx, src/platform/ModelProfiles.tsx
---

# 供应商失败那几句：Rust 给码 + 英文原句，前端给句子

## 1. 问题

界面是双语的（`runtime/i18n.ts`，key 就是英文原句）。**唯一没有跟着换语言的一块，是供应商失败的那几句**——它们不是前端写的，是 Rust 写的：

- `llm_policy::describe_status(401, body)` → `the provider rejected the API key (HTTP 401) — invalid api key. Check the key in Assistant settings`
- `llm_policy::describe_failure("12029 …")` → `could not reach the provider — check the base URL and your connection`

这两条字符串经 `llm_chat` / `llm_chat_stream` / `llm_models` 的 `Err(String)` 原样到前端，前端再原样塞进 `setError`。所以一个中文界面的用户，模型档填错 key 时看到的是整句英文；更糟的是它**和旁边那圈中文标签混在一起**，看起来像"这半边界面没做完"。

AGENTS §8 里这一条原来写的是"暂时留着"：把文案的家搬到前端这件事，看起来要动跨进程契约。

## 2. 候选

| 做法 | 为什么不行 |
| --- | --- |
| **A. Rust 自己拼中文** | 等于给 i18n 开第二个家：Rust 要么持有一份中文表（和 `i18n/assistant.ts` 各改一次，还会漂），要么每次调用把 `language` 一路传进 `llm_policy`（多一个参数，且 Rust 仍然要知道"中文该怎么说"）。`docs/README.md` 的第一条就是"一份事实只有一个家" |
| **B. 前端认英文子串**（`text.includes("rejected the API key")`） | 前端和 Rust 的耦合从"一个码"变成"整句措辞"。Rust 那边改个标点，前端**不会报错**，只会静默退回英文——这正是这个仓库最怕的那类坏法：改的人以为改完了，看到的人以为功能没做 |
| **C. Rust 在前面加一行机器可读抬头**（选中） | 代价是协议上多一行：失败字符串不再是"一句话"，而是"抬头 + 换行 + 英文原句"。所有拿它当字符串用的地方（日志、审计、第三方）都要能容忍这一行 |
| **D. Rust 只回状态码与响应体，判据全搬前端** | 判据搬不过去：`describe_failure` 认的是 WinHTTP 的 12029 / 12044 / 12002，那是 Rust 侧 `network::send` 的知识；前端拿到的是一个错误字符串，没有结构。而且同一条字符串也写给审计日志，那里没有前端 |

C 之所以比 B 好，只差一件事：**耦合面是一个词表，不是一段措辞**。码表（`key-rejected` / `not-found` / …）是契约，措辞是实现；前者该跨进程，后者不该。

## 3. 决定

1. **失败字符串的形状固定成两段**：

   ```
   @@llm:{"code":"key-rejected","status":401,"detail":"invalid api key"}
   the provider rejected the API key (HTTP 401) — invalid api key. Check the key in Assistant settings
   ```

   第一行是抬头（`llm_policy::FAILURE_TAG` + 一行 JSON），第二行起是**原来就有的英文句子，一个字没改**。
2. **码表只有一份，在 Rust**（`llm_policy::status_code`）：`401 | 403 → key-rejected`、`404 → not-found`、`413 → too-large`、`429 → rate-limited`、其余 4xx → `rejected`、5xx → `server-error`、其他 → `unexpected`。网络那几条的码写死在 `describe_failure` 里：`unreachable` / `tls` / `timeout` / `send-error`。**前端不重判状态码**，只按码挑句子——两处各判一次，迟早有一处漂。
3. **句子只有一份，在前端**（`runtime/llm-errors.ts` 的 `SENTENCES`，中文在 `i18n/assistant.ts`）。key 仍然是英文原句，缺翻译就退化成英文（`t()` 的既有行为）。
4. **`detail` 不翻译**。它是供应商说的那句话（`{"error":{"message":"invalid api key"}}` 里的一段），是数据不是文案；原样贴在句子后面，前端只负责加一个 ` — `。
5. **`@@llm:` 这个字面量故意写两遍**（`llm_policy.rs::FAILURE_TAG` 和 `llm-errors.ts::FAILURE_TAG`）。它不能只活在一处：一边是 Rust，一边是浏览器，中间只有一个字符串。所以两边各钉一条断言，钉的是"同一个字面量"这件事本身（`tests/llm-models.html` 有 `eq(FAILURE_TAG, "@@llm:", …)`）。
6. **认不出就原样显示**。抬头坏了（日志被切）、码不认识、JSON 少了字段——都不能让一条错误变成空白。顺序是：认得出码 → 本地语言那句；认得出抬头但码不认识 → 抬头之后那句英文；根本认不出抬头 → 整条原样返回。
7. **`llm.rs` 的 IO / 配置错误仍然只有英文**（`could not read assistant.json` 这类）。它们不是"供应商失败"，是平台自己的毛病，不该占用供应商那张码表；而且它们是开发者要看的话，不是用户要解决的场景。这条写在这里是为了**下次别把它当漏网之鱼**——§8 那一行就是被误读成"所有 Rust 的话都要双语"才一直挂着的。

代价：失败字符串不再是"一句话"，是"两行"。任何把它当一句话用的地方都得知道这一点——现在只有日志和审计（两者都原样写，不受影响），以及 `AgentReply.error`（同样是原样透传）。

## 4. 接口与数据

| 接口 | 形状 | 谁答 |
| --- | --- | --- |
| `llm_policy::describe_status(status, body)` | `@@llm:{code,status,detail}\n<英文句子>` | `llm.rs`（`llm_chat` / `llm_chat_stream` / `llm_models`） |
| `llm_policy::describe_failure(error)` | 同上，`status` 是 `null` | `llm.rs`（`network::send` / `network::stream` 失败） |
| `llm_policy::status_code(status)` | `&'static str` | 上一个表的唯一判据 |
| `parseLlmFailure(raw)` | `{code, status, detail, english} \| null` | 前端（纯函数） |
| `describeFailure(raw)` | `string`（认不出就 `raw`） | 面板的每一个错误位 |
| `FAILURE_TAG` | `"@@llm:"` | 两边各一份，字面量必须一致 |

抬头里三个字段：`code`（必填，非空才认）、`status`（数字或 `null`）、`detail`（字符��或空串，已经过 `escape`）。`failure_tag` 用 `escape()` 转义，所以供应商原话里带引号 / 换行也不会把 JSON 拆坏。

**没有落盘格式变化**：`assistant.json` / `state.json` 一个字段都没动，失败字符串是即时返回值。所以没有迁移。

## 5. 失败模式

| 坏法 | 用户看到什么 | 兜底 |
| --- | --- | --- |
| 抬头被截断（只留半行 JSON） | 有英文原句就显示它，否则原样 | `parseLlmFailure` 的 `catch`：抬头坏了但 `english` 非空 → 用 `english` |
| 抬头坏了、后面也没有英文（一条只有抬头的日志） | 原样那一整串 | `parseLlmFailure` 返回 `null` |
| 前端还不认识这个码（版本不同步 / 将来加码） | 英文原句 | `SENTENCES[code]` 未命中 → `failure.english \|\| raw` |
| 中文表漏了一条 | 英文原句（不是 key 本身） | `t()` 的"缺翻译退化" |
| `detail` 里有引号 / 换行 | 正常显示，句子后面多一段 | Rust 侧 `escape()` + 前端只做拼接 |
| 不是 LLM 的错误（文件坏了、桥超时）进了同一个框 | 原样那一句 | `parseLlmFailure` 不认这种形状，返回 `null` |
| `status` 缺失（网络类失败） | 句子里的 `{status}` 变成 `0`，但那几条句子**都不含 `{status}`** | `describe_status` / `describe_failure` 的码表各占一半 |
| 一条错误被显示两次（面板与设置面板各一处） | 两处都换过语言 | 调用点全部套 `describeFailure`，它是幂等的（认不出就原样） |

## 6. 验收

- `llm_policy.rs` 49 → **50 条**：`failure_tag_carries_a_machine_readable_code`（抬头是 `@@llm:` 开头、`code` 拆得出来、英文原句在换行之后还在）。
- `tests/llm-models.html` 26 → **42 条**（+16）：抬头字面量与 Rust 一致、拆出码 / 状态 / 原话、英文原句留着、非 LLM 错误原样过、英文界面照旧那句、中文界面换成中文且**不露出英文原句**、供应商原话两门语言都带着、不认识的码退回英文、截断的抬头当认不出、网络失败（`status: null`）也认得出。
- `npm run typecheck` 干净；`cargo check --all-targets` 干净。
- 真机那一段：故意把 key 改错一个字符，中文界面下点"测试连接"该看到**中文**那句"供应商拒绝了这把 API key（HTTP 401）"，后面跟着供应商原话。这一条要和 0007 §6 的真机验收一起走。
