//! MCP（外部服务）——**纯逻辑**这一半：名字、命令行、JSON-RPC 的字节与形状。
//!
//! 为什么单独一份、而且**不引 crate**：一个 MCP 服务器可以声明任意工具，所以
//! 这里有两条东西要钉死 —— 工具名怎么进模型那张表（`mcp.<server>.<tool>` 的三段
//! 形状），以及我们发出去的每一行 JSON 长什么样。它们必须能在任何机器上用
//! `rustc --test` 单跑（`llm_policy.rs` / `hands_policy.rs` 同一条规矩）。
//!
//! 执行（起进程、发 HTTP、收响应）在 `mcp.rs` 里，那边要碰 Win32 与网络，测不细。
//!
//! # 四条判据
//!
//! - **工具名是小写命名空间**：`mcp.<server>.<tool>`，两段各 1..=32 / 1..=48 字，
//!   只许 `a-z0-9_-`。和前端 `runtime/hands.ts::mcpNameOk` 一字不差 —— 两边不一致
//!   的症状是"前端给了、Rust 说没有这个工具"，而错在哪儿看不出来。
//! - **服务器给的名字要过一遍机器**：真服务器会返回 `readFile`、`fs.read`、
//!   甚至带表情的名字，而工具名要同时当**审计日志的键**。所以统一压成合法形状，
//!   并且**去重**（两个工具压成同一个名字 = 一个永远调不到）。
//! - **stdio 走 `cmd /C` + 自己拼引号**：Windows 上 `npx` 是 `.cmd`，`CreateProcess`
//!   不执行批处理；而 Rust 的默认给 `cmd` 加引号的方式会和 `cmd` 自己的解析打架。
//!   拼法固定在这里，好加用例。
//! - **一行一个 JSON**：stdio 传输按 `\n` 切帧（HTTP 那条读整包）。半行不解析，
//!   攒着等下一段 —— `WinHttpReadData` / 管道都可能从多字节字符中间切开。

/// 前缀。工具名以它开头就是外部服务（`hands_policy::group_of` 按这个认）
pub const PREFIX: &str = "mcp.";

/// 我们只会说这一个版本的协议。比它新的服务器会回它自己支持的版本，
/// 我们按"能用的交集"继续（字段兼容，多出来的我们不读）
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// 单行上限。`tools/list` 的 schema 可以很大，但 4 MB 已经远超任何正常服务器
pub const MAX_LINE: usize = 4 * 1024 * 1024;

/// `mcp.<server>.<tool>` 拆成两段。形状不对就是 `None`（和 `name_ok` 同一套规则）
pub fn parse_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix(PREFIX)?;
    let (server, tool) = rest.split_once('.')?;
    if !segment_ok(server, 32) || !segment_ok(tool, 48) {
        return None;
    }
    Some((server, tool))
}

/// 名字形状对不对。**和 `hands_policy::mcp_ok` 完全相同**（这里不 import 它：
/// 两份文件都得能单跑，抄一遍规则比引入依赖便宜）
pub fn name_ok(name: &str) -> bool {
    parse_name(name).is_some()
}

fn segment_ok(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.len() <= max
        && text
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

/// 服务器声明的工具名 → 合法的那一段。
///
/// 规则：ASCII 字母转小写、数字与 `_` `-` 保留、别的一律变 `_`；
/// 压完截到 48；空的话给 `tool`。**这是单向的** —— 反查靠服务器那边的原始名字
/// （`mcp.rs` 的缓存里两样都留着），所以不需要可逆编码
pub fn sanitize_tool(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if out.len() >= 48 {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        return "tool".to_string();
    }
    out
}

/// 完整的外部工具名。`server` 是本地生成的 id（只含 `a-z0-9`），不用再压
pub fn expose(server: &str, raw_tool: &str) -> String {
    format!("{PREFIX}{server}.{}", sanitize_tool(raw_tool))
}

/// 重名时的第二个名字：`read_file` → `read_file_2`。**截断要在加后缀之前**，
/// 否则 48 字的工具名加完后缀又超了
pub fn dedupe(taken: &[String], candidate: &str) -> String {
    if !taken.iter().any(|name| name == candidate) {
        return candidate.to_string();
    }
    for index in 2..1000 {
        let suffix = format!("_{index}");
        let mut base = candidate.to_string();
        let keep = 48usize.saturating_sub(suffix.len());
        if base.len() > keep {
            base.truncate(keep);
        }
        // 截断可能落在多字节边界上（工具名里有中文时），往回退到字符边界
        while !base.is_char_boundary(base.len()) {
            base.pop();
        }
        let next = format!("{base}{suffix}");
        if !taken.iter().any(|name| name == &next) {
            return next;
        }
    }
    candidate.to_string()
}

/// 一个参数在 `cmd /C` 里的写法。
///
/// 只做两件事：空的与带空白的包双引号；内部的双引号写成两个（`cmd` 的规矩）。
/// `%` 转义成 `%%` —— 不转的话 `100%` 会被 `cmd` 当变量名去找，然后整段消失
pub fn quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    let escaped = arg.replace('%', "%%");
    if escaped
        .chars()
        .any(|ch| ch.is_whitespace() || "\"&|<>^()".contains(ch))
    {
        return format!("\"{}\"", escaped.replace('"', "\"\""));
    }
    escaped
}

/// `cmd /C` 后面那一整串。**命令本身也要过 `quote_arg`**：用户可能写
/// `"C:\Program Files\nodejs\npx.cmd"`
pub fn command_line(command: &str, args: &[String]) -> String {
    let mut parts = vec![quote_arg(command.trim())];
    for arg in args {
        parts.push(quote_arg(arg));
    }
    parts.join(" ")
}

/// 从缓冲区里取一整行（不含 `\n`；`\r\n` 的 `\r` 也去掉）。没有整行就是 `None`
pub fn take_line(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let index = buffer.iter().position(|byte| *byte == b'\n')?;
    let mut line: Vec<u8> = buffer.drain(..=index).collect();
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Some(line)
}

/// JSON 字符串的转义（够用版：只处理必须处理的那些）。
///
/// 工具名是外部输入的，拼进我们发出去的 JSON 之前必须过这一道 —— 一个带 `"`
/// 的工具名能把整条请求变成两段垃圾
pub fn json_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
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

/// `initialize`。MCP 的第一步：协议版本 + 客户端自我介绍
pub fn initialize(id: i64) -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"initialize\",\"params\":{{\"protocolVersion\":\"{PROTOCOL_VERSION}\",\"capabilities\":{{}},\"clientInfo\":{{\"name\":\"lattice\",\"version\":\"0.1.1\"}}}}}}"
    )
}

/// 第二步。**是通知，没有 id**：服务器不回它，回了我们也当没看见
pub fn initialized_note() -> String {
    "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}".to_string()
}

pub fn list_tools(id: i64) -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/list\",\"params\":{{}}}}")
}

/// 工具调用。`args` 是模型给的参数，**原样**嵌进去（它已经是合法 JSON）
pub fn call_tool(id: i64, raw_tool: &str, args_json: &str) -> String {
    let args = if args_json.trim().is_empty() {
        "{}"
    } else {
        args_json.trim()
    };
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/call\",\"params\":{{\"name\":\"{}\",\"arguments\":{args}}}}}",
        json_escape(raw_tool)
    )
}

/// 这一行是哪一条请求的回答。读不到数字就是 `None`（通知 / 服务器日志噪声）
pub fn id_of(line: &str) -> Option<i64> {
    let start = line.find("\"id\"")? + 4;
    let rest = &line[start..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix(':')?;
    let rest = rest.trim_start();
    let digits: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
        .collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_two_segments() {
        assert_eq!(parse_name("mcp.github.list_issues"), Some(("github", "list_issues")));
        assert_eq!(parse_name("mcp.a.b"), Some(("a", "b")));
        assert_eq!(parse_name("mcp.a.b.c"), None);
        assert_eq!(parse_name("mcp.a"), None);
        assert_eq!(parse_name("mcp..b"), None);
        assert_eq!(parse_name("mcpx.a.b"), None);
        assert_eq!(parse_name("mcp.Server.tool"), None);
    }

    #[test]
    fn name_ok_matches_hands_policy() {
        // 同一套规则在两侧各钉一份（这里不 import `hands_policy`：要能单跑）
        for name in ["mcp.a.b", "mcp.my-server.read_file", "mcp.x.y"] {
            assert!(name_ok(name), "{name}");
        }
        for name in ["mcp.", "mcp.a", "mcp.a.b.c", "mcp.A.b", "mcp.a b.c"] {
            assert!(!name_ok(name), "{name}");
        }
    }

    #[test]
    fn tool_names_are_pressed_into_shape() {
        assert_eq!(sanitize_tool("read_file"), "read_file");
        assert_eq!(sanitize_tool("readFile"), "readfile");
        assert_eq!(sanitize_tool("fs.read"), "fs_read");
        assert_eq!(sanitize_tool("read file!"), "read_file_");
        assert_eq!(sanitize_tool(""), "tool");
        assert_eq!(sanitize_tool("读文件"), "___");
    }

    #[test]
    fn long_tool_names_are_cut_to_48() {
        let long = sanitize_tool(&"a".repeat(80));
        assert_eq!(long.len(), 48);
        assert!(name_ok(&format!("mcp.s.{long}")));
    }

    #[test]
    fn exposed_names_round_trip_through_parse() {
        let exposed = expose("s1a2b3c4", "read file");
        assert_eq!(exposed, "mcp.s1a2b3c4.read_file");
        assert_eq!(parse_name(&exposed), Some(("s1a2b3c4", "read_file")));
    }

    #[test]
    fn duplicates_get_a_suffix_that_still_fits() {
        let taken = vec!["read_file".to_string()];
        assert_eq!(dedupe(&[], "read_file"), "read_file");
        assert_eq!(dedupe(&taken, "read_file"), "read_file_2");
        let full = "a".repeat(48);
        let taken = vec![full.clone()];
        let next = dedupe(&taken, &full);
        assert_eq!(next.len(), 48);
        assert!(next.ends_with("_2"));
        assert!(name_ok(&format!("mcp.s.{next}")));
    }

    #[test]
    fn arguments_are_quoted_only_when_needed() {
        assert_eq!(quote_arg("npx"), "npx");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg("C:\\Program Files\\x"), "\"C:\\Program Files\\x\"");
        assert_eq!(quote_arg("100%"), "100%%");
    }

    #[test]
    fn inner_quotes_are_doubled() {
        assert_eq!(quote_arg("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn command_lines_join_quoted_parts() {
        let args = vec!["-y".to_string(), "pkg".to_string(), "D:\\我的 目录".to_string()];
        assert_eq!(command_line("npx", &args), "npx -y pkg \"D:\\我的 目录\"");
        assert_eq!(command_line(" npx ", &[]), "npx");
    }

    #[test]
    fn take_line_waits_for_a_whole_line() {
        let mut buffer = b"{\"a\":1}".to_vec();
        assert_eq!(take_line(&mut buffer), None);
        assert_eq!(buffer.len(), 7);
        buffer.extend_from_slice(b"\r\n{\"b\":2}\n");
        assert_eq!(take_line(&mut buffer), Some(b"{\"a\":1}".to_vec()));
        assert_eq!(take_line(&mut buffer), Some(b"{\"b\":2}".to_vec()));
        assert_eq!(take_line(&mut buffer), None);
        assert!(buffer.is_empty());
    }

    #[test]
    fn empty_lines_are_still_lines() {
        let mut buffer = b"\n\n".to_vec();
        assert_eq!(take_line(&mut buffer), Some(Vec::new()));
        assert_eq!(take_line(&mut buffer), Some(Vec::new()));
    }

    #[test]
    fn json_escape_covers_the_dangerous_four() {
        assert_eq!(json_escape("plain"), "plain");
        assert_eq!(json_escape("a\"b"), "a\\\"b");
        assert_eq!(json_escape("a\\b"), "a\\\\b");
        assert_eq!(json_escape("a\nb\tc"), "a\\nb\\tc");
        assert_eq!(json_escape("\u{1}"), "\\u0001");
        // 中文原样过去（服务端按 UTF-8 读）
        assert_eq!(json_escape("读文件"), "读文件");
    }

    #[test]
    fn initialize_carries_the_version_and_an_id() {
        let line = initialize(7);
        assert!(line.contains("\"id\":7"));
        assert!(line.contains(PROTOCOL_VERSION));
        assert!(line.contains("\"clientInfo\""));
        assert!(line.ends_with('}'));
    }

    #[test]
    fn initialized_is_a_notification() {
        let line = initialized_note();
        assert!(!line.contains("\"id\""));
        assert!(line.contains("notifications/initialized"));
    }

    #[test]
    fn tool_calls_embed_arguments_verbatim() {
        let line = call_tool(3, "read_file", "{\"path\":\"C:\\\\x\"}");
        assert!(line.contains("\"id\":3"));
        assert!(line.contains("\"name\":\"read_file\""));
        assert!(line.contains("\"arguments\":{\"path\":\"C:\\\\x\"}"));
        // 工具名里的引号要被转义，不能把请求劈成两段
        let tricky = call_tool(1, "a\"b", "");
        assert!(tricky.contains("\"name\":\"a\\\"b\""));
        assert!(tricky.contains("\"arguments\":{}"));
    }

    #[test]
    fn id_of_finds_the_number() {
        assert_eq!(id_of("{\"jsonrpc\":\"2.0\",\"id\":12,\"result\":{}}"), Some(12));
        assert_eq!(id_of("{\"id\" : \"7\"}"), None); // 字符串 id 我们不发，也不认
        assert_eq!(id_of("{\"method\":\"notifications/initialized\"}"), None);
        assert_eq!(id_of("noise"), None);
    }

    #[test]
    fn responses_with_notification_ids_are_ignored() {
        // 服务器可以主动发通知（日志、进度）—— 它们没有 id，不能被当成回答
        let note = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}";
        assert_eq!(id_of(note), None);
    }
}
