//! `shell.run` 的**纯逻辑**：超时怎么夹、命令形状、输出怎么截。
//!
//! 不引 crate（`rustc --test` 要能单跑），也不 import 别的 policy 文件 ——
//! 它要能被单独 `#[path]` 进一个壳子里跑（见 AGENTS §11）。
//!
//! # 这里不判断"命令危不危险"
//!
//! 判断不了。`Remove-Item` 和 `Get-ChildItem` 的差别不在字符串里，而在参数、
//! 变量、管道、脚本文件里 —— 任何"危险命令黑名单"都能被一行 `& $x` 绕过。
//! 所以这一层的职责只是**形状**：非空、不太长、没有 NUL；危险与否交给审批
//! （用户看得见完整命令，然后点 Allow）。

/// 不传超时（或者传了 0）时的默认值。一分钟足够 `cargo check` 之外的大多数事
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;

/// 下限：500ms 会让 `pwsh` 连启动都来不及，用户看到的是永久的 `timedOut`
pub const MIN_TIMEOUT_MS: u64 = 1_000;

/// 上限：五分钟。再长的活应该让用户自己在终端里跑 —— 这个助手是"顺手做点事"，
/// 不是 CI
pub const MAX_TIMEOUT_MS: u64 = 300_000;

/// 一条命令最长多少字符
pub const MAX_COMMAND_CHARS: usize = 8_000;

/// stdout / stderr 各自最多返回多少字符
pub const MAX_OUTPUT_CHARS: usize = 16_000;

/// 把模型给的时间夹进 `MIN..=MAX`。**夹，不拒绝**：一个 600 秒的请求最可能是
/// 模型算错了，按上限跑仍然有意义；直接拒绝只会让它重试一次、再算错一次
pub fn clamp_timeout(requested: Option<u64>) -> u64 {
    match requested {
        Some(ms) if ms > 0 => ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
        _ => DEFAULT_TIMEOUT_MS,
    }
}

/// 命令形状。返回去掉首尾空白的命令 —— 后面要拿它拼审计的 `detail`
pub fn command_ok(command: &str) -> Result<String, String> {
    let text = command.trim();
    if text.is_empty() {
        return Err("\"command\" must not be empty".to_string());
    }
    if text.contains('\0') {
        return Err("\"command\" must not contain a NUL byte".to_string());
    }
    // `\r` 会让有些解析器把命令截断成两半：前半段执行、后半段丢掉，
    // 而用户看到的命令是完整的
    if text.contains('\r') {
        return Err("\"command\" must use \\n for line breaks, not \\r".to_string());
    }
    if text.chars().count() > MAX_COMMAND_CHARS {
        return Err(format!(
            "\"command\" may hold at most {MAX_COMMAND_CHARS} characters"
        ));
    }
    Ok(text.to_string())
}

/// 截输出。**在行边界上切**：切在半个 token 上会让模型读到 `cargo che`
/// 然后开始猜；切在整行上，它至少知道自己看到的是完整的一句话
pub fn truncate_output(text: &str, max_chars: usize) -> (String, bool) {
    let mut out = String::new();
    let mut used = 0usize;
    for line in text.lines() {
        // +1 是那一行的换行
        if used + line.chars().count() + 1 > max_chars {
            // 第一行就超了（常见于一条 JSON）：整条丢掉等于什么都没返回，
            // 那种情况按字切，至少让模型看见前面一段
            if used == 0 {
                let clipped: String = line.chars().take(max_chars).collect();
                return (clipped, true);
            }
            return (out, true);
        }
        if used > 0 {
            out.push('\n');
        }
        out.push_str(line);
        used += line.chars().count() + 1;
    }
    (out, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_timeout_takes_the_default() {
        assert_eq!(clamp_timeout(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(0)), DEFAULT_TIMEOUT_MS);
    }

    #[test]
    fn a_short_timeout_is_lifted_to_the_floor() {
        // 否则 `pwsh` 还没起来就被判超时，用户以为命令坏了
        assert_eq!(clamp_timeout(Some(1)), MIN_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(50)), MIN_TIMEOUT_MS);
    }

    #[test]
    fn a_long_timeout_is_capped() {
        assert_eq!(clamp_timeout(Some(600_000)), MAX_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(MAX_TIMEOUT_MS)), MAX_TIMEOUT_MS);
    }

    #[test]
    fn an_empty_command_is_refused() {
        assert!(command_ok("   \n  ").is_err());
    }

    #[test]
    fn a_command_is_trimmed() {
        assert_eq!(command_ok("  ls  ").unwrap(), "ls");
        assert_eq!(command_ok("Get-ChildItem\n").unwrap(), "Get-ChildItem");
    }

    #[test]
    fn a_carriage_return_is_refused() {
        // 有的 shell 会把 `\r` 之前的那段当完整命令 —— 用户看见的却是整行
        assert!(command_ok("echo a\r echo b").is_err());
        assert!(command_ok("echo a\n echo b").is_ok());
    }

    #[test]
    fn a_huge_command_is_refused_but_a_big_one_is_fine() {
        assert!(command_ok(&"x".repeat(MAX_COMMAND_CHARS)).is_ok());
        assert!(command_ok(&"x".repeat(MAX_COMMAND_CHARS + 1)).is_err());
    }

    #[test]
    fn a_single_huge_line_is_still_worth_something() {
        // 一条 30k 的 JSON 没有换行：整条丢掉等于"命令跑了但什么都没返回"
        let (kept, cut) = truncate_output(&"z".repeat(50), 10);
        assert!(cut);
        assert_eq!(kept.chars().count(), 10);
    }

    #[test]
    fn output_is_cut_on_a_line_boundary() {
        let text = "one\ntwo\nthree\nfour\n";
        let (kept, cut) = truncate_output(text, 10);
        assert!(cut);
        assert_eq!(kept, "one\ntwo");
        let (kept, cut) = truncate_output(text, 100);
        assert!(!cut);
        assert_eq!(kept, "one\ntwo\nthree\nfour");
    }
}
