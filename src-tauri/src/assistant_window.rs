//! assistant 的桌面窗口（`0002` / `0007`）。
//!
//! # 为什么是独立窗口，不是主窗口里的抽屉
//!
//! 抽屉只能活在主窗口里：主窗口一收起（桌面上还有组件时"关窗口"只是 `hide()`），
//! 抽屉就跟着消失。而这个东西的用途恰恰是"一边干别的、一边让它改桌面" ——
//! 它得能离开主窗口存在。
//!
//! # 它是平台的一部分，不是组件
//!
//! 所以它走的是 `llm_*` 那套命令 + `agent` 那条执行器通道（`assistant_act`
//! 转给主窗口跑），**不碰组件桥**。组件那侧只有 `llm:chat`（一张嘴，没有手）；
//! 这里是有手的：因为改桌面的是平台自己，不是某段第三方代码。
//!
//! # 两种模式（0007）
//!
//! - **浮窗**（默认）：普通窗口，不置顶。`Ctrl+K` 唤出这一下已经把它提到最前了。
//! - **桌面**：`desktop::apply_to(Desktop, interactive: true)` —— `HWND_BOTTOM` 的
//!   普通窗口 + 底层守卫。**不挂 WorkerW**：那是桌面的子窗口，WebView2 拿不到键盘
//!   焦点，聊天框等于废了（`desktop.rs` 开头写着这条）。要的是"贴着桌面、被应用
//!   盖住，但点它就能打字"。
//!
//! 两种层级都是**事后可改**的窗口属性，所以切换模式**不重建窗口** —— 对话留在
//! 它自己的内存里，一行都不会丢。谁要是把它改成"重建"，先读 `0007 §5` 最后一行。
//!
//! # 三条窗口上的老规矩
//!
//! 1. **不置顶**。置顶好找，但会压在浏览器上面挡视线。
//! 2. **关窗口 = 藏起来**，不是销毁。对话在内存里（`messages` ref），销毁 webview
//!    等于把刚聊到一半的过程扔掉 —— 而"哪一句让它动了什么"正是这个功能的价值。
//! 3. **位置、尺寸、底板、锁都记在磁盘上**（`assistant-window.json` v2）。
//!
//! 圆角走 `desktop::clip_rounded`（和卡片同一个 `CORNER_RADIUS`），不引透明窗口：
//! 它自己会画满一块面板，逐像素透明只是多绕 DWM 一圈。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use crate::desktop::{self, WindowLayer, WindowShape};

/*
 * 纯逻辑那一半**以子模块的形式挂在这里**，而不是在 `lib.rs` 里加一行 `mod`：
 * 这个功能分两步落地，第一步不该去动 `lib.rs`（那一刻它正归另一个会话）。
 * 文件仍然是独立的一份，`rustc --test assistant_window_policy.rs` 照样能单跑。
 */
#[path = "assistant_window_policy.rs"]
mod policy;

/// 窗口标签。**和 `main` / `widget-*` 都不一样**，别撞上
pub const LABEL: &str = "assistant";

/// 现在的窗口形态（`0007`）。磁盘上就 `floating` / `desktop` 两个字符串
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Floating,
    Desktop,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Floating => "floating",
            Mode::Desktop => "desktop",
        }
    }

    fn from_str(raw: &str) -> Mode {
        match policy::normalize_mode(raw) {
            "desktop" => Mode::Desktop,
            _ => Mode::Floating,
        }
    }
}

/// 逻辑像素。**和组件那边一样**：位置尺寸存逻辑像素，用的时候再按 DPI 放缩
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 底板（`0007` §3）。语义与组件的 `Appearance` 一字不差：
/// `tint` 是 `"auto"` 或 `#rrggbb`，`alpha` 是底色浓度 0..1，`blur` 是磨砂半径 0..40
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub tint: String,
    pub alpha: f64,
    pub blur: f64,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            tint: "auto".to_string(),
            alpha: 1.0,
            blur: 0.0,
        }
    }
}

/// `assistant-window.json` v2 的全量形状。**一次读、一次写**，
/// 前端拿到的就是这一份（别在两边各攒一份状态）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub version: u32,
    pub mode: Mode,
    pub rect: Rect,
    pub appearance: Appearance,
    pub locked: bool,
}

impl WindowState {
    /// 出厂状态：浮窗、400×580、右下角、底板出厂、不锁
    fn fresh(work: (f64, f64, f64, f64)) -> Self {
        let (width, height) = (policy::DEFAULT_W, policy::DEFAULT_H);
        let (x, y) = policy::default_position(width, height, work);
        Self {
            version: 2,
            mode: Mode::Floating,
            rect: Rect {
                x,
                y,
                width,
                height,
            },
            appearance: Appearance::default(),
            locked: false,
        }
    }
}

/// v1 的形状：只有 `{x, y}`。**只用来读**，写出去永远是 v2
#[derive(Debug, Deserialize)]
struct LegacyPos {
    x: f64,
    y: f64,
}

fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    Some(config_dir(app)?.join("assistant-window.json"))
}

/// 当前屏（逻辑像素）：`(left, top, width, height)`。
///
/// 取"窗口现在所在的那块屏"，窗口还没建时退回主屏 —— 拖到副屏再重启，
/// 它应该还在副屏上。
fn screen_area(app: &AppHandle) -> (f64, f64, f64, f64) {
    let monitor = app
        .get_webview_window(LABEL)
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        // 连屏幕都问不到：给一个不至于把窗口卡在负坐标的兜底
        return (0.0, 0.0, 1280.0, 800.0);
    };
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    (origin.x, origin.y, size.width, size.height)
}

/// 把一份状态夹进现在的屏幕与上下限。
///
/// **读和写都要过这一道**：文件可能是手改的、可能来自另一块屏、可能是
/// 一个已经缩到 0 的旧版本 —— 一次都不该变成"窗口看不见"
fn normalize_state(state: &mut WindowState, work: (f64, f64, f64, f64)) {
    state.version = 2;
    state.mode = Mode::from_str(state.mode.as_str());
    let (width, height) = policy::clamp_size(state.rect.width, state.rect.height);
    let (x, y) = policy::clamp_position(state.rect.x, state.rect.y, width, height, work);
    state.rect = Rect {
        x,
        y,
        width,
        height,
    };
    state.appearance = Appearance {
        tint: policy::normalize_tint(&state.appearance.tint),
        alpha: policy::clamp_alpha(state.appearance.alpha),
        blur: policy::clamp_blur(state.appearance.blur),
    };
}

fn load_state(app: &AppHandle) -> WindowState {
    let work = screen_area(app);
    let mut state = WindowState::fresh(work);
    let Some(path) = state_path(app) else {
        return state;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return state;
    };

    if let Ok(parsed) = serde_json::from_str::<WindowState>(&text) {
        state = parsed;
    } else if let Ok(legacy) = serde_json::from_str::<LegacyPos>(&text) {
        // v1 就地升级：位置照用，其余落出厂（尺寸取默认、底板出厂、不锁）
        state.rect.x = legacy.x;
        state.rect.y = legacy.y;
    } else {
        // 坏文件当"没有记录"：落右下角。**绝不拦住窗口** ——
        // 用户拿到的是一个能用的面板，而不是"它打不开了"
        return WindowState::fresh(work);
    }

    normalize_state(&mut state, work);
    state
}

fn save_state(app: &AppHandle, state: &WindowState) {
    let Some(path) = state_path(app) else { return };
    let Ok(text) = serde_json::to_string_pretty(state) else {
        return;
    };
    /* 临时文件 + 原子替换：和 `state.json` / `assistant.json` 同一条规矩，
     * 半截文件会让下次启动"没有记录"，落回默认角落 —— 那不是灾难，但也没必要 */
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, text.as_bytes()).is_ok() {
        let _ = std::fs::rename(&temp, &path);
    }
}

/// 把层级落到窗口上。两条路都是**事后可改**的，所以切模式不用重建窗口
fn apply_mode(window: &tauri::WebviewWindow, mode: Mode) -> Result<(), String> {
    match mode {
        // 能打字的那条路：不挂 WorkerW，`HWND_BOTTOM` + 底层守卫
        Mode::Desktop => {
            desktop::apply_to(window, WindowLayer::Desktop, false, true, WindowShape::Rect)
        }
        Mode::Floating => {
            if let Ok(handle) = window.window_handle() {
                if let RawWindowHandle::Win32(win32) = handle.as_raw() {
                    // 摘掉"永远待在底层"的守卫，否则点了它也升不到前面
                    desktop::set_sink(win32.hwnd.get() as isize, false);
                }
            }
            window
                .set_always_on_top(false)
                .map_err(|error| format!("could not reset the window layer: {error}"))?;
            let _ = window.show();
            let _ = window.set_focus();
            Ok(())
        }
    }
}

/// 把位置与尺寸落到窗口上（物理像素换算 + 跟着重裁圆角）
/// 按窗口**当前外框**裁一次圆角（和组件卡片同一个半径）。
///
/// 两件事都靠它：建窗口 / 换模式时要裁，**尺寸变了也要重裁** —— 区域是
/// "当时那个尺寸"的快照，放大之后新露出来的角落既不是圆的，也不在窗口的
/// 可点区域里（区域之外对系统来说等于那里没有窗口）。
fn reclip(window: &tauri::WebviewWindow) {
    if let Ok(handle) = window.window_handle() {
        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
            let scale = window.scale_factor().unwrap_or(1.0);
            let _ = desktop::clip_rounded_current(win32.hwnd.get() as isize, desktop::CORNER_RADIUS * scale);
        }
    }
}

fn apply_rect(app: &AppHandle, state: &WindowState) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LABEL) else {
        // 窗口还没建 / 已经藏起来：只存盘，下次 `create` 会按这一份建
        return Ok(());
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = (state.rect.width * scale).round().max(1.0) as u32;
    let height = (state.rect.height * scale).round().max(1.0) as u32;
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| format!("could not resize the assistant window: {error}"))?;
    window
        .set_position(PhysicalPosition::new(
            (state.rect.x * scale).round() as i32,
            (state.rect.y * scale).round() as i32,
        ))
        .map_err(|error| format!("could not move the assistant window: {error}"))?;
    reclip(&window);
    Ok(())
}

/// 拖完 / 缩完之后才写盘。
///
/// Windows 在拖动时会连发几十个 `Moved`（还有 `Resized`），每条都写一遍文件
/// 既费磁盘也没意义。这里只记"又来了一条"，400ms 内没有新事件才真写 ——
/// 用户松手时那一次刚好落在最后一个窗口里。收窗口（`hide`）与显式保存
/// （`assistant_window_save_pos`）各自还有保存点，所以不会漏。
///
/// 为什么放在 Rust 而不是页面里：位置是**窗口自己的事**。页面只在松手时补一次
/// IPC 的话，"按住拖、拖完立刻退出"这种序列就有一拍没存上；而这里连
/// 程序自己挪窗口（`apply_rect`）也一起兜住了。
fn schedule_save(app: AppHandle) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        if SEQ.load(Ordering::SeqCst) != seq {
            return; // 后面还有新的移动，让它去存
        }
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = save_current_rect(&app, &window);
        }
    });
}

/// 关窗口只藏起来：对话还在内存里，下次 `Ctrl+K` 接着聊
fn guard_close(window: &tauri::WebviewWindow) {
    let clone = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = clone.hide();
        }
    });
}

fn create(app: &AppHandle) -> Result<(), String> {
    let state = load_state(app);

    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("assistant.html".into()))
        .title("Lattice Assistant")
        .inner_size(state.rect.width, state.rect.height)
        .position(state.rect.x, state.rect.y)
        // **必须可调整**：Windows 上不可调整的窗口没有 `WS_THICKFRAME`，
        // 于是 `startResizeDragging`（WM_NCLBUTTONDOWN + HTBOTTOMRIGHT）什么都不做，
        // 页面自绘的手柄按下去等于按在一块石头上。上一版写 `resizable(false)` 是怕
        // 系统边框和自绘手柄打架，实测那一点"打架"根本不存在：`decorations(false)`
        // 之下没有可见边框，两个入口落到同一条 `Resized` 上。
        .resizable(true)
        // 下限交给系统再判一次：手柄和页面都在 320 × 420 处夹紧，但拖边那条路
        // 根本不过页面
        .min_inner_size(policy::MIN_W, policy::MIN_H)
        .decorations(false)
        .skip_taskbar(true)
        // 不置顶（见模块注释第 1 条）。`Ctrl+K` 会 `set_focus()` 把它提到前面
        .always_on_top(false)
        // 桌面模式的窗口一出生就该是沉的，别抢焦点
        .focused(state.mode == Mode::Floating)
        .visible(false)
        .build()
        .map_err(|error| format!("could not create the assistant window: {error}"))?;

    apply_mode(&window, state.mode)?;

    // 圆角：浮窗模式下 `apply_mode` 不走 `apply_to`，所以这里补一次
    reclip(&window);

    guard_close(&window);
    // 拖动与缩放的位置 / 尺寸由窗口自己记（页面不需要在松手时补一次 IPC）
    let moved_app = app.clone();
    // Resized 要多做一件事：**重裁圆角**。区域记的是当时那个尺寸，
    // 拖手柄放大之后新露出来的那一圈既不是圆角、也**点不到**
    // （区域之外的部分属于"窗口不存在"，鼠标会掉到下面的窗口里）
    let reclip_target = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) => schedule_save(moved_app.clone()),
        WindowEvent::Resized(_) => {
            reclip(&reclip_target);
            schedule_save(moved_app.clone());
        }
        _ => {}
    });
    window
        .show()
        .map_err(|error| format!("could not show the assistant window: {error}"))?;
    if state.mode == Mode::Floating {
        window
            .set_focus()
            .map_err(|error| format!("could not focus the assistant window: {error}"))?;
    }
    Ok(())
}

/// `Ctrl+K` 的那一下。
///
/// 三种状态各走各的：开着且是当前窗口 → 收起；开着但不是当前窗口 → 提到前面
/// 并聚焦（用户刚在主窗口里按的，他要的是"到这儿来"）；没开 → 建一个。
/// 返回操作之后它是不是可见，界面上那颗按钮的 `is-active` 跟着这个走。
pub fn toggle(app: &AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        if visible && window.is_focused().unwrap_or(false) {
            let _ = save_current_rect(app, &window);
            window
                .hide()
                .map_err(|error| format!("could not hide the assistant window: {error}"))?;
            return Ok(false);
        }
        window
            .show()
            .map_err(|error| format!("could not show the assistant window: {error}"))?;
        window.set_focus().ok();
        return Ok(true);
    }
    create(app)?;
    Ok(true)
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = save_current_rect(app, &window);
        let _ = window.hide();
    }
}

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .map(|window| window.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// 当前落点与尺寸换算成逻辑像素存起来（多屏、不同缩放都用这一份）
fn save_current_rect(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let PhysicalPosition { x, y } = window
        .outer_position()
        .map_err(|error| format!("could not read the window position: {error}"))?;
    let PhysicalSize { width, height } = window
        .inner_size()
        .map_err(|error| format!("could not read the window size: {error}"))?;

    let mut state = load_state(app);
    state.rect = Rect {
        x: x as f64 / scale,
        y: y as f64 / scale,
        width: width as f64 / scale,
        height: height as f64 / scale,
    };
    // 拖到屏幕边缘的情况要夹一次，否则下次启动它可能有一半在屏外
    normalize_state(&mut state, screen_area(app));
    save_state(app, &state);
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------
//
// **`toggle` / `hide` / `save_pos` 是 `async fn`**，理由是踩出来的：
// `WebviewWindowBuilder::build()` 要把建窗口的活儿投递回主线程再等结果，而同步
// 命令**就占着主线程** —— 命令等自己，界面当场冻住（`sync_widget_windows` 那条
// 也是这么定下来的，见 lib.rs §5）。`hide` / `save_pos` 本身不建窗口，但一起做成
// async，免得下次有人在这里加一句 `build()` 又踩一遍。
//
// 0007 的五条（state / mode / appearance / locked / save_rect）和上面三条同一批接线：
// 命令宏挂在这里，注册在 `lib.rs` 的 `invoke_handler`。**`mode` 与 `save_rect` 必须
// async** —— 它们要 `apply_mode` / `apply_rect` 去改窗口层级和位置，那是主线程的活，
// 同步命令会占着主线程等自己（理由同上一条）。面板开局读一次 `state`、改一次底板或锁
// 都拿返回值覆盖本地状态，所以这五条都返回 `WindowState`（改不动的两次给 `Result`）。

#[tauri::command]
pub async fn assistant_window_toggle(app: AppHandle) -> Result<bool, String> {
    toggle(&app)
}

/// 界面上那个 ✕ / Esc。和"关窗口"是同一件事：藏起来，不销毁
#[tauri::command]
pub async fn assistant_window_hide(app: AppHandle) -> Result<(), String> {
    hide(&app);
    Ok(())
}

/// 拖完标题栏 / 拉完手柄存一次。由页面在松手时调用 —— 拖动过程中系统会连发
/// 几十个 Moved，在那里存盘等于每次拖都写几十遍文件
#[tauri::command]
pub async fn assistant_window_save_pos(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return save_current_rect(&app, &window);
    }
    Ok(())
}

/// 现在这一份状态（模式、位置尺寸、底板、锁）。面板开局读一次，
/// 之后每次改都拿返回值覆盖 —— **别在页面里另攒一份权威**
#[tauri::command]
pub async fn assistant_window_state(app: AppHandle) -> WindowState {
    load_state(&app)
}

/// 换模式。窗口已经开着的话**就地改层级**（不重建 = 对话不丢）
#[tauri::command]
pub async fn assistant_window_mode(app: AppHandle, mode: String) -> Result<WindowState, String> {
    let mut state = load_state(&app);
    state.mode = Mode::from_str(&mode);
    if let Some(window) = app.get_webview_window(LABEL) {
        apply_mode(&window, state.mode)?;
    }
    save_state(&app, &state);
    Ok(state)
}

/// 改底板。**归一化在这里做**（非法值退回出厂），前端只负责把滑杆的值送上来
#[tauri::command]
pub async fn assistant_window_appearance(app: AppHandle, appearance: Appearance) -> WindowState {
    let mut state = load_state(&app);
    state.appearance = appearance;
    normalize_state(&mut state, screen_area(&app));
    save_state(&app, &state);
    state
}

/// 锁 / 解锁。锁的是**位置与尺寸**，不锁内容（和组件的 `locked` 同一句话）
#[tauri::command]
pub async fn assistant_window_locked(app: AppHandle, locked: bool) -> WindowState {
    let mut state = load_state(&app);
    state.locked = locked;
    save_state(&app, &state);
    state
}

/// 缩放结束：夹一次、落到窗口上、存盘。
/// 前端已经夹过一遍，这里再判一次 —— **Rust 是唯一真源**，渲染进程的 bug
/// 不该让窗口变成"0 宽"或者跑到屏外
#[tauri::command]
pub async fn assistant_window_save_rect(app: AppHandle, rect: Rect) -> Result<WindowState, String> {
    let mut state = load_state(&app);
    state.rect = rect;
    normalize_state(&mut state, screen_area(&app));
    apply_rect(&app, &state)?;
    save_state(&app, &state);
    Ok(state)
}
