//! assistant 的桌面小窗。
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
//! # 三条窗口上的规矩
//!
//! 1. **不置顶**。置顶好找，但会压在浏览器上面挡视线；`Ctrl+K` 唤出这一下
//!    已经把它提到最前了，够用。
//! 2. **关窗口 = 藏起来**，不是销毁。对话在内存里（`messages` ref），销毁 webview
//!    等于把刚聊到一半的过程扔掉 —— 而"哪一句让它动了什么"正是这个功能的价值。
//! 3. **位置记在磁盘上**（`assistant-window.json`）。拖动结束存一次，下次开在
//!    原处；没有记录时落在主屏右下角。
//!
//! 圆角走 `desktop::clip_rounded`（和卡片同一个 `CORNER_RADIUS`），不引透明窗口：
//! 它自己会画满一块不透明的面板，逐像素透明只是多绕 DWM 一圈。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// 窗口标签。**和 `main` / `widget-*` 都不一样**，别撞上
pub const LABEL: &str = "assistant";

/// 逻辑像素。宽度和主窗口里的抽屉一致（380 + 两侧内边距），高度够放六七轮对话
const WIDTH: f64 = 400.0;
const HEIGHT: f64 = 580.0;

/// 默认位置的边距：贴着右下角，但不贴边
const MARGIN: f64 = 28.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Pos {
    x: f64,
    y: f64,
}

fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

fn pos_path(app: &AppHandle) -> Option<PathBuf> {
    Some(config_dir(app)?.join("assistant-window.json"))
}

fn load_pos(app: &AppHandle) -> Option<Pos> {
    let text = std::fs::read_to_string(pos_path(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_pos(app: &AppHandle, pos: Pos) {
    let Some(path) = pos_path(app) else { return };
    let Ok(text) = serde_json::to_string_pretty(&pos) else {
        return;
    };
    /* 临时文件 + 原子替换：和 `state.json` / `assistant.json` 同一条规矩，
     * 半截文件会让下次启动"没有位置"，落回默认角落 —— 那不是灾难，但也没必要 */
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, text.as_bytes()).is_ok() {
        let _ = std::fs::rename(&temp, &path);
    }
}

/// 没有记录时的落点：主屏右下角。
///
/// 用工作区而不是整块屏幕 —— 任务栏高度得让出来，否则底下那截输入框永远在
/// 任务栏底下。
fn default_pos(app: &AppHandle) -> Pos {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return Pos { x: 120.0, y: 120.0 };
    };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);
    Pos {
        x: origin.x + size.width - WIDTH - MARGIN,
        y: origin.y + size.height - HEIGHT - MARGIN * 2.0,
    }
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
    let pos = load_pos(app).unwrap_or_else(|| default_pos(app));

    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("assistant.html".into()))
        .title("Lattice Assistant")
        .inner_size(WIDTH, HEIGHT)
        // 固定尺寸：面板是为这个宽度排的，拉宽只会让每行变长、读起来更累
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        // 不置顶（见模块注释第 1 条）。`Ctrl+K` 会 `set_focus()` 把它提到前面
        .always_on_top(false)
        .focused(true)
        .visible(false)
        .position(pos.x, pos.y)
        .build()
        .map_err(|error| format!("could not create the assistant window: {error}"))?;

    if let Ok(handle) = window.window_handle() {
        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
            let scale = window.scale_factor().unwrap_or(1.0);
            let _ = crate::desktop::clip_rounded(
                win32.hwnd.get() as isize,
                (WIDTH * scale).round() as u32,
                (HEIGHT * scale).round() as u32,
                crate::desktop::CORNER_RADIUS * scale,
            );
        }
    }

    guard_close(&window);
    window
        .show()
        .map_err(|error| format!("could not show the assistant window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("could not focus the assistant window: {error}"))?;
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
            let _ = save_current_pos(app, &window);
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
        let _ = save_current_pos(app, &window);
        let _ = window.hide();
    }
}

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .map(|window| window.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// 当前落点换算成逻辑像素存起来（多屏、不同缩放都用这一份）
fn save_current_pos(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let PhysicalPosition { x, y } = window
        .outer_position()
        .map_err(|error| format!("could not read the window position: {error}"))?;
    save_pos(
        app,
        Pos {
            x: x as f64 / scale,
            y: y as f64 / scale,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------
//
// **三个都是 `async fn`**，理由是踩出来的：`WebviewWindowBuilder::build()` 要把
// 建窗口的活儿投递回主线程再等结果，而同步命令**就占着主线程** —— 命令等自己，
// 界面当场冻住（`sync_widget_windows` 那条也是这么定下来的，见 lib.rs §5）。
// `hide` / `save_pos` 本身不建窗口，但一起做成 async，免得下次有人在这里加一句
// `build()` 又踩一遍。

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

/// 拖完标题栏存一次位置。由页面在 `startDragging()` 之后调用 ——
/// 拖动过程中系统会连发几十个 Moved，在那里存盘等于每次拖都写几十遍文件
#[tauri::command]
pub async fn assistant_window_save_pos(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return save_current_pos(&app, &window);
    }
    Ok(())
}
