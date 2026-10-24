//! 桌面拖拽的对齐参考线：告诉前端"能和谁对齐"，并把算出来的线画到屏幕上
//!
//! 画布上的对齐是纯前端的事（`runtime/align-guides.ts` 算坐标、`Canvas.tsx` 画线）。
//! 桌面上不行：每个组件是一个独立窗口，前端拿不到别人的矩形，也画不到自己窗口
//! 外面去。所以这里补两件事：
//!
//! - `guide_targets`：把其它可见组件窗口的矩形 + 当前显示器工作区交给宿主页，
//!   让它在**同一套** `computeAlign` 里算吸附（算法只有一份，画布和桌面不会漂）；
//! - `guide_show`：接收算出来的两段线（位置 + 长度），交给 `guides_overlay.rs` 画。
//!
//! # 线是局部的
//!
//! 传进来的不是"一条贯穿屏幕的竖线坐标"，而是一段：`at` 钉住的那个坐标，
//! `from` / `len` 说这一截有多长。长度由前端按"以被拖的窗口为中心、两端各伸出
//! 半个窗口 + 48px"
//! 算出来（`guideLines`，画布用的是同一个函数）—— 一条从屏幕顶画到底的线会像
//! 把桌面切成两半，比卡片本身还显眼。
//!
//! # 为什么坐标全是物理像素
//!
//! 桌面窗口的位置与尺寸本来就是物理像素（PerMonitorV2，见 widgetHost.ts 的注释），
//! 两块屏缩放不同时"逻辑像素"不是同一套空间。参考线也必须落在物理像素上，
//! 否则在 150% 的屏上会偏几像素 —— 而 8px 的吸附阈值本身就很窄。
//!
//! # 为什么邻居只在拖动开始时取一次
//!
//! 拖动期间只有被拖的那扇窗口在动，别人的矩形是静止的。一帧一次 IPC 换来的
//! 只是"别人刚好在同时被拖"这种不存在的情形。跨屏时缩放变了会重取一次
//! （见 widgetHost.ts 里 `scale` 变化那段）。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::guides_overlay;
use crate::runner::LABEL_PREFIX;

/// 物理像素矩形
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 一段参考线（物理像素）：`at` 是钉住的坐标，`from` / `len` 是它画多长
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct GuideSegment {
    pub at: f64,
    pub from: f64,
    pub len: f64,
}

/// 拖动开始时可以从哪儿对齐
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignTargets {
    /// 当前显示器的工作区。给了它，"摆到屏幕正中 / 贴着屏幕边"也有参考线
    pub bounds: Rect,
    /// 其它可见组件窗口。隐藏的（暂停中）不算 —— 和看不见的东西对齐是魔法
    pub rects: Vec<Rect>,
}

/// 拿邻居矩形与工作区。
///
/// 必须 `async`：同步命令跑在主线程上，而 `outer_position()` / `inner_size()`
/// 要把活儿投递回主线程再等结果 —— 自己等自己，和 `sync_widget_windows` 里
/// 那条死锁是同一回事（见 runner.rs 的注释）。
#[tauri::command]
pub async fn guide_targets(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<AlignTargets, String> {
    let me = window.label().to_string();

    let mut rects = Vec::new();
    for (label, other) in app.webview_windows() {
        if !label.starts_with(LABEL_PREFIX) || label == me {
            continue;
        }
        // 读不到可见性就当它可见：和 visibility.rs "读不到就当看得见"同一条规矩
        if !other.is_visible().unwrap_or(true) {
            continue;
        }
        let (Ok(position), Ok(size)) = (other.outer_position(), other.inner_size()) else {
            continue;
        };
        if size.width == 0 || size.height == 0 {
            continue;
        }
        rects.push(Rect {
            x: position.x as f64,
            y: position.y as f64,
            w: size.width as f64,
            h: size.height as f64,
        });
    }

    Ok(AlignTargets {
        bounds: bounds_for(&window),
        rects,
    })
}

/// 显示 / 移动 / 收掉参考线。
///
/// 两个参数各是一段线（绝对物理像素），`None` 表示这个方向没有线；两个都 `None`
/// 就是收线。颜色由宿主页从 `--lattice-accent` 读出来传进来 —— 平台切换明暗时
/// 线要跟着换色。
#[tauri::command]
pub fn guide_show(
    vertical: Option<GuideSegment>,
    horizontal: Option<GuideSegment>,
    color: Option<String>,
) {
    let accent = color
        .as_deref()
        .and_then(crate::guide_policy::parse_hex_color)
        // 宿主页读不到令牌时的兜底：深色主题的 accent
        .unwrap_or([0x5d, 0xca, 0xa5]);

    // NaN / Infinity 会让 `round() as i32` 变成 0，反倒画出一条贴在(0,0)的线，
    // 所以先按 0 兜住；长度 <= 0 的段落在 `Segment::sane` 里被丢掉
    let round = |value: f64| if value.is_finite() { value.round() as i32 } else { 0 };
    let wire = |segment: Option<GuideSegment>| {
        segment.map(|segment| guides_overlay::Segment {
            at: round(segment.at),
            from: round(segment.from),
            len: round(segment.len),
        })
    };

    let vertical = wire(vertical);
    let horizontal = wire(horizontal);
    if vertical.is_none() && horizontal.is_none() {
        guides_overlay::hide();
        return;
    }
    guides_overlay::show(vertical, horizontal, accent);
}

fn bounds_for(window: &WebviewWindow) -> Rect {
    #[cfg(windows)]
    {
        let hwnd = hwnd_of(window);
        let area = guides_overlay::work_area(hwnd).unwrap_or_else(guides_overlay::screen_bounds);
        Rect {
            x: area[0] as f64,
            y: area[1] as f64,
            w: area[2] as f64,
            h: area[3] as f64,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Rect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
        }
    }
}

#[cfg(windows)]
fn hwnd_of(window: &WebviewWindow) -> isize {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().map(|handle| handle.as_raw()) {
        Ok(RawWindowHandle::Win32(win32)) => win32.hwnd.get() as isize,
        _ => 0,
    }
}
