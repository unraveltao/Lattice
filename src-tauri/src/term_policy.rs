//! 终端组件（`lattice.term`）的**纯逻辑**：一条命令怎么变成一行 stdin、哨兵怎么切、
//! 输出怎么流、怎么截。
//!
//! 不引 crate（`rustc --test` 要能单跑），也不 import 别的 policy 文件。
//! 执行那一半在 `term.rs`，这里只放"给定字节，应该得到什么"。
//!
//! # 为什么命令要过 base64
//!
//! 实测（这台机器，2026-10-26）：`powershell -Command -` 的 **stdin 按 OEM 代码页
//! 解码**（没有控制台时就是 437）。直接写中文命令进去，PowerShell 收到的是一串
//! `Σ╕¡µûç` —— 命令跑了，但跑的是另一个字符串。
//! `[Console]::InputEncoding` 在运行时改不了已经在读的那个 reader（试过）。
//!
//! 所以走一条 ASCII 通道：命令先按 UTF-8 编成 base64，作为一段**纯 ASCII** 的
//! 脚本行喂进去，PowerShell 那边解回来再 `Invoke-Expression`。中文路径、中文参数、
//! 中文输出全部正常，代价是错误信息里多一行 wrapper（见 PITFALLS）。
//!
//! # 哨兵为什么不是设计稿里那一行
//!
//! 设计稿写的是 `Write-Output "`u{1E}LATTICE:<id>"`。两处按实测改了：
//!
//! 1. **`` `u{1E} `` 只有 PowerShell 7 认**。Windows 自带的 5.1 里它是一个字面量
//!    —— 实测打出来是 7 个字节 `u{1E}`，哨兵永远匹配不上，卡片会一直转圈。
//!    改用 `[char]0x1E`，两个版本都对。
//! 2. **哨兵单独一行，不拼 `; ` 在同一条命令后面**。命令以行注释结尾时
//!    （`git status # 看一眼`），`; Write-Output …` 整段会进注释，这一条永远
//!    等不到结束标记。单独一行既不进注释，也不改变 `$?` 的归属。
//!
//! 哨兵行还顺手带两样东西：退出码和当前目录。前者让卡片能说"失败（退出码 3）"，
//! 后者让提示符跟着 `cd` 走 —— 都是 `term.state` 要答的字段。

/// 一条命令的输出上限（字节）。超过就丢弃并标记 `truncated`，
/// 但**继续读**：不读的话子进程写满管道会卡死（`hands.rs::drain` 同一条规矩）
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// 哨兵的前缀。`\u{1e}` 是 ASCII 的记录分隔符 —— 正常输出里不会出现它
pub const SENTINEL_PREFIX: &str = "\u{1e}LATTICE:";

/// 每实例最多留多少条已发事件给"窗口藏起来之后回来补"用
pub const RING_EVENTS: usize = 512;

/// 补发缓冲最多占多少字节（只算输出正文）
pub const RING_BYTES: usize = 200 * 1024;

/// 命令的编号：`c1`、`c2`……。进哨兵，所以只能用 ASCII 字母数字
pub fn command_id(seq: u64) -> String {
    format!("c{seq}")
}

/// 启动时先喂进去的那一行：输出编码。
///
/// `[Console]::OutputEncoding` 管的是"PowerShell 往管道里写什么编码" ——
/// Windows PowerShell 5.1 默认按控制台代码页（这台机器上是 GBK）写，
/// 中文会变成一串问号。`$OutputEncoding` 管的是"喂给下一个程序的那一段"，
/// 两个都设上才不会只对一半（和 `hands.rs` 的 `shell_run` 同一条判据）。
pub fn preamble() -> &'static str {
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8"
}

/// 哨兵行：先存 `$?` 和 `$LASTEXITCODE`，再打一行带编号的标记。
///
/// `$?` 是**用户那条命令**的成功与否（这一行在它后面，所以看到的是它留下的值）。
/// 原生命令失败时才有可信的 `$LASTEXITCODE`；cmdlet 失败时它**还是上一条原生
/// 命令留下的旧值**，直接拿来用会让卡片报一个别人的退出码（实测：`cmd /c exit 3`
/// 之后 `Get-Item C:\nope` 报 3）。所以只在这个值**相对上一条命令变了**时才采信，
/// 否则落到 1。上一轮的值由本行末尾那句记下 —— 哨兵自己不改 `$LASTEXITCODE`。
/// `:` 后面接当前目录 —— 提示符要它。
pub fn sentinel_line(id: &str) -> String {
    format!(
        "$__lt_ok = $?; $__lt_code = $LASTEXITCODE; $__rs = [char]0x1E; \
         Write-Output ($__rs + \"LATTICE:{id}:\" + \
         $(if ($__lt_ok) {{ 0 }} \
           elseif ($__lt_code -is [int] -and $__lt_code -ne 0 -and $__lt_code -ne $__lt_prior) {{ $__lt_code }} \
           else {{ 1 }}) + \
         \":\" + $PWD.Path); $__lt_prior = $LASTEXITCODE"
    )
}

/// 一条命令 → 要塞进 stdin 的那段脚本：命令原文 + 换行 + 哨兵行。
///
/// 多行命令在这条路上是**能跑**的：整段进 `Invoke-Expression`，由它按脚本解析，
/// 块级语句不会被撕成两半（实测 `if (…) { … }` 跨三行正常）。
pub fn script_for(id: &str, command: &str) -> String {
    format!("{command}\n{}", sentinel_line(id))
}

/// 标准 base64。`Invoke-Expression` 那一边用 `[Convert]::FromBase64String` 解，
/// 所以字母表和补位都得是标准的 —— 这里不引 crate，手写四十行
pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let packed = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((packed >> 18) & 63) as usize] as char);
        out.push(TABLE[((packed >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((packed >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(packed & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 真正写进 stdin 的那一行（ASCII）。解码 → 执行，两件事都在 shell 里完成。
///
/// 命令正文在 base64 里，所以这一行**永远是纯 ASCII** —— 不管用户敲了什么。
pub fn wrapper_line(encoded: &str) -> String {
    format!(
        "$__lt_c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')); Invoke-Expression $__lt_c"
    )
}

/// 这一串是不是纯 ASCII。命令能安全地原样进 stdin 时可以直接写，
/// 但 `term.rs` 一律走 base64 —— 留着这个判断是给断言用的
pub fn is_ascii(text: &str) -> bool {
    text.is_ascii()
}

/// 把 `\r\n` 和孤立的 `\r` 都归一成 `\n`。
///
/// 终端里孤立的 `\r` 是"回到行首重画这一行"（进度条、`npm` 的转圈）。组件不会
/// 实现覆盖写，所以按换行处理 —— 至少每次更新都看得见，而不是最后只剩一条。
pub fn normalize_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(ch);
        }
    }
    out
}

/// 缓冲区前面有多少字节可以安全地当成"这一段的输出"发出去。
///
/// 留住的尾巴有两种：可能是一段哨兵的**开头**（`\x1eLATTI…`），或者是一个
/// 从中间被切断的 UTF-8 字符。两者都可能在下一次 read 里补齐 —— 提前发出去
/// 就会看到替换符，或者把哨兵拆成两段谁都不认。
pub fn safe_prefix_len(buf: &[u8], marker: &[u8]) -> usize {
    let max = marker.len().min(buf.len());
    let mut keep = 0usize;
    for len in (1..=max).rev() {
        if buf[buf.len() - len..] == marker[..len] {
            keep = len;
            break;
        }
    }
    let mut end = buf.len() - keep;
    // 退到字符边界：`end` 指着的那一字节如果是续字节，说明这个字符从前面开始。
    // 只在字符中间时才退 —— `end == buf.len()` 是"后面没有东西"，
    // 它到底完不完整由下面那次解码判断
    while end > 0 && end < buf.len() && (buf[end] & 0b1100_0000) == 0b1000_0000 {
        end -= 1;
    }
    match std::str::from_utf8(&buf[..end]) {
        Ok(_) => end,
        // 尾巴上有个没收全的字符：留给下一次 read
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        // 真的坏字节（管道里不该出现）：连它一起发出去，让 lossy 画成替换符，
        // 否则这段缓冲会永远卡在这里，后面的输出全部到不了卡片
        Err(error) => (error.valid_up_to() + error.error_len().unwrap_or(1)).min(end),
    }
}

/// 一次读完的字节里能解的完整 UTF-8 前缀（尾部不完整的字符留给下一次）
pub fn decode_prefix(buf: &[u8]) -> String {
    let end = safe_prefix_len(buf, b"");
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// 哨兵行解出来的两样东西
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
    pub code: Option<i32>,
    pub cwd: String,
}

/// 在缓冲区里找 `id` 的哨兵行。
///
/// 返回 `(标记起点, 这一行之后的位置, 解析出来的 done)`：
/// - 标记起点之前是输出正文；
/// - 第三项取"这一行之后"，是因为 `\r\n` 也要一起吃掉，否则下一段输出
///   开头会多一个空行；
/// - 行还没收完（读到 `\x1eLATTICE:c1:` 就断了）返回 `None` —— 下一轮再试。
pub fn find_done(buf: &[u8], id: &str) -> Option<(usize, usize, Done)> {
    let prefix = format!("{SENTINEL_PREFIX}{id}:");
    let marker = prefix.as_bytes();
    let start = find_bytes(buf, marker)?;
    let rest = &buf[start + marker.len()..];
    let end_of_line = rest.iter().position(|byte| *byte == b'\n')?;
    let mut line = &rest[..end_of_line];
    if line.last() == Some(&b'\r') {
        line = &line[..line.len() - 1];
    }
    let text = String::from_utf8_lossy(line);
    let (code, cwd) = match text.split_once(':') {
        Some((code, cwd)) => (parse_code(code), cwd.to_string()),
        None => (None, text.into_owned()),
    };
    Some((start, start + marker.len() + end_of_line + 1, Done { code, cwd }))
}

fn parse_code(raw: &str) -> Option<i32> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    text.parse::<i32>().ok()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// 截断：这一条已经发出去 `used` 字节，再拿到 `text` 时还能发多少。
///
/// 返回 `(要发的部分, 新的 used, 有没有丢东西)`。丢的时候返回空串，
/// 调用方只把 `truncated` 记上 —— 卡片的"（已截断）"那一行是它画的。
pub fn clamp_chunk(text: &str, used: usize) -> (String, usize, bool) {
    if used >= MAX_OUTPUT_BYTES {
        return (String::new(), used, !text.is_empty());
    }
    let room = MAX_OUTPUT_BYTES - used;
    if text.len() <= room {
        return (text.to_string(), used + text.len(), false);
    }
    // 在字符边界上切，别把最后一个汉字劈成两半
    let mut end = room;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), used + end, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64_encode(b"hi"), "aGk=");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(b""), "");
        // 中文：UTF-8 的四个字节一进一出必须原样回来
        assert_eq!(base64_encode("中".as_bytes()), "5Lit");
    }

    #[test]
    fn the_wrapper_line_is_pure_ascii_even_for_chinese() {
        let script = script_for("c7", "Write-Output '中文测试'");
        let line = wrapper_line(&base64_encode(script.as_bytes()));
        assert!(line.is_ascii(), "wrapper 里有非 ASCII 字节：{line}");
        assert!(line.contains("FromBase64String"));
        assert!(line.contains("Invoke-Expression"));
    }

    #[test]
    fn the_script_is_the_command_then_the_sentinel_on_its_own_line() {
        let script = script_for("c3", "Get-ChildItem # 注释");
        let mut lines = script.lines();
        assert_eq!(lines.next(), Some("Get-ChildItem # 注释"));
        // 关键：哨兵在**下一行**。拼在注释后面会被整段吃掉（见文件头）
        let sentinel = lines.next().expect("哨兵要单独一行");
        assert!(sentinel.starts_with("$__lt_ok"), "哨兵行应以捕获状态开头");
        assert!(sentinel.contains("LATTICE:c3:"));
        assert!(lines.next().is_none(), "一条命令只该追加一行哨兵");
    }

    #[test]
    fn the_sentinel_uses_the_character_escape_not_the_backtick_u_form() {
        // PowerShell 5.1 不认 `u{1E}，会原样打出 u{1E} 七个字节
        let line = sentinel_line("c1");
        assert!(line.contains("[char]0x1E"));
        assert!(!line.contains("u{1E}"));
    }

    #[test]
    fn a_cmdlet_failure_does_not_borrow_the_last_native_code() {
        let line = sentinel_line("c9");
        // 采信 `$LASTEXITCODE` 的前提多了一条：它得和上一条命令留下的不一样
        assert!(line.contains("$__lt_code -ne $__lt_prior"), "要挡住旧值：{line}");
        // 上一轮的值在哨兵**之后**记下 —— 这一行不改 `$LASTEXITCODE`，所以记下的是同一个值；
        // 顺序反了就变成"跟本轮的自己比"，那个条件永远为假，原生命令的码也就丢了
        let snapshot = line
            .find("$__lt_prior = $LASTEXITCODE")
            .expect("要记下这一轮的退出码");
        let marker = line.find("LATTICE:").expect("要有标记");
        assert!(snapshot > marker, "快照要在哨兵之后");
    }

    #[test]
    fn a_sentinel_line_yields_code_and_directory() {
        let buf = b"\x1eLATTICE:c2:0:C:\\Windows\r\ntail";
        let (start, end, done) = find_done(buf, "c2").expect("应该有哨兵");
        assert_eq!(start, 0);
        assert_eq!(&buf[end..], b"tail");
        assert_eq!(done, Done { code: Some(0), cwd: "C:\\Windows".to_string() });
    }

    #[test]
    fn a_native_failure_keeps_its_exit_code() {
        let buf = b"out\x1eLATTICE:c3:3:D:\\x\n";
        let (start, end, done) = find_done(buf, "c3").expect("应该有哨兵");
        assert_eq!(start, 3);
        assert_eq!(&buf[..start], b"out");
        assert_eq!(done.code, Some(3));
        assert_eq!(&buf[end..], b"");
    }

    #[test]
    fn a_directory_with_a_colon_is_kept_whole() {
        // `C:\Program Files` 里那个冒号只出现在第二段之后，别拿第一个冒号切完就扔
        let buf = b"\x1eLATTICE:c4:0:C:\\Program Files\\x\n";
        let (_, _, done) = find_done(buf, "c4").expect("应该有哨兵");
        assert_eq!(done.cwd, "C:\\Program Files\\x");
    }

    #[test]
    fn another_commands_sentinel_is_not_mistaken_for_ours() {
        let buf = b"\x1eLATTICE:c10:0:C:\\x\n\x1eLATTICE:c1:0:C:\\y\n";
        let (start, _, done) = find_done(buf, "c1").expect("c1 的哨兵在后面");
        assert!(start > 0, "c10 不是 c1");
        assert_eq!(done.cwd, "C:\\y");
    }

    #[test]
    fn a_half_read_sentinel_waits_for_the_rest() {
        assert!(find_done(b"\x1eLATTICE:c1", "c1").is_none());
        assert!(find_done(b"\x1eLATTICE:c1:0:C:\\W", "c1").is_none());
    }

    #[test]
    fn the_streaming_prefix_holds_back_a_possible_sentinel() {
        let marker = format!("{SENTINEL_PREFIX}c1:").into_bytes();
        // 输出 + 哨兵的半个开头：只发输出
        let buf = b"hello\x1eLATT".to_vec();
        assert_eq!(safe_prefix_len(&buf, &marker), 5);
        // 纯输出：全发
        assert_eq!(safe_prefix_len(b"hello", &marker), 5);
    }

    #[test]
    fn the_streaming_prefix_does_not_cut_a_character_in_half() {
        let marker = b"\x1eLATTICE:c1:";
        // "中" 是三个字节，这里只有两个 —— 一个都别发
        let bytes = "中".as_bytes();
        assert_eq!(safe_prefix_len(&bytes[..2], marker), 0);
        // 完整的时候三个都发
        assert_eq!(safe_prefix_len(bytes, marker), 3);
        assert_eq!(decode_prefix(bytes), "中");
    }

    #[test]
    fn carriage_returns_become_newlines() {
        assert_eq!(normalize_lines("a\r\nb"), "a\nb");
        assert_eq!(normalize_lines("10%\r20%\r100%"), "10%\n20%\n100%");
        assert_eq!(normalize_lines("already\nfine"), "already\nfine");
    }

    #[test]
    fn output_is_capped_on_a_character_boundary() {
        // 还有 10 字节额度，5 字节的输出整段放得下
        let (kept, used, cut) = clamp_chunk("hello", MAX_OUTPUT_BYTES - 10);
        assert!(!cut);
        assert_eq!(kept, "hello");
        assert_eq!(used, MAX_OUTPUT_BYTES - 5);

        // 放不下的部分丢掉，但最后那个汉字要完整 —— 宁可少三个字节
        let (kept, used, cut) = clamp_chunk(&"中".repeat(40), MAX_OUTPUT_BYTES - 4);
        assert!(cut);
        assert_eq!(used, MAX_OUTPUT_BYTES - 4 + 3, "只发得下一个完整的汉字");
        assert_eq!(kept, "中");
    }

    #[test]
    fn nothing_goes_out_once_the_budget_is_gone() {
        let (kept, used, cut) = clamp_chunk("still talking", MAX_OUTPUT_BYTES);
        assert!(kept.is_empty());
        assert!(cut);
        assert_eq!(used, MAX_OUTPUT_BYTES);
    }
}
