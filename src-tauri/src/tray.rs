//! 托盘图标
//!
//! 三件事：唤回主窗口、暂停/恢复全部组件、退出。
//!
//! # 为什么现在才做
//!
//! 没有托盘的时候，"关掉主窗口"只能靠 `guard_main_close` 把窗口藏起来 ——
//! 用户想再打开它，唯一的办法是去点第二次启动（靠单实例锁唤回），
//! 或者干脆任务管理器结束进程。托盘把这条路补上了。
//!
//! # 暂停是真的停
//!
//! 不是"把窗口藏起来但后台照跑"。`Window::hide()` 会让 WebView2 把
//! `document.visibilityState` 翻成 hidden，同时 `visibility.rs` 从
//! `WindowEvent::Resized`（藏起来的窗口尺寸变 0×0）推一条
//! `lattice:window-visible` 下来 —— 调度器把两者取"与"，所有
//! `schedule.every` 当场停摆。恢复时反过来。所以"暂停"省的是真 CPU，
//! 不是只把画面抹掉。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

/// 托盘菜单里那三项的 id。字符串是为了跨线程安全（`MenuId` 也一样，
/// 但 id 用 `&str` 比出来更直观）
const ID_OPEN: &str = "lattice.open";
const ID_PAUSE: &str = "lattice.pause";
const ID_QUIT: &str = "lattice.quit";
/// 听写浮钮那一项（0027 §4，0032 删掉了「隐藏」）：钮上没有右键菜单，这里才是它的去处
const ID_DICTATION_RESET: &str = "lattice.dictation.reset";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, ID_OPEN, "Open Lattice", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, ID_PAUSE, "Pause all widgets", true, None::<&str>)?;
    // 0032：浮钮只在听写期间出现，所以"隐藏浮钮"这一项没有意义了，只剩"找回来"
    let reset_button = MenuItem::with_id(
        app,
        ID_DICTATION_RESET,
        "Put the dictation button back",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit Lattice", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &reset_button, &quit])?;

    // 暂停项的文字要跟着状态变，所以得把 handle 搬进闭包
    let pause_item: MenuItem<Wry> = pause.clone();

    let mut builder = TrayIconBuilder::with_id("lattice")
        .tooltip("Lattice")
        .menu(&menu)
        // 左键是"打开"，右键才是菜单 —— 托盘图标的常规约定
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            ID_OPEN => crate::instance::show_main(app),
            ID_PAUSE => {
                let paused = crate::runner::toggle_paused(app);
                // 文字写失败不该影响暂停本身，最多是菜单上那行字过时
                let _ = pause_item.set_text(if paused {
                    "Resume widgets"
                } else {
                    "Pause all widgets"
                });
            }
            ID_QUIT => app.exit(0),
            ID_DICTATION_RESET => crate::dictation::reset_button(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::instance::show_main(tray.app_handle());
            }
        });

    // 用窗口图标而不是另做一张：打包时图标已经在二进制里，多一份就多一份漂移
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    } else {
        eprintln!("[lattice] no window icon available; the tray icon will be blank");
    }

    builder.build(app)?;
    Ok(())
}
