//! `llm.rs` 里能脱离运行时单测的那部分：上限、裁剪、失败文案。
//!
//! 和 `agent_policy` / `metrics_policy` 一样，这里**不碰**网络、线程、Tauri、
//! serde —— 所以能用 `rustc --test` 单独跑（本机的 `cargo test` 被策略挡着）。
//! 脏活（DPAPI、HTTP、节流）留在 `llm.rs`。
//!
//! 为什么上限要在这里而不是只写在 `llm.rs`：这些数字**前端也抄了一份**
//! （`bridge.ts` 的 `MAX_LLM_MESSAGES` / `MAX_LLM_MESSAGE_CHARS`）。两边各写各的
//! 时候很容易漂 —— 前端放行、后端拒，症状是"组件里报了个没人看得懂的红字"。
//! 现在前端那几条断言（`tests/llm.html`）和后端这几条（`tests` 模块）比的是
//! 同一组数字，漂了就会红。

/// 一次对话最多几条。系统提示词也算在里面。
pub const MAX_MESSAGES: usize = 12;

/// 单条消息最多几个字符。**按码点算**（`chars()`），不是字节也不是 UTF-16 单元：
/// 前端用 `[...content].length`，对 emoji 和汉字都是同一个数。
pub const MAX_MESSAGE_CHARS: usize = 4_000;

/// 整段对话合计上限。超了拒绝，不截断 —— 截断等于替用户决定哪句不重要。
pub const MAX_TOTAL_CHARS: usize = 12_000;

/// 回复上限。桌宠的气泡放不下长回复，也顺手挡了"把余额刷空"。
pub const MAX_TOKENS: u32 = 300;

/// 两次请求之间至少隔这么久。
pub const MIN_INTERVAL_MS: u64 = 700;

pub const DEFAULT_MODEL: &str = "deepseek-chat";

/// 只认这两个；用户换模型走设置，组件换不了。
pub const ALLOWED_MODELS: [&str; 2] = ["deepseek-chat", "deepseek-reasoner"];

/// 失败文案里引用服务端原话的长度上限。原话可能是几 KB 的 HTML 错误页。
pub const MAX_DETAIL_CHARS: usize = 200;

pub fn is_allowed_model(model: &str) -> bool {
    ALLOWED_MODELS.contains(&model)
}

/// 角色只认这三个。别放行 `tool` / `function`：那是另一套协议（要带
/// `tool_calls` 结构），组件按普通消息塞进来只会让服务端回 400。
pub fn parse_role(value: &str) -> Option<&'static str> {
    match value {
        "system" => Some("system"),
        "user" => Some("user"),
        "assistant" => Some("assistant"),
        _ => None,
    }
}

/// 裁掉首尾空白。空白消息直接丢掉（不是错误）：桌宠按了回车但没打字，
/// 这不该变成一个红字气泡。
pub fn trimmed(value: &str) -> &str {
    value.trim()
}

/// 单条长度检查。**拒绝，不截断** —— 前端也是拒绝，两边必须是同一个行为。
pub fn check_message_chars(content: &str) -> Result<(), String> {
    if content.chars().count() > MAX_MESSAGE_CHARS {
        return Err(format!("a single message may be at most {MAX_MESSAGE_CHARS} characters"));
    }
    Ok(())
}

/// 合计长度检查。
pub fn check_total_chars(total: usize) -> Result<(), String> {
    if total > MAX_TOTAL_CHARS {
        return Err(format!("the conversation is longer than {MAX_TOTAL_CHARS} characters"));
    }
    Ok(())
}

/// 把服务端的原话裁到 `MAX_DETAIL_CHARS`，按码点裁（别把中文切成半个字）。
pub fn clip_detail(body: &str) -> String {
    body.chars().take(MAX_DETAIL_CHARS).collect()
}

/// 状态码 + 服务端原话 → 一句人能读的话。
///
/// 401 单独说清楚：那是最常见的一类失败，而"你的 key 不对"和"网络不通"
/// 在界面上的下一步动作完全不同。401 不带原话 —— 服务端那句
/// `Authentication Fails, Your api key is invalid` 里什么新信息都没有，
/// 只会把气泡撑长。
pub fn failure_message(status: u16, detail: &str) -> String {
    match status {
        401 => "the API key was rejected (401) — check it in Settings".to_string(),
        402 => format!("the account is out of balance (402): {detail}"),
        429 => format!("rate limited by the provider (429): {detail}"),
        400..=499 => format!("the provider rejected the request ({status}): {detail}"),
        500..=599 => format!("the provider is having trouble ({status}): {detail}"),
        _ => format!("the request failed ({status}): {detail}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 上限 ----

    #[test]
    fn limits_are_the_numbers_the_frontend_also_uses() {
        // 这几个数字前端（src/runtime/bridge.ts）抄了一份，tests/llm.html 钉着那边。
        // 改这里就得同时改那边，否则"前端放行、后端拒"。
        assert_eq!(MAX_MESSAGES, 12);
        assert_eq!(MAX_MESSAGE_CHARS, 4_000);
        assert_eq!(MAX_TOTAL_CHARS, 12_000);
        assert_eq!(MAX_TOKENS, 300);
        assert_eq!(MIN_INTERVAL_MS, 700);
    }

    #[test]
    fn message_limit_counts_characters_not_bytes() {
        // 4000 个汉字是 12000 字节，按字节判会误拒
        assert!(check_message_chars(&"字".repeat(MAX_MESSAGE_CHARS)).is_ok());
        assert!(check_message_chars(&"字".repeat(MAX_MESSAGE_CHARS + 1)).is_err());
    }

    #[test]
    fn emoji_count_as_one_character() {
        // 前端用 [...content].length，一个 emoji 是 1；Rust 的 chars() 也是 1。
        // 用 .len() 的话这里是 4 字节，两边就漂了
        assert!(check_message_chars(&"🐟".repeat(MAX_MESSAGE_CHARS)).is_ok());
        assert!(check_message_chars(&"🐟".repeat(MAX_MESSAGE_CHARS + 1)).is_err());
    }

    #[test]
    fn long_message_is_refused_not_truncated() {
        let long = "a".repeat(MAX_MESSAGE_CHARS + 1);
        assert_eq!(
            check_message_chars(&long),
            Err("a single message may be at most 4000 characters".to_string())
        );
    }

    #[test]
    fn total_limit_is_inclusive() {
        assert!(check_total_chars(MAX_TOTAL_CHARS).is_ok());
        assert!(check_total_chars(MAX_TOTAL_CHARS + 1).is_err());
    }

    // ---- 角色 / 裁剪 ----

    #[test]
    fn only_the_three_chat_roles_pass() {
        assert_eq!(parse_role("system"), Some("system"));
        assert_eq!(parse_role("user"), Some("user"));
        assert_eq!(parse_role("assistant"), Some("assistant"));
        // 这两类是另一套协议，塞进来只会换来服务端 400
        assert_eq!(parse_role("tool"), None);
        assert_eq!(parse_role("function"), None);
        assert_eq!(parse_role("System"), None);
    }

    #[test]
    fn whitespace_only_content_disappears() {
        assert_eq!(trimmed("  hi  "), "hi");
        assert_eq!(trimmed("   \n\t "), "");
    }

    // ---- 模型 ----

    #[test]
    fn only_two_models_are_allowed() {
        assert!(is_allowed_model("deepseek-chat"));
        assert!(is_allowed_model("deepseek-reasoner"));
        assert!(!is_allowed_model("gpt-4o"));
        assert!(!is_allowed_model("deepseek-chat "));
    }

    // ---- 失败文案 ----

    #[test]
    fn unauthorized_says_what_to_do_next() {
        // 401 不引用服务端原话：那句话里没有新信息，只会把气泡撑长
        assert_eq!(
            failure_message(401, "Authentication Fails, Your api key is invalid"),
            "the API key was rejected (401) — check it in Settings"
        );
    }

    #[test]
    fn balance_and_rate_limit_keep_the_provider_wording() {
        assert_eq!(
            failure_message(402, "Insufficient Balance"),
            "the account is out of balance (402): Insufficient Balance"
        );
        assert_eq!(
            failure_message(429, "Rate limit reached"),
            "rate limited by the provider (429): Rate limit reached"
        );
    }

    #[test]
    fn other_codes_fall_into_three_buckets() {
        assert_eq!(
            failure_message(400, "bad model"),
            "the provider rejected the request (400): bad model"
        );
        assert_eq!(
            failure_message(503, "upstream"),
            "the provider is having trouble (503): upstream"
        );
        assert_eq!(
            failure_message(302, "moved"),
            "the request failed (302): moved"
        );
    }

    #[test]
    fn detail_is_clipped_by_characters() {
        // 错误页可能是几 KB 的 HTML；按字节裁会把最后一个汉字切坏
        let long = "错".repeat(500);
        let clipped = clip_detail(&long);
        assert_eq!(clipped.chars().count(), MAX_DETAIL_CHARS);
        assert_eq!(clip_detail("short"), "short");
    }
}
