//! 能力体检的判据 —— **纯逻辑**；探针在 `capability_probe.rs`，界面在设置页的 Diagnostics。
//!
//! 为什么单独一份、而且**不引 crate**：这台机器跑不了 `cargo test`（安全策略拦
//! `target/debug/deps` 下的 exe），而"哪条事实算哪一条原因"全是纯映射 —— 用
//! `rustc --test` 壳子单独编一遍就能钉住（`hands_policy.rs` / `dictation_policy.rs`
//! 同一条规矩）。探针那半要碰 Win32、COM、文件，跑不动也测不细。
//!
//! # 一条硬规矩：灰了必须说得出为什么
//!
//! `available: false` 而 `reason: null` 是这个功能最坏的形态 —— 界面上就一行灰字，
//! 用户既不知道要装什么，也不知道该找谁。所以这里**不给**"可用的布尔"单独存在的
//! 机会：`Verdict` 里只有 `reason`，`available` 由它算出来（`reason.is_none()`）。
//! 想写"不可用但没原因"，得先把结构体改掉，那一步会绊住人。
//!
//! # 原因是一个码，不是一句话
//!
//! `reason` 是 `snake_case` 的固定集合（`REASONS`），`detail` 才是具体那个名字
//! （缺的命令、坏在哪儿的服务器）。分两截的理由是**双语**：一句话在 Rust 里写死，
//! 中文界面上就会冒出一句英文。码交前端翻（`runtime/capabilities.ts`），和
//! `dictation_status` 的 `reason` 是同一个形状。
//!
//! # 先问开关，再问机器
//!
//! 一组手关着的时候，机器能不能做这件事**不重要** —— 用户要做的是把它打开，
//! 而不是去装 ffmpeg。所以 `switched_off` 排在所有机器判据前面，而且**不带
//! `detail`**：这时候任何技术细节都是噪音。（打开之后的下一次体检会说下一句
//! 真话，两句都是真的。）
//!
//! # 探针只报它真能看见的事
//!
//! 键鼠那组永远是绿的：`SendInput` 没有"能不能用"这个问题，唯一会失败的是
//! "目标窗口比我们高一个完整性级别"（UIPI），那件事**只有目标窗口知道**，
//! 从探针这里看不见。看不见就不假装看得见 —— 这和 `LayerProbeLine` 那条
//! "真话读数"是同一条规矩：读数可以不好看，但不能是编的。

/// 六组手，顺序和 `hands_policy::GROUPS` 一样。
///
/// 这里不 `use crate::hands_policy::GROUPS`：两份文件都要能单独 `rustc --test`。
/// **改一处就要改另一处** —— 顺序错了的症状是"开关拨的是文件，体检说的是屏幕"。
pub const HANDS: [&str; 6] = ["files", "shell", "web", "screen", "input", "mcp"];

/// 一条能力需要机器上的什么。
///
/// 用枚举而不是在 `judge` 里 match 字符串 id：加了新能力必须在这里挑一个，
/// 漏了编译就红。match 一个 `&'static str` 是穷不尽的 —— 那种写法漏一行只会
/// 静默地落到 `_ => ok`，于是新加的能力永远显示"能用"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    /// 平台自己就能做，没有外部依赖
    Nothing,
    /// 要一个 shell 可执行文件
    Shell,
    /// 要 GDI 能把屏幕上的像素拷出来
    Screen,
    /// 要至少一个起得来的 MCP 服务器
    Mcp,
    /// 要当前那一档模型配好了 key（或者它本来就不要 key）
    Llm,
    /// 要一块默认输出设备
    Audio,
    /// 要密封库解得开
    Secrets,
}

/// 一条能力的固定身份。**顺序就是界面上那一列的顺序**（六组手在前，平台在后）
#[derive(Debug, Clone, Copy)]
pub struct Capability {
    pub id: &'static str,
    /// 六组手里的哪一组；`None` = 平台自己的能力（不归助手管）
    pub hand: Option<&'static str>,
    pub need: Need,
}

/// 九条。加一条要同时想清楚"它需要什么"（`Need`）和"界面上怎么叫"（前端那张表）
pub const CAPABILITIES: [Capability; 9] = [
    Capability {
        id: "hands.files",
        hand: Some("files"),
        need: Need::Nothing,
    },
    Capability {
        id: "hands.shell",
        hand: Some("shell"),
        need: Need::Shell,
    },
    Capability {
        id: "hands.web",
        hand: Some("web"),
        need: Need::Nothing,
    },
    Capability {
        id: "hands.screen",
        hand: Some("screen"),
        need: Need::Screen,
    },
    Capability {
        id: "hands.input",
        hand: Some("input"),
        need: Need::Nothing,
    },
    Capability {
        id: "hands.mcp",
        hand: Some("mcp"),
        need: Need::Mcp,
    },
    Capability {
        id: "platform.llm",
        hand: None,
        need: Need::Llm,
    },
    Capability {
        id: "platform.audio",
        hand: None,
        need: Need::Audio,
    },
    Capability {
        id: "platform.secrets",
        hand: None,
        need: Need::Secrets,
    },
];

/// 用户自己在助手设置里关了
pub const SWITCHED_OFF: &str = "switched_off";
/// 缺一个命令（`detail` 是那个命令的名字）
pub const MISSING_COMMAND: &str = "missing_command";
/// 一个都还没配（MCP 服务器、模型档）
pub const NOT_CONFIGURED: &str = "not_configured";
/// 配了，但缺 key
pub const NO_KEY: &str = "no_key";
/// 没有默认输出设备
pub const NO_DEVICE: &str = "no_device";
/// 配置本身不成立（命令空着、地址不合法）—— 和"缺命令"分开，因为要做的事不同
pub const BAD_CONFIG: &str = "bad_config";
/// 系统拒绝了（`detail` 是系统给的那句）
pub const BLOCKED: &str = "blocked";
/// 文件在，但解不开
pub const UNREADABLE: &str = "unreadable";

/// 全部原因码。**封闭集合** —— 前端那张翻译表按它写，多出来一个码就等于
/// 界面上出现一个没有名字的状态
pub const REASONS: [&str; 8] = [
    SWITCHED_OFF,
    MISSING_COMMAND,
    NOT_CONFIGURED,
    NO_KEY,
    NO_DEVICE,
    BAD_CONFIG,
    BLOCKED,
    UNREADABLE,
];

/// 一行体检结果。
///
/// 没有 `available` 字段：它由 `reason` 算。两个字段各存一份的话，总有一条路
/// 能把它们写成互相矛盾的样子（"不可用"且"没有原因"），而那条路迟早会有人走。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub id: String,
    /// `None` = 能用。**不是** `Some("ok")` —— 那样前端要认两个"好"值
    pub reason: Option<&'static str>,
    pub detail: Option<String>,
}

impl Verdict {
    pub fn available(&self) -> bool {
        self.reason.is_none()
    }

    fn ok(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            reason: None,
            detail: None,
        }
    }

    fn no(id: impl Into<String>, reason: &'static str, detail: Option<String>) -> Self {
        debug_assert!(
            REASONS.contains(&reason),
            "reason {reason} is not in REASONS — the front end has no sentence for it"
        );
        debug_assert!(
            reason != SWITCHED_OFF || detail.is_none(),
            "switched_off must not carry a machine detail: the user's next step is the switch"
        );
        Self {
            id: id.into(),
            reason: Some(reason),
            detail,
        }
    }
}

/// 一个 MCP 服务器的状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerState {
    Ready,
    /// 命令不在 PATH 上，也不是一个存在的绝对路径（`detail` 是命令名）
    MissingCommand(String),
    /// 配置本身不成立（空命令、地址不合法）
    BadConfig(String),
}

/// 探针收到的一条服务器事实
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerFact {
    pub id: String,
    pub state: ServerState,
}

/// 模型那一档的状态
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum LlmFact {
    /// 一个档都没有
    #[default]
    NoProfile,
    /// 有档，但当前这一档没有 key
    NoKey,
    /// 有 key，但地址或模型名没填完。带的是**缺哪一项**（`"address"` / `"model"`），
    /// 不是档的 id —— 界面上那句要填的是"地址"，用户不认得 `p4` 这种内部编号
    Incomplete(&'static str),
    Ready,
}

/// 探针收齐的事实。**全是机器事实，不含任何文案** —— 这个结构体的每个字段
/// 都该能在探针那半用一次系统调用填出来
#[derive(Debug, Clone, Default)]
pub struct Facts {
    /// 六组手的开关，顺序同 `HANDS`（探针传的是**生效后**的值：完全访问模式下
    /// 六组都算开，见 `hands_policy::effective_hands`）
    pub hands: [bool; 6],
    /// 找到的那个 shell 的路径；`None` = 一个都没有
    pub shell: Option<String>,
    /// 屏幕抓取失败的原因；`None` = 能用
    pub screen_error: Option<String>,
    pub mcp: Vec<ServerFact>,
    pub llm: LlmFact,
    /// 有没有默认输出设备
    pub audio_device: bool,
    /// 密封库的错误；`None` = 正常（没建过也算正常）
    pub secrets_error: Option<String>,
}

/// 事实 → 一行一行。
///
/// 返回的**顺序是固定的**：先是 `CAPABILITIES` 那九条，再是每个 MCP 服务器一行。
/// 界面不做排序 —— 一次刷新之后行号跳来跳去，用户会以为多了少了什么。
pub fn evaluate(facts: &Facts) -> Vec<Verdict> {
    let mut rows: Vec<Verdict> = CAPABILITIES
        .iter()
        .map(|capability| judge(capability, facts))
        .collect();
    rows.extend(mcp_rows(facts));
    rows
}

fn judge(capability: &Capability, facts: &Facts) -> Verdict {
    if let Some(hand) = capability.hand {
        if !hand_on(facts, hand) {
            return Verdict::no(capability.id, SWITCHED_OFF, None);
        }
    }

    match capability.need {
        // 文件：路径都落在 `%APPDATA%` 下，写不进去的话整个应用都已经坏了
        // 网页：出网闸门在进程里，没有外部依赖
        // 键鼠：见文件头的"探针只报它真能看见的事"
        Need::Nothing => Verdict::ok(capability.id),
        Need::Shell => match &facts.shell {
            Some(_) => Verdict::ok(capability.id),
            // 一个都没有时才报。具体缺哪个不重要 —— 一台没有 PowerShell 也没有
            // cmd 的 Windows 不是"装一个就好"，是这台机器不该跑这个应用
            None => Verdict::no(
                capability.id,
                MISSING_COMMAND,
                Some("powershell.exe".to_string()),
            ),
        },
        Need::Screen => match &facts.screen_error {
            None => Verdict::ok(capability.id),
            Some(error) => Verdict::no(capability.id, BLOCKED, Some(error.clone())),
        },
        Need::Mcp => mcp_group(facts),
        Need::Llm => match &facts.llm {
            LlmFact::Ready => Verdict::ok(capability.id),
            LlmFact::NoProfile => Verdict::no(capability.id, NOT_CONFIGURED, None),
            LlmFact::NoKey => Verdict::no(capability.id, NO_KEY, None),
            LlmFact::Incomplete(field) => {
                Verdict::no(capability.id, NOT_CONFIGURED, Some((*field).to_string()))
            }
        },
        Need::Audio => {
            if facts.audio_device {
                Verdict::ok(capability.id)
            } else {
                Verdict::no(capability.id, NO_DEVICE, None)
            }
        }
        Need::Secrets => match &facts.secrets_error {
            None => Verdict::ok(capability.id),
            Some(error) => Verdict::no(capability.id, UNREADABLE, Some(error.clone())),
        },
    }
}

/// 组那一行：说"这一组整体还能不能用"。
///
/// 只要有一个服务器起得来就是能用 —— 坏的那个自己有单独一行，别在这里重复。
/// 全坏时才报，而且只说**第一个**（顺序按配置，稳定）：一屏里三行一模一样的
/// "缺命令 npx"没有多给任何信息。
fn mcp_group(facts: &Facts) -> Verdict {
    if facts.mcp.is_empty() {
        return Verdict::no("hands.mcp", NOT_CONFIGURED, None);
    }
    if facts.mcp.iter().any(|server| server.state == ServerState::Ready) {
        return Verdict::ok("hands.mcp");
    }
    match facts.mcp.first().map(|server| &server.state) {
        Some(ServerState::MissingCommand(command)) => Verdict::no(
            "hands.mcp",
            MISSING_COMMAND,
            Some(command.clone()),
        ),
        Some(ServerState::BadConfig(what)) => {
            Verdict::no("hands.mcp", BAD_CONFIG, Some(what.clone()))
        }
        // 有服务器、而且一个都不是 Ready，走到这里只可能是上面两种
        _ => Verdict::no("hands.mcp", NOT_CONFIGURED, None),
    }
}

/// 每个服务器一行，id 就是它的工具命名空间（`mcp.<server>`）。
///
/// 为什么拆开：用户配了两个服务器、其中一个死了，只报一行"外部服务：能用"
/// 等于把死的那一个藏起来。而这一行的 id 和助手调工具时那个前缀是同一个字符串，
/// 对照着看不用翻译。
fn mcp_rows(facts: &Facts) -> Vec<Verdict> {
    let on = hand_on(facts, "mcp");
    facts
        .mcp
        .iter()
        .map(|server| {
            let id = format!("mcp.{}", server.id);
            if !on {
                return Verdict::no(id, SWITCHED_OFF, None);
            }
            match &server.state {
                ServerState::Ready => Verdict::ok(id),
                ServerState::MissingCommand(command) => {
                    Verdict::no(id, MISSING_COMMAND, Some(command.clone()))
                }
                ServerState::BadConfig(what) => Verdict::no(id, BAD_CONFIG, Some(what.clone())),
            }
        })
        .collect()
}

fn hand_on(facts: &Facts, hand: &str) -> bool {
    HANDS
        .iter()
        .position(|name| *name == hand)
        .and_then(|index| facts.hands.get(index).copied())
        .unwrap_or(false)
}

/// 几好几坏。界面拿它画导航上那个小圆点 —— 也是"一眼看出有没有事"的唯一数字
pub fn tally(rows: &[Verdict]) -> (usize, usize) {
    let bad = rows.iter().filter(|row| !row.available()).count();
    (rows.len() - bad, bad)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 六组全开、机器一切正常。每个用例只改它关心的那一项
    fn healthy() -> Facts {
        Facts {
            hands: [true; 6],
            shell: Some("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe".to_string()),
            screen_error: None,
            mcp: vec![],
            llm: LlmFact::Ready,
            audio_device: true,
            secrets_error: None,
        }
    }

    fn row<'a>(rows: &'a [Verdict], id: &str) -> &'a Verdict {
        rows.iter()
            .find(|row| row.id == id)
            .unwrap_or_else(|| panic!("no row {id}"))
    }

    // --- 好路径 -----------------------------------------------------------

    #[test]
    fn a_healthy_machine_flags_only_the_unconfigured_mcp() {
        let mut facts = healthy();
        // MCP 没配是"没配"，不是"坏了" —— 健康的机器上它本来就该是这条
        facts.mcp.clear();
        let rows = evaluate(&facts);
        let (ok, bad) = tally(&rows);
        assert_eq!(bad, 1, "只有 hands.mcp 该是红的");
        assert_eq!(row(&rows, "hands.mcp").reason, Some(NOT_CONFIGURED));
        assert_eq!(ok, rows.len() - 1);
    }

    #[test]
    fn every_capability_shows_up_exactly_once() {
        let rows = evaluate(&healthy());
        for capability in CAPABILITIES {
            let count = rows.iter().filter(|row| row.id == capability.id).count();
            assert_eq!(count, 1, "{} appears {count} times", capability.id);
        }
        assert_eq!(rows.len(), CAPABILITIES.len(), "没有 MCP 服务器时只有那九行");
    }

    #[test]
    fn the_order_is_the_table_order_and_never_shuffles() {
        // 两次算出来的 id 序列必须一样：界面不做排序，行号跳一下就像少了什么
        let facts = healthy();
        let first: Vec<String> = evaluate(&facts).into_iter().map(|row| row.id).collect();
        let second: Vec<String> = evaluate(&facts).into_iter().map(|row| row.id).collect();
        assert_eq!(first, second);
        assert_eq!(
            &first[..CAPABILITIES.len()],
            CAPABILITIES.map(|capability| capability.id.to_string()).as_slice()
        );
    }

    // --- 开关 -------------------------------------------------------------

    #[test]
    fn a_switched_off_group_is_off_before_anything_else_is_asked() {
        let mut facts = healthy();
        facts.hands = [false; 6];
        // 机器这边全是坏的，但用户关着 —— 报的必须还是"关着"
        facts.shell = None;
        facts.screen_error = Some("BitBlt could not copy the screen".to_string());
        let rows = evaluate(&facts);
        for capability in CAPABILITIES.iter().filter(|item| item.hand.is_some()) {
            let verdict = row(&rows, capability.id);
            assert_eq!(verdict.reason, Some(SWITCHED_OFF), "{}", capability.id);
            assert_eq!(verdict.detail, None, "{} 不许带机器细节", capability.id);
        }
    }

    #[test]
    fn platform_rows_do_not_care_about_hand_switches() {
        let mut facts = healthy();
        facts.hands = [false; 6];
        let rows = evaluate(&facts);
        assert!(row(&rows, "platform.llm").available());
        assert!(row(&rows, "platform.audio").available());
        assert!(row(&rows, "platform.secrets").available());
    }

    // --- 机器判据 ---------------------------------------------------------

    #[test]
    fn no_shell_is_a_missing_command() {
        let mut facts = healthy();
        facts.shell = None;
        let verdict = &evaluate(&facts)[1];
        assert_eq!(verdict.id, "hands.shell");
        assert_eq!(verdict.reason, Some(MISSING_COMMAND));
        assert!(verdict.detail.is_some());
    }

    #[test]
    fn a_blocked_screen_says_what_windows_said() {
        let mut facts = healthy();
        facts.screen_error = Some("BitBlt could not copy the screen".to_string());
        let rows = evaluate(&facts);
        let verdict = row(&rows, "hands.screen");
        assert_eq!(verdict.reason, Some(BLOCKED));
        // 系统那句话原样带上：它比"截图失败"有用
        assert_eq!(
            verdict.detail.as_deref(),
            Some("BitBlt could not copy the screen")
        );
    }

    #[test]
    fn the_llm_row_tells_the_three_cases_apart() {
        let mut facts = healthy();
        facts.llm = LlmFact::NoProfile;
        let rows = evaluate(&facts);
        assert_eq!(row(&rows, "platform.llm").reason, Some(NOT_CONFIGURED));

        facts.llm = LlmFact::NoKey;
        let rows = evaluate(&facts);
        let verdict = row(&rows, "platform.llm");
        assert_eq!(verdict.reason, Some(NO_KEY));
        // 这句话本身就完整了，不需要再带一个内部编号
        assert_eq!(verdict.detail, None);

        // 有 key 但地址/模型没填完：这不是"去粘一个 key"，是"去把表单填完"。
        // 两件事分开报，用户才不会照着错的那句去补
        facts.llm = LlmFact::Incomplete("model");
        let rows = evaluate(&facts);
        assert_eq!(row(&rows, "platform.llm").reason, Some(NOT_CONFIGURED));
        assert_eq!(row(&rows, "platform.llm").detail.as_deref(), Some("model"));

        facts.llm = LlmFact::Ready;
        assert!(row(&evaluate(&facts), "platform.llm").available());
    }

    #[test]
    fn no_output_device_and_a_locked_store_are_two_different_sentences() {
        let mut facts = healthy();
        facts.audio_device = false;
        facts.secrets_error = Some("the sealed store could not be opened".to_string());
        let rows = evaluate(&facts);
        assert_eq!(row(&rows, "platform.audio").reason, Some(NO_DEVICE));
        assert_eq!(row(&rows, "platform.secrets").reason, Some(UNREADABLE));
        assert!(row(&rows, "platform.secrets").detail.is_some());
    }

    // --- MCP --------------------------------------------------------------

    #[test]
    fn no_servers_is_not_configured_not_broken() {
        let rows = evaluate(&healthy());
        assert_eq!(row(&rows, "hands.mcp").reason, Some(NOT_CONFIGURED));
        // 而且不会凭空长出服务器行
        assert!(!rows.iter().any(|row| row.id.starts_with("mcp.")));
    }

    #[test]
    fn one_dead_server_does_not_take_the_group_down() {
        let mut facts = healthy();
        facts.mcp = vec![
            ServerFact {
                id: "github".to_string(),
                state: ServerState::Ready,
            },
            ServerFact {
                id: "notes".to_string(),
                state: ServerState::MissingCommand("npx".to_string()),
            },
        ];
        let rows = evaluate(&facts);
        // 组还是绿的……
        assert!(row(&rows, "hands.mcp").available());
        // ……但坏的那个自己有单独一行，说得出缺什么
        let dead = row(&rows, "mcp.notes");
        assert_eq!(dead.reason, Some(MISSING_COMMAND));
        assert_eq!(dead.detail.as_deref(), Some("npx"));
        assert!(row(&rows, "mcp.github").available());
    }

    #[test]
    fn all_servers_dead_reports_the_first_one() {
        let mut facts = healthy();
        facts.mcp = vec![
            ServerFact {
                id: "a".to_string(),
                state: ServerState::MissingCommand("npx".to_string()),
            },
            ServerFact {
                id: "b".to_string(),
                state: ServerState::BadConfig("the address is not a URL".to_string()),
            },
        ];
        let rows = evaluate(&facts);
        let group = row(&rows, "hands.mcp");
        assert_eq!(group.reason, Some(MISSING_COMMAND));
        assert_eq!(group.detail.as_deref(), Some("npx"));
        // 第二个的原因没丢，它在自己那一行上
        assert_eq!(row(&rows, "mcp.b").reason, Some(BAD_CONFIG));
    }

    #[test]
    fn server_rows_go_quiet_when_the_group_is_off() {
        let mut facts = healthy();
        facts.hands[5] = false;
        facts.mcp = vec![ServerFact {
            id: "github".to_string(),
            state: ServerState::Ready,
        }];
        let rows = evaluate(&facts);
        assert_eq!(row(&rows, "hands.mcp").reason, Some(SWITCHED_OFF));
        // 服务器本身没问题，但它这会儿用不上 —— 说"关着"比说"能用"诚实
        assert_eq!(row(&rows, "mcp.github").reason, Some(SWITCHED_OFF));
    }

    // --- 那条硬规矩 -------------------------------------------------------

    #[test]
    fn a_red_row_always_has_a_reason_and_a_green_row_never_does() {
        // 穷举一遍各种坏法。这条断言是整件事的底线：灰了必须说得出为什么
        let mut combos: Vec<Facts> = Vec::new();
        for mask in 0..64u8 {
            let hands = [
                mask & 1 != 0,
                mask & 2 != 0,
                mask & 4 != 0,
                mask & 8 != 0,
                mask & 16 != 0,
                mask & 32 != 0,
            ];
            for shell in [true, false] {
                for screen in [true, false] {
                    let mut facts = healthy();
                    facts.hands = hands;
                    facts.shell = if shell {
                        Some("C:\\Windows\\cmd.exe".to_string())
                    } else {
                        None
                    };
                    facts.screen_error = if screen {
                        None
                    } else {
                        Some("no desktop".to_string())
                    };
                    facts.mcp = vec![ServerFact {
                        id: "x".to_string(),
                        state: if screen {
                            ServerState::Ready
                        } else {
                            ServerState::BadConfig("empty command".to_string())
                        },
                    }];
                    combos.push(facts);
                }
            }
        }
        for facts in combos {
            for verdict in evaluate(&facts) {
                if verdict.available() {
                    assert_eq!(verdict.reason, None);
                } else {
                    let reason = verdict.reason.expect("a red row must say why");
                    assert!(
                        REASONS.contains(&reason),
                        "{} has a reason the front end cannot name: {reason}",
                        verdict.id
                    );
                }
            }
        }
    }

    #[test]
    fn every_reason_code_has_a_sentence_on_the_other_side() {
        // 前端 `capabilityReasonText` 按这张表写。少一条的后果是界面上一个空白的
        // 状态说明 —— 比不报还糟
        assert_eq!(REASONS.len(), 8);
        for reason in REASONS {
            assert!(!reason.is_empty());
            assert!(
                reason.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_'),
                "{reason} is not snake_case"
            );
        }
    }

    #[test]
    fn ids_are_unique_and_namespaced() {
        let rows = evaluate(&healthy());
        let mut seen = std::collections::HashSet::new();
        for row in &rows {
            assert!(seen.insert(row.id.clone()), "duplicate id {}", row.id);
            assert!(
                row.id.starts_with("hands.") || row.id.starts_with("platform.") || row.id.starts_with("mcp."),
                "{} is not namespaced",
                row.id
            );
        }
    }

    #[test]
    fn the_six_hand_rows_are_in_the_same_order_as_the_switches() {
        // `Facts::hands` 是按 `HANDS` 排的，而 `judge` 用 `HANDS` 查下标。
        // 两边顺序一旦不一致，症状是"拨了文件、报的是屏幕" —— 而这种错不会崩
        let rows = evaluate(&healthy());
        let hand_rows: Vec<&str> = rows
            .iter()
            .filter(|row| row.id.starts_with("hands."))
            .map(|row| row.id.trim_start_matches("hands."))
            .collect();
        assert_eq!(hand_rows, HANDS.to_vec());
    }
}
