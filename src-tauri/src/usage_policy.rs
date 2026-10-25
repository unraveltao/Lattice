//! 使用记录里与系统无关的那一半：日键校验、累加、裁剪。
//!
//! 这一层不碰文件、不碰窗口、不引 crate —— 所以能单独 `rustc --test`。
//! `usage.rs` 负责把"窗口有没有在前台"变成对这里的调用。

use std::collections::BTreeMap;

/// 最多留多少天。和前端 `runtime/usage.ts` 的 `MAX_DAYS` 一致。
pub const MAX_DAYS: usize = 400;

/// 一天最多 1440 分钟：时钟回拨或重复滴答都不该把一格画穿
pub const MAX_MINUTES: u32 = 24 * 60;

fn leap(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// 严格认 `YYYY-MM-DD`，并且这一天真的存在（2 月 30 日不算）
pub fn is_day_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }

    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    month >= 1 && month <= 12 && day >= 1 && day <= days_in_month(year, month)
}

/// 给今天加一分钟。日键不合法就不记（返回 false）
pub fn add(days: &mut BTreeMap<String, u32>, key: &str) -> bool {
    if !is_day_key(key) {
        return false;
    }
    let entry = days.entry(key.to_string()).or_insert(0);
    *entry = entry.saturating_add(1).min(MAX_MINUTES);
    prune(days, MAX_DAYS);
    true
}

/// 只留最近的 `max` 天。键是 ISO 日期，字典序就是时间序
pub fn prune(days: &mut BTreeMap<String, u32>, max: usize) {
    while days.len() > max {
        let Some(oldest) = days.keys().next().cloned() else {
            break;
        };
        days.remove(&oldest);
    }
}

pub fn total(days: &BTreeMap<String, u32>) -> u32 {
    days.values().copied().sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, u32)]) -> BTreeMap<String, u32> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
    }

    #[test]
    fn accepts_a_real_day() {
        assert!(is_day_key("2026-10-25"));
        assert!(is_day_key("2028-02-29"));
    }

    #[test]
    fn rejects_impossible_days() {
        assert!(!is_day_key("2026-2-3"));
        assert!(!is_day_key("2026-02-30"));
        assert!(!is_day_key("2027-02-29"));
        assert!(!is_day_key("2026-13-01"));
        assert!(!is_day_key(""));
        assert!(!is_day_key("2026/10/25"));
    }

    #[test]
    fn adds_a_minute() {
        let mut days = BTreeMap::new();
        assert!(add(&mut days, "2026-10-25"));
        assert!(add(&mut days, "2026-10-25"));
        assert_eq!(days.get("2026-10-25"), Some(&2));
    }

    #[test]
    fn refuses_a_bad_day() {
        let mut days = BTreeMap::new();
        assert!(!add(&mut days, "not-a-day"));
        assert!(days.is_empty());
    }

    #[test]
    fn caps_one_day_at_a_full_day() {
        let mut days = map(&[("2026-10-25", MAX_MINUTES - 1)]);
        assert!(add(&mut days, "2026-10-25"));
        assert_eq!(days.get("2026-10-25"), Some(&MAX_MINUTES));
    }

    #[test]
    fn prunes_the_oldest() {
        let mut days = map(&[("2025-01-01", 1), ("2025-01-02", 1), ("2025-01-03", 1)]);
        prune(&mut days, 2);
        assert_eq!(days.keys().cloned().collect::<Vec<_>>(), vec!["2025-01-02", "2025-01-03"]);
    }

    #[test]
    fn prune_is_a_no_op_below_the_cap() {
        let mut days = map(&[("2025-01-01", 1)]);
        prune(&mut days, MAX_DAYS);
        assert_eq!(days.len(), 1);
    }

    #[test]
    fn totals_the_minutes() {
        let days = map(&[("2025-01-01", 30), ("2025-01-02", 12)]);
        assert_eq!(total(&days), 42);
    }
}
