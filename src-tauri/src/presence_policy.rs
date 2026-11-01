//! 姿态（presence）的判据 —— 纯逻辑，能 `rustc --test` 单跑。
//!
//! # 它解决什么
//!
//! "agent 现在在干什么"必须有**一个**答案。没有它的时候，桌面上那只宠物只能靠
//! 听 `lattice:llm-delta` 猜，而 delta 带 `requestId`（一次可能两轮在跑）、
//! 也看不到「等你批」——审批是前端 state（`AssistantPanel.tsx`），根本不经 Rust。
//!
//! 所以这里存的是一份**单一真相源**：谁拥有这一轮，谁 `report`；别人只读。
//!
//! # 三条规则，别的都在它们之下
//!
//! 1. **同值重复报告不重置计时。** 否则流式出字时每 20ms 报一次 `working`，
//!    `since` 永远在动，任何"多久没动过"的判断都会失效。
//! 2. **`done` / `error` 是瞬时的。** 它们说的是"刚才发生了一件事"，不是"现在处于
//!    这个状态"。过期由 `tick` 回落到 `idle` —— 回落**只在这里做**，让每个报告方
//!    自己记定时器就是 N 个定时器抢同一个字段。
//! 3. **睡着不是锁。** 一开始我写的是"睡着时 working 不叫醒它，只记着"，那是错的：
//!    那就得再存一个 `pending`，而 pending 又要在醒来时判断有没有过期 —— 一个
//!    两字段的状态机为了一个几乎不会发生的场景。
//!    **真正"我不想看见它"的开关是隐藏（`pet.json` 的 `hidden`），不是睡觉。**
//!    睡觉是装饰性的：agent 一干活它就醒，这才是对的。

use crate::pet_policy::{TRANSIENT_MS, POSTURES};

/// 六种姿态。**顺序必须和 `pet_policy::POSTURES` 一致** —— 皮肤的
/// `postures` 数组按下标对齐，错一位就是"干活时在睡觉"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Posture {
    Idle,
    Working,
    Waiting,
    Done,
    Error,
    Asleep,
}

impl Posture {
    pub const ALL: [Posture; POSTURES.len()] = [
        Posture::Idle,
        Posture::Working,
        Posture::Waiting,
        Posture::Done,
        Posture::Error,
        Posture::Asleep,
    ];

    /// 线上用的那个字符串。它同时是 `lattice:presence` 载荷里的值、
    /// 也是 `pet.json` 里 `postures` 的键。
    pub fn as_str(self) -> &'static str {
        match self {
            Posture::Idle => "idle",
            Posture::Working => "working",
            Posture::Waiting => "waiting",
            Posture::Done => "done",
            Posture::Error => "error",
            Posture::Asleep => "asleep",
        }
    }

    /// 认不出来就 `None`。**不做"猜一个最像的"** —— 报告方拼错一个词，
    /// 静默变成 `idle` 的话，宠物就再也不会显示那个姿态，而没人会想到是拼写。
    pub fn parse(text: &str) -> Option<Posture> {
        let text = text.trim();
        Posture::ALL.into_iter().find(|p| p.as_str() == text)
    }

    /// 报完过一会儿要自己回落的那些。
    pub fn is_transient(self) -> bool {
        matches!(self, Posture::Done | Posture::Error)
    }
}

/// 当前姿态 + 它是从什么时候开始的（毫秒，单调时钟）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Presence {
    pub posture: Posture,
    /// 这个姿态**开始**的时刻。同值重复报告不会改它（规则 1）。
    pub since_ms: u64,
}

impl Presence {
    /// 启动时的初值。后建的窗口（宠物窗重启、小窗刚打开）拿这一份，
    /// 不用等下一次变化 —— 否则一只刚重启的宠物会显示 `idle`，而 agent 正在干活。
    pub fn boot(now: u64) -> Presence {
        Presence {
            posture: Posture::Idle,
            since_ms: now,
        }
    }

    /// 进入某个姿态。**只在真的换了姿态时才动 `since`。**
    pub fn enter(posture: Posture, now: u64) -> Presence {
        Presence {
            posture,
            since_ms: now,
        }
    }
}

/// 收到一次报告。
///
/// 唯一一条"忽略"是**同值**：姿态没变，只是又报了一次。除此之外一律照办 ——
/// 包括"睡着了但 agent 开始干活"，那是叫醒，不是打断（规则 3）。
pub fn report(current: Presence, incoming: Posture, now: u64) -> Presence {
    if incoming == current.posture {
        return current;
    }
    Presence::enter(incoming, now)
}

/// 时间走了一格。只有瞬时的姿态会因此变化。
///
/// `now.saturating_sub`：时钟回拨（夏令时、手动改系统时间、测试里的假时钟）
/// 不能算出天文数字的差值，那会让 `done` 立刻过期 —— 或者永远不过期。
pub fn tick(current: Presence, now: u64) -> Presence {
    if !current.posture.is_transient() {
        return current;
    }
    if now.saturating_sub(current.since_ms) >= TRANSIENT_MS {
        return Presence::enter(Posture::Idle, now);
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- 词表对齐 ---

    #[test]
    fn the_enum_order_matches_the_policy_table() {
        // 皮肤的 postures 是按下标对齐的。这里错一位，症状是"干活时在睡觉"，
        // 而那种 bug 没有任何断言会自然抓到 —— 所以钉一条。
        for (i, posture) in Posture::ALL.iter().enumerate() {
            assert_eq!(
                posture.as_str(),
                POSTURES[i],
                "第 {i} 位不一致：皮肤按 POSTURES 存，这里按 enum 读"
            );
        }
    }

    #[test]
    fn every_posture_round_trips() {
        for posture in Posture::ALL {
            assert_eq!(Posture::parse(posture.as_str()), Some(posture));
        }
    }

    #[test]
    fn parse_trims_and_rejects_the_rest() {
        assert_eq!(Posture::parse("  working "), Some(Posture::Working));
        assert_eq!(Posture::parse(""), None);
        assert_eq!(Posture::parse("Workin"), None, "不做模糊匹配");
        assert_eq!(Posture::parse("sleepy"), None, "平台还没有这个姿态");
    }

    #[test]
    fn only_done_and_error_are_transient() {
        assert!(Posture::Done.is_transient());
        assert!(Posture::Error.is_transient());
        for steady in [Posture::Idle, Posture::Working, Posture::Waiting, Posture::Asleep] {
            assert!(!steady.is_transient(), "{:?} 不该自己回落", steady);
        }
    }

    // --- 报告 ---

    #[test]
    fn a_new_posture_stamps_the_clock() {
        let start = Presence::boot(1_000);
        let next = report(start, Posture::Working, 2_000);
        assert_eq!(next.posture, Posture::Working);
        assert_eq!(next.since_ms, 2_000);
    }

    #[test]
    fn repeating_the_same_posture_does_not_restamp() {
        // 流式出字时每 20ms 报一次 working。`since` 要是跟着动，
        // 任何"这个姿态持续了多久"的判断都失效。
        let start = Presence::enter(Posture::Working, 1_000);
        let next = report(start, Posture::Working, 9_999);
        assert_eq!(next, start, "同值报告必须原样返回");
    }

    #[test]
    fn an_agent_that_starts_working_wakes_a_sleeping_pet() {
        // 规则 3：睡着不是锁。真正"别让我看见它"的开关是隐藏。
        let asleep = Presence::enter(Posture::Asleep, 1_000);
        let next = report(asleep, Posture::Working, 2_000);
        assert_eq!(next.posture, Posture::Working);
    }

    #[test]
    fn every_transition_lands_on_a_real_posture() {
        // 6×6 全走一遍：结果必须仍在词表内，`since` 要么原样要么等于 now。
        for from in Posture::ALL {
            for to in Posture::ALL {
                let before = Presence::enter(from, 100);
                let after = report(before, to, 500);
                assert!(Posture::ALL.contains(&after.posture));
                assert!(after.since_ms == 100 || after.since_ms == 500);
                if from == to {
                    assert_eq!(after, before);
                } else {
                    assert_eq!(after.posture, to);
                    assert_eq!(after.since_ms, 500);
                }
            }
        }
    }

    // --- 回落 ---

    #[test]
    fn done_falls_back_to_idle_after_the_hold() {
        let done = Presence::enter(Posture::Done, 1_000);
        assert_eq!(
            tick(done, 1_000 + TRANSIENT_MS).posture,
            Posture::Idle,
            "到点就该回落"
        );
    }

    #[test]
    fn done_stays_for_one_millisecond_less_than_the_hold() {
        let done = Presence::enter(Posture::Done, 1_000);
        assert_eq!(
            tick(done, 1_000 + TRANSIENT_MS - 1).posture,
            Posture::Done,
            "差一毫秒也算没到"
        );
    }

    #[test]
    fn working_never_falls_back() {
        // 一轮长回答可能跑十分钟，中途不能自己变回 idle。
        let working = Presence::enter(Posture::Working, 1_000);
        assert_eq!(tick(working, 1_000 + 600_000), working);
    }

    #[test]
    fn ticking_idle_is_a_no_op() {
        let idle = Presence::boot(0);
        assert_eq!(tick(idle, 10_000_000), idle);
    }

    #[test]
    fn a_backwards_clock_does_not_expire_anything() {
        // 时钟回拨不能算出天文数字的差值 —— 那会让 done 立刻过期或者永不过期。
        let done = Presence::enter(Posture::Done, 5_000);
        assert_eq!(tick(done, 1_000), done);
    }

    #[test]
    fn falling_back_restamps_so_it_does_not_fire_again() {
        let done = Presence::enter(Posture::Done, 1_000);
        let idle = tick(done, 5_000);
        assert_eq!(idle.posture, Posture::Idle);
        assert_eq!(idle.since_ms, 5_000);
        // 再走一格还是 idle，不会反复"回落"
        assert_eq!(tick(idle, 99_999), idle);
    }

    #[test]
    fn the_boot_value_is_idle_not_nothing() {
        let boot = Presence::boot(42);
        assert_eq!(boot.posture, Posture::Idle);
        assert_eq!(boot.since_ms, 42);
    }
}
