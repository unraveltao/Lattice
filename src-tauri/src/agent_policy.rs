//! Agent 接入的纯逻辑：HTTP 解析、令牌比对、动作白名单。
//!
//! 和 `occlusion_policy` / `network_policy` 一样，这里**不碰**网络、线程、
//! Tauri，只做能脱离运行时单测的部分。脏活（监听、线程、事件）在 `agent.rs`。
//!
//! 为什么要自己解析 HTTP：这是一个只听 127.0.0.1、只收 JSON、只允许单请求
//! 短连接的端点。为了它引一个 web 框架，等于为了 200 行协议换进来几万行依赖 ——
//! 而这个项目的全部卖点之一是"安装包 2.7 MB"。
//!
//! 自己写就得写对，所以下面每一条分支都有测试钉着：收不全会等、收全了但畸形
//! 要拒、超长要在读之前就拒（不是读完再拒）。

/// 请求体上限。一个 `act` 最多带几个坐标，64KB 已经宽得离谱。
pub const MAX_BODY: usize = 64 * 1024;

/// 请求头上限。防止一个不带 `\r\n\r\n` 的流把内存吃满。
pub const MAX_HEAD: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// 原样保留 `Authorization` 头的值（含 `Bearer ` 前缀）
    pub authorization: Option<String>,
    pub body: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    /// 还没收全：头没到空行，或者 body 没到 Content-Length。**继续读**。
    Incomplete,
    /// 收全了但不合规。**回 400，别等**。
    Malformed(&'static str),
    /// 超过 `MAX_BODY` / `MAX_HEAD`。**回 413，别读**。
    TooLarge,
}

/// 解析一个已经收到的字节流。
///
/// 调用方在 `Incomplete` 时继续读、在另外两种错误时立刻回错误 —— 这个区分
/// 是整个解析器的关键：把 `Incomplete` 当成错误，正常请求会被误杀；把错误
/// 当成 `Incomplete`，一个畸形请求能让线程一直等下去。
pub fn parse_request(bytes: &[u8]) -> Result<Request, ParseError> {
    let head_end = match find_head_end(bytes) {
        Some(at) => at,
        None => {
            if bytes.len() > MAX_HEAD {
                return Err(ParseError::TooLarge);
            }
            return Err(ParseError::Incomplete);
        }
    };

    let head = std::str::from_utf8(&bytes[..head_end]).map_err(|_| ParseError::Malformed("request head is not UTF-8"))?;

    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or(ParseError::Malformed("empty request"))?;
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let version = parts.next().unwrap_or("");
    if method.is_empty() || path.is_empty() || parts.next().is_some() {
        return Err(ParseError::Malformed("request line must be METHOD PATH VERSION"));
    }
    if !version.starts_with("HTTP/1.") {
        return Err(ParseError::Malformed("only HTTP/1.x is supported"));
    }

    let mut authorization = None;
    let mut content_length = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or(ParseError::Malformed("header line without a colon"))?;
        let value = value.trim();
        // 头名大小写不敏感，这是 HTTP 的规定；curl 发的是 `Authorization`，
        // 而有些客户端发 `authorization`，两者必须都认
        if name.trim().eq_ignore_ascii_case("authorization") {
            authorization = Some(value.to_string());
        } else if name.trim().eq_ignore_ascii_case("content-length") {
            let parsed: usize = value
                .parse()
                .map_err(|_| ParseError::Malformed("content-length is not a number"))?;
            if parsed > MAX_BODY {
                return Err(ParseError::TooLarge);
            }
            content_length = parsed;
        }
    }

    let body_start = head_end + 4;
    let available = bytes.len() - body_start;
    if available < content_length {
        return Err(ParseError::Incomplete);
    }

    let body = std::str::from_utf8(&bytes[body_start..body_start + content_length])
        .map_err(|_| ParseError::Malformed("request body is not UTF-8"))?
        .to_string();

    Ok(Request {
        method: method.to_string(),
        path: path.to_string(),
        authorization,
        body,
    })
}

fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

/// 令牌比对，常量时间。
///
/// 长度不同直接返回 false —— 长度本身会泄露，但那不是一个秘密（令牌固定 64 个
/// hex 字符）。真正要防的是"逐字节比较，第一个字节错了就返回"，那能让攻击者
/// 一个字节一个字节地试出来。
pub fn authorized(header: Option<&str>, token: &str) -> bool {
    let Some(raw) = header else {
        return false;
    };
    let Some(value) = raw.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(value.trim().as_bytes(), token.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

/// 把 32 字节随机数变成 64 个 hex 字符。
pub fn token_from_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// agent 能做的事，**穷举**在这个枚举里。
///
/// 白名单而不是黑名单：新增动作必须回来改这个文件、改前端执行器、改文档，
/// 三处都改了才算数。黑名单的问题是新动作默认是允许的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    PlacementAdd,
    PlacementMove,
    PlacementResize,
    PlacementRemove,
    PlacementPin,
    PlacementFront,
    ThemeSet,
    WidgetsPause,
    ConfigSet,
}

impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Action::PlacementAdd => "placement.add",
            Action::PlacementMove => "placement.move",
            Action::PlacementResize => "placement.resize",
            Action::PlacementRemove => "placement.remove",
            Action::PlacementPin => "placement.pin",
            Action::PlacementFront => "placement.front",
            Action::ThemeSet => "theme.set",
            Action::WidgetsPause => "widgets.pause",
            Action::ConfigSet => "config.set",
        }
    }
}

/// 所有被允许的动作，顺序即文档里的顺序。
pub const ACTIONS: &[Action] = &[
    Action::PlacementAdd,
    Action::PlacementMove,
    Action::PlacementResize,
    Action::PlacementRemove,
    Action::PlacementPin,
    Action::PlacementFront,
    Action::ThemeSet,
    Action::WidgetsPause,
    Action::ConfigSet,
];

/// **永远不给** agent 的动作。列在这里不是为了拒绝（`parse_action` 本来就不认），
/// 是为了让"为什么不给"有地方写，也让测试能钉住"哪天有人加进来就红"。
pub const DENIED: &[(&str, &str)] = &[
    ("widget.grant", "提权。agent 能给自己授权，前面所有闸门就都白设了"),
    ("widget.install", "装组件 = 跑别人写的代码，必须人点"),
    ("widget.uninstall", "卸载会连备份一起清，不可撤销"),
    // `config.set` 曾经在这里，理由是"用户亲手填的值，需要一次界面确认，v1 没做确认流"。
    // 0037 把它移进 ACTIONS：确认条已经有了（`approvalFor` 的 `ask`），而且它在
    // `auto` 档也照样问 —— 当初拒绝的那个前提没了，就不该继续拒。
    ("storage.write", "组件数据没有 schema，agent 只能瞎猜键名"),
    ("state.clear", "一条命令清空用户桌面"),
    ("agent.set_enabled", "自己给自己开门"),
    (
        "dictation_start",
        "开麦。麦克风是平台自己的那一份能力 —— 组件够不到（没有 speech 权限，桥的方法表里也没有），\
         agent 更不该有一条绕过界面的口子去听房间里的声音（0027 §8）",
    ),
];

pub fn parse_action(name: &str) -> Option<Action> {
    ACTIONS.iter().copied().find(|action| action.name() == name)
}

/// `say` 的长度上限，**按字符算不按字节算** —— 中文一个字三个字节，
/// 按字节截会把字切开。
pub const MAX_SAY_CHARS: usize = 500;

/// 归一化 agent 想说的一句话。
///
/// 三件事一起做：去首尾空白、把连续空白（含换行）压成一个空格、超长拒绝。
///
/// **压成一行是硬要求**：审计日志是一行一条 JSON，多行内容会把它撑成两条，
/// 之后每一条都解析失败。而这块板子本来就只有 320px 宽，换行也显示不出来。
///
/// 超长**拒绝而不是截断**：截断是替 agent 决定了什么不重要，它看到报错会自己
/// 写短一点，而截断只会让它以为说全了。
pub fn say_text(raw: &str) -> Result<String, &'static str> {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("say needs some text");
    }
    if text.chars().count() > MAX_SAY_CHARS {
        return Err("say text is too long (max 500 characters)");
    }
    Ok(text)
}

/// 组一个 HTTP/1.1 响应。永远 `Connection: close`：单请求短连接，
/// 不实现 keep-alive 也就不需要处理分块和管道化。
pub fn response(status: u16, body: &str) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Unknown",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Cache-Control: no-store\r\n\
         \r\n",
        body.len()
    );
    let mut out = Vec::with_capacity(head.len() + body.len());
    out.extend_from_slice(head.as_bytes());
    out.extend_from_slice(body.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn post(body: &str) -> Vec<u8> {
        format!(
            "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn parses_a_complete_post() {
        let raw = post(r#"{"op":"state"}"#);
        let request = parse_request(&raw).expect("should parse");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/rpc");
        assert_eq!(request.body, r#"{"op":"state"}"#);
        assert!(request.authorization.is_some());
    }

    #[test]
    fn header_without_a_body_is_complete() {
        let raw = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let request = parse_request(raw).expect("should parse");
        assert_eq!(request.body, "");
        assert_eq!(request.authorization, None);
    }

    #[test]
    fn a_partial_head_is_incomplete_not_malformed() {
        // 少一个 \r\n：调用方要继续读，不能当错误
        let raw = b"POST /rpc HTTP/1.1\r\nAuthorization: Bearer abc\r\n";
        assert_eq!(parse_request(raw), Err(ParseError::Incomplete));
    }

    #[test]
    fn a_partial_body_is_incomplete() {
        let raw = b"POST /rpc HTTP/1.1\r\nContent-Length: 20\r\n\r\n{\"op\":\"sta";
        assert_eq!(parse_request(raw), Err(ParseError::Incomplete));
    }

    #[test]
    fn an_oversized_body_is_rejected_before_reading_it() {
        let raw = format!("POST /rpc HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert_eq!(parse_request(raw.as_bytes()), Err(ParseError::TooLarge));
    }

    #[test]
    fn a_head_that_never_ends_is_bounded() {
        let mut raw = b"POST /rpc HTTP/1.1\r\n".to_vec();
        raw.extend(std::iter::repeat(b'X').take(MAX_HEAD + 16));
        assert_eq!(parse_request(&raw), Err(ParseError::TooLarge));
    }

    #[test]
    fn a_bad_request_line_is_malformed() {
        assert!(matches!(
            parse_request(b"POST\r\n\r\n"),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_request(b"POST /rpc\r\n\r\n"),
            Err(ParseError::Malformed(_))
        ));
    }

    #[test]
    fn only_http_1x_is_accepted() {
        assert!(matches!(
            parse_request(b"POST /rpc HTTP/2\r\n\r\n"),
            Err(ParseError::Malformed(_))
        ));
    }

    #[test]
    fn header_names_are_case_insensitive() {
        let raw = format!(
            "POST /rpc HTTP/1.1\r\nauthorization: Bearer {TOKEN}\r\ncontent-length: 2\r\n\r\n{{}}"
        );
        let request = parse_request(raw.as_bytes()).expect("should parse");
        assert_eq!(request.authorization.as_deref(), Some(format!("Bearer {TOKEN}").as_str()));
        assert_eq!(request.body, "{}");
    }

    #[test]
    fn a_header_line_without_a_colon_is_malformed() {
        assert!(matches!(
            parse_request(b"POST /rpc HTTP/1.1\r\nBroken\r\n\r\n"),
            Err(ParseError::Malformed(_))
        ));
    }

    #[test]
    fn a_non_numeric_content_length_is_malformed() {
        assert!(matches!(
            parse_request(b"POST /rpc HTTP/1.1\r\nContent-Length: lots\r\n\r\n"),
            Err(ParseError::Malformed(_))
        ));
    }

    #[test]
    fn the_right_token_is_accepted() {
        assert!(authorized(Some(&format!("Bearer {TOKEN}")), TOKEN));
    }

    #[test]
    fn a_wrong_token_is_rejected() {
        assert!(!authorized(Some(&format!("Bearer {}", "0".repeat(64))), TOKEN));
    }

    #[test]
    fn a_missing_header_is_rejected() {
        assert!(!authorized(None, TOKEN));
    }

    #[test]
    fn only_the_bearer_scheme_is_accepted() {
        // Basic / 裸令牌都不认：认两种就等于两种都要写对
        assert!(!authorized(Some(&format!("Basic {TOKEN}")), TOKEN));
        assert!(!authorized(Some(TOKEN), TOKEN));
    }

    #[test]
    fn a_token_of_the_wrong_length_is_rejected() {
        assert!(!authorized(Some("Bearer abc"), TOKEN));
        assert!(!authorized(Some("Bearer "), TOKEN));
    }

    #[test]
    fn the_allowlist_is_exactly_nine_actions() {
        // 0037 之前是八个。加一个动作**必须**同时改这里 —— 这条断言存在的意义
        // 就是让"白名单悄悄多一条"变成一次红。
        assert_eq!(ACTIONS.len(), 9);
        for action in ACTIONS {
            assert_eq!(parse_action(action.name()), Some(*action));
        }
    }

    #[test]
    fn denied_actions_are_not_in_the_allowlist() {
        for (name, why) in DENIED {
            assert!(
                parse_action(name).is_none(),
                "{name} must never be callable by an agent ({why})"
            );
        }
    }

    #[test]
    fn an_unknown_action_is_none() {
        assert!(parse_action("placement.explode").is_none());
        assert!(parse_action("").is_none());
    }

    #[test]
    fn dictation_is_not_an_agent_action() {
        // 听写是**平台自己**的能力：没有 speech 权限、桥的方法表里也没有它。
        // 这条断言钉的是"哪天有人把 dictation_* 加进 ACTIONS 就红"
        for action in ACTIONS {
            assert!(
                !action.name().starts_with("dictation"),
                "{} must never be callable by an agent",
                action.name()
            );
        }
        assert!(parse_action("dictation_start").is_none());
        assert!(parse_action("dictation_stop").is_none());
    }

    #[test]
    fn the_dictation_denial_says_why() {
        // 拒绝清单里要有这一条，而且理由要写成"给人看的一句话"，不是占位符
        let (_, why) = DENIED
            .iter()
            .find(|(name, _)| *name == "dictation_start")
            .expect("dictation_start must be listed in DENIED");
        assert!(why.chars().count() > 20, "the reason is too short: {why}");
        assert!(why.contains("麦克风"), "the reason should name the thing: {why}");
    }

    #[test]
    fn a_response_carries_a_length_and_closes() {
        let raw = String::from_utf8(response(200, r#"{"ok":true}"#)).expect("utf-8");
        assert!(raw.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(raw.contains("Content-Length: 11\r\n"));
        assert!(raw.contains("Connection: close\r\n"));
        assert!(raw.ends_with(r#"{"ok":true}"#));
    }

    #[test]
    fn a_token_is_64_hex_characters() {
        let token = token_from_bytes(&[0x00, 0x0f, 0xff, 0x5a]);
        assert_eq!(token, "000fff5a");
        assert_eq!(token_from_bytes(&[7u8; 32]).len(), 64);
    }

    // ---- say ----

    #[test]
    fn say_keeps_an_ordinary_sentence() {
        assert_eq!(
            say_text("Moved the clock to the top right"),
            Ok("Moved the clock to the top right".to_string())
        );
    }

    #[test]
    fn say_collapses_newlines_into_one_line() {
        // 审计日志一行一条 JSON，多行内容会把后面每一条都撑坏
        assert_eq!(say_text("first\nsecond\r\n\nthird"), Ok("first second third".to_string()));
    }

    #[test]
    fn say_trims_and_rejects_emptiness() {
        assert_eq!(say_text("  padded  "), Ok("padded".to_string()));
        assert_eq!(say_text(""), Err("say needs some text"));
        assert_eq!(say_text("   \n\t "), Err("say needs some text"));
    }

    #[test]
    fn say_counts_characters_not_bytes() {
        // 500 个汉字是 1500 字节，按字节判会误拒
        assert!(say_text(&"字".repeat(MAX_SAY_CHARS)).is_ok());
        assert!(say_text(&"字".repeat(MAX_SAY_CHARS + 1)).is_err());
    }

    #[test]
    fn say_refuses_instead_of_truncating() {
        // 截断等于替 agent 决定什么不重要，它只会以为说全了
        let long = "a".repeat(MAX_SAY_CHARS + 1);
        assert_eq!(say_text(&long), Err("say text is too long (max 500 characters)"));
    }
}
