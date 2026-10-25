//! 内置 assistant 的**纯逻辑**：地址归一化、请求体、响应解析、错误翻译、上限。
//!
//! # 为什么这里连 serde 都不用
//!
//! 和 `network_policy.rs` / `agent_policy.rs` 同一条规矩：纯逻辑要能用一个
//! `rustc --test` 的壳子跑起来（这台机器的安全策略不让 `cargo test` 往
//! `target/debug/deps` 写新 exe）。`rustc --test` 认不到外部 crate，所以这一层
//! 自己带一个够用的 JSON 读取器 —— 它只解析**供应商的响应**和**统计消息长度**。
//!
//! 序列化那一半（请求体）是字符串拼接 + 一次转义，也放在这一层：它同样是
//! "协议怎么长"的知识，该和解析一起被测试钉住。

/// 一次请求最多带多少条消息
pub const MAX_MESSAGES: usize = 60;
/// 单条消息最多多少字符
pub const MAX_MESSAGE_CHARS: usize = 12_000;
/// 全部消息加起来的字符上限
pub const MAX_TOTAL_CHARS: usize = 60_000;
/// 工具循环最多几轮（前端也拦一次，这里是后端兜底）
pub const MAX_TOOL_STEPS: usize = 8;
/// 输出 token 上限（"这次最多说多少"，不是上下文窗口）
pub const MAX_OUTPUT_TOKENS: u32 = 2048;
/// 响应体上限。一次 chat 的 JSON 正常几 KB，超过这个数一定不对劲
pub const MAX_RESPONSE_BYTES: usize = 512 * 1024;
/// 错误信息里带多少字符的原始响应
const ERROR_SNIPPET: usize = 240;
/// 工具数量上限。白名单只有八个，这个数是挡畸形输入的
const MAX_TOOLS: usize = 32;

// ---------------------------------------------------------------------------
// base URL
// ---------------------------------------------------------------------------

/// 归一化用户填的 base URL。
///
/// 用户会填成这几种样子，全都得认：
///   - `api.deepseek.com`            （少了协议头）
///   - `https://api.deepseek.com/`   （多了斜杠）
///   - `https://api.deepseek.com/v1`
///   - `https://api.deepseek.com/chat/completions`（整个端点贴进来）
///
/// 只放 http/https。**明文 http 只给本机**（Ollama / LM Studio 就住在
/// `127.0.0.1:11434`）：key 明文发到外网等于贴在明信片上，这一步拦不住的话，
/// 后面所有的权限设计都白做。
pub fn normalize_base(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("the API base URL is empty".to_string());
    }

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let lower = with_scheme.to_ascii_lowercase();
    let secure = lower.starts_with("https://");
    if !secure && !lower.starts_with("http://") {
        return Err("only http:// and https:// base URLs are supported".to_string());
    }

    let mut base = with_scheme.trim_end_matches('/').to_string();

    // 用户把完整端点贴进来了：剥掉尾巴，只留 base
    for suffix in ["/chat/completions", "/completions", "/models"] {
        if base.to_ascii_lowercase().ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            base = base.trim_end_matches('/').to_string();
            break;
        }
    }

    if base.is_empty() {
        return Err("the API base URL has no host".to_string());
    }

    let host = host_of(&base);
    if host.is_empty() {
        return Err("the API base URL has no host".to_string());
    }

    if !secure && !is_loopback(&host) {
        return Err(format!(
            "plain http is only allowed for localhost (got \"{host}\") — use https, or point at a local model on 127.0.0.1"
        ));
    }

    Ok(base)
}

/// 从 base URL 里取出主机名。
///
/// 三种形状都要对：普通 `host:port`、带账号的 `user:pass@host`、以及 IPv6 的
/// `[::1]:8080` —— 最后这种按冒号切会切成 `[`，于是"本机 Ollama"被判成远程，
/// 用户看到的是"明文 http 只允许本机"，而地址明明就是本机。
fn host_of(base: &str) -> String {
    let rest = base.split_once("://").map(|(_, tail)| tail).unwrap_or("");
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if let Some(inner) = authority.strip_prefix('[') {
        return inner.split(']').next().unwrap_or("").to_string();
    }
    let authority = authority.rsplit_once('@').map(|(_, host)| host).unwrap_or(authority);
    authority.split(':').next().unwrap_or("").to_string()
}

/// 本机地址。`[::1]` 也认 —— Windows 上 Ollama 有时就绑在 v6 上
pub fn is_loopback(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.eq_ignore_ascii_case("localhost")
        || bare == "127.0.0.1"
        || bare.starts_with("127.")
        || bare == "::1"
}

pub fn chat_url(base: &str) -> String {
    format!("{base}/chat/completions")
}

pub fn models_url(base: &str) -> String {
    format!("{base}/models")
}

/// 界面上显示的 key 提示。**永远不回完整 key**：它一旦进了前端状态，
/// 就会跟着调试面板、截图、某次 `JSON.stringify` 一起外泄
pub fn mask_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 8 {
        return "••••".to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

// ---------------------------------------------------------------------------
// 一个够用的 JSON 读取器
// ---------------------------------------------------------------------------

/// 只读不写。够解析 OpenAI 兼容的响应：对象 / 数组 / 字符串 / 数字 / 布尔 / null
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_num(&self) -> Option<f64> {
        match self {
            Json::Num(value) => Some(*value),
            _ => None,
        }
    }

    /// 把一段 JSON 重新写出来。工具参数有时是对象（而不是协议要求的字符串），
    /// 那时要把它转回字符串交回模型
    pub fn to_text(&self) -> String {
        match self {
            Json::Null => "null".to_string(),
            Json::Bool(value) => value.to_string(),
            Json::Num(value) => {
                if value.fract() == 0.0 && value.abs() < 1e15 {
                    format!("{}", *value as i64)
                } else {
                    format!("{value}")
                }
            }
            Json::Str(text) => format!("\"{}\"", escape(text)),
            Json::Arr(items) => {
                let inner: Vec<String> = items.iter().map(Json::to_text).collect();
                format!("[{}]", inner.join(","))
            }
            Json::Obj(entries) => {
                let inner: Vec<String> = entries
                    .iter()
                    .map(|(name, value)| format!("\"{}\":{}", escape(name), value.to_text()))
                    .collect();
                format!("{{{}}}", inner.join(","))
            }
        }
    }
}

/// 转义成 JSON 字符串内部的样子（不含外层引号）
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out
}

/// 递归深度上限：一个 1MB 的 `[[[[[…` 不该把这台机器弄崩
const MAX_DEPTH: usize = 32;

pub fn parse_json(text: &str) -> Result<Json, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut at = 0usize;
    let value = parse_value(&chars, &mut at, 0)?;
    skip_space(&chars, &mut at);
    if at < chars.len() {
        return Err(format!("unexpected trailing JSON at character {at}"));
    }
    Ok(value)
}

fn skip_space(chars: &[char], at: &mut usize) {
    while *at < chars.len() && matches!(chars[*at], ' ' | '\t' | '\r' | '\n') {
        *at += 1;
    }
}

fn expect(chars: &[char], at: &mut usize, want: char) -> Result<(), String> {
    skip_space(chars, at);
    if chars.get(*at) == Some(&want) {
        *at += 1;
        Ok(())
    } else {
        Err(format!("expected '{want}' at character {at}"))
    }
}

fn parse_value(chars: &[char], at: &mut usize, depth: usize) -> Result<Json, String> {
    if depth > MAX_DEPTH {
        return Err("the JSON is nested too deeply".to_string());
    }
    skip_space(chars, at);
    match chars.get(*at) {
        Some('{') => {
            *at += 1;
            let mut entries = Vec::new();
            skip_space(chars, at);
            if chars.get(*at) == Some(&'}') {
                *at += 1;
                return Ok(Json::Obj(entries));
            }
            loop {
                skip_space(chars, at);
                let key = match parse_value(chars, at, depth + 1)? {
                    Json::Str(text) => text,
                    _ => return Err(format!("an object key must be a string (character {at})")),
                };
                expect(chars, at, ':')?;
                let value = parse_value(chars, at, depth + 1)?;
                entries.push((key, value));
                skip_space(chars, at);
                match chars.get(*at) {
                    Some(',') => {
                        *at += 1;
                    }
                    Some('}') => {
                        *at += 1;
                        break;
                    }
                    _ => return Err(format!("expected ',' or '}}' at character {at}")),
                }
            }
            Ok(Json::Obj(entries))
        }
        Some('[') => {
            *at += 1;
            let mut items = Vec::new();
            skip_space(chars, at);
            if chars.get(*at) == Some(&']') {
                *at += 1;
                return Ok(Json::Arr(items));
            }
            loop {
                items.push(parse_value(chars, at, depth + 1)?);
                skip_space(chars, at);
                match chars.get(*at) {
                    Some(',') => {
                        *at += 1;
                    }
                    Some(']') => {
                        *at += 1;
                        break;
                    }
                    _ => return Err(format!("expected ',' or ']' at character {at}")),
                }
            }
            Ok(Json::Arr(items))
        }
        Some('"') => Ok(Json::Str(parse_string(chars, at)?)),
        Some('t') if chars[*at..].starts_with(&['t', 'r', 'u', 'e']) => {
            *at += 4;
            Ok(Json::Bool(true))
        }
        Some('f') if chars[*at..].starts_with(&['f', 'a', 'l', 's', 'e']) => {
            *at += 5;
            Ok(Json::Bool(false))
        }
        Some('n') if chars[*at..].starts_with(&['n', 'u', 'l', 'l']) => {
            *at += 4;
            Ok(Json::Null)
        }
        Some(ch) if *ch == '-' || ch.is_ascii_digit() => {
            let start = *at;
            if chars[*at] == '-' {
                *at += 1;
            }
            while *at < chars.len()
                && (chars[*at].is_ascii_digit() || matches!(chars[*at], '.' | 'e' | 'E' | '+' | '-'))
            {
                *at += 1;
            }
            let slice: String = chars[start..*at].iter().collect();
            slice
                .parse::<f64>()
                .map(Json::Num)
                .map_err(|_| format!("not a number: {slice}"))
        }
        _ => Err(format!("unexpected JSON at character {at}")),
    }
}

fn parse_string(chars: &[char], at: &mut usize) -> Result<String, String> {
    // 进到这里时 chars[*at] == '"'
    *at += 1;
    let mut out = String::new();
    loop {
        let Some(ch) = chars.get(*at).copied() else {
            return Err("the JSON string never ends".to_string());
        };
        *at += 1;
        match ch {
            '"' => return Ok(out),
            '\\' => {
                let Some(escaped) = chars.get(*at).copied() else {
                    return Err("the JSON string ends inside an escape".to_string());
                };
                *at += 1;
                match escaped {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    '/' => out.push('/'),
                    'b' => out.push('\u{8}'),
                    'f' => out.push('\u{c}'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'u' => {
                        let mut code = 0u32;
                        for _ in 0..4 {
                            let Some(digit) = chars.get(*at).and_then(|c| c.to_digit(16)) else {
                                return Err("a \\u escape needs four hex digits".to_string());
                            };
                            code = code * 16 + digit;
                            *at += 1;
                        }
                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    }
                    other => return Err(format!("unknown escape \\{other}")),
                }
            }
            ch => out.push(ch),
        }
    }
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

/// 拼请求体。
///
/// `messages_json` / `tools_json` 是调用方传来的原始 JSON **文本** —— 这一层
/// 不重新序列化它们（那等于把用户的历史过一遍我们的解析器，白白多一处能出错
/// 的地方）。`tools` 为空或空数组时**整个字段都不出现**：有的供应商见到空数组
/// 会直接 400。
pub fn build_body(
    model: &str,
    messages_json: &str,
    tools_json: Option<&str>,
    temperature: f64,
    max_tokens: u32,
) -> String {
    let mut body = format!(
        "{{\"model\":\"{}\",\"messages\":{},\"temperature\":{},\"max_tokens\":{},\"stream\":false",
        escape(model.trim()),
        messages_json.trim(),
        clamp_temperature(temperature),
        max_tokens,
    );
    if let Some(tools) = tools_json {
        let trimmed = tools.trim();
        if !trimmed.is_empty() && trimmed != "[]" {
            body.push_str(&format!(",\"tools\":{trimmed},\"tool_choice\":\"auto\""));
        }
    }
    body.push('}');
    body
}

fn clamp_temperature(value: f64) -> String {
    let clamped = if value.is_finite() { value.clamp(0.0, 2.0) } else { 0.6 };
    // 两位小数就够，也避免 0.30000000000000004 这种串进请求体
    format!("{clamped:.2}")
}

/// 消息体检。超了就**拒绝并说清楚**，不静默截断 —— 悄悄砍掉历史会让模型
/// 在"我不记得刚才说过什么"的状态下自信地回答。
pub fn check_messages(messages_json: &str) -> Result<(), String> {
    let value = parse_json(messages_json)?;
    let list = value
        .as_arr()
        .ok_or_else(|| "\"messages\" must be an array".to_string())?;
    if list.is_empty() {
        return Err("\"messages\" is empty".to_string());
    }
    if list.len() > MAX_MESSAGES {
        return Err(format!(
            "the conversation has {} messages, which is more than the {MAX_MESSAGES} this platform sends",
            list.len()
        ));
    }
    let mut total = 0usize;
    for (index, message) in list.iter().enumerate() {
        let role = message.get("role").and_then(Json::as_str).unwrap_or("");
        if !matches!(role, "system" | "user" | "assistant" | "tool") {
            return Err(format!("message {index} has an unknown role \"{role}\""));
        }
        let chars = message
            .get("content")
            .and_then(Json::as_str)
            .map(|text| text.chars().count())
            .unwrap_or(0);
        if chars > MAX_MESSAGE_CHARS {
            return Err(format!("message {index} is longer than {MAX_MESSAGE_CHARS} characters"));
        }
        total += chars;
    }
    if total > MAX_TOTAL_CHARS {
        return Err(format!(
            "the conversation is {total} characters, which is more than the {MAX_TOTAL_CHARS} this platform sends"
        ));
    }
    Ok(())
}

/// 工具数组的体检：必须是数组、不超过 32 个。
/// **名字对不对不在这里判** —— 那是 `AGENT_ACTIONS` 和执行器的事（都有测试）。
pub fn check_tools(tools_json: &str) -> Result<(), String> {
    let value = parse_json(tools_json)?;
    let list = value
        .as_arr()
        .ok_or_else(|| "\"tools\" must be an array".to_string())?;
    if list.len() > MAX_TOOLS {
        return Err(format!("too many tools (max {MAX_TOOLS})"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/// 一条工具调用。`arguments` 保持**字符串**（协议如此）；供应商给对象时
/// 解析阶段就把它写成字符串，前端只处理一种形状。
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatReply {
    /// 说了什么。只调用工具时是空串
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    /// `stop` / `tool_calls` / `length` / …
    pub finish: String,
    pub usage: Option<Usage>,
}

pub fn parse_chat(body: &str) -> Result<ChatReply, String> {
    let value = parse_json(body).map_err(|error| format!("the provider did not return JSON: {error}"))?;

    // 有的供应商在 200 里塞 error（兼容层尤其常见）
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Json::as_str)
            .unwrap_or("the provider reported an error");
        return Err(message.to_string());
    }

    let choice = value
        .get("choices")
        .and_then(Json::as_arr)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "the response has no choices".to_string())?;

    let message = choice
        .get("message")
        .ok_or_else(|| "the response has no message".to_string())?;

    let text = match message.get("content") {
        Some(Json::Str(text)) => text.clone(),
        // 只调工具时是 null；有的供应商给的是数组（多段内容）
        Some(Json::Arr(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Json::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };

    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(Json::as_arr) {
        for (index, call) in calls.iter().enumerate() {
            let function = call.get("function");
            let name = function
                .and_then(|f| f.get("name"))
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            let arguments = match function.and_then(|f| f.get("arguments")) {
                Some(Json::Str(text)) => text.clone(),
                Some(other) => other.to_text(),
                None => "{}".to_string(),
            };
            let id = call
                .get("id")
                .and_then(Json::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{index}"));
            tool_calls.push(ToolCall { id, name, arguments });
        }
    }

    let finish = choice
        .get("finish_reason")
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();

    let usage = value.get("usage").map(|usage| Usage {
        prompt_tokens: usage
            .get("prompt_tokens")
            .and_then(Json::as_num)
            .unwrap_or(0.0) as u64,
        completion_tokens: usage
            .get("completion_tokens")
            .and_then(Json::as_num)
            .unwrap_or(0.0) as u64,
    });

    Ok(ChatReply {
        text,
        tool_calls,
        finish,
        usage,
    })
}

/// 解析 `GET /models`。只回 id 列表
pub fn parse_models(body: &str) -> Result<Vec<String>, String> {
    let value = parse_json(body).map_err(|error| format!("the provider did not return JSON: {error}"))?;
    let data = value
        .get("data")
        .and_then(Json::as_arr)
        .ok_or_else(|| "the response has no \"data\" list".to_string())?;

    let mut out: Vec<String> = Vec::new();
    for item in data {
        let id = match item.get("id").and_then(Json::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            // Ollama 的兼容层给的是 `name`
            _ => match item.get("name").and_then(Json::as_str) {
                Some(name) if !name.is_empty() => name.to_string(),
                _ => continue,
            },
        };
        if !out.contains(&id) {
            out.push(id);
        }
    }
    if out.is_empty() {
        return Err("the provider returned no models".to_string());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 人话
// ---------------------------------------------------------------------------

/// HTTP 状态码 → 人话。
///
/// 这一层的价值在于**别把 401 说成"连不上"**：用户看到"检查你的网络"会去
/// 重启路由器，而真正要做的是换一把 key。
pub fn describe_status(status: u16, body: &str) -> String {
    let snippet = body_snippet(body);
    let detail = if snippet.is_empty() {
        String::new()
    } else {
        format!(" — {snippet}")
    };
    match status {
        401 | 403 => format!(
            "the provider rejected the API key (HTTP {status}){detail}. Check the key in Assistant settings"
        ),
        404 => format!(
            "the endpoint was not found (HTTP 404){detail}. The base URL is usually https://api.<name>.com/v1"
        ),
        413 => format!("the request was too large (HTTP 413){detail}"),
        429 => format!("the provider is rate limiting or out of quota (HTTP 429){detail}"),
        400..=499 => format!("the provider rejected the request (HTTP {status}){detail}"),
        500..=599 => format!("the provider returned an error (HTTP {status}){detail}"),
        _ => format!("unexpected HTTP status {status}{detail}"),
    }
}

/// 网络层失败 → 人话。`send()` 给的是 Win32 错误码，直接甩给用户等于没说
pub fn describe_failure(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("connecting to the host") || lower.contains("12029") || lower.contains("12007") {
        return "could not reach the provider — check the base URL and your connection".to_string();
    }
    if lower.contains("12044") || lower.contains("12045") || lower.contains("12175") {
        return "the TLS handshake failed (a proxy or a certificate problem)".to_string();
    }
    if lower.contains("12002") || lower.contains("timeout") {
        return "the provider did not answer in time".to_string();
    }
    format!("the request could not be sent: {error}")
}

fn body_snippet(body: &str) -> String {
    let text = body.trim();
    if text.is_empty() {
        return String::new();
    }
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let clipped: String = one_line.chars().take(ERROR_SNIPPET).collect();
    if clipped.chars().count() < one_line.chars().count() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

// ---------------------------------------------------------------------------
// 档 / 鉴权
// ---------------------------------------------------------------------------

/// 鉴权形状归一化。和 TS 的 `normalizeAuth` 同一套别名 —— 两边不一致的症状是
/// "界面说这一档不要 key，发请求时又挂了个空 Bearer"，provider 回 401。
pub fn normalize_auth(raw: &str) -> &'static str {
    let value = raw.trim().to_ascii_lowercase().replace('_', "-");
    match value.as_str() {
        "none" | "no-key" => "none",
        "api-key-header" | "apikey" | "api-key" => "api-key-header",
        _ => "bearer",
    }
}

/// 这一档要挂的头。`none` 什么都不挂 —— 本机模型（Ollama / LM Studio）常常不要 key，
/// 而"空字符串的 Bearer"不是一个合法的鉴权，只会换来 401。
pub fn auth_header(auth: &str, key: &str) -> Option<(&'static str, String)> {
    let key = key.trim();
    match normalize_auth(auth) {
        "none" => None,
        "api-key-header" => Some(("api-key", key.to_string())),
        _ => Some(("authorization", format!("Bearer {key}"))),
    }
}

/// 一档的默认名字：主机名（去掉 `www.`）。本机地址叫 "Local model" —— 用户
/// 在列表里认得出那是自己机器上的模型，而不是又一个云端账号。
pub fn profile_label(base: &str) -> String {
    let host = host_of(base);
    if host.is_empty() {
        return String::new();
    }
    if is_loopback(&host) {
        return "Local model".to_string();
    }
    host.trim_start_matches("www.").to_string()
}

/// 新建一档的 id。时间戳（毫秒）+ 序号：够唯一，也不带任何用户信息。
pub fn profile_id(seed: u64, serial: u32) -> String {
    format!("p-{seed:x}-{serial:x}")
}

/// id 规则：`p-` 开头，后面只许小写十六进制 / 数字 / 短横线。
/// 命令收前端来的 id 时要过这一道（它会拼进 JSON 的键和日志）。
pub fn profile_id_ok(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("p-") else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 40
        && rest.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_forgiving_about_what_people_paste() {
        assert_eq!(
            normalize_base("api.deepseek.com").unwrap(),
            "https://api.deepseek.com"
        );
        assert_eq!(
            normalize_base("  https://api.deepseek.com/  ").unwrap(),
            "https://api.deepseek.com"
        );
        assert_eq!(
            normalize_base("https://api.deepseek.com/v1").unwrap(),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            normalize_base("https://api.deepseek.com/v1/chat/completions").unwrap(),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            normalize_base("https://api.openai.com/v1/models").unwrap(),
            "https://api.openai.com/v1"
        );
    }

    #[test]
    fn plain_http_only_for_local_models() {
        assert_eq!(
            normalize_base("http://127.0.0.1:11434/v1").unwrap(),
            "http://127.0.0.1:11434/v1"
        );
        assert!(normalize_base("http://localhost:1234/v1").is_ok());
        assert!(normalize_base("http://[::1]:8080/v1").is_ok());
        let remote = normalize_base("http://api.example.com/v1").unwrap_err();
        assert!(remote.contains("localhost"), "{remote}");
    }

    #[test]
    fn endpoints_are_the_base_plus_the_path() {
        assert_eq!(
            chat_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            models_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/models"
        );
    }

    #[test]
    fn empty_and_weird_bases_are_rejected() {
        assert!(normalize_base("").is_err());
        assert!(normalize_base("   ").is_err());
        assert!(normalize_base("ftp://api.example.com").is_err());
        assert!(normalize_base("https:///v1").is_err());
    }

    #[test]
    fn key_mask_never_leaks_the_middle() {
        assert_eq!(mask_key("sk-1234567890abcdef"), "sk-1…cdef");
        assert_eq!(mask_key("short"), "••••");
        assert_eq!(mask_key("  "), "");
    }

    #[test]
    fn the_json_reader_handles_the_real_shapes() {
        let value = parse_json(r#"{"a":[1,2.5,true,false,null],"b":{"c":"x"},"d":-3}"#).unwrap();
        assert_eq!(value.get("a").and_then(Json::as_arr).unwrap().len(), 5);
        assert_eq!(
            value.get("b").and_then(|b| b.get("c")).and_then(Json::as_str),
            Some("x")
        );
        assert_eq!(value.get("d").and_then(Json::as_num), Some(-3.0));
        // 再写出来必须还是合法 JSON（工具参数要经过这一手交给前端）
        assert!(parse_json(&value.to_text()).is_ok());
    }

    #[test]
    fn the_json_reader_unescapes_strings() {
        let value = parse_json(r#"{"s":"a\"b\\c\nd\u00e9"}"#).unwrap();
        assert_eq!(value.get("s").and_then(Json::as_str), Some("a\"b\\c\ndé"));
    }

    #[test]
    fn broken_json_is_an_error_not_a_panic() {
        assert!(parse_json("{").is_err());
        assert!(parse_json("{\"a\":}").is_err());
        assert!(parse_json("[1,]").is_err());
        assert!(parse_json("{} extra").is_err());
        let deep = format!("{}1{}", "[".repeat(64), "]".repeat(64));
        assert!(parse_json(&deep).is_err());
    }

    #[test]
    fn a_reply_with_content_only() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"你好呀"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#;
        let reply = parse_chat(body).unwrap();
        assert_eq!(reply.text, "你好呀");
        assert!(reply.tool_calls.is_empty());
        assert_eq!(reply.finish, "stop");
        assert_eq!(reply.usage.unwrap().completion_tokens, 3);
    }

    #[test]
    fn a_reply_with_tool_calls_and_null_content() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
            {"id":"call_1","type":"function","function":{"name":"placement.move","arguments":"{\"instanceId\":\"a\",\"x\":1}"}}
        ]},"finish_reason":"tool_calls"}]}"#;
        let reply = parse_chat(body).unwrap();
        assert_eq!(reply.text, "");
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].name, "placement.move");
        assert!(reply.tool_calls[0].arguments.contains("instanceId"));
        assert_eq!(reply.finish, "tool_calls");
    }

    #[test]
    fn arguments_given_as_an_object_still_parse() {
        let body = r#"{"choices":[{"message":{"content":"","tool_calls":[{"function":{"name":"theme.set","arguments":{"theme":"dark"}}}]},"finish_reason":"tool_calls"}]}"#;
        let reply = parse_chat(body).unwrap();
        assert_eq!(reply.tool_calls[0].arguments, "{\"theme\":\"dark\"}");
        // 没有 id 时补一个：前端要靠它对上工具结果
        assert!(!reply.tool_calls[0].id.is_empty());
    }

    #[test]
    fn multi_part_content_is_joined() {
        let body = r#"{"choices":[{"message":{"content":[{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]},"finish_reason":"stop"}]}"#;
        assert_eq!(parse_chat(body).unwrap().text, "第一段第二段");
    }

    #[test]
    fn errors_hide_in_200_and_are_lifted() {
        let body = r#"{"error":{"message":"model not found","type":"invalid_request_error"}}"#;
        let error = parse_chat(body).unwrap_err();
        assert!(error.contains("model not found"), "{error}");
    }

    #[test]
    fn junk_is_not_json() {
        assert!(parse_chat("<html>502</html>").is_err());
        assert!(parse_chat("{}").is_err());
        assert!(parse_chat(r#"{"choices":[]}"#).is_err());
    }

    #[test]
    fn models_parse_two_shapes() {
        assert_eq!(
            parse_models(r#"{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}"#).unwrap(),
            vec!["deepseek-chat", "deepseek-reasoner"]
        );
        assert_eq!(
            parse_models(r#"{"data":[{"name":"llama3.1:8b"}]}"#).unwrap(),
            vec!["llama3.1:8b"]
        );
        assert!(parse_models(r#"{"data":[]}"#).is_err());
    }

    #[test]
    fn body_has_no_tools_key_when_there_are_none() {
        let messages = r#"[{"role":"user","content":"hi"}]"#;
        let body = build_body("m", messages, None, 0.6, 512);
        assert!(body.contains(r#""model":"m""#), "{body}");
        assert!(body.contains(r#""stream":false"#));
        assert!(!body.contains("\"tools\""));
        assert!(!body.contains("tool_choice"));
        assert!(parse_json(&body).is_ok(), "拼出来必须是合法 JSON：{body}");

        let tools = r#"[{"type":"function","function":{"name":"theme.set"}}]"#;
        let with = build_body("m", messages, Some(tools), 0.6, 512);
        assert!(with.contains("\"tools\""), "{with}");
        assert!(with.contains("\"tool_choice\":\"auto\""));
        assert!(parse_json(&with).is_ok(), "{with}");

        // 空数组不该带出去：有的供应商见到它会 400
        let empty = build_body("m", messages, Some("[]"), 0.6, 512);
        assert!(!empty.contains("\"tools\""));
    }

    #[test]
    fn body_escapes_the_model_name_and_clamps_temperature() {
        let body = build_body("weird\"model\\name", "[]", None, 99.0, 512);
        let parsed = parse_json(&body).unwrap();
        assert_eq!(
            parsed.get("model").and_then(Json::as_str),
            Some("weird\"model\\name")
        );
        assert_eq!(parsed.get("temperature").and_then(Json::as_num), Some(2.0));

        let nan = build_body("m", "[]", None, f64::NAN, 512);
        assert!(nan.contains("0.60"), "{nan}");
    }

    #[test]
    fn message_checks_reject_rather_than_truncate() {
        assert!(check_messages("[]").is_err());
        assert!(check_messages("\"nope\"").is_err());
        assert!(check_messages(r#"[{"role":"wizard","content":"hi"}]"#).is_err());
        assert!(check_messages(r#"[{"role":"user","content":"hi"}]"#).is_ok());

        let long = format!(
            r#"[{{"role":"user","content":"{}"}}]"#,
            "x".repeat(MAX_MESSAGE_CHARS + 1)
        );
        let error = check_messages(&long).unwrap_err();
        assert!(error.contains("longer than"), "{error}");

        let many: Vec<String> = (0..MAX_MESSAGES + 1)
            .map(|_| r#"{"role":"user","content":"hi"}"#.to_string())
            .collect();
        assert!(check_messages(&format!("[{}]", many.join(","))).is_err());
    }

    #[test]
    fn tool_checks_only_care_about_shape() {
        assert!(check_tools("{}").is_err());
        assert!(check_tools("[]").is_ok());
        let lots: Vec<String> = (0..MAX_TOOLS + 1).map(|_| "{}".to_string()).collect();
        assert!(check_tools(&format!("[{}]", lots.join(","))).is_err());
    }

    #[test]
    fn status_messages_point_at_the_right_fix() {
        assert!(describe_status(401, "").contains("API key"));
        assert!(describe_status(403, "").contains("API key"));
        assert!(describe_status(404, "").contains("/v1"));
        assert!(describe_status(429, "").contains("quota"));
        assert!(describe_status(500, "").contains("HTTP 500"));
        let long = "a".repeat(400);
        let text = describe_status(400, &format!("{{\"error\":\"{long}\"}}"));
        assert!(text.contains('…'));
        assert!(text.chars().count() < 400);
    }

    #[test]
    fn network_failures_are_translated() {
        assert!(describe_failure("connecting to the host failed (Win32 error 12029)").contains("could not reach"));
        assert!(describe_failure("sending the request failed (Win32 error 12175)").contains("TLS"));
        assert!(describe_failure("something odd").contains("something odd"));
    }

    #[test]
    fn auth_shapes_are_three() {
        assert_eq!(normalize_auth("bearer"), "bearer");
        assert_eq!(normalize_auth("api_key_header"), "api-key-header");
        assert_eq!(normalize_auth("NONE"), "none");
        assert_eq!(normalize_auth(""), "bearer");
        assert_eq!(normalize_auth("whatever"), "bearer");
    }

    #[test]
    fn no_key_means_no_authorization_header() {
        assert!(auth_header("none", "sk-123").is_none());

        let (name, value) = auth_header("bearer", " sk-123 ").unwrap();
        assert_eq!(name, "authorization");
        assert_eq!(value, "Bearer sk-123");

        let (name, value) = auth_header("api-key-header", "abc").unwrap();
        assert_eq!(name, "api-key");
        assert_eq!(value, "abc");
    }

    #[test]
    fn labels_come_from_the_host() {
        assert_eq!(profile_label("https://api.deepseek.com/v1"), "api.deepseek.com");
        assert_eq!(profile_label("https://www.example.com/v1"), "example.com");
        assert_eq!(profile_label("http://127.0.0.1:11434/v1"), "Local model");
        assert_eq!(profile_label("http://[::1]:8080/v1"), "Local model");
        assert_eq!(profile_label(""), "");
    }

    #[test]
    fn profile_ids_are_bounded_and_safe() {
        assert!(profile_id_ok("p-1a2b-3"));
        assert!(profile_id_ok("p-0"));
        assert!(!profile_id_ok("1a2b"));
        assert!(!profile_id_ok("p-"));
        assert!(!profile_id_ok("p-AB"));
        assert!(!profile_id_ok("p-../etc"));
        assert!(!profile_id_ok(&format!("p-{}", "a".repeat(41))));
        assert_eq!(profile_id(0x1f, 2), "p-1f-2");
    }
}
