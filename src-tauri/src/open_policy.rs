//! 组件说"帮我打开这个网址"时，什么样的字符串才许交给系统 shell。
//!
//! # 为什么需要单独一层判断
//!
//! `tauri-plugin-opener` 把字符串原样丢给 `ShellExecuteW` —— 它**不认协议**。
//! `file:` / `ms-settings:` / `search-ms:` / 任何注册过的自定义协议都会被执行。
//! 对组件来说那等于一条绕过全部出网闸门的路：
//!
//! - `egress.rs` 拦住组件把自己的 frame 导航走；
//! - `network.rs` 只放行清单里声明过的主机；
//! - 而 `shell.open("file:///C:/Users/…")` 会把本地文件交给系统默认程序打开，
//!   `ms-settings:privacy-microphone` 会直接翻到系统隐私设置页。
//!
//! 所以白名单只有两项：`http` 和 `https`。别的协议一律失败，并且失败原因要说
//! 清楚（"只支持 http/https"），否则用户看到的是"浏览器没起来"，会去查浏览器。
//!
//! # 为什么边界上还要补协议头
//!
//! 书签类组件的输入是用户手打的，`github.com` 这种写法很常见。组件那边也会补
//! （它还要顺手算出域名当标题），但**在边界上再补一次**的成本是一行，收益是
//! "任何第三方组件都不会因为少写一个 `https://` 而报错"。两边的规则必须一致，
//! 用例表在 `tests/bookmarks.html`（组件侧）和本文件的 `tests`（Rust 侧）各钉
//! 一份 —— 改一边就要改另一边。
//!
//! # 不做什么
//!
//! 不判断"这个站点安不安全"、不查黑名单、不解析重定向 —— 那是浏览器的事。
//! 这里只回答一个问题：**这个字符串能不能交给 shell**。

/// 网址的长度上限。书签是给人看的，超过这个长度基本是粘贴事故。
pub const MAX_URL_LEN: usize = 2048;

/// 允许交给 shell 的协议，只有这两个。
const ALLOWED_SCHEMES: [&str; 2] = ["http", "https"];

/// 校验并补全一个网址。成功时返回可以直接交给 shell 的绝对地址。
///
/// 失败时返回的字符串是给组件看的（组件会原样显示在卡片上），所以写成
/// 一句人话，不要带内部的函数名或错误码。
pub fn normalize(input: &str) -> Result<String, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("there is no url to open".to_string());
    }
    if text.len() > MAX_URL_LEN {
        return Err(format!("the url is longer than {MAX_URL_LEN} characters"));
    }
    // 裸空格和控制字符会让 ShellExecuteW 的解析变得不可预测（有的会截断，
    // 有的会当成两个参数）。组件已经用 URL 解析器编码过一遍，走到这里还有
    // 空白就说明不是一条合法的网址。
    if text.chars().any(|c| c == ' ' || c.is_control()) {
        return Err("the url contains a space or a control character".to_string());
    }

    // `//example.com/x` —— 只有协议相对写法，补上协议就行
    if let Some(rest) = text.strip_prefix("//") {
        if rest.is_empty() {
            return Err("the url has no host".to_string());
        }
        return Ok(format!("https://{rest}"));
    }

    match split_scheme(text) {
        None => {
            // 没有协议头：`github.com`、`example.com:8080/x`
            let candidate = format!("https://{text}");
            check_host(&candidate)?;
            Ok(candidate)
        }
        Some((scheme, rest)) => {
            if ALLOWED_SCHEMES.contains(&scheme.as_str()) {
                // `http:/example.com` 这种少一条斜杠的写法不猜，直接说清楚
                if !rest.starts_with("//") {
                    return Err(format!("the {scheme} link is missing // before the host"));
                }
                check_host(text)?;
                return Ok(text.to_string());
            }
            // `example.com:8080/x` 会被读成"协议是 example.com" —— 按浏览器
            // 地址栏的规矩，冒号后面是纯数字端口就当成主机:端口
            if looks_like_host_port(rest) {
                let candidate = format!("https://{text}");
                check_host(&candidate)?;
                return Ok(candidate);
            }
            Err(format!(
                "only http and https links can be opened, not \"{scheme}:\""
            ))
        }
    }
}

/// 取出协议头。只认 RFC 3986 的形状（字母开头，字母/数字/`+`/`-`/`.`），
/// 而且冒号必须出现在第一个 `/`、`?`、`#` 之前 —— 否则那是路径里的冒号。
fn split_scheme(text: &str) -> Option<(String, &str)> {
    let colon = text.find(':')?;
    let head = &text[..colon];
    if head.is_empty() || !head.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    if !head
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    Some((head.to_ascii_lowercase(), &text[colon + 1..]))
}

/// 冒号后面是不是一个端口（1–5 位数字，然后结束或接 `/ ? #`）。
fn looks_like_host_port(rest: &str) -> bool {
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 5 {
        return false;
    }
    match rest[digits..].chars().next() {
        None => true,
        Some('/') | Some('?') | Some('#') => true,
        Some(_) => false,
    }
}

/// `scheme://authority…` 里 authority 必须非空、且不能只剩一个用户信息段。
fn check_host(url: &str) -> Result<(), String> {
    let after = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .ok_or_else(|| "the url has no scheme".to_string())?;
    let authority = after
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    // `user:pass@host` 是合法的，去掉用户信息再看有没有主机
    let host = authority.rsplit('@').next().unwrap_or_default();
    if host.is_empty() || host.starts_with(':') {
        return Err("the url has no host".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(input: &str) -> String {
        normalize(input).unwrap_or_else(|error| panic!("{input} 应该能打开，却报错：{error}"))
    }

    fn err(input: &str) {
        assert!(normalize(input).is_err(), "{input} 应该被拒绝");
    }

    #[test]
    fn keeps_absolute_http_links() {
        assert_eq!(ok("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
        assert_eq!(ok("http://localhost:1420/"), "http://localhost:1420/");
        assert_eq!(ok("  https://example.com  "), "https://example.com");
        // 大小写不影响判断，也不改写原样（浏览器认）
        assert_eq!(ok("HTTPS://Example.COM/X"), "HTTPS://Example.COM/X");
        // 用户信息是合法的，主机在后面
        assert_eq!(ok("https://user:pw@example.com/"), "https://user:pw@example.com/");
    }

    #[test]
    fn fills_in_the_scheme_like_an_address_bar() {
        assert_eq!(ok("github.com"), "https://github.com");
        assert_eq!(ok("github.com/tauri-apps/tauri"), "https://github.com/tauri-apps/tauri");
        // 冒号后面是端口，不是协议
        assert_eq!(ok("example.com:8080/x"), "https://example.com:8080/x");
        assert_eq!(ok("example.com:8080"), "https://example.com:8080");
        // 协议相对写法
        assert_eq!(ok("//example.com/x"), "https://example.com/x");
    }

    #[test]
    fn refuses_every_other_scheme() {
        // 这四条就是这道闸存在的理由
        err("file:///C:/Windows/System32/drivers/etc/hosts");
        err("ms-settings:privacy-microphone");
        err("search-ms:query=secret");
        err("javascript:alert(1)");
        err("data:text/html,<b>x</b>");
        err("vbscript:msgbox(1)");
        err("mailto:someone@example.com");
        err("ftp://example.com/x");
        // 大小写也一样拒
        err("FILE:///C:/Windows");
    }

    #[test]
    fn refuses_things_that_are_not_urls() {
        err("");
        err("   ");
        err("https://");
        err("https:///x");
        err("https://:8080/x");
        err("http:/example.com");
        // 裸空格会让 shell 的解析不可预测
        err("https://example.com/a b");
        err("https://example.com/\u{0}evil");
        // 超长
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        err(&long);
    }

    #[test]
    fn normalize_is_idempotent() {
        // 组件补过一次协议头，边界上再补一次必须什么都不变
        for input in [
            "https://example.com/x",
            "github.com/x",
            "example.com:8080/x",
            "//example.com/x",
        ] {
            let once = ok(input);
            let twice = ok(&once);
            assert_eq!(once, twice, "{input} 归一化两次结果不同");
        }
    }
}
