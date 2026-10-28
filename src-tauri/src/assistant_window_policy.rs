//! assistant 窗口的**纯逻辑**这一半：模式、尺寸、位置、边框色的夹紧（`0007`）。
//!
//! 为什么单独一份、而且**不引 crate**：这些值决定"窗口会出现在哪、能不能被找回来"，
//! 它们必须能在任何机器上用 `rustc --test` 单跑（`fs_policy.rs` / `shell_policy.rs`
//! 同一条规矩）。真正碰窗口的那一半在 `assistant_window.rs` 里 —— 那边要建 webview、
//! 挂层级守卫，跑不动也测不细。

/// 面板的最小尺寸。
///
/// 宽度从 320 抬到 560 是因为**两栏**（`0034`）：左边一条 208 的会话栏占完，
/// 320 宽只剩 112 给对话，一行字断成三截。560 是"侧栏 208 + 对话 352"，
/// 352 刚好放得下一条 12px 的整句。
pub const MIN_W: f64 = 560.0;
pub const MIN_H: f64 = 420.0;

/// 出厂尺寸。`400 × 580` 是单栏时代的出厂值，两栏放不下（侧栏占完只剩 190），
/// 所以先改成 `880 × 640`。0035 又收到 `800 × 600`：用户的原话是"让整体的
/// 对话框变得小一点"，而 880 那版在 1080p 上占掉 4/5 屏，看着像一整个应用。
/// 800 = 侧栏 208 + 对话 592，仍能并排放下一列会话和一段回答。
pub const DEFAULT_W: f64 = 800.0;
pub const DEFAULT_H: f64 = 600.0;

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

/// 磁盘上存的那份尺寸 → 这一版该用的尺寸。
///
/// 和 `clamp_size` 分开，因为两者答的不是同一个问题。`clamp_size` 夹的是
/// **一个已经算出来的值**：比最小还小说明他松手在了边界外，夹回最小就行。
/// 这里读的是**上一版存下来的出厂值** —— `400 × 580` 在两栏下等于"侧栏占完
/// 只剩 190 给对话"，夹到 560 也还是挤，所以比最小还窄的一律当旧出厂值，
/// 直接抬到新出厂值。
///
/// 这个判据不会误伤"真有人把窗口拖窄了"：`min_inner_size(MIN_W, MIN_H)`
/// 挡着，拖不到 560 以下。
pub fn migrate_size(width: f64, height: f64) -> (f64, f64) {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return (DEFAULT_W, DEFAULT_H);
    }
    if width < MIN_W {
        return (DEFAULT_W, DEFAULT_H);
    }
    (width.max(MIN_W), height.max(MIN_H))
}

/// 把尺寸夹进工作区：既不许小过下限，也**不许大过屏幕**。
///
/// 上限这一半是踩出来的（0036）：`SetWindowPos(SWP_FRAMECHANGED)` 之后系统会
/// 补发一条 `Resized`，而那条事件里的 `inner_size()` 可能是 0 —— 读出来的 0
/// 换算成 `u32` 再落盘，就成了 `800 × 65535` 这种记录。`migrate_size` 只管
/// 下限，`clamp_position` 只会挪位置，于是下次启动窗口整个跑到屏幕外，
/// 只能手改 JSON 才救得回来。工作区就是唯一正确的上限。
pub fn clamp_size(width: f64, height: f64, work: (f64, f64, f64, f64)) -> (f64, f64) {
    let (_, _, work_w, work_h) = work;
    // 工作区本身可能是坏值（`screen_area` 问不到屏幕时的兜底是 1280×800，
    // 但别指望），所以先把上限抬到不低于下限，免得夹出一个负的可用区间
    let max_w = if work_w.is_finite() { work_w.max(MIN_W) } else { MIN_W };
    let max_h = if work_h.is_finite() { work_h.max(MIN_H) } else { MIN_H };
    let width = if width.is_finite() { width } else { DEFAULT_W };
    let height = if height.is_finite() { height } else { DEFAULT_H };
    (width.clamp(MIN_W, max_w), height.clamp(MIN_H, max_h))
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

/// 缩放档位（0036）。**五档，从小到大**，和 `src/runtime/assistant-window.ts`
/// 的 `ZOOM_STEPS` 必须一字不差（尺寸那几个数已经是这个规矩）。
///
/// 为什么是五档而不是连续值：`Ctrl+滚轮` 一格滚轮跳一档，连续值会让"滚一格
/// 变多少"取决于滚轮加速度（每台鼠标不一样）。五档还能保证 `Ctrl+0` 回得去。
///
/// 为什么顶到 1.5 就不涨了：800 宽的窗里会话栏 208，1.5 倍时它占 312，
/// 对话区剩 488 —— 再大一档，一行字就要断成两截了。
pub const ZOOM_STEPS: [f64; 5] = [0.85, 1.0, 1.15, 1.3, 1.5];

/// 认不出来 / 不在档位表上 → **最近的档位**；坏值（NaN / 无穷 / ≤ 0）→ 1.0。
///
/// 两个"最近的"一样近时取**小的那个**（1.4 → 1.3，不是 1.5）：宁可比用户要的
/// 小一点，也不要让一个手改过的数字把面板撑得比他要的大。
pub fn normalize_zoom(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return 1.0;
    }
    let mut best = ZOOM_STEPS[0];
    let mut best_gap = f64::INFINITY;
    for step in ZOOM_STEPS {
        let gap = (step - value).abs();
        if gap < best_gap {
            best_gap = gap;
            best = step;
        }
    }
    best
}

/// `dir > 0` 放大一档，`dir < 0` 缩小一档，`dir == 0` 原地不动。
/// **到顶到底也原地不动** —— 再滚不报错、不循环回另一头（循环会让"滚到底了"
/// 看起来像"突然变得很小"）。
///
/// 运行时真正走这一步的是前端（`src/runtime/assistant-window.ts::stepZoom`），
/// 这份镜像的用处是**被 `rustc --test` 钉住**：两张表一旦各走各的，症状是
/// "滚一格跳两档"或者"到顶了还在涨"，而那种错两边都看不出来。
#[allow(dead_code)]
pub fn step_zoom(current: f64, dir: i32) -> f64 {
    let current = normalize_zoom(current);
    let index = ZOOM_STEPS
        .iter()
        .position(|step| *step == current)
        .unwrap_or(1) as i32;
    let next = (index + dir.signum()).clamp(0, ZOOM_STEPS.len() as i32 - 1);
    ZOOM_STEPS[next as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一块 1920×1080 的屏，原点 (0, 0)
    const SCREEN: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn the_zoom_table_is_the_documented_five_steps() {
        assert_eq!(ZOOM_STEPS, [0.85, 1.0, 1.15, 1.3, 1.5]);
        // 必须递增，而且必须含 1（出厂值得有一档能落）
        assert!(ZOOM_STEPS.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(ZOOM_STEPS.contains(&1.0));
    }

    #[test]
    fn a_zoom_off_the_table_snaps_to_the_nearest_step() {
        for step in ZOOM_STEPS {
            assert_eq!(normalize_zoom(step), step, "档位上的值原样放行");
        }
        // 1.4 和 1.3 / 1.5 一样近 → 取小的那个
        assert_eq!(normalize_zoom(1.4), 1.3);
        assert_eq!(normalize_zoom(1.17), 1.15);
        // 超出上下界 → 落到两头的档，而不是夹成一个不在表上的数
        assert_eq!(normalize_zoom(1.9), 1.5);
        assert_eq!(normalize_zoom(0.3), 0.85);
    }

    #[test]
    fn a_broken_zoom_falls_back_to_one() {
        // 坏值不是"最近的档"，是 1 —— 一个 0 或 NaN 不该被解读成"用户要 0.85"
        assert_eq!(normalize_zoom(f64::NAN), 1.0);
        assert_eq!(normalize_zoom(f64::INFINITY), 1.0);
        assert_eq!(normalize_zoom(f64::NEG_INFINITY), 1.0);
        assert_eq!(normalize_zoom(0.0), 1.0);
        assert_eq!(normalize_zoom(-2.0), 1.0);
    }

    #[test]
    fn stepping_stops_at_both_ends() {
        assert_eq!(step_zoom(1.0, 1), 1.15);
        assert_eq!(step_zoom(1.0, -1), 0.85);
        // 到顶 / 到底原地不动，不循环
        assert_eq!(step_zoom(1.5, 1), 1.5);
        assert_eq!(step_zoom(0.85, -1), 0.85);
        assert_eq!(step_zoom(1.3, 0), 1.3);
        // 从坏值起步先归位，再走一档
        assert_eq!(step_zoom(f64::NAN, 1), 1.15);
    }

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
    fn a_legacy_size_is_lifted_to_the_new_default() {
        // 单栏时代的出厂值：夹到 560 仍然挤（侧栏 208 占完只剩 352），所以抬到 880×640
        assert_eq!(migrate_size(400.0, 580.0), (DEFAULT_W, DEFAULT_H));
        // 用户自己拖出来的尺寸原样留着
        assert_eq!(migrate_size(880.0, 640.0), (880.0, 640.0));
        assert_eq!(migrate_size(720.0, 520.0), (720.0, 520.0));
        // 太窄 = 只可能是旧出厂值；太矮 = 夹回最小，宽度留着
        assert_eq!(migrate_size(300.0, 520.0), (DEFAULT_W, DEFAULT_H));
        assert_eq!(migrate_size(720.0, 300.0), (720.0, MIN_H));
        // 坏值落回出厂值，不是最小 —— 坏值不该把窗口变成一条缝
        assert_eq!(migrate_size(0.0, 0.0), (DEFAULT_W, DEFAULT_H));
        assert_eq!(migrate_size(-10.0, -10.0), (DEFAULT_W, DEFAULT_H));
        assert_eq!(migrate_size(f64::NAN, 600.0), (DEFAULT_W, DEFAULT_H));
        assert_eq!(migrate_size(f64::INFINITY, 0.0), (DEFAULT_W, DEFAULT_H));
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
    fn a_size_is_clamped_into_the_work_area() {
        // 正常值原样通过
        assert_eq!(clamp_size(800.0, 600.0, SCREEN), (800.0, 600.0));
        // 上限：`800 × 65535` 那种落盘记录不许再进来（0036 的现场）
        assert_eq!(clamp_size(800.0, 65535.0, SCREEN), (800.0, 1080.0));
        assert_eq!(clamp_size(4000.0, 600.0, SCREEN), (1920.0, 600.0));
        // 下限：比最小还小 → 抬到最小
        assert_eq!(clamp_size(100.0, 100.0, SCREEN), (MIN_W, MIN_H));
        // 坏值 → 出厂尺寸
        assert_eq!(clamp_size(f64::NAN, f64::NAN, SCREEN), (DEFAULT_W, DEFAULT_H));
    }

    #[test]
    fn a_tiny_work_area_does_not_invert_the_range() {
        // 工作区比下限还小（分屏 / 竖屏）：上限抬到下限，不能夹出一个负区间
        let tiny = (0.0, 0.0, 400.0, 300.0);
        assert_eq!(clamp_size(800.0, 600.0, tiny), (MIN_W, MIN_H));
        assert_eq!(
            clamp_size(800.0, 600.0, (0.0, 0.0, f64::NAN, f64::NAN)),
            (MIN_W, MIN_H)
        );
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
