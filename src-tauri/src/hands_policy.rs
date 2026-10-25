//! assistant 的"手"——**纯逻辑**这一半：名字 → 能力组 / 审批档。
//!
//! 为什么单独一份、而且**不引 crate**：这张表决定"模型能不能跑命令"，它必须能在
//! 任何机器上用 `rustc --test` 单跑（`llm_policy.rs` / `agent_policy.rs` 同一条规矩）。
//! 执行在 `hands.rs` 里，那边要碰文件与进程，跑不动也测不细。
//!
//! # 三条判据
//!
//! - **组决定开关**：用户拨的是"文件 / 命令 / 网页 / 屏幕 / 输入 / 外部服务"，
//!   不是逐个工具。少一个开关就多一个用户要理解的概念。
//! - **审批只分两档**：读自动、写与执行必问。中间档（"读也可以问"）没用 ——
//!   一个每步都要点确认的助手，用户会直接去点 `Always this turn`，等于全自动。
//! - **认不出来的名字一律"要问"**：以后新加的手忘了登记，最坏结果是多点一次确认，
//!   而不是静默地全自动跑。

/// 六个能力组。顺序就是设置面板里的顺序
pub const GROUPS: [&str; 6] = ["files", "shell", "web", "screen", "input", "mcp"];

/// 一组开关。**默认全关**：升级上来的用户一条手都没开（见 0004 §5）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Hands {
    pub files: bool,
    pub shell: bool,
    pub web: bool,
    pub screen: bool,
    pub input: bool,
    pub mcp: bool,
}

impl Hands {
    /// 组开着才给模型这张表里的工具（`hands.rs` 里还会再查一次：只靠前端不够）
    pub fn enabled(&self, group: &str) -> bool {
        match group {
            "files" => self.files,
            "shell" => self.shell,
            "web" => self.web,
            "screen" => self.screen,
            "input" => self.input,
            "mcp" => self.mcp,
            _ => false,
        }
    }

    /// 一个都没开。界面用它决定"要不要提一句你现在什么都不能干"
    pub fn none(&self) -> bool {
        GROUPS.iter().all(|group| !self.enabled(group))
    }
}

/// 某个工具属于哪一组。`None` = 不是手（名字拼错了，或者以后加的新工具忘了登记）
pub fn group_of(name: &str) -> Option<&'static str> {
    match name {
        "file.list" | "file.read" | "file.search" | "file.write" => Some("files"),
        "shell.run" => Some("shell"),
        "web.fetch" => Some("web"),
        "screen.windows" | "screen.capture" => Some("screen"),
        "input.click" | "input.type" | "input.key" => Some("input"),
        // MCP 的工具名是服务器给的，所以只能按前缀认 —— 但形状要卡死：
        // `mcp.` 后面必须是"服务器名.工具名"，否则前缀会变成一个任意字符串通道
        _ if name.starts_with("mcp.") => mcp_ok(name).then_some("mcp"),
        _ => None,
    }
}

/// 要不要用户点头。
///
/// **认不出来的名字返回 `true`**：默认放行的话，以后某个新工具忘了登记，
/// 症状是"它自己跑了"，而没人会去查一个没有报错的默认值。
pub fn needs_approval(name: &str) -> bool {
    match name {
        "file.list" | "file.read" | "file.search" => false,
        "web.fetch" | "screen.windows" | "screen.capture" => false,
        "file.write" | "shell.run" | "input.click" | "input.type" | "input.key" => true,
        _ => true,
    }
}

/// 审批档（0003 §3）。**磁盘上就这三个字符串**，别再加别名
pub const APPROVAL_MODES: [&str; 3] = ["ask", "auto", "readonly"];

/// 认不出来一律退回 `ask`。方向是故意的：多问一次是麻烦，少问一次是事故
/// （和 `needs_approval` 对陌生名字返回 `true` 同一条理由）
pub fn normalize_approval(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "auto" => "auto",
        "readonly" => "readonly",
        _ => "ask",
    }
}

/// 只读档该不该拒掉这一次调用。
///
/// 判据**只有一句**：只读档拦的正是 `needs_approval` 为真的那些。前端
/// `approvalFor` 用的是同一句 —— 两边各自维护一份名单，迟早一边漏一个工具，
/// 而漏的那一边正好是"不拦"。
pub fn readonly_blocks(mode: &str, name: &str) -> bool {
    mode == "readonly" && needs_approval(name)
}

// ---------------------------------------------------------------------------
// 全权模式（0006）—— 一次会话级的定时授权
// ---------------------------------------------------------------------------
//
// 它**不是第四档审批**，所以 `APPROVAL_MODES` 一直是那三个字面量。这里只有
// 三个纯函数：时长夹紧、到期判定、开关合并 —— 会话态本身在 `full_access.rs`
// 的 `AtomicU64` 里（那一位只能在这一份文件之外，因为它是进程状态）。

/// 时长档位（分钟）。**没有"永久"**：高权限的价值是"这段时间别烦我"，不是
/// "以后永远别烦我" —— 需要更久就再点一次延长
pub const FULL_ACCESS_MINUTES: [u64; 4] = [15, 30, 60, 120];
/// 面板默认选中的那一档
pub const FULL_ACCESS_DEFAULT_MINUTES: u64 = 30;
/// 一次授权最多多久。夹的是"手滑多打一位数"，不是"用户不能用得久"
pub const FULL_ACCESS_MAX_MINUTES: u64 = 120;

/// 把用户给的分钟夹进 `1..=120`；`0`（没传 / 解析失败）落回默认 30。
///
/// 方向是故意的：**坏值不许放大权限**，和 `normalize_approval` 对陌生值落回
/// `ask` 同一条理由。不夹的话，一个 `3000` 就是 50 小时的全权。
pub fn clamp_full_minutes(raw: u64) -> u64 {
    match raw {
        0 => FULL_ACCESS_DEFAULT_MINUTES,
        minutes => minutes.min(FULL_ACCESS_MAX_MINUTES),
    }
}

/// 全权还剩几毫秒。`until == 0`（从没开过）与已过期都是 `0`。
///
/// 判定只认这一个数：`full_access_active` 就是它 > 0，所以"过期"只有一种解释。
pub fn full_access_remaining(now_ms: u64, until_ms: u64) -> u64 {
    until_ms.saturating_sub(now_ms)
}

/// 全权现在开着吗。**每次调用现算**，不靠一个定时器把状态改掉 ——
/// 面板重挂载、进程被挂起、系统时间被调，都不会留下一个"假的开着"
pub fn full_access_active(now_ms: u64, until_ms: u64) -> bool {
    full_access_remaining(now_ms, until_ms) > 0
}

/// 全权期间的开关：六组临时全开。**返回新值，不改入参** ——
/// 用户存的那一份要能在结束之后原样回来
pub fn effective_hands(hands: Hands, full: bool) -> Hands {
    if !full {
        return hands;
    }
    Hands {
        files: true,
        shell: true,
        web: true,
        screen: true,
        input: true,
        mcp: true,
    }
}

/// 全权能不能盖过这一档。`readonly` **优先**：用户说"别改"之后，
/// 一个还没到期的授权也不许把东西改掉（结束全权是界面的事，这里是兜底）。
/// `mode` 已经是 `normalize_approval` 给过的三个字面量之一
pub fn full_access_overrides(mode: &str, full: bool) -> bool {
    full && mode != "readonly"
}

/// 审计那一栏的"这一笔是在全权下做的"标记。**加在最后**：
/// 目标是 `shell.run · npm test`，标记是 `… · full`，别插到中间去
pub fn mark_full(detail: &str, full: bool) -> String {
    if full {
        format!("{detail} · full")
    } else {
        detail.to_string()
    }
}

/// `mcp.<server>.<tool>` 的形状：两段小写名字，各 1..=32 / 1..=48 字。
///
/// 卡这么死的理由是它要当成**工具名**发给模型，而工具名同时是审计日志里的键：
/// 允许斜杠、点、空格的话，一个恶意服务器可以把 `mcp.evil.placement.remove`
/// 造成和平台自己的工具看着差不多，用户扫一眼分不出来
pub fn mcp_ok(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("mcp.") else {
        return false;
    };
    if rest.len() > 96 {
        return false;
    }
    let mut parts = rest.split('.');
    let (Some(server), Some(tool), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    segment_ok(server, 32) && segment_ok(tool, 48)
}

fn segment_ok(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.len() <= max
        && text
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_group_is_reachable() {
        // 六个组各至少有一个工具：否则界面上会出现一个"拨了也没用"的开关
        for group in GROUPS {
            let reachable = [
                "file.read",
                "shell.run",
                "web.fetch",
                "screen.windows",
                "input.click",
                "mcp.x.y",
            ]
            .iter()
            .any(|name| group_of(name) == Some(group));
            assert!(reachable, "group {group} has no tool");
        }
    }

    #[test]
    fn known_names_map_to_their_group() {
        assert_eq!(group_of("file.read"), Some("files"));
        assert_eq!(group_of("file.write"), Some("files"));
        assert_eq!(group_of("shell.run"), Some("shell"));
        assert_eq!(group_of("web.fetch"), Some("web"));
        assert_eq!(group_of("screen.capture"), Some("screen"));
        assert_eq!(group_of("input.key"), Some("input"));
    }

    #[test]
    fn a_misspelled_name_is_not_a_hand() {
        // 拼错的名字不能落到任何一组：否则它会被当成"这组开着就能跑"
        assert_eq!(group_of("file.reed"), None);
        assert_eq!(group_of("shell"), None);
        assert_eq!(group_of("placement.move"), None);
        assert_eq!(group_of(""), None);
    }

    #[test]
    fn writes_and_exec_and_input_need_approval() {
        assert!(needs_approval("file.write"));
        assert!(needs_approval("shell.run"));
        assert!(needs_approval("input.click"));
        assert!(needs_approval("input.type"));
        assert!(needs_approval("input.key"));
    }

    #[test]
    fn reads_do_not() {
        assert!(!needs_approval("file.read"));
        assert!(!needs_approval("file.list"));
        assert!(!needs_approval("file.search"));
        assert!(!needs_approval("web.fetch"));
        assert!(!needs_approval("screen.windows"));
        assert!(!needs_approval("screen.capture"));
    }

    #[test]
    fn an_unknown_name_is_asked_about() {
        // 默认放行 = 以后新加的手忘了登记就静默全自动，这条是那件事的闸
        assert!(needs_approval("file.delete"));
        assert!(needs_approval("mcp.bad"));
    }

    #[test]
    fn mcp_names_are_shaped_like_namespaces() {
        assert!(mcp_ok("mcp.github.list_issues"));
        assert!(mcp_ok("mcp.my-server.read-file"));
        assert_eq!(group_of("mcp.github.list_issues"), Some("mcp"));
        // MCP 的工具一律要问：服务器随时会升级，它的语义不由我们掌握
        assert!(needs_approval("mcp.github.list_issues"));
    }

    #[test]
    fn mcp_names_cannot_smuggle_a_platform_tool() {
        // `mcp.evil.placement` 的形状其实合法（服务器 evil、工具 placement）——
        // 防"长得像"靠的不是这条规则，而是 `mcp.` 前缀永远在名字开头：
        // 界面上和审计里都一眼能看出它是外部服务给的
        assert!(mcp_ok("mcp.evil.placement"));
        assert_eq!(group_of("mcp.evil.placement"), Some("mcp"));
        // 三段的名字一律不合法：解析 `mcp.<server>.<tool>` 时不能有歧义
        assert!(!mcp_ok("mcp.placement.remove.extra"));
        assert!(group_of("mcp.placement.remove") == Some("mcp"));
    }

    #[test]
    fn mcp_names_reject_loose_shapes() {
        assert!(!mcp_ok("mcp."));
        assert!(!mcp_ok("mcp.only"));
        assert!(!mcp_ok("mcp.a.b.c")); // 只许两段
        assert!(!mcp_ok("mcp..tool")); // 空服务器名
        assert!(!mcp_ok("mcp.Server.Tool")); // 大写：大小写会让审计里出现两个名字
        assert!(!mcp_ok("mcp.a b.c")); // 空格
        assert!(!mcp_ok("mcp.a/.b")); // 斜杠
        assert!(!mcp_ok(&format!("mcp.{}.t", "x".repeat(33)))); // 服务器名过长
    }

    #[test]
    fn hands_start_off() {
        let hands = Hands::default();
        assert!(hands.none());
        for group in GROUPS {
            assert!(!hands.enabled(group));
        }
    }

    #[test]
    fn enabling_a_group_only_touches_that_group() {
        let mut hands = Hands::default();
        hands.files = true;
        assert!(hands.enabled("files"));
        assert!(!hands.enabled("shell"));
        assert!(!hands.none());
    }

    #[test]
    fn an_unknown_group_is_never_enabled() {
        let mut hands = Hands::default();
        hands.files = true;
        hands.shell = true;
        hands.web = true;
        hands.screen = true;
        hands.input = true;
        hands.mcp = true;
        assert!(!hands.enabled("everything"));
        assert!(!hands.enabled(""));
        assert!(!hands.none());
    }

    #[test]
    fn approval_modes_normalize_loosely() {
        assert_eq!(normalize_approval("ask"), "ask");
        assert_eq!(normalize_approval("auto"), "auto");
        assert_eq!(normalize_approval("readonly"), "readonly");
        // 大小写与空白都算同一个人写的
        assert_eq!(normalize_approval(" Auto "), "auto");
        assert_eq!(normalize_approval("READONLY"), "readonly");
        assert_eq!(normalize_approval("ReadOnly"), "readonly");
    }

    #[test]
    fn a_typo_falls_back_to_asking() {
        // 退回 `auto` 就是一次静默提权，所以这里的默认值只有一个方向
        for raw in ["", "  ", "yes", "read-only", "read_only", "off", "no", "1"] {
            assert_eq!(normalize_approval(raw), "ask", "{raw} should fall back to ask");
        }
    }

    #[test]
    fn only_the_three_modes_exist() {
        // 三个字面量是磁盘上的值，也是界面上那三个按钮 —— 加第四个要同时改
        // `runtime/hands.ts` 的 `APPROVAL_MODES` 和面板
        assert_eq!(APPROVAL_MODES, ["ask", "auto", "readonly"]);
        for mode in APPROVAL_MODES {
            assert_eq!(normalize_approval(mode), mode);
        }
    }

    #[test]
    fn readonly_blocks_exactly_the_writes() {
        // 判据只有一句：只读档拦的正是 `needs_approval` 为真的那些
        assert!(readonly_blocks("readonly", "file.write"));
        assert!(readonly_blocks("readonly", "shell.run"));
        assert!(readonly_blocks("readonly", "input.click"));
        assert!(readonly_blocks("readonly", "mcp.github.list_issues"));
        assert!(!readonly_blocks("readonly", "file.read"));
        assert!(!readonly_blocks("readonly", "web.fetch"));
        // 另外两档一律不拦 —— `ask` 是"问"，问在执行前，不在 Rust 这层
        for mode in ["ask", "auto"] {
            assert!(!readonly_blocks(mode, "file.write"));
            assert!(!readonly_blocks(mode, "shell.run"));
        }
    }

    // ---- 全权（0006）----

    #[test]
    fn full_access_minutes_are_clamped_short() {
        // 坏值一律往短里夹：`0` 是"看着开了其实立刻到期"，`3000` 是 50 小时
        assert_eq!(clamp_full_minutes(0), FULL_ACCESS_DEFAULT_MINUTES);
        assert_eq!(clamp_full_minutes(1), 1);
        assert_eq!(clamp_full_minutes(15), 15);
        assert_eq!(clamp_full_minutes(120), 120);
        assert_eq!(clamp_full_minutes(121), FULL_ACCESS_MAX_MINUTES);
        assert_eq!(clamp_full_minutes(3000), FULL_ACCESS_MAX_MINUTES);
        // 默认值自己必须在档位表里，否则界面会显示一个选不中的时长
        assert!(FULL_ACCESS_MINUTES.contains(&FULL_ACCESS_DEFAULT_MINUTES));
        assert_eq!(FULL_ACCESS_MAX_MINUTES, *FULL_ACCESS_MINUTES.iter().max().unwrap());
    }

    #[test]
    fn an_expired_grant_is_the_same_as_not_started() {
        // 「没开过」（0）与「过期了」必须落到同一个答案：否则界面会出现
        // 一个"开着、但剩余时间是 0"的状态，用户没法判断要不要点结束
        assert_eq!(full_access_remaining(1_000, 0), 0);
        assert_eq!(full_access_remaining(1_000, 1_000), 0);
        assert_eq!(full_access_remaining(1_000, 999), 0);
        assert!(!full_access_active(1_000, 0));
        assert!(!full_access_active(1_000, 1_000));
        assert!(!full_access_active(1_000, 1));
    }

    #[test]
    fn a_running_grant_counts_down() {
        assert_eq!(full_access_remaining(1_000, 61_000), 60_000);
        assert!(full_access_active(1_000, 1_001));
        assert!(full_access_active(0, 1));
    }

    #[test]
    fn full_access_turns_every_switch_on_without_touching_the_input() {
        let stored = Hands::default();
        let forced = effective_hands(stored, true);
        for group in GROUPS {
            assert!(forced.enabled(group), "full access should open every group");
        }
        // 入参一动不动：结束之后用户存的那一份必须原样回来
        assert!(stored.none());
        // 没开全权时原样返回（同一个值，不是复制一份）
        let untouched = effective_hands(stored, false);
        assert_eq!(untouched.files, stored.files);
        assert!(untouched.none());
    }

    #[test]
    fn readonly_wins_over_a_grant() {
        // 用户说"别改"之后，一个还没到期的授权不许把东西改掉
        assert!(full_access_overrides("ask", true));
        assert!(full_access_overrides("auto", true));
        assert!(!full_access_overrides("readonly", true));
        // 没开全权时它什么都不盖过 —— 平时的裁决还是 `approvalFor` 那一份
        for mode in APPROVAL_MODES {
            assert!(!full_access_overrides(mode, false));
        }
    }

    #[test]
    fn the_audit_marker_goes_last() {
        // 目标是 `shell.run · npm test`，标记加在最后；插到中间会让人以为
        // "full" 是命令的一部分
        assert_eq!(mark_full("shell.run · npm test", true), "shell.run · npm test · full");
        assert_eq!(mark_full("shell.run · npm test", false), "shell.run · npm test");
        assert_eq!(mark_full("", true), " · full");
    }
}
