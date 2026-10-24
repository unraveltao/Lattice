//! 声音高低的纯逻辑：RMS → 分贝 → 0..1，外加一条释放曲线。
//!
//! # 为什么单独一个文件
//!
//! 采集那半边（`audio.rs`）满身都是 WASAPI 的 COM 指针，`rustc --test` 编不进来；
//! 而"一个采样块有多响"这件事本身是纯算术。拆开之后 `tests` 里那几条能真的跑
//! （`rustc --edition 2024 --test src-tauri/src/audio_policy.rs`），
//! 不用等一台能 `cargo test` 的机器。
//!
//! # 为什么是分贝不是线性
//!
//! 正常听歌时 RMS 在 0.02..0.15 之间 —— 直接当 0..1 用，那条线永远贴着底，
//! 看着像没接上。人耳本来也是对数感知的，所以：取 `20·log10(rms)`，把
//! -60dB..0dB 铺到 0..1。低于 -60dB 一律当静音（那已经是听不见的量级）。

/// 低于这个分贝就是静音
pub const FLOOR_DB: f32 = -60.0;

/// 释放时间常数（毫秒）：峰值之后多久落到 1/e。
///
/// 120ms 是照着"心跳图那种尖峰"调的：太快像噪点，太慢就糊成一条包络线。
pub const RELEASE_MS: f32 = 120.0;

/// 一次采样的上限。浮点混音理论上可能超过 1.0（几个流叠在一起），
/// 但这条线只表示"多响"，超过满刻度就该顶到天花板。
pub fn clamp01(value: f32) -> f32 {
    if value.is_nan() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

/// 线性 RMS → 0..1 的显示值
pub fn to_level(rms: f32) -> f32 {
    if !(rms > 0.0) || rms.is_nan() {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    clamp01((db - FLOOR_DB) / -FLOOR_DB)
}

/// 32 位浮点采样块的 RMS。共享模式的混音格式几乎总是 f32。
pub fn rms_f32(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0f64;
    for sample in samples {
        let value = *sample as f64;
        if value.is_finite() {
            sum += value * value;
        }
    }
    (sum / samples.len() as f64).sqrt() as f32
}

/// 16 位整数采样块的 RMS，先归一到 -1..1。
///
/// 老设备 / 独占格式会走到这条，不写的话那台机器上永远是平线。
pub fn rms_i16(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0f64;
    for sample in samples {
        let value = *sample as f64 / 32768.0;
        sum += value * value;
    }
    (sum / samples.len() as f64).sqrt() as f32
}

/// 峰值之后按指数往下掉。
///
/// 采集线程大约每 10~20ms 推一次，而组件每 80ms 才读一次 —— 中间要是"取最后一次"
/// 就会漏掉短促的重音。所以这里不是采样保持，是"包络"：新的值直接顶上去，
/// 旧的按 `elapsed` 衰减。
pub fn decay(level: f32, elapsed_ms: f32) -> f32 {
    if !(elapsed_ms > 0.0) || !level.is_finite() {
        return clamp01(if level.is_finite() { level } else { 0.0 });
    }
    clamp01(level * (-elapsed_ms / RELEASE_MS).exp())
}

/// 这一拍该显示多少：立刻起，慢慢落。
pub fn next_level(previous: f32, rms: f32, elapsed_ms: f32) -> f32 {
    let incoming = to_level(rms);
    let falling = decay(previous, elapsed_ms);
    if incoming > falling { incoming } else { falling }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_zero_not_negative_infinity() {
        assert_eq!(to_level(0.0), 0.0);
        assert_eq!(to_level(-0.5), 0.0);
        assert_eq!(to_level(f32::NAN), 0.0);
        assert_eq!(rms_f32(&[]), 0.0);
        assert_eq!(rms_i16(&[]), 0.0);
        assert_eq!(rms_f32(&[0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn full_scale_is_one_and_the_floor_is_zero() {
        assert_eq!(to_level(1.0), 1.0);
        // -60dB 正好是地板
        assert_eq!(to_level(0.001), 0.0);
        // 比地板更低也还是 0，不是负数
        assert_eq!(to_level(0.00001), 0.0);
        // 超过满刻度顶到 1
        assert_eq!(to_level(4.0), 1.0);
    }

    #[test]
    fn a_sine_at_half_scale_reads_as_about_minus_three_db() {
        // 振幅 0.5 的正弦，RMS = 0.5/√2 ≈ 0.3536 → -9dB → (60-9)/60 = 0.8497
        let samples: Vec<f32> = (0..480)
            .map(|i| 0.5 * (i as f32 * 2.0 * std::f32::consts::PI / 48.0).sin())
            .collect();
        let rms = rms_f32(&samples);
        assert!((rms - 0.3536).abs() < 0.01, "rms = {rms}");
        let level = to_level(rms);
        assert!((level - 0.8497).abs() < 0.02, "level = {level}");
    }

    #[test]
    fn sixteen_bit_samples_are_normalised_the_same_way() {
        // i16::MAX 满刻度 → 1.0
        assert!((rms_i16(&[i16::MAX, i16::MAX]) - 1.0).abs() < 0.001);
        // 静音
        assert_eq!(rms_i16(&[0, 0, 0, 0]), 0.0);
        // 和 f32 那条走同一个量级
        let square = rms_i16(&[16384, 16384, 16384, 16384]);
        assert!((square - 0.5).abs() < 0.001, "square = {square}");
    }

    #[test]
    fn release_falls_by_one_over_e_per_time_constant() {
        let one = decay(1.0, RELEASE_MS);
        assert!((one - 1.0 / std::f32::consts::E).abs() < 0.001, "one = {one}");
        // 零时间不衰减
        assert_eq!(decay(0.8, 0.0), 0.8);
        // 负时间当零处理（时钟回拨不该把值放大）
        assert_eq!(decay(0.8, -5.0), 0.8);
        // 很久之后归零
        assert!(decay(1.0, 5000.0) < 0.001);
    }

    #[test]
    fn the_envelope_rises_at_once_and_falls_slowly() {
        // 从静音来一个满刻度：立刻到位，不等
        assert_eq!(next_level(0.0, 1.0, 0.0), 1.0);
        // 之后静音：慢慢落，不是一下掉到 0
        let falling = next_level(1.0, 0.0, 40.0);
        assert!(falling > 0.5 && falling < 1.0, "falling = {falling}");
        // 落的过程中来了个更大的：顶上去
        assert_eq!(next_level(0.2, 1.0, 80.0), 1.0);
    }
}
