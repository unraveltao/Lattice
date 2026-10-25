//! 文件那几只手的**纯逻辑**：路径归一化、二进制判定、行与字的额度、跳过表。
//!
//! 不引 crate（`rustc --test` 要能单跑）。真正碰磁盘的在 `hands.rs`。
//!
//! # 额度不是建议
//!
//! 这个助手会去读用户随手指的路径，而"随手指的"里包含 2 GB 的日志和 `.dmp`。
//! 所以三处都有硬上限，而且**超了要说"截断了"** —— 静默截断比读不完整更糟：
//! 模型会以为它看完了整个文件，然后基于半份内容改代码。

/// 单个文件最多读这么多字节（超了直接拒绝，不读了再截）
pub const MAX_READ_BYTES: u64 = 4 << 20;

/// `file.write` 一次最多写这么多字节
pub const MAX_WRITE_BYTES: usize = 2 << 20;

/// 一次默认读多少行，以及不管参数怎么给都不超过多少行
pub const READ_MAX_LINES: usize = 200;
pub const READ_HARD_MAX_LINES: usize = 4_000;

/// 一次返回的正文最多多少**字符**（不是字节：中文三字节一个字，按字节算会把
/// 一段正常的中文代码判成"太长"）
pub const READ_MAX_CHARS: usize = 40_000;

/// `file.list` 一次最多列多少条
pub const LIST_MAX: usize = 500;

/// `file.search` 的三道上限：访问多少文件、单文件多大、返回多少条命中
pub const SEARCH_MAX_FILES: usize = 5_000;
pub const SEARCH_MAX_BYTES: u64 = 1 << 20;
pub const SEARCH_MAX_MATCHES: usize = 100;

/// 命中那一行的摘要长度（够看清上下文，不够把整份文件带进上下文）
pub const SEARCH_LINE_CHARS: usize = 240;

/// 搜索时整棵跳过的目录。**不是"性能优化"，是正确性**：`node_modules` 里
/// 同名符号有几千份，模型会把第三方的实现当成本仓库的答案
pub const SKIP_DIRS: [&str; 12] = [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
];

/// 路径归一化：去空白、剥引号（从资源管理器复制来的路径带引号）、拒空、拒 `\0`。
///
/// **不解析 `..`、不展开 `~`**：这里不判断"能不能碰"，只把用户/模型给的那串
/// 变成能交给 `std::fs` 的样子。越界判定在 `path_is_under`，而且只在需要
/// "相对工作目录"的少数地方用。
pub fn normalize_path(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    let text = text
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| text.strip_prefix('\'').and_then(|rest| rest.strip_suffix('\'')))
        .unwrap_or(text)
        .trim();
    if text.is_empty() {
        return Err("\"path\" must not be empty".to_string());
    }
    if text.contains('\0') {
        return Err("\"path\" must not contain a NUL byte".to_string());
    }
    Ok(text.to_string())
}

/// 看起来像二进制就别往上下文里塞。判据只看头部 1 KB 里的 NUL ——
/// UTF-16 的文件会被误判，但它读出来本来也是满屏 NUL，误判得对
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(1024).any(|byte| *byte == 0)
}

/// 从 `offset` 开始取最多 `limit` 行，同时守住字符额度。
///
/// 返回 `(正文, 取到的行数, 是不是还有没取的)`。**行号从 0 数**：给模型的
/// `offset` 也是 0 起，界面上再换算成 1 起（换算错一格，模型就会去改错行）。
pub fn take_lines(text: &str, offset: usize, limit: usize) -> (String, usize, bool) {
    let limit = limit.clamp(1, READ_HARD_MAX_LINES);
    let mut out = String::new();
    let mut taken = 0usize;
    let mut truncated = false;
    for (index, line) in text.lines().enumerate() {
        if index < offset {
            continue;
        }
        if taken >= limit || out.len() + line.len() > READ_MAX_CHARS {
            truncated = true;
            break;
        }
        if taken > 0 {
            out.push('\n');
        }
        out.push_str(line);
        taken += 1;
    }
    (out, taken, truncated)
}

/// 按**字符**截断（不是字节）：切在多字节序列中间会得到替换符，
/// 而模型看到的那半个字就是"读出来是乱码"的来源
pub fn clip(text: &str, max_chars: usize) -> (String, bool) {
    let mut out = String::new();
    for (count, ch) in text.chars().enumerate() {
        if count >= max_chars {
            return (out, true);
        }
        out.push(ch);
    }
    (out, false)
}

/// 命中行摘要：单行化 + 截断 + 省略号。返回值**不再带换行**以外的空白，
/// 因为搜索结果是一行一条，多行会把上下文撑乱
pub fn clip_line(text: &str, max_chars: usize) -> String {
    let collapsed = text.replace(['\t', '\r'], " ").trim().to_string();
    let (mut clipped, cut) = clip(&collapsed, max_chars);
    if cut {
        clipped.push('…');
    }
    clipped
}

/// 这层目录要不要跳过（Windows 上大小写不敏感，比之前先转小写）
pub fn should_skip_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SKIP_DIRS.contains(&lower.as_str())
}

/// `path` 是不是在 `root` 这棵子树里。**按段比，不比字符串前缀**：
/// `C:\work2` 的字符串前缀是 `C:\work`，但它是另一个目录。
/// 两种分隔符都归一成 `\`：模型给的路径常常是 `/` 混着 `\`
pub fn path_is_under(path: &str, root: &str) -> bool {
    let path = path.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let root = root.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    if root.is_empty() {
        return false;
    }
    path == root || path.starts_with(&format!("{root}\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pasted_path_loses_its_quotes() {
        // 从资源管理器"复制为路径"拿到的是带引号的
        assert_eq!(normalize_path("  \"C:\\work\\a.txt\"  ").unwrap(), "C:\\work\\a.txt");
        assert_eq!(normalize_path("'C:\\work\\b.txt'").unwrap(), "C:\\work\\b.txt");
        assert_eq!(normalize_path("C:\\work\\c.txt").unwrap(), "C:\\work\\c.txt");
    }

    #[test]
    fn an_empty_path_is_refused() {
        assert!(normalize_path("   ").is_err());
        assert!(normalize_path("\"\"").is_err());
    }

    #[test]
    fn a_nul_byte_is_refused() {
        // `std::fs` 拿到带 NUL 的路径会直接 panic 在 FFI 层
        assert!(normalize_path("C:\\a\0b").is_err());
    }

    #[test]
    fn a_text_file_is_not_binary() {
        assert!(!looks_binary("hello\nworld".as_bytes()));
        assert!(!looks_binary("中文".as_bytes()));
        assert!(!looks_binary(&[]));
    }

    #[test]
    fn a_file_with_a_nul_byte_is_binary() {
        assert!(looks_binary(b"PK\x03\x04\0\0\0\0"));
        // 只看头部 1 KB：1 KB 之后才有 NUL 的文件仍当文本（可能是长文本里夹了一个）
        let mut bytes = vec![b'a'; 2048];
        bytes[1500] = 0;
        assert!(!looks_binary(&bytes));
    }

    #[test]
    fn take_lines_honours_offset_and_limit() {
        let text = "a\nb\nc\nd\ne\n";
        assert_eq!(take_lines(text, 0, 2), ("a\nb".to_string(), 2, true));
        assert_eq!(take_lines(text, 2, 2), ("c\nd".to_string(), 2, true));
        assert_eq!(take_lines(text, 3, 10), ("d\ne".to_string(), 2, false));
    }

    #[test]
    fn take_lines_past_the_end_is_empty_but_not_an_error() {
        // 模型偶尔会把 offset 给大：回空让它自己发现，而不是报错整轮崩
        assert_eq!(take_lines("a\nb", 99, 10), (String::new(), 0, false));
    }

    #[test]
    fn take_lines_stops_at_the_char_budget() {
        let line = "x".repeat(10_000);
        let text = format!("{line}\n{line}\n{line}\n{line}\n{line}\n");
        let (body, taken, truncated) = take_lines(&text, 0, 200);
        assert!(truncated);
        assert_eq!(taken, 3, "40k 字 / 每条 10k 字 = 3 条多一点");
        assert!(body.chars().count() <= READ_MAX_CHARS);
    }

    #[test]
    fn take_lines_never_splits_a_character() {
        let text = "中文中文\n中文";
        let (body, _, _) = take_lines(text, 0, 10);
        assert_eq!(body, text);
        // 额度边上也不会出现半个字：`String` 本身保证，这里钉的是"没按字节切"
        let (clipped, cut) = clip(&"中".repeat(10), 3);
        assert_eq!(clipped, "中中中");
        assert!(cut);
    }

    #[test]
    fn clip_reports_whether_it_cut() {
        assert_eq!(clip("abcd", 4), ("abcd".to_string(), false));
        assert_eq!(clip("abcde", 4), ("abcd".to_string(), true));
    }

    #[test]
    fn clip_line_collapses_tabs_and_marks_the_cut() {
        assert_eq!(clip_line("\t  let x = 1;  ", 80), "let x = 1;");
        let long = "y".repeat(50);
        let clipped = clip_line(&long, 10);
        assert!(clipped.ends_with('…'));
        assert_eq!(clipped.chars().count(), 11);
    }

    #[test]
    fn build_outputs_are_skipped() {
        for name in [".git", "node_modules", "Target", "dist", "__pycache__"] {
            assert!(should_skip_dir(name), "{name} should be skipped");
        }
        for name in ["src", "docs", "public", "tests"] {
            assert!(!should_skip_dir(name), "{name} should not be skipped");
        }
    }

    #[test]
    fn under_is_compared_by_segment() {
        assert!(path_is_under("C:\\work\\a\\b", "C:\\work"));
        assert!(path_is_under("c:/work/a", "C:\\Work"));
        assert!(path_is_under("C:\\work", "C:\\work"));
        // 字符串前缀相同但不是同一棵子树
        assert!(!path_is_under("C:\\work2\\a", "C:\\work"));
        assert!(!path_is_under("C:\\other", "C:\\work"));
        assert!(!path_is_under("C:\\work", ""));
    }

    #[test]
    fn the_quotas_are_internally_consistent() {
        // 读的上限要比"能塞进上下文"大：否则大文件永远读得完却装不下
        assert!(READ_MAX_CHARS >= READ_MAX_LINES * 40);
        assert!(READ_HARD_MAX_LINES > READ_MAX_LINES);
        assert!(SEARCH_MAX_MATCHES > 0 && SEARCH_MAX_FILES > SEARCH_MAX_MATCHES);
        assert!((MAX_READ_BYTES as usize) >= MAX_WRITE_BYTES);
    }
}
