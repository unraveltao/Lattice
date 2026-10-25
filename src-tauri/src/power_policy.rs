//! 电源读数的纯逻辑：`SYSTEM_POWER_STATUS` 的原始字节 → 能画的那几个值。
//!
//! # 为什么单独一个文件
//!
//! `power.rs` 里只有一次 `GetSystemPowerStatus` 和一个结构体，`rustc --test`
//! 编不进来；而"255 是什么意思""秒怎么变分钟""在充电时还剩多久根本没有意义"
//! 恰好是会算错的地方。拆出来这几条断言才跑得动：
//!
//! ```text
//! rustc --edition 2024 --test src-tauri/src/power_policy.rs -o 壳子.exe
//! ```
//!
//! # 口径（Win32 的 `SYSTEM_POWER_STATUS`，全是 u8 / u32）
//!
//! | 字段 | 取值 |
//! | --- | --- |
//! | `ACLineStatus` | 0 用电瓶 / 1 接着交流电 / 255 未知 |
//! | `BatteryFlag` | 位掩码：1 high、2 low、4 critical、8 charging、128 没电池、255 未知 |
//! | `BatteryLifePercent` | 0–100 / 255 未知 |
//! | `SystemStatusFlag` | 1 = 节电模式开着（别的值一律当关着） |
//! | `BatteryLifeTime` | 还能用多少秒，`u32::MAX` = 未知 |
//!
//! **`BatteryFlag` 的 255 不是位掩码**。它字面上是全 1，按位拆出来会是"充电中 +
//! 没电池 + 严重不足"三条互相打架的结论。所以先认 255 再拆位 —— 这条是照着
//! `SYSTEM_POWER_STATUS` 的文档写的，不是防御性编程。

/// `ACLineStatus` / `BatteryFlag` 里那个"读不出来"的哨兵
pub const UNKNOWN: u8 = 255;
/// `BatteryLifeTime` 里那个"读不出来"的哨兵（秒）
pub const UNKNOWN_SECONDS: u32 = u32::MAX;

pub const FLAG_HIGH: u8 = 0x01;
pub const FLAG_LOW: u8 = 0x02;
pub const FLAG_CRITICAL: u8 = 0x04;
pub const FLAG_CHARGING: u8 = 0x08;
pub const FLAG_NO_BATTERY: u8 = 0x80;

/// 超过一周的"剩余时间"不是估得松，是读数坏了（有些虚拟机报 `0xFFFFFFFE`）。
/// 与其在卡片上印"还剩 11811 小时"，不如老实说读不出来。
pub const MAX_MINUTES: u32 = 7 * 24 * 60;

/// 位掩码拆出来的三件事。`high` / `low` 不单独出，因为百分比本身更准
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flags {
    pub charging: bool,
    pub no_battery: bool,
    pub critical: bool,
}

/// 接没接交流电。除了 0 / 1 都是"不知道"（255 是文档里的未知）
pub fn ac(ac_line: u8) -> Option<bool> {
    match ac_line {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// 电量百分比。101 以上（含 255）都是无效读数 —— 别夹到 100，那会把"读坏了"
/// 画成"满电"
pub fn percent(raw: u8) -> Option<u8> {
    if raw > 100 { None } else { Some(raw) }
}

/// 拆 `BatteryFlag`。255 整组按未知
pub fn flags(raw: u8) -> Flags {
    if raw == UNKNOWN {
        return Flags::default();
    }
    Flags {
        charging: raw & FLAG_CHARGING != 0,
        no_battery: raw & FLAG_NO_BATTERY != 0,
        critical: raw & FLAG_CRITICAL != 0,
    }
}

/// 还能用多久（分钟）。
///
/// 三种"没有意义"一律 `None`：读数未知、接着交流电（插着电谈"剩余时间"是错的）、
/// 这台机器没有电池。秒向下取整 —— 报"还剩 2 分钟"而实际 2 分 59 秒，比报 3 分钟
/// 保守，用户少一次"它说还有 3 分钟，结果 2 分钟就关机了"。
pub fn minutes_left(seconds: u32, ac: Option<bool>, no_battery: bool) -> Option<u32> {
    if no_battery || ac == Some(true) || seconds == UNKNOWN_SECONDS {
        return None;
    }
    let minutes = seconds / 60;
    if minutes > MAX_MINUTES { None } else { Some(minutes) }
}

/// 节电模式。Win32 只定义了 0 和 1，别的值当关着（多报一次"省电中"比漏报更烦人）
pub fn saver(raw: u8) -> bool {
    raw == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ac_line_only_knows_two_values() {
        assert_eq!(ac(0), Some(false));
        assert_eq!(ac(1), Some(true));
        assert_eq!(ac(UNKNOWN), None);
        assert_eq!(ac(2), None);
    }

    #[test]
    fn percent_refuses_to_guess() {
        assert_eq!(percent(0), Some(0));
        assert_eq!(percent(87), Some(87));
        assert_eq!(percent(100), Some(100));
        // 101 / 255 都是坏读数：夹到 100 会把"读坏了"画成"满电"
        assert_eq!(percent(101), None);
        assert_eq!(percent(UNKNOWN), None);
    }

    #[test]
    fn unknown_flags_are_not_a_bitmask() {
        // 255 字面上是全 1：按位拆会同时得到"充电中"和"没电池"
        assert_eq!(flags(UNKNOWN), Flags::default());
        assert_eq!(flags(0), Flags::default());
    }

    #[test]
    fn flags_combine() {
        assert_eq!(flags(FLAG_CHARGING).charging, true);
        assert_eq!(flags(FLAG_NO_BATTERY).no_battery, true);
        assert_eq!(flags(FLAG_HIGH | FLAG_LOW).no_battery, false);
        let both = flags(FLAG_CHARGING | FLAG_CRITICAL);
        assert!(both.charging && both.critical && !both.no_battery);
    }

    #[test]
    fn minutes_only_while_discharging() {
        assert_eq!(minutes_left(3600, Some(false), false), Some(60));
        assert_eq!(minutes_left(90, Some(false), false), Some(1));
        // 59 秒是"不到一分钟"，不是 1 分钟，也不是负数
        assert_eq!(minutes_left(59, Some(false), false), Some(0));
        // 插着电：剩余时间没有意义
        assert_eq!(minutes_left(3600, Some(true), false), None);
        // 没有电池（台式机）
        assert_eq!(minutes_left(3600, Some(true), true), None);
        // 未知 / 坏读数
        assert_eq!(minutes_left(UNKNOWN_SECONDS, Some(false), false), None);
        assert_eq!(minutes_left(MAX_MINUTES * 60 + 60, Some(false), false), None);
        // 刚好一周还算数
        assert_eq!(minutes_left(MAX_MINUTES * 60, Some(false), false), Some(MAX_MINUTES));
        // 交流电状态未知时保守地照报 —— 有电池、有时间，就画出来
        assert_eq!(minutes_left(3600, None, false), Some(60));
    }

    #[test]
    fn saver_is_a_single_flag() {
        assert!(!saver(0));
        assert!(saver(1));
        assert!(!saver(UNKNOWN));
        assert!(!saver(2));
    }
}
