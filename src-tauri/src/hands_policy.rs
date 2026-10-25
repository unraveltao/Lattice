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
}
