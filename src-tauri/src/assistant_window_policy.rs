//! assistant 窗口的**纯逻辑**这一半：模式、尺寸、位置、边框色的夹紧（`0007`）。
//!
//! 为什么单独一份、而且**不引 crate**：这些值决定"窗口会出现在哪、能不能被找回来"，
//! 它们必须能在任何机器上用 `rustc --test` 单跑（`fs_policy.rs` / `shell_policy.rs`
//! 同一条规矩）。真正碰窗口的那一半在 `assistant_window.rs` 里 —— 那边要建 webview、
//! 挂层级守卫，跑不动也测不细。

/// 面板的最小尺寸。再小，最后一条回答和输入框就叠在一起了
pub const MIN_W: f64 = 320.0;
pub const MIN_H: f64 = 420.0;

/// 出厂尺寸。和这个窗口一直以来的 `400 × 580` 一致 —— 老用户升级之后
/// 不会发现"它自己变了个样子"
pub const DEFAULT_W: f64 = 400.0;
pub const DEFAULT_H: f64 = 580.0;

/// 默认落点离屏幕边缘的余量（逻辑像素）
pub const MARGIN: f64 = 28.0;

/// 模糊上限，和 `src/runtime/appearance.ts` 的 `MAX_BLUR` 是**同一个数**。
/// 两处都要判（前端滑杆夹一次、写盘前再夹一次），所以只能是两个家；
/// 改一处必须改另一处 —— 对不上不会报错，只会让"滑杆到头"和"文件里的值"不一致
pub const MAX_BLUR: f64 = 40.0;

/// 两个模式。**磁盘上就这两个字符串**，别再加别名
pub const MODES: [&str; 2] = ["floating", "desktop"];

/// 认不出来一律退回 `floating`，**不是**退回 `desktop`。
///
/// 方向是故意的：桌面模式的窗口沉在底下、被应用盖住（那正是它的用途），
/// 一个坏值让它"看起来消失了"；浮窗至少还能 Ctrl+K 找回来。和
/// `normalize_approval` 对陌生值落回 `ask` 同一条理由 —— 坏值不许扩大影响。
pub fn normalize_mode(raw: &str) -> &'static str {
    let text = raw.trim().to_ascii_lowercase();
    // 清单只此一份：先认 `MODES` 里的字面量，认不出来才谈兜底
    MODES
        .iter()
        .copied()
        .find(|mode| *mode == text)
        .unwrap_or("floating")
}

/// 尺寸夹进 `MIN..`；坏值（NaN / 0 / 负数 / 无穷）落回出厂值。
///
/// 不夹的后果很具体：一个 `0` 宽的面板是"看不见也点不到"，而用户只能去
/// 删配置文件 —— 一个坏值不该把窗口变成不可用。
pub fn clamp_size(width: f64, height: f64) -> (f64, f64) {
    let width = if width.is_finite() && width > 0.0 { width } else { DEFAULT_W };
    let height = if height.is_finite() && height > 0.0 { height } else { DEFAULT_H };
    (width.max(MIN_W), height.max(MIN_H))
}

/// 把窗口整个夹进工作区 `(left, top, width, height)`（逻辑像素）。
///
/// 窗口比工作区还大时贴左上角：宁可右边/下边溢出，也不让它跑到屏幕外
/// （跑到屏幕外 = 用户想找都找不回来，只能改配置文件）。
pub fn clamp_position(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    work: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (left, top, work_w, work_h) = work;
    let max_x = (left + work_w - width).max(left);
    let max_y = (top + work_h - height).max(top);
    let x = if x.is_finite() { x.clamp(left, max_x) } else { left };
    let y = if y.is_finite() { y.clamp(top, max_y) } else { top };
    (x, y)
}

/// 没有记录时的落点：右下角，留出任务栏和一圈余量（和旧版 `default_pos` 同一条）
pub fn default_position(width: f64, height: f64, work: (f64, f64, f64, f64)) -> (f64, f64) {
    let (left, top, work_w, work_h) = work;
    clamp_position(
        left + work_w - width - MARGIN,
        top + work_h - height - MARGIN * 2.0,
        width,
        height,
        work,
    )
}

/// 底色浓度夹进 `0..=1`，两位小数。坏值落回 `1`（实心 = 出厂）
pub fn clamp_alpha(alpha: f64) -> f64 {
    if !alpha.is_finite() {
        return 1.0;
    }
    (alpha.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

/// 磨砂半径夹进 `0..=MAX_BLUR`，一位小数。坏值落回 `0`（不磨砂 = 出厂）
pub fn clamp_blur(blur: f64) -> f64 {
    if !blur.is_finite() {
        return 0.0;
    }
    (blur.clamp(0.0, MAX_BLUR) * 10.0).round() / 10.0
}

/// 底色：`"auto"`（跟随主题）或 `#rrggbb`。认不出来一律 `"auto"`，
/// 三位缩写摊成六位 —— 和前端 `normalizeTint` 同一条规则，只是这里
/// 返回 `String`（要写进文件，`&'static str` 不够用）
pub fn normalize_tint(raw: &str) -> String {
    let text = raw.trim().to_ascii_lowercase();
    if text == "auto" {
        return "auto".to_string();
    }
    let Some(hex) = text.strip_prefix('#') else {
        return "auto".to_string();
    };
    if !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return "auto".to_string();
    }
    match hex.len() {
        3 => {
            let mut out = String::from("#");
            for ch in hex.chars() {
                out.push(ch);
                out.push(ch);
            }
            out
        }
        6 => format!("#{hex}"),
        _ => "auto".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一块 1920×1080 的屏，原点 (0, 0)
    const SCREEN: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn only_the_two_modes_exist() {
        assert_eq!(MODES, ["floating", "desktop"]);
        for mode in MODES {
            assert_eq!(normalize_mode(mode), mode);
        }
    }

    #[test]
    fn a_bad_mode_falls_back_to_floating() {
        // 退回 `desktop` 会让窗口"看起来消失了" —— 默认值只有一个方向
        for raw in ["", "  ", "desk", "top", "0", "floating!", "desktopx"] {
            assert_eq!(normalize_mode(raw), "floating", "bad mode: {raw}");
        }
        // 大小写与空白算同一个人写的
        assert_eq!(normalize_mode("DESKTOP"), "desktop");
        assert_eq!(normalize_mode(" Desktop "), "desktop");
    }

    #[test]
    fn size_never_goes_below_the_minimum() {
        assert_eq!(clamp_size(400.0, 580.0), (400.0, 580.0));
        assert_eq!(clamp_size(100.0, 100.0), (MIN_W, MIN_H));
        assert_eq!(clamp_size(900.0, 700.0), (900.0, 700.0));
    }

    #[test]
    fn a_broken_size_falls_back_to_the_default() {
        // `0` 宽 = 看不见也点不到，只能去删配置文件
        assert_eq!(clamp_size(0.0, 0.0), (DEFAULT_W, DEFAULT_H));
        assert_eq!(clamp_size(-10.0, -10.0), (DEFAULT_W, DEFAULT_H));
        assert_eq!(clamp_size(f64::NAN, f64::NAN), (DEFAULT_W, DEFAULT_H));
        assert_eq!(clamp_size(f64::INFINITY, 0.0), (DEFAULT_W, DEFAULT_H));
    }

    #[test]
    fn a_position_inside_the_screen_is_kept() {
        assert_eq!(clamp_position(100.0, 120.0, 400.0, 580.0, SCREEN), (100.0, 120.0));
    }

    #[test]
    fn a_position_is_pulled_back_inside() {
        // 右边 / 下边溢出 → 拉到"刚好贴边"
        assert_eq!(
            clamp_position(1900.0, 1000.0, 400.0, 580.0, SCREEN),
            (1520.0, 500.0)
        );
        // 左边 / 上边溢出 → 拉到 0
        assert_eq!(clamp_position(-50.0, -80.0, 400.0, 580.0, SCREEN), (0.0, 0.0));
    }

    #[test]
    fn a_window_bigger_than_the_screen_sticks_to_the_top_left() {
        // 溢出右边也不许跑到屏幕外：跑到屏幕外 = 用户找不回来
        assert_eq!(clamp_position(500.0, 500.0, 2400.0, 1600.0, SCREEN), (0.0, 0.0));
    }

    #[test]
    fn a_broken_position_lands_on_the_origin() {
        assert_eq!(clamp_position(f64::NAN, f64::NAN, 400.0, 580.0, SCREEN), (0.0, 0.0));
    }

    #[test]
    fn the_default_spot_is_the_bottom_right_corner() {
        let (x, y) = default_position(400.0, 580.0, SCREEN);
        // 右边留一个 MARGIN，下边留两个（一个给任务栏）
        assert_eq!(x, 1920.0 - 400.0 - MARGIN);
        assert_eq!(y, 1080.0 - 580.0 - MARGIN * 2.0);
        // 已经夹过一遍，所以一定在屏内
        assert_eq!(clamp_position(x, y, 400.0, 580.0, SCREEN), (x, y));
    }

    #[test]
    fn alpha_and_blur_are_clamped_to_their_ranges() {
        assert_eq!(clamp_alpha(1.0), 1.0);
        assert_eq!(clamp_alpha(0.0), 0.0);
        assert_eq!(clamp_alpha(0.456), 0.46);
        assert_eq!(clamp_alpha(-3.0), 0.0);
        assert_eq!(clamp_alpha(9.0), 1.0);
        assert_eq!(clamp_alpha(f64::NAN), 1.0);

        assert_eq!(clamp_blur(0.0), 0.0);
        assert_eq!(clamp_blur(12.34), 12.3);
        assert_eq!(clamp_blur(100.0), MAX_BLUR);
        assert_eq!(clamp_blur(-1.0), 0.0);
        assert_eq!(clamp_blur(f64::NAN), 0.0);
    }

    #[test]
    fn tint_is_auto_or_a_six_digit_hex() {
        assert_eq!(normalize_tint("auto"), "auto");
        assert_eq!(normalize_tint(" AUTO "), "auto");
        assert_eq!(normalize_tint("#abc"), "#aabbcc");
        assert_eq!(normalize_tint("#AABBCC"), "#aabbcc");
        // 认不出来一律跟随主题：写死一个坏色号会让面板变成一块黑
        for bad in ["", "red", "#12", "#12345", "123456", "rgb(1,2,3)", "#gggggg"] {
            assert_eq!(normalize_tint(bad), "auto");
        }
    }
}
