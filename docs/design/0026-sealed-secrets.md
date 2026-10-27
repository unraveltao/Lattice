---
status: accepted
date: 2026-10-27
supersedes:
code: src-tauri/src/{secrets.rs,secrets_policy.rs,llm.rs,lib.rs}, src-tauri/Cargo.toml, src/runtime/{bridge.ts,manifest.ts,catalogue.ts}, src/runtime/i18n/misc.ts, tests/secret.html, docs/{WIDGET_SPEC.md,PITFALLS.md,ROADMAP.md}, AGENTS.md
---

# 0026 —— 给密钥一个密封的抽屉（DPAPI）

## 1. 问题

平台的 LLM key **明文**躺在 `%APPDATA%\com.iron-tom.lattice\assistant.json` 里。任何能读这个目录的进程（包括任何一块组件的 Rust 侧？不——组件碰不到文件；但包括任何一个以这个用户身份跑的 exe）都能拿走它。

**坏结果**：一次误传的备份、一次 `%APPDATA%` 被同步到网盘、一次日志里 `JSON.stringify` 打到了整份配置 —— key 就泄露了，而用户要等到账单才发现。

第二个后果是**组件永远拿不到 token**：想接 GitHub 的组件只能把 PAT 写进 `config`（明文落 `state.json`），所以像"相似项目"这类组件被永久卡在匿名额度上。

## 2. 候选

| | A：DPAPI 密封一个文件（选中） | B：Windows 凭据管理器 | C：用户口令派生密钥 | D：不管 |
| --- | --- | --- | --- | --- |
| 做法 | `CryptProtectData` 封 `secrets.bin` | `CredWrite` 逐条存 | 让用户设一个主密码，AES 派生 | 保持明文 |
| 换掉什么 | 一个文件格式 + 读写层 | 每条 2.5 KB 上限，枚举别扭 | 每次启动要输密码 | —— |
| 代价 | 绑当前 Windows 账户：换账户 / 重装系统就解不开 | 用户会在系统 UI 里看到"Lattice"，多一处要解释的东西 | 桌面组件每次开都弹一次密码框，等于废掉"摆着不用管" | 泄露一次就是账单 |

## 3. 决定

**决定**：A —— DPAPI 密封一个 `secrets.bin`。

**代价**（具体）：

- **换 Windows 账户或重装系统，密钥全部失效**。这是 DPAPI 的定义（密钥由用户登录凭据派生），不是缺陷，但必须在界面上说清楚：解不开时是"读不出来，请重新填"，**不是静默清空**。
- **不是密码学意义上的保险箱**。任何以**这个用户身份**运行的进程都能调 `CryptUnprotectData` 解开它 —— DPAPI 挡的是"别的用户"和"拷走文件到另一台机器"，挡不住本机同账户的木马。想挡那个得靠口令（候选 C），而 C 的代价是每次启动要输密码。**这一条必须写进文档**，不然它会被当成"加密了所以安全"。
- 一个二进制文件，`git diff` 看不出来，出问题只能看头部那行 magic。

**什么时候该推翻它**：要做跨设备同步（那时需要口令派生，DPAPI 绑机器）；或者 Windows 全面转向 passkey / Hello 的密钥存储 API。

**被推翻的**：

- "每条密钥一个文件" → **一个密封的 JSON**。一个文件 = 一次原子写 + 一份 `.bak`，而 20 个文件就是 20 次写和 20 份备份。
- "顺手给组件一个通用 `secret.get(key)`" → **按组件 id 命名空间隔离**。组件只能碰 `widget.<自己的 id>.` 开头的键，拿不到 `llm.*`，也拿不到别的组件的。没有这条，一个组件装上就能读走用户的模型 key。

## 4. 接口与数据

**文件**：`%APPDATA%\com.iron-tom.lattice\secrets.bin`

```
LATTICESECRET1\n          ← magic + 版本，8 字节
<DPAPI blob>              ← CryptProtectData(UTF-8 JSON)，CRYPTPROTECT_UI_FORBIDDEN
```

明文 JSON 的形状（只在内存里存在）：

```json
{ "llm.<profileId>": "sk-…", "widget.lattice.related.github": "ghp_…" }
```

**Rust 侧（平台内部，不是桥方法）**

```
secrets::get(app, key)   -> Option<String>
secrets::set(app, key, value) -> Result<(), String>
secrets::delete(app, key)     -> Result<(), String>
secrets::keys(app)            -> Vec<String>        // 只回名字，永不回值
```

**桥方法**（组件用，权限 `secret`）

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `secret.set` | `{ name, value }` | `{ ok }` |
| `secret.get` | `{ name }` | `{ value }` —— 没有就是 `null` |
| `secret.delete` | `{ name }` | `{ ok }` |

- `name` 必须匹配 `[a-z][a-z0-9_-]{0,31}`，平台内部拼成 `widget.<widgetId>.<name>`。**组件看不到也写不了这个前缀**。
- `secret.get` 的返回会进组件的 JS 环境 —— 这是这条能力**故意**打开的：组件要拿 token 去请求。所以 `help` 和权限文案里必须写明"这个组件能看到你填的密钥"。

**迁移（`assistant.json`）**

1. 读 `assistant.json`，凡是 `profiles[].api_key` 非空的，写进 `secrets` 的 `llm.<profileId>`，然后把那个字段清空、只留 `key_hint`。
2. **幂等**：再跑一次什么都不发生（字段已经空了）。
3. **失败不吞**：DPAPI 写失败 → 保留明文、在设置页挂一行"密钥还没加密保存（原因）"，**绝不为了"迁移成功"把 key 删掉**。
4. 回滚：`secrets.bin` 解不开时，若 `assistant.json` 里还留着明文（迁移失败的老机器），照旧用它。

**要改的文件**（第六处还是文档）

1. `src-tauri/src/secrets.rs` + `secrets_policy.rs`（命名空间拼接、magic 头、迁移判定）
2. `src-tauri/src/llm.rs`：读 key 的地方改成 `secrets::get` 优先、明文兜底
3. `src-tauri/src/lib.rs` 的 `generate_handler!`
4. `src/runtime/bridge.ts`：三个 `defineMethod` + `KNOWN_PERMISSIONS` + `manifest.ts` 的 `Permission` 联合类型与文案
5. `WIDGET_SPEC` 新一节（§3.8）+ §4 方法表三行 + 权限表 13 → 14
6. `AGENTS.md` 一条不变量（"密钥只进 secrets，明文只作为迁移兜底"）+ `PITFALLS.md`

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 换电脑之后模型全部"没配置" | DPAPI 解不开 | 当"没有密钥"，提示重新填；**不要删 `secrets.bin`**（换回去还能用） |
| 迁移之后模型还能用，但账单翻倍 | 迁移写成功却没清明文，两处都在 | 迁移是"先写密封、再清明文、最后校验"，顺序不能反 |
| 组件读到了模型的 key | 命名空间没隔离 | `name` 只能拼在 `widget.<id>.` 之后，`llm.` 前缀对组件不可见 |
| 用户以为"加密了就安全" | 文档没说清 DPAPI 的边界 | 权限文案与 `help` 里明写：挡别的用户和拷走的文件，挡不住本机同账户的程序 |
| 保存后立刻读回来是乱码 | 写的时候按字节、读的时候按字符串 | 统一 UTF-8，`secrets.bin` 只存字节，编解码在 `secrets.rs` 一处 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `src-tauri/src/secrets_policy.rs` | ~15（`rustc --test`） | 命名空间拼接（组件名不能越界）、magic 头解析、迁移的三步顺序与幂等、解不开时的兜底判定 |
| `tests/secret.html` | ~12 | 桥这一侧的 `name` 校验与错误码、`null` 与错误的区分 |

**手工验一次**：填一个模型 key → 关掉设置 → 看 `assistant.json` 里 `api_key` 是空的、`secrets.bin` 存在 → 重启后模型仍可用 → 把 `secrets.bin` 复制到另一台机器（或另一个 Windows 账户）下，确认它读不出来且**文件还在** → 用一块临时组件试 `secret.get`，确认它读不到 `llm.*`。

## 7. 实现之后（三处修正 + 一处补强）

> 上面几节是动手前的推理，**保留原样**。这一节只记"真写下去才发现对不上的地方"。

1. **文件不在 `%APPDATA%\com.iron-tom.lattice`，在 `app_config_dir()`。** 在这台机器上两者恰好是同一个目录（`assistant.json`、`state.json` 都在那儿），但判据要以 `llm::config_dir` 为准 —— 别在代码里手拼 `%APPDATA%`，那会在换 bundle id 之后静默分叉出两个库。
2. **文件头是 15 字节，不是 8。** `LATTICESECRET1\n` 就这么长。写"8 字节"会让人以为后面还有版本号字段 —— 没有，版本编在 magic 里（换格式就改这一串，旧文件一眼认不出来）。
3. **§3.8 实际落成了 §3.7。** 权限那一节当时只写到 3.6。
4. **补强：校验从"清明文之后"提到"清明文之前"。** 原文的第三步是"最后校验"，但校验失败时明文已经没了 —— 那一把 key 用户再也拿不回来。现在 `secrets_policy::run_migration` 是 seal → verify → clear：先后依赖没变（清明文永远是最后一步），失败面却只剩"什么都没发生"。这条是**改了设计的顺序**，不是改了设计的结论，所以记在这里而不是新开一份。
5. **多了一条 `secrets_status` 命令。** 原文的"失败不吞 → 在设置页挂一行"没有说那行字从哪来。现在由 `secrets_status` 回 `{ path, exists, count, error }`，`error` 是上一次 DPAPI 失败的原因（`secrets::last_error`）。只回条数不回键名 —— 键名里有组件 id，而那一行要回答的是"存了几把钥匙"。
