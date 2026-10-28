//! GPU 采样的纯逻辑：把 PDH 的实例名拆成"哪块卡、哪种引擎"，再压成一个百分比。
//!
//! # 为什么单独一个文件
//!
//! 和 `metrics_policy.rs` 一个理由：`gpu.rs` 里全是 PDH 句柄和裸指针，
//! `rustc --test` 编不进来；而"一堆实例怎么合成一个数"是这里唯一会算错的地方。
//!
//! ```text
//! rustc --edition 2024 --test src-tauri/src/gpu_policy.rs -o 壳子.exe
//! ```
//!
//! # 口径（三条，每条都跟"看着合理但其实错"的写法有关）
//!
//! 1. **同一种引擎内求和，不同引擎之间取最大。** 一块卡有 3D / Copy /
//!    VideoDecode / VideoEncode / Security / VR / OFA 好几条引擎，各自有各自的
//!    占用率。求和会算出 300%，而"这块卡有多忙"的答案是**最忙的那条引擎**
//!    —— 任务管理器那个 GPU 百分比就是它。
//!
//! 2. **必须按 LUID 分组。** 实例名里带着 `luid_0xHIGH_0xLOW`，混合显卡
//!    （核显 + 独显）会有两组。不分组的"最大值"可能来自核显，而用户问的是
//!    独显。挑哪一块由 `pick` 决定，不在这里猜。
//!
//! 3. **求和后夹到 100。** 单条引擎理论上是 0–100，但 PDH 的按进程归因会
//!    在进程数多的时候溢出（同一段 GPU 时间被两个进程都记上），画成 137%
//!    只会让人以为组件坏了。

use std::collections::HashMap;

/// 两块 LUID 的高低 32 位拼成一个可比较的 u64。实例名和 DXGI 的 `LUID`
/// 都是"高低两半"，拼法只此一处 —— 拼错了两边就对不上，而症状是"永远挑不到卡"
pub fn luid(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

/// 实例名里 `luid_0xHHHHHHHH_0xHHHHHHHH` 那一段 → u64。
///
/// 从 `luid_` 后面开始切两段，各自按 16 进制读；读不出来就是 `None`。
/// 不认正负号、不认十进制 —— 这两个符号在真实的实例名里都不会出现。
fn read_luid(text: &str) -> Option<u64> {
    let start = text.find("luid_")? + "luid_".len();
    let mut parts = text[start..].split('_');
    let high = hex(parts.next()?)?;
    let low = hex(parts.next()?)?;
    Some(luid(high, low))
}

fn hex(text: &str) -> Option<u32> {
    let digits = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    // 空串会让 `from_str_radix` 返回 Err，正是想要的
    u32::from_str_radix(digits, 16).ok()
}

/// `pid_10860_luid_0x00000000_0x000117C4_phys_0_eng_3_engtype_3D`
/// → `(卡, "3D")`。
///
/// 引擎类型从**最后一个** `_engtype_` 之后整段取：`OFA_0` 自己带下划线，
/// 按 `_` 切会把类型切成 `OFA`，于是它和别的引擎被当成同一类求和。
pub fn parse_engine(name: &str) -> Option<(u64, &str)> {
    let card = read_luid(name)?;
    let at = name.rfind("_engtype_")? + "_engtype_".len();
    let engine = &name[at..];
    if engine.is_empty() {
        return None;
    }
    Some((card, engine))
}

/// `luid_0x00000000_0x000117C4_phys_0` → 卡。显存那一组计数器没有 pid / engtype
pub fn parse_adapter(name: &str) -> Option<u64> {
    read_luid(name)
}

/// 一堆 `(卡, 引擎, 0–100)` → 每块卡一个 0–100。
///
/// 返回按 LUID 排序，方便断言和"同一个输入永远同一个输出"。
pub fn engine_totals(samples: &[(u64, &str, f64)]) -> Vec<(u64, f64)> {
    let mut sums: HashMap<(u64, &str), f64> = HashMap::new();
    for (card, engine, value) in samples {
        if !value.is_finite() {
            continue;
        }
        // 负数是坏读数（PDH 在第一次 collect 后偶尔给），当成 0
        let entry = sums.entry((*card, *engine)).or_insert(0.0);
        *entry += value.max(0.0);
    }

    let mut busiest: HashMap<u64, f64> = HashMap::new();
    for ((card, _), total) in sums {
        let slot = busiest.entry(card).or_insert(0.0);
        if total > *slot {
            *slot = total;
        }
    }

    let mut out: Vec<(u64, f64)> = busiest
        .into_iter()
        .map(|(card, total)| (card, total.clamp(0.0, 100.0)))
        .collect();
    out.sort_by_key(|(card, _)| *card);
    out
}

/// 挑一块"这张卡就是用户想看的那张"的适配器。
///
/// 规则只有两条：**最忙的那块**；一样忙就挑显存大的（独显的显存总比核显大）。
/// 混合显卡上"两块都画"会挤爆 268px 的卡，而"取平均"既不是核显也不是独显。
/// 一块都没有就返回 `None`，组件据此把整行收起来。
pub fn pick(usage: &[(u64, f64)], vram: &[(u64, u64)]) -> Option<u64> {
    usage
        .iter()
        .map(|(card, percent)| {
            let total = vram
                .iter()
                .find(|(other, _)| other == card)
                .map(|(_, total)| *total)
                .unwrap_or(0);
            (*card, *percent, total)
        })
        .max_by(|left, right| {
            // 先比占用，再比显存；最后比 LUID 只是为了"永远同一个答案"
            left.1
                .partial_cmp(&right.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.2.cmp(&right.2))
                .then(left.0.cmp(&right.0))
        })
        .map(|(card, _, _)| card)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD: u64 = 0x0000_0000_0001_17C4;
    const OTHER: u64 = 0x0000_0000_0001_2AA6;

    #[test]
    fn luid_is_high_then_low() {
        assert_eq!(luid(0, 0x117C4), CARD);
        // 高低两半不能弄反：弄反了只会在"高 32 位恰好非 0"的机器上错
        assert_eq!(luid(1, 0), 0x1_0000_0000);
    }

    #[test]
    fn engine_names_parse() {
        let name = "pid_10860_luid_0x00000000_0x000117C4_phys_0_eng_0_engtype_3D";
        assert_eq!(parse_engine(name), Some((CARD, "3D")));

        // 引擎类型自己带下划线：整段取，别按 `_` 切
        let ofa = "pid_8_luid_0x00000000_0x000117C4_phys_0_eng_7_engtype_OFA_0";
        assert_eq!(parse_engine(ofa), Some((CARD, "OFA_0")));

        // 显存那组没有 engtype，不能当引擎实例
        assert_eq!(
            parse_engine("luid_0x00000000_0x000117C4_phys_0"),
            None
        );
        assert_eq!(parse_engine("garbage"), None);
        // 名字对但十六进制坏了：宁可丢掉这一个实例，也别猜成 0 号卡
        assert_eq!(
            parse_engine("pid_1_luid_0xzzzz_0x000117C4_eng_0_engtype_3D"),
            None
        );
    }

    #[test]
    fn adapter_names_parse() {
        assert_eq!(parse_adapter("luid_0x00000000_0x000117C4_phys_0"), Some(CARD));
        assert_eq!(parse_adapter("luid_0x00000000_0x00012AA6_phys_0"), Some(OTHER));
        assert_eq!(parse_adapter("pid_1_luid_0x00000000_0x000117C4_eng_0"), Some(CARD));
    }

    #[test]
    fn same_engine_sums_different_engines_take_the_max() {
        // 两个进程各占 3D 的 30% / 20%，Copy 引擎 90%
        // → 3D 合成 50%，Copy 90%，这块卡"有多忙" = 90
        let samples = [(CARD, "3D", 30.0), (CARD, "3D", 20.0), (CARD, "Copy", 90.0)];
        assert_eq!(engine_totals(&samples), vec![(CARD, 90.0)]);
    }

    #[test]
    fn totals_are_clamped_and_negative_readings_dropped() {
        // 三个进程各 60%：按进程归因会重复记同一段 GPU 时间
        let samples = [(CARD, "3D", 60.0), (CARD, "3D", 60.0), (CARD, "3D", 10.0)];
        assert_eq!(engine_totals(&samples), vec![(CARD, 100.0)]);

        // 负数是坏读数，当 0；NaN 直接丢
        let odd = [(CARD, "3D", -40.0), (CARD, "Copy", f64::NAN)];
        assert_eq!(engine_totals(&odd), vec![(CARD, 0.0)]);
        assert!(engine_totals(&[]).is_empty());
    }

    #[test]
    fn two_adapters_stay_apart() {
        let samples = [(CARD, "3D", 12.0), (OTHER, "3D", 70.0)];
        assert_eq!(engine_totals(&samples), vec![(CARD, 12.0), (OTHER, 70.0)]);
    }

    #[test]
    fn picks_the_busiest_adapter() {
        let usage = [(CARD, 12.0), (OTHER, 70.0)];
        let vram = [(CARD, 8 << 30), (OTHER, 2 << 30)];
        assert_eq!(pick(&usage, &vram), Some(OTHER));
    }

    #[test]
    fn ties_go_to_the_bigger_memory() {
        // 两块都闲着（0%）：挑显存大的那块，也就是独显
        let usage = [(CARD, 0.0), (OTHER, 0.0)];
        let vram = [(CARD, 8 << 30), (OTHER, 512 << 20)];
        assert_eq!(pick(&usage, &vram), Some(CARD));

        // 显存也读不到（DXGI 没给）：退到 LUID 顺序，答案仍然稳定
        assert_eq!(pick(&usage, &[]), Some(OTHER));
    }

    #[test]
    fn no_adapter_is_none() {
        assert_eq!(pick(&[], &[]), None);
    }
}
