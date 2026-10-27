//! 密封密钥的**纯逻辑**：命名空间拼接、文件头、迁移判定。
//!
//! # 为什么这一层不碰 DPAPI、不碰磁盘
//!
//! 和 `llm_policy.rs` / `agent_policy.rs` 同一条规矩：判定要能用 `rustc --test`
//! 的壳子单跑（这台机器的安全策略不让 `cargo test` 往 `target/debug/deps` 写新
//! exe）。所以加密、读写文件在 `secrets.rs`，**"该不该、叫什么、按什么顺序"**
//! 全在这里。
//!
//! # 这一层守住的两条
//!
//! 1. **组件够不到别人的键**。键名一律由平台拼（`widget.<id>.<name>`），组件
//!    只递一个名字片段；拼出来的结果里 `llm.` 前缀对它不可达。没有这条，
//!    一个组件装上就能读走用户的模型 key。
//! 2. **迁移失败时明文一行不动**。顺序写在 `run_migration` 里，而且它接受
//!    注入的闭包 —— 于是"第 2 条密封失败，明文不许清"这条能被单测钉死，
//!    而不是靠人去读一遍 `secrets.rs` 的 if 缩进。

use crate::llm_policy;

/// 文件头。**版本就编在里面**：以后要换加密形状，改这一串，旧文件一眼认不出来
/// 也不会被当成新格式读（`unwrap_payload` 会拒）。
///
/// 注意它是 15 字节，不是 8 —— 设计稿 0026 里写的 8 是"magic + 版本"估的，
/// 实际字符串比估的长。长度以这个常量为准。
pub const MAGIC: &[u8] = b"LATTICESECRET1\n";

/// 一条值的字符上限。模型 key 最长 512（`llm.rs` 拦的），PAT 一百来字符，
/// 4096 是"别把一整个文件塞进来"的意思
pub const MAX_VALUE_CHARS: usize = 4096;

/// 最多存多少条。超了**拒绝不截断** —— 静默丢一条的表现是"某个组件的 token
/// 莫名其妙失效"，而用户永远查不出来
pub const MAX_ENTRIES: usize = 256;

/// 组件给的那个名字片段的长度上限
pub const MAX_NAME_CHARS: usize = 32;

/// 组件 id 的长度上限（清单里的反向域名，`lattice.momentum` 这种十几字符）
pub const MAX_WIDGET_ID_CHARS: usize = 64;

/// 组件能用的名字：`[a-z][a-z0-9_-]{0,31}`。
///
/// 为什么限制得这么死：这个名字会被拼进键名、而键名是这一层唯一的隔离手段。
/// 允许 `.` 或大写就等于允许 `llm` 之类的花样，而隔离靠的正是"组件给的东西
/// 拼不出前缀"。字母数字加两个分隔符，够用了。
pub fn name_ok(name: &str) -> bool {
    if name.chars().count() > MAX_NAME_CHARS {
        return false;
    }
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

/// 组件 id 的形状，**和前端 `manifest.ts` 的 `ID_RE` 逐字对应**：
/// `^[a-z0-9]+(?:[.-][a-z0-9]+)+$`。
///
/// 为什么在这里再判一次而不是信宿主：`widget_id` 确实来自宿主上下文（组件
/// 递不上来），但它最终来自**磁盘上的清单文件**。一个手改过的清单可以把 id
/// 写成 `..`，而这个名字会拼进键名 —— 于是两条防线里至少这一条不能省。
pub fn widget_id_ok(id: &str) -> bool {
    if id.is_empty() || id.chars().count() > MAX_WIDGET_ID_CHARS {
        return false;
    }
    let mut separators = 0;
    let mut previous_separator = true; // 首个字符按"上一个分隔符"处理，等于要求它必须是字母数字
    for ch in id.chars() {
        if ch == '.' || ch == '-' {
            if previous_separator {
                return false; // 两个分隔符挨着，或者以分隔符开头
            }
            separators += 1;
            previous_separator = true;
            continue;
        }
        if !(ch.is_ascii_lowercase() || ch.is_ascii_digit()) {
            return false;
        }
        previous_separator = false;
    }
    // 至少一个分隔符（反向域名），且不能以分隔符结尾
    separators > 0 && !previous_separator
}

/// 组件那条键：`widget.<id>.<name>`。**前缀由平台拼，组件看不到也写不了**。
pub fn widget_key(widget_id: &str, name: &str) -> Result<String, String> {
    if !widget_id_ok(widget_id) {
        return Err(format!("invalid widget id: {widget_id}"));
    }
    if !name_ok(name) {
        return Err(
            "a secret name is 1-32 characters of a-z, 0-9, _ or -, starting with a letter"
                .to_string(),
        );
    }
    Ok(format!("widget.{widget_id}.{name}"))
}

/// 模型那条键：`llm.<profileId>`。id 的判据沿用 `llm_policy`，免得两处各认一套
pub fn llm_key(profile_id: &str) -> Result<String, String> {
    if !llm_policy::profile_id_ok(profile_id) {
        return Err("that is not a profile id".to_string());
    }
    Ok(format!("llm.{profile_id}"))
}

/// 值合不合法。**拒绝不截断**：截断之后存的是一把错的钥匙，症状是 401，
/// 而用户会以为"填对了却没生效"
pub fn check_value(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("a secret cannot be empty".to_string());
    }
    if value.chars().count() > MAX_VALUE_CHARS {
        return Err(format!(
            "that is too long for a secret ({} characters, at most {MAX_VALUE_CHARS})",
            value.chars().count()
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 文件头
// ---------------------------------------------------------------------------

/// 把密封后的字节包上文件头
pub fn wrap(blob: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(MAGIC.len() + blob.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(blob);
    out
}

/// 剥掉文件头，交出 DPAPI blob。
///
/// 三种坏情况分开报：**空文件 / 不是这个格式 / 头对了但没内容**。它们对应
/// 三种完全不同的处理（重新填一遍 / 换回原来那台机器 / 文件被截断），合成
/// 一句"读不出来"会让用户没法判断该做什么。
pub fn unwrap_payload(bytes: &[u8]) -> Result<&[u8], String> {
    if bytes.is_empty() {
        return Err("the secrets file is empty".to_string());
    }
    if bytes.len() < MAGIC.len() || &bytes[..MAGIC.len()] != MAGIC {
        return Err("this is not a Lattice secrets file".to_string());
    }
    let payload = &bytes[MAGIC.len()..];
    if payload.is_empty() {
        return Err("the secrets file has no payload".to_string());
    }
    Ok(payload)
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

/// 一份 `assistant.json` 里有多少把明文 key 该搬走，以及哪些搬不动。
///
/// `skipped` 不是"没 key"，是**有 key 但档 id 不合法**（手改坏的文件）。那种
/// 情况搬不了（拼不出 `llm.` 键），也不能清（清了就丢了），只能报出来让人看见。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MigrationPlan {
    /// `(密封库的键, 明文值)`
    pub entries: Vec<(String, String)>,
    /// 搬不动的档 id
    pub skipped: Vec<String>,
}

impl MigrationPlan {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// 从 `assistant.json` 的原文里读出迁移计划。**只判不改**。
///
/// 幂等是免费的：清掉之后字段是空串，下一次跑就是空计划 —— 所以这里只需要
/// 判"非空"。
///
/// 认两个字段名（`apiKey` 与 `api_key`）：serde 那边 `alias` 认后者，手写的
/// 配置文件常常是 snake_case。迁移只认 `apiKey` 的话，一份 snake_case 的文件
/// 会看起来"没有 key"，而它其实一直能用。
pub fn plan_migration(text: &str) -> MigrationPlan {
    let mut plan = MigrationPlan::default();
    let Ok(root) = llm_policy::parse_json(text) else {
        return plan;
    };
    let Some(profiles) = root.get("profiles").and_then(|value| value.as_arr()) else {
        return plan;
    };
    for profile in profiles {
        let id = profile.get("id").and_then(|value| value.as_str()).unwrap_or("").trim();
        let key = ["apiKey", "api_key"]
            .iter()
            .filter_map(|name| profile.get(name).and_then(|value| value.as_str()))
            .map(str::trim)
            .find(|value| !value.is_empty());
        let Some(key) = key else {
            continue;
        };
        match llm_key(id) {
            Ok(name) => plan.entries.push((name, key.to_string())),
            Err(_) => plan.skipped.push(if id.is_empty() { "(no id)" } else { id }.to_string()),
        }
    }
    plan
}

/// 迁移的三步，**顺序本身就是设计**（0026 §4）：
///
///   1. 逐条写进密封库（`seal`）
///   2. 每条都读回来比一次（`verify`）
///   3. 全部对得上，才清明文（`clear`）
///
/// 三个动作从外面注入，于是这一层不碰 DPAPI 也不碰磁盘 —— 而"第 2 条失败时
/// 明文一行不动"这条**能被单测钉死**。设计稿写的是"先写密封、再清明文、
/// 最后校验"，这里把校验提到清明文之前：校验放在后面的话，它失败时明文已经
/// 没了，而那一把 key 用户再也拿不回来。顺序改成 seal → verify → clear 之后，
/// 三个动作的**先后依赖**没变（清明文永远是最后一步），失败面却只剩"什么都没
/// 发生"。
///
/// 返回搬了几条。空计划直接 `Ok(0)`，**`clear` 一次都不会被调用**。
pub fn run_migration(
    plan: &MigrationPlan,
    mut seal: impl FnMut(&str, &str) -> Result<(), String>,
    mut verify: impl FnMut(&str, &str) -> bool,
    mut clear: impl FnMut() -> Result<(), String>,
) -> Result<usize, String> {
    if plan.entries.is_empty() {
        return Ok(0);
    }
    for (name, value) in &plan.entries {
        seal(name, value).map_err(|error| format!("could not seal {name}: {error}"))?;
    }
    for (name, value) in &plan.entries {
        if !verify(name, value) {
            return Err(format!("the sealed copy of {name} did not read back"));
        }
    }
    clear()?;
    Ok(plan.entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    // —— 名字 ——

    #[test]
    fn names_follow_the_documented_shape() {
        assert!(name_ok("github"));
        assert!(name_ok("gh_token"));
        assert!(name_ok("a"));
        assert!(name_ok("x9-b_2"));
        // 首字符必须是小写字母
        assert!(!name_ok(""));
        assert!(!name_ok("9lives"));
        assert!(!name_ok("_x"));
        // 大写、点、空格、别的标点一律不认
        assert!(!name_ok("GitHub"));
        assert!(!name_ok("llm.chat"));
        assert!(!name_ok("a b"));
        // 32 个字符是上限
        assert!(name_ok(&"a".repeat(32)));
        assert!(!name_ok(&"a".repeat(33)));
    }

    #[test]
    fn widget_ids_mirror_the_manifest_rule() {
        assert!(widget_id_ok("lattice.momentum"));
        assert!(widget_id_ok("lattice.pet"));
        assert!(widget_id_ok("a-b"));
        // 至少要一个分隔符（反向域名），且不许以它开头 / 结尾 / 连着
        assert!(!widget_id_ok("lattice"));
        assert!(!widget_id_ok(".lattice"));
        assert!(!widget_id_ok("lattice."));
        assert!(!widget_id_ok("lattice..pet"));
        // 大写、下划线、路径片段都不认
        assert!(!widget_id_ok("Lattice.pet"));
        assert!(!widget_id_ok("lattice_pet"));
        assert!(!widget_id_ok("../etc"));
        assert!(!widget_id_ok(""));
    }

    // —— 命名空间 ——

    #[test]
    fn widget_keys_are_built_by_the_platform_only() {
        assert_eq!(widget_key("lattice.related", "github").unwrap(), "widget.lattice.related.github");
        // 名字片段里带点 = 想自己拼前缀，直接拒
        assert!(widget_key("lattice.related", "llm.chat").is_err());
        // 组件的 id 坏了也拒
        assert!(widget_key("..", "github").is_err());
    }

    #[test]
    fn a_widget_can_never_reach_the_model_keys() {
        // 这条是整块设计的核心：无论组件怎么填名字，拼出来的键都以 `widget.` 开头
        let key = widget_key("lattice.related", "github").unwrap();
        assert!(key.starts_with("widget."));
        assert!(!key.starts_with("llm."));
        // 反过来说，模型那条键的 id 判据根本不给组件用（`p-` 开头的十六进制）
        assert!(llm_key("p-1e9ac1").is_ok());
        assert!(llm_key("lattice.related").is_err());
    }

    #[test]
    fn model_keys_are_namespaced_by_profile() {
        assert_eq!(llm_key("p-1e9ac1").unwrap(), "llm.p-1e9ac1");
        // 两个档各有各的键，互不覆盖
        assert_ne!(llm_key("p-1e9ac1").unwrap(), llm_key("p-2b3c4d").unwrap());
    }

    // —— 值 ——

    #[test]
    fn empty_and_oversized_values_are_rejected_not_truncated() {
        assert!(check_value("").is_err());
        assert!(check_value("   ").is_err());
        assert!(check_value("ghp_abc").is_ok());
        assert!(check_value(&"x".repeat(MAX_VALUE_CHARS)).is_ok());
        let too_long = "x".repeat(MAX_VALUE_CHARS + 1);
        // 拒绝：截断之后存进去的是一把错的钥匙，症状是 401
        assert!(check_value(&too_long).is_err());
    }

    // —— 文件头 ——

    #[test]
    fn wrap_and_unwrap_round_trip() {
        let wrapped = wrap(b"\x01\x02\x03");
        assert_eq!(&wrapped[..MAGIC.len()], MAGIC);
        assert_eq!(unwrap_payload(&wrapped).unwrap(), b"\x01\x02\x03");
    }

    #[test]
    fn three_kinds_of_damage_get_three_messages() {
        // 空文件 / 不是这个格式 / 头对了但没内容 —— 三种处理方式完全不同
        assert!(unwrap_payload(b"").unwrap_err().contains("empty"));
        assert!(unwrap_payload(b"{\"a\":1}").unwrap_err().contains("not a Lattice"));
        assert!(unwrap_payload(MAGIC).unwrap_err().contains("no payload"));
        // 短于文件头也算"不是这个格式"，不能越界读
        assert!(unwrap_payload(b"LATTICE").is_err());
    }

    // —— 迁移判定 ——

    fn config_with(profiles: &str) -> String {
        format!(r#"{{"version":4,"activeId":"p-1e9ac1","profiles":{profiles}}}"#)
    }

    #[test]
    fn migration_picks_up_plaintext_keys() {
        let text = config_with(
            r#"[{"id":"p-1e9ac1","apiKey":"sk-one"},{"id":"p-2b3c4d","apiKey":"sk-two"}]"#,
        );
        let plan = plan_migration(&text);
        assert_eq!(
            plan.entries,
            vec![
                ("llm.p-1e9ac1".to_string(), "sk-one".to_string()),
                ("llm.p-2b3c4d".to_string(), "sk-two".to_string()),
            ]
        );
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn migration_is_idempotent_because_a_cleared_field_is_empty() {
        // 迁移之后字段是空串 —— 再跑一次必须是空计划，否则每次启动都重写一遍文件
        let text = config_with(r#"[{"id":"p-1e9ac1","apiKey":""}]"#);
        let plan = plan_migration(&text);
        assert!(plan.is_empty());
        // 连 `apiKey` 这个键都没有的老文件同理
        let plan = plan_migration(&config_with(r#"[{"id":"p-1e9ac1"}]"#));
        assert!(plan.is_empty());
    }

    #[test]
    fn migration_accepts_the_snake_case_alias() {
        // serde 那边 `api_key` 是 alias，手写的配置常常就是 snake_case
        let plan = plan_migration(&config_with(r#"[{"id":"p-1e9ac1","api_key":"sk-old"}]"#));
        assert_eq!(plan.entries, vec![("llm.p-1e9ac1".to_string(), "sk-old".to_string())]);
    }

    #[test]
    fn migration_reports_what_it_cannot_move() {
        // 有 key 但 id 坏了：搬不动（拼不出 llm. 键），也不能清 —— 报出来
        let plan = plan_migration(&config_with(r#"[{"id":"nonsense","apiKey":"sk-x"}]"#));
        assert!(plan.entries.is_empty());
        assert_eq!(plan.skipped, vec!["nonsense".to_string()]);
    }

    #[test]
    fn migration_survives_broken_files() {
        // 坏 JSON / v1 平铺 / 没有 profiles：都当"没有要搬的"，不 panic
        assert!(plan_migration("{ not json").is_empty());
        assert!(plan_migration(r#"{"apiKey":"sk-v1"}"#).is_empty());
        assert!(plan_migration("{}").is_empty());
    }

    // —— 迁移的顺序 ——

    #[test]
    fn empty_plan_never_touches_the_plaintext() {
        let plan = MigrationPlan::default();
        let cleared = RefCell::new(0);
        let moved = run_migration(
            &plan,
            |_, _| panic!("不该密封任何东西"),
            |_, _| panic!("不该校验任何东西"),
            || {
                *cleared.borrow_mut() += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(moved, 0);
        assert_eq!(*cleared.borrow(), 0);
    }

    #[test]
    fn a_failed_seal_leaves_the_plaintext_alone() {
        let plan = MigrationPlan {
            entries: vec![
                ("llm.p-1e9ac1".to_string(), "sk-one".to_string()),
                ("llm.p-2b3c4d".to_string(), "sk-two".to_string()),
            ],
            skipped: Vec::new(),
        };
        let cleared = RefCell::new(0);
        let sealed = RefCell::new(Vec::new());
        let result = run_migration(
            &plan,
            |name, _| {
                if name.ends_with("p-2b3c4d") {
                    return Err("DPAPI said no".to_string());
                }
                sealed.borrow_mut().push(name.to_string());
                Ok(())
            },
            |_, _| true,
            || {
                *cleared.borrow_mut() += 1;
                Ok(())
            },
        );
        assert!(result.unwrap_err().contains("p-2b3c4d"));
        // 第一条密封成功了，但明文**一行都没清** —— 下次启动重来一遍即可
        assert_eq!(sealed.borrow().len(), 1);
        assert_eq!(*cleared.borrow(), 0);
    }

    #[test]
    fn a_seal_that_does_not_read_back_leaves_the_plaintext_alone() {
        // 写成功了、读回来却是别的值（编码不一致的经典症状）。这时候清明文
        // 等于把 key 弄丢，所以必须停在校验这一步
        let plan = MigrationPlan {
            entries: vec![("llm.p-1e9ac1".to_string(), "sk-one".to_string())],
            skipped: Vec::new(),
        };
        let cleared = RefCell::new(0);
        let result = run_migration(
            &plan,
            |_, _| Ok(()),
            |_, _| false,
            || {
                *cleared.borrow_mut() += 1;
                Ok(())
            },
        );
        assert!(result.unwrap_err().contains("did not read back"));
        assert_eq!(*cleared.borrow(), 0);
    }

    #[test]
    fn a_successful_migration_seals_verifies_then_clears() {
        let plan = MigrationPlan {
            entries: vec![("llm.p-1e9ac1".to_string(), "sk-one".to_string())],
            skipped: Vec::new(),
        };
        let steps = RefCell::new(Vec::new());
        let moved = run_migration(
            &plan,
            |_, _| {
                steps.borrow_mut().push("seal");
                Ok(())
            },
            |_, _| {
                steps.borrow_mut().push("verify");
                true
            },
            || {
                steps.borrow_mut().push("clear");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(moved, 1);
        // 顺序钉死：清明文永远是最后一步
        assert_eq!(*steps.borrow(), vec!["seal", "verify", "clear"]);
    }
}
