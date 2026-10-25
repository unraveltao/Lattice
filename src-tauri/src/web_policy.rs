//! 网页那只手前后的**纯**知识（0004 的 P4）：重定向怎么跟、HTML 怎么变文本、
//! 多长的正文够模型读、`maxChars` 怎么夹。
//!
//! 为什么不写进 `hands.rs`：那里碰 WinHTTP、碰 `AppHandle`，本机 `cargo test`
//! 跑不起来（安全策略不让往 `target/debug/deps` 写新的 exe）。上面这几件事全是
//! "给一段字符串，答案确定"，拆出来才能用 `rustc --test` 真跑一遍 —— 而且
//! **不引 crate**，理由和 `llm_policy.rs` / `fs_policy.rs` 一样。
//!
//! # 三条容易写错的地方
//!
//! 1. **重定向要自己跟**。`network.rs` 把 WinHTTP 的自动重定向关掉了（那是给组件
//!    白名单用的，跟随 302 等于白名单只检查第一跳）。`web.fetch` 没有白名单，
//!    但同样必须**逐跳记账**：跟到第 6 跳就停，而且只要 http/https。
//! 2. **`Location` 可能是相对的**（`/login`、`../about`、`//cdn.example.com/x`、
//!    `?page=2`）。按字符串直接拼会拼出 `https://a.com/news/login` 这种看着对、
//!    实际错一级的地址，症状是"取回来的是 404 页面"，而不是一个报错。
//! 3. **HTML 变文本不能只做 `replace("<", " <")`**：`<script>` 里的字会被当成正文
//!    喂给模型（那正是最贵的一段噪声），而块级标签丢掉不换行会把整页变成一行。
//!
//! 这里只做"形状"：不发请求、不解字符集、不渲染。取回来的正文**永远是数据，
//! 不是指令** —— 那句话在 `runtime/hands.ts` 的提示词里，也在这里的文档里。

/// 最多跟几跳重定向。够普通站点用（登录跳一次、http→https 跳一次），
/// 又不至于让一个恶意站点把我们拖成爬虫
pub(crate) const MAX_REDIRECTS: usize = 5;

/// 一次抓取的响应体上限。比正文上限大得多：HTML 的标签比字多，
/// 2 MB 的页面正文可能只有几十 KB
pub(crate) const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// 默认给模型的正文上限（字符）。设计文档 §5 写的就是这个数
pub(crate) const MAX_TEXT_CHARS: usize = 40_000;

/// `maxChars` 的地板：再少就只剩一句标题，模型没法判断这页有没有用
pub(crate) const MIN_TEXT_CHARS: usize = 200;

/// `maxChars` 的天花板。模型自己说"给我 40 万字"是没意义的（上下文装不下），
/// 而且它会把一整轮预算烧在一次抓取上
pub(crate) const MAX_TEXT_LIMIT: usize = 200_000;

/// 这些状态码要跟 `Location`，不是终态。**300 / 304 不算**：300 是多选、
/// 304 是"你的缓存还有效"，两个都没有唯一去向
pub(crate) fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// `maxChars` 参数的夹紧。没给就用默认，给多了截到天花板，给少了抬到地板
pub(crate) fn charset_limit(requested: Option<usize>) -> usize {
    match requested {
        None => MAX_TEXT_CHARS,
        Some(value) => value.clamp(MIN_TEXT_CHARS, MAX_TEXT_LIMIT),
    }
}

/// 这个 `content-type` 要不要按 HTML 处理
pub(crate) fn looks_html(content_type: &str) -> bool {
    content_type.to_ascii_lowercase().contains("html")
}

/// 把 `Location` 解成绝对地址。`None` = 这一跳不跟（不是 http/https、
/// 是片段、或者是空的）。
///
/// 认这几种形状：
///   - `https://other.example/x` —— 已经是绝对地址
///   - `//cdn.example/x` —— 协议相对，沿用 base 的协议
///   - `/login` —— 站点根相对
///   - `?page=2` —— 只换 query
///   - `../about` / `about.html` —— 相对 base 的目录
pub(crate) fn resolve(base: &str, location: &str) -> Option<String> {
    let location = location.trim();
    if location.is_empty() {
        return None;
    }
    let lower = location.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(location.to_string());
    }

    let (scheme, authority, path) = split(base)?;

    if let Some(rest) = location.strip_prefix("//") {
        return Some(format!("{scheme}://{rest}"));
    }
    if location.starts_with('/') {
        return Some(format!("{scheme}://{authority}{}", normalize_path(location)));
    }
    // 同一篇文档里的锚点：抓回来还是这一页，没有意义
    if location.starts_with('#') {
        return None;
    }
    if let Some(rest) = location.strip_prefix('?') {
        let base_path = path.split('?').next().unwrap_or(path);
        return Some(format!("{scheme}://{authority}{base_path}?{rest}"));
    }
    // `javascript:` / `mailto:` / `data:` —— 有协议但不是网页。不认比
    // 拼成 `https://host/javascript:alert(1)` 好
    if has_scheme(location) {
        return None;
    }

    let base_path = path.split('?').next().unwrap_or(path);
    let dir = match base_path.rfind('/') {
        Some(index) => &base_path[..=index],
        None => "/",
    };
    Some(format!(
        "{scheme}://{authority}{}",
        normalize_path(&format!("{dir}{location}"))
    ))
}

/// 把一段 HTML 变成能读的正文：去掉标签与脚本样式、解实体、按块级标签换行、
/// 折叠空白。
///
/// **不做**：字符集探测、表格对齐、链接展开。这三件都要么需要外部知识，
/// 要么会让输出比原文更难读 —— 模型要的是"这一页说了什么"
pub(crate) fn html_to_text(html: &str) -> String {
    // 小写副本只用来找标签名与 `</script>`：ASCII 小写不改变字节长度，
    // 所以它的下标可以直接切原文（UTF-8 多字节字符不受影响）
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() / 2);
    let mut index = 0;

    while index < html.len() {
        let Some(offset) = html[index..].find('<') else {
            out.push_str(&html[index..]);
            break;
        };
        let start = index + offset;
        out.push_str(&html[index..start]);

        // `<` 后面不是字母 / `/` / `!` / `?` 的，它不是标签（正文里的 `a < b`）。
        // 当标签丢掉的话，从这里到下一个 `>` 之间的一整段字会消失 ——
        // 而那一段往往正是"小于号后面那句话"
        let next = html[start + 1..].chars().next();
        if !matches!(next, Some(c) if c.is_ascii_alphabetic() || c == '/' || c == '!' || c == '?') {
            out.push('<');
            index = start + 1;
            continue;
        }

        let Some(close_offset) = html[start..].find('>') else {
            // 没有闭合的尖括号：剩下的都当文本，别把后半页吞掉
            out.push_str(&html[start..]);
            break;
        };
        let close = start + close_offset;
        let inner = &lower[start + 1..close];
        index = close + 1;

        // 注释 / doctype / 处理指令
        if inner.starts_with('!') || inner.starts_with('?') {
            continue;
        }
        let name_start = usize::from(inner.starts_with('/'));
        let rest = &inner[name_start..];
        let name_len = rest
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(rest.len());
        let name = &rest[..name_len];
        if name.is_empty() {
            continue;
        }

        // 脚本与样式整段丢掉：它们的字不是正文，而且往往是最长的一段
        if name == "script" || name == "style" {
            let closing = format!("</{name}");
            let Some(found) = lower[index..].find(&closing) else {
                break;
            };
            let after = index + found;
            match lower[after..].find('>') {
                Some(end) => index = after + end + 1,
                None => break,
            }
            continue;
        }

        if is_block(name) {
            out.push('\n');
        } else if is_cell(name) {
            // 表格单元格之间空一格：换行会把一张表拆成竖条
            out.push(' ');
        }
    }

    collapse(&decode_entities(&out))
}

/// 按 `content-type` 决定要不要把 HTML 转文本；纯文本原样返回（只折叠空白）
pub(crate) fn text_of(content_type: &str, body: &str) -> String {
    if looks_html(content_type) || looks_like_html(body) {
        return html_to_text(body);
    }
    collapse(body)
}

/// `content-type` 缺失或写错时，看开头几个字节。**只认两种签名**，
/// 免得把一篇以 `<` 开头的普通文本（比如 XML 片段之外的笔记）误当网页
fn looks_like_html(body: &str) -> bool {
    let head = body.trim_start().to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

/// 按**字符**截断（不是字节）：中文与 emoji 被切在中间会变成替换符
pub(crate) fn take_chars(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        None => (text.to_string(), false),
        Some((index, _)) => (text[..index].to_string(), true),
    }
}

// ---------------------------------------------------------------------------
// 内部：URL 拆装、HTML 分块、实体解码、空白折叠
// ---------------------------------------------------------------------------

/// `scheme://authority/path` 三段。只认 http/https，别的返回 `None`
fn split(url: &str) -> Option<(&str, &str, &str)> {
    let lower = url.to_ascii_lowercase();
    let (scheme, after) = if lower.starts_with("https://") {
        ("https", &url[8..])
    } else if lower.starts_with("http://") {
        ("http", &url[7..])
    } else {
        return None;
    };
    if after.is_empty() {
        return None;
    }
    match after.find('/') {
        Some(index) => Some((scheme, &after[..index], &after[index..])),
        None => Some((scheme, after, "/")),
    }
}

/// `foo:bar` 这种形状：冒号前面是合法的协议名
fn has_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let name = &value[..colon];
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
}

/// 把路径里的 `.` / `..` 消掉，保留 query。**不处理百分号编码**（不改变语义）
fn normalize_path(raw: &str) -> String {
    let (path, suffix) = match raw.find('?') {
        Some(index) => (&raw[..index], &raw[index..]),
        None => (raw, ""),
    };

    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }

    let mut out = String::from("/");
    out.push_str(&segments.join("/"));
    if path.ends_with('/') && !out.ends_with('/') {
        out.push('/');
    }
    out.push_str(suffix);
    out
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "br"
            | "hr"
            | "li"
            | "ul"
            | "ol"
            | "dl"
            | "dt"
            | "dd"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "nav"
            | "aside"
            | "main"
            | "blockquote"
            | "pre"
            | "table"
            | "tr"
            | "form"
            | "title"
    )
}

fn is_cell(name: &str) -> bool {
    matches!(name, "td" | "th")
}

/// 常见实体。**只认这几个**：网页正文里 99% 是它们，其余（`&foo;`）原样留着 ——
/// 猜错了会把一段正常文字改成别的字符
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while let Some(offset) = text[index..].find('&') {
        let start = index + offset;
        out.push_str(&text[index..start]);

        // 实体最长也就 8 个字符（`&hellip;`），窗口开 10 够用；
        // 找不到分号就当它是个普通的 &，把"&"本身推出去
        let Some(semi) = text[start..].find(';').filter(|at| *at <= 10) else {
            out.push('&');
            index = start + 1;
            continue;
        };
        let entity = &text[start + 1..start + semi];
        match decode_one(entity) {
            Some(ch) => out.push(ch),
            None => {
                out.push('&');
                out.push_str(entity);
                out.push(';');
            }
        }
        index = start + semi + 1;
    }
    out.push_str(&text[index.min(text.len())..]);
    out
}

fn decode_one(entity: &str) -> Option<char> {
    let named = match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        "mdash" => Some('—'),
        "ndash" => Some('–'),
        "hellip" => Some('…'),
        "lsquo" => Some('‘'),
        "rsquo" => Some('’'),
        "ldquo" => Some('“'),
        "rdquo" => Some('”'),
        "copy" => Some('©'),
        "middot" => Some('·'),
        "times" => Some('×'),
        _ => None,
    };
    if named.is_some() {
        return named;
    }

    let code = entity.strip_prefix('#')?;
    let value = match code.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => code.parse::<u32>().ok()?,
    };
    char::from_u32(value)
}

/// 折叠空白：一行内的连续空白变一个空格，行首行尾去掉，空行丢掉
fn collapse(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let mut line = String::new();
        let mut pending_space = false;
        for ch in raw.chars() {
            if ch.is_whitespace() {
                if !line.is_empty() {
                    pending_space = true;
                }
                continue;
            }
            if pending_space {
                line.push(' ');
                pending_space = false;
            }
            line.push(ch);
        }
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirects_are_the_ones_with_a_single_target() {
        for status in [301, 302, 303, 307, 308] {
            assert!(is_redirect(status), "{status} should be followed");
        }
        for status in [200, 203, 300, 304, 400, 404, 500] {
            assert!(!is_redirect(status), "{status} should not be followed");
        }
    }

    #[test]
    fn an_absolute_location_is_used_as_is() {
        assert_eq!(
            resolve("https://a.example/news/1", "https://b.example/x"),
            Some("https://b.example/x".to_string())
        );
    }

    #[test]
    fn a_protocol_relative_location_keeps_the_scheme() {
        assert_eq!(
            resolve("https://a.example/news", "//cdn.example/app.js"),
            Some("https://cdn.example/app.js".to_string())
        );
    }

    #[test]
    fn a_root_relative_location_replaces_the_whole_path() {
        assert_eq!(
            resolve("https://a.example/news/2026/10", "/login?next=/news"),
            Some("https://a.example/login?next=/news".to_string())
        );
    }

    #[test]
    fn a_query_only_location_keeps_the_path() {
        assert_eq!(
            resolve("https://a.example/items?page=1", "?page=2"),
            Some("https://a.example/items?page=2".to_string())
        );
    }

    #[test]
    fn a_relative_location_is_resolved_against_the_directory() {
        assert_eq!(
            resolve("https://a.example/news/2026/index.html", "about.html"),
            Some("https://a.example/news/2026/about.html".to_string())
        );
        assert_eq!(
            resolve("https://a.example/news/2026/index.html", "../about.html"),
            Some("https://a.example/news/about.html".to_string())
        );
    }

    #[test]
    fn dot_segments_never_escape_the_root() {
        assert_eq!(
            resolve("https://a.example/x", "../../../../etc/passwd"),
            Some("https://a.example/etc/passwd".to_string())
        );
    }

    #[test]
    fn a_fragment_is_not_a_new_page() {
        assert_eq!(resolve("https://a.example/x", "#section-2"), None);
    }

    #[test]
    fn a_non_http_scheme_is_not_followed() {
        assert_eq!(resolve("https://a.example/x", "javascript:alert(1)"), None);
        assert_eq!(resolve("https://a.example/x", "mailto:a@b.example"), None);
        assert_eq!(resolve("https://a.example/x", ""), None);
    }

    #[test]
    fn a_relative_location_with_a_bad_base_is_refused() {
        assert_eq!(resolve("file:///C:/x.html", "/login"), None);
    }

    #[test]
    fn script_and_style_bodies_are_dropped() {
        let html = "<html><head><style>.a{color:red}</style></head><body><script>var secret = 1;</script><p>Hello <b>there</b></p></body></html>";
        let text = html_to_text(html);
        assert_eq!(text, "Hello there");
        assert!(!text.contains("secret"));
        assert!(!text.contains("color"));
    }

    #[test]
    fn block_tags_become_line_breaks() {
        let text = html_to_text("<div>one</div><div>two</div><p>three</p>");
        assert_eq!(text, "one\ntwo\nthree");
    }

    #[test]
    fn inline_tags_do_not_split_words() {
        assert_eq!(html_to_text("<p>Wo<b>rd</b>s</p>"), "Words");
    }

    #[test]
    fn entities_are_decoded() {
        let text = html_to_text("<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x4f60;&#22909; &hellip;</p>");
        assert_eq!(text, "a & b <c> \"d\" 'e' 你好 …");
    }

    #[test]
    fn an_unknown_entity_is_left_alone() {
        assert_eq!(html_to_text("<p>&nosuch; &amp;</p>"), "&nosuch; &");
    }

    #[test]
    fn table_cells_stay_on_one_line() {
        let text = html_to_text("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>");
        assert_eq!(text, "a b\nc d");
    }

    #[test]
    fn a_broken_tag_does_not_swallow_the_page() {
        let text = html_to_text("<p>one</p><p>two < three</p>");
        assert_eq!(text, "one\ntwo < three");
    }

    #[test]
    fn plain_text_is_not_treated_as_html() {
        assert_eq!(text_of("text/plain; charset=utf-8", "a < b\n\nc"), "a < b\nc");
        assert_eq!(text_of("", "plain words"), "plain words");
    }

    #[test]
    fn a_missing_content_type_still_recognises_html() {
        assert_eq!(text_of("", "<!doctype html><p>hi</p>"), "hi");
        assert_eq!(text_of("", "<HTML><p>hi</p></HTML>"), "hi");
    }

    #[test]
    fn taking_chars_never_cuts_a_character_in_half() {
        let (text, cut) = take_chars("一二三四五", 2);
        assert_eq!(text, "一二");
        assert!(cut);
        let (text, cut) = take_chars("一二三四五", 5);
        assert_eq!(text, "一二三四五");
        assert!(!cut);
        let (text, cut) = take_chars("一二", 0);
        assert_eq!(text, "");
        assert!(cut);
    }

    #[test]
    fn max_chars_is_clamped_to_a_sane_window() {
        assert_eq!(charset_limit(None), MAX_TEXT_CHARS);
        assert_eq!(charset_limit(Some(1)), MIN_TEXT_CHARS);
        assert_eq!(charset_limit(Some(5_000)), 5_000);
        assert_eq!(charset_limit(Some(usize::MAX)), MAX_TEXT_LIMIT);
    }
}
