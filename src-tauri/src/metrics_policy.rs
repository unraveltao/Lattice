//! 指标采样的纯逻辑：累计计数 → 占用率。
//!
//! # 为什么单独一个文件
//!
//! `metrics.rs` 里全是 Win32 调用和指针，`rustc --test` 编不进来；而"两次累计
//! 计数之间忙了多少"是纯算术，也是这里唯一会算错的地方（除零、计数器回绕、
//! 核数变了）。拆出来这几条断言才跑得动：
//!
//! ```text
//! rustc --edition 2024 --test src-tauri/src/metrics_policy.rs -o 壳子.exe
//! ```
//!
//! # 口径
//!
//! Windows 的 CPU 累计计数里 **kernel 时间包含 idle**（`GetSystemTimes` 和
//! `NtQuerySystemInformation` 都是这个口径），所以"忙" = `(kernel + user) - idle`，
//! 而不是 `kernel + user`。照后者算，一台闲着的机器会报 100%。

/// 一个核（或整机）的累计计数，单位 100ns
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct CpuTimes {
    pub idle: u64,
    pub total: u64,
}

/// 两次累计计数之间的忙碌比例，0..1。
///
/// 没有前值 / 两次之间没走过时间（`total` 没变）都返回 0 —— 那正是"还没测出来"，
/// 编一个好看的假数字比 0 更糟。
pub fn usage(previous: CpuTimes, current: CpuTimes) -> f64 {
    // 计数器是单调的，但热插拔 / 计数器被重置时可能倒退，saturating 收掉
    let idle = current.idle.saturating_sub(previous.idle);
    let total = current.total.saturating_sub(previous.total);
    if total == 0 {
        return 0.0;
    }
    let busy = total.saturating_sub(idle);
    (busy as f64 / total as f64).clamp(0.0, 1.0)
}

/// 每个核各算一次。
///
/// **核数变了就返回空**，而不是硬算：休眠唤醒、CPU 热插拔、大小核调度都会让
/// 这个数组变长变短，按索引对上去会把 A 核的计数减到 B 核头上 —— 画出来的
/// 是一条看着合理、其实全错的曲线。空数组让组件把那一条收起来，下一拍自然恢复。
pub fn per_core(previous: &[CpuTimes], current: &[CpuTimes]) -> Vec<f64> {
    if current.is_empty() || previous.len() != current.len() {
        return Vec::new();
    }
    previous
        .iter()
        .zip(current.iter())
        .map(|(before, now)| usage(*before, *now))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn times(idle: u64, total: u64) -> CpuTimes {
        CpuTimes { idle, total }
    }

    #[test]
    fn no_time_passed_reads_as_zero_not_nan() {
        assert_eq!(usage(times(100, 200), times(100, 200)), 0.0);
        // 计数器倒退（重置 / 热插拔）也是 0，不是负数
        assert_eq!(usage(times(500, 900), times(100, 200)), 0.0);
        assert_eq!(usage(times(0, 0), times(0, 0)), 0.0);
    }

    #[test]
    fn half_the_time_idle_is_half_load() {
        // 100 个 tick 里 50 个空闲
        assert!((usage(times(1000, 2000), times(1050, 2100)) - 0.5).abs() < 1e-9);
        // 全程空闲
        assert_eq!(usage(times(1000, 2000), times(1100, 2100)), 0.0);
        // 全程忙
        assert_eq!(usage(times(1000, 2000), times(1000, 2100)), 1.0);
    }

    #[test]
    fn idle_cannot_exceed_total() {
        // 坏数据（idle 比 total 还大）夹到 0，不出现负数占用
        let value = usage(times(0, 0), times(500, 100));
        assert_eq!(value, 0.0);
    }

    #[test]
    fn per_core_computes_each_core_separately() {
        let previous = [times(0, 0), times(0, 0), times(0, 0)];
        let current = [times(100, 100), times(50, 100), times(0, 100)];
        let values = per_core(&previous, &current);
        assert_eq!(values.len(), 3);
        assert_eq!(values[0], 0.0); // 全空闲
        assert!((values[1] - 0.5).abs() < 1e-9);
        assert_eq!(values[2], 1.0); // 全忙
    }

    #[test]
    fn a_changed_core_count_returns_nothing() {
        // 8 核 -> 16 核（休眠唤醒 / 热插拔）：宁可不画，也别错位
        let previous = [times(0, 0); 8];
        let current = [times(0, 0); 16];
        assert!(per_core(&previous, &current).is_empty());
        assert!(per_core(&[], &current).is_empty());
        assert!(per_core(&previous, &[]).is_empty());
    }
}
