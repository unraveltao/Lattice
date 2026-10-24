//! 参考线的像素规则：虚线的节拍和亮度
//!
//! 桌面上的那条线不是 DOM 画的（每个组件是一个独立窗口，谁也画不到窗口外面去），
//! 而是 `guides_overlay.rs` 在 Win32 层用两个 1px 的叠层窗口逐像素画出来的。
//! 逐像素就有"每一像素给多少 alpha"的问题 —— 那正是这个文件。
//!
//! 抽出来的理由和 `occlusion_policy.rs` 一样：Win32 那半在这台机器上没法自动跑
//! （要真桌面、真窗口），但"第 40 个像素该不该亮"是纯算术，可以用
//! `rustc --test` 单独编一遍，断言不复制。
//!
//! # 形状：一条 4px/4px 的虚线
//!
//! 实线太抢眼：一条 1px 的实线压在所有窗口上面，第一眼看到的是线本身，不是
//! "对上了"。虚线把存在感压下去一半，指向性一点不少。
//!
//! 线本身也**不是贯穿屏幕**的：它以被拖的那扇窗口为中心、两端各伸出「半个窗口
//! + 48px」（长度在 `runtime/align-guides.ts::guideLines` 里算，画布和桌面共用
//! 一份规则）。
//! 所以这里不需要"端头淡入"之类的过渡 —— 一段两三百像素的短虚线，两头断开
//! 本来就是虚线该有的样子。
//!
//! 画布上的 `.lattice-guide` 用同一套数（4px/4px、62% 亮度，见 src/styles.css），
//! 两边的观感才对得上。

/// 参考线的基准不透明度。
///
/// 1px 的线全靠明度和底色区分：给满会盖住卡片内容，给太少在壁纸上又看不见。
/// 0.62 和画布那条（`src/styles.css` 的 `color-mix(... 62%, transparent)`）
/// 是同一个数 —— 两边的线看起来必须一模一样，不然用户会觉得"桌面上的不是同一个东西"。
pub const BASE_ALPHA: f64 = 0.62;

/// 虚线的实线段长度（物理像素）
pub const DASH_ON: usize = 4;
/// 虚线的空白段长度（物理像素）
pub const DASH_OFF: usize = 4;

/// 这个像素在虚线的"实"段还是"空"段。
///
/// 相位从段落的起点算（窗口位置就是段落起点），拖动时整段线跟着窗口走，
/// 所以看起来不会"流动"。
pub fn is_dash_on(index: usize) -> bool {
    index % (DASH_ON + DASH_OFF) < DASH_ON
}

/// 第 `index` 个像素的不透明度：实段 `BASE_ALPHA`，空段 0。
pub fn line_alpha(index: usize) -> f64 {
    if is_dash_on(index) {
        BASE_ALPHA
    } else {
        0.0
    }
}

/// 把 `#rgb` / `#rrggbb` 解析成 RGB。
///
/// 不认 `rgb()` / `color-mix()`：颜色是宿主页从 `--lattice-accent` 读出来传进来的，
/// 那两个主题里都是十六进制。解析失败就退回调用方给的默认色 —— 参考线的颜色
/// 不值得为它引一个 CSS 颜色解析器。
pub fn parse_hex_color(text: &str) -> Option<[u8; 3]> {
    let hex = text.trim().strip_prefix('#').unwrap_or(text.trim());
    let nibble = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let bytes = hex.as_bytes();
    match bytes.len() {
        3 => {
            let r = nibble(bytes[0])?;
            let g = nibble(bytes[1])?;
            let b = nibble(bytes[2])?;
            Some([r * 17, g * 17, b * 17])
        }
        6 => {
            let mut out = [0u8; 3];
            for (slot, pair) in out.iter_mut().zip(bytes.chunks_exact(2)) {
                *slot = nibble(pair[0])? * 16 + nibble(pair[1])?;
            }
            Some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一整轮的节拍长度
    const CYCLE: usize = DASH_ON + DASH_OFF;

    #[test]
    fn it_is_a_dash_not_a_solid_line() {
        // 一条**全虚线**：不管在多长的线上，连续 8 个像素里必定 4 亮 4 灭。
        // 以前中段是实线，这里会红 —— 这条断言就是"线别再变回实线"的钉子
        for start in [0usize, 8, 40, 400, 996] {
            let lit = (start..start + CYCLE)
                .filter(|index| line_alpha(*index) > 0.0)
                .count();
            assert_eq!(lit, DASH_ON, "start={start}");
        }
    }

    #[test]
    fn alpha_is_only_two_values() {
        // 只有"亮"和"灭"两种像素，没有过渡灰 —— 端头不再淡入了，
        // 一段短虚线的两头断得干干净净才是虚线该有的样子
        for index in 0..256 {
            let alpha = line_alpha(index);
            assert!(
                alpha == 0.0 || (alpha - BASE_ALPHA).abs() < 1e-9,
                "index={index} alpha={alpha}"
            );
        }
    }

    #[test]
    fn phase_starts_at_the_segment() {
        // 段落起点（窗口左上角）一定是实段：Drop 到屏幕上的第一眼就能看见线头
        assert!(is_dash_on(0));
        assert!(!is_dash_on(DASH_ON));
        assert_eq!(is_dash_on(0), is_dash_on(CYCLE));
        assert_eq!(is_dash_on(3), is_dash_on(3 + CYCLE));
    }

    #[test]
    fn brightness_matches_the_canvas() {
        // 画布那边是 color-mix(... 62%, transparent)；两边必须是一个数
        assert!((BASE_ALPHA - 0.62).abs() < 1e-12);
        assert!((line_alpha(1) - 0.62).abs() < 1e-12);
    }

    #[test]
    fn hex_colours() {
        assert_eq!(parse_hex_color("#5dcaa5"), Some([0x5d, 0xca, 0xa5]));
        assert_eq!(parse_hex_color("5dcaa5"), Some([0x5d, 0xca, 0xa5]));
        assert_eq!(parse_hex_color("#fff"), Some([255, 255, 255]));
        assert_eq!(parse_hex_color("  #0f6e56 "), Some([0x0f, 0x6e, 0x56]));
        assert_eq!(parse_hex_color("#0F6E56"), Some([0x0f, 0x6e, 0x56]));
        assert_eq!(parse_hex_color("color-mix(in srgb, red, blue)"), None);
        assert_eq!(parse_hex_color(""), None);
        assert_eq!(parse_hex_color("#12345"), None);
        assert_eq!(parse_hex_color("#gggggg"), None);
    }
}
