//! 棂 / Lattice —— Windows 桌面小组件平台
//!
//! 分三层：
//!   - 前端（src/）：平台外壳 + 组件运行时（沙箱 iframe + RPC 桥）
//!   - 本模块：把前端需要的能力收敛成少量命令
//!   - desktop / runner：窗口层级、裁剪、焦点，以及"把画布上的组件变成真窗口"
//!
//! 主窗口承担"设计态"：摆组件、调层级、授权限。
//! 点"投放到桌面"之后，每个 Placement 变成一个独立的 WebviewWindow，
//! 主窗口最小化退场，组件就留在桌面上。

pub mod agent;
pub mod agent_policy;
pub mod audio;
pub mod audio_policy;
pub mod autostart;
pub mod autostart_policy;
pub mod backup;
pub mod catalogue_policy;
pub mod crash;
pub mod crash_policy;
pub mod csp;
pub mod desktop;
pub mod diagnostics;
pub mod egress;
pub mod instance;
pub mod media;
pub mod metrics;
pub mod network;
pub mod package;
pub mod package_policy;
pub mod network_policy;
pub mod occlusion;
pub mod occlusion_policy;
pub mod protocol;
pub mod runner;
pub mod signature;
pub mod signature_policy;
pub mod state;
pub mod store;
pub mod tray;
pub mod visibility;
pub mod wallpaper;
pub mod watch;
pub mod watch_policy;
pub mod widget_store;
pub mod widgets;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 单实例：已经有 Lattice 在跑就把主窗口翻出来，然后本进程退出。
    // 必须在建窗口之前判 —— 晚一步，两套组件窗口就已经各自建出来了。
    if !instance::claim() {
        instance::signal_existing();
        return;
    }

    // 这台机器上 WebView2 的 GPU 进程起不来：窗口建出来了、URL 也对，
    // 但渲染进程不工作，画面一片白，脚本也不执行（eval 返回 Ok 却什么都没跑）。
    // 把 GPU 挪进浏览器进程（--in-process-gpu）就好了。
    //
    // 注意**不要**顺手加 --disable-gpu-compositing：它会把 DirectComposition
    // 关掉，WebView2 的透明背景直接退回白底；加上它之后透明窗口甚至建不出来
    // （HRESULT 0x8007139F）。想恢复默认行为：启动前设 LATTICE_GPU=1。
    let software_render = std::env::var("LATTICE_GPU").map(|v| v != "1").unwrap_or(true);
    if software_render && std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        // SAFETY: 在任何线程创建之前设置，单线程阶段写入环境变量是安全的
        unsafe {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--in-process-gpu");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 自动更新：只在用户点了"Check for updates"时跑，不后台轮询。
        // 后台轮询一个只发布几次的项目，等于每台机器每天替你发一次请求
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(runner::Runner::default())
        // agent 端点：默认关，开关在设置菜单里。它要转发请求给主窗口，
        // 所以状态得先 manage 好（见 agent.rs 的模块注释）
        .manage(agent::Agent::default())
        .setup(|app| {
            // 第二次启动 → 唤回主窗口的那条线程
            instance::listen(app.handle().clone());
            guard_main_close(app.handle());
            // 主窗口最小化时 `document.visibilityState` 不会变，画布上的组件
            // 会继续按心跳空转 —— 可见性得从这里发下去（见 visibility.rs）
            if let Some(main) = app.get_webview_window("main") {
                visibility::watch(&main);
            }
            // 托盘失败不该拖垮启动：最坏情况是回到"没有托盘"的旧行为
            if let Err(error) = tray::setup(app.handle()) {
                eprintln!("[lattice] could not create the tray icon: {error}");
            }
            // 组件目录的文件监听：改完文件存盘，卡片自己刷新
            watch::start(app.handle().clone());
            // 被别的窗口挡住不产生任何事件，只能自己轮询（见 occlusion.rs）
            occlusion::watch_all(app.handle());
            // 自启那条注册表命令可能指着上一次的安装位置（升级、换盘、
            // 或者开发态写进去的 target\debug 路径）。启动时对一次账
            autostart::reconcile();
            // agent 端点：磁盘上说开着才开。关着的时候**不 bind**，
            // 不是"绑上但拒绝"（见 agent.rs）
            agent::start(app.handle().clone());
            Ok(())
        })
        // 用户组件不在前端资源里，得靠自定义协议把 %APPDATA% 下的文件发给 iframe
        .register_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .invoke_handler(tauri::generate_handler![
            widgets::list_widgets,
            widgets::widgets_dir,
            widgets::install_widget,
            widgets::uninstall_widget,
            widgets::widget_backup_info,
            widgets::widget_rollback,
            desktop::apply_window_layer,
            state::state_read,
            state::state_write,
            state::state_clear,
            widget_store::widget_store_read,
            widget_store::widget_store_write,
            widget_store::widget_store_update,
            widget_store::widget_store_clear,
            runner::sync_widget_windows,
            runner::close_widget_windows,
            runner::widget_host_config,
            runner::widget_report_rect,
            runner::widget_set_pinned,
            runner::widget_set_layer,
            runner::widget_close,
            runner::widget_reload,
            runner::widget_set_theme,
            runner::widget_set_appearance,
            wallpaper::widget_wallpaper,
            metrics::system_metrics,
            media::media_session,
            media::media_control,
            audio::audio_level,
            runner::set_widgets_paused,
            runner::widgets_paused,
            autostart::autostart_get,
            autostart::autostart_set,
            network::network_fetch,
            store::store_load_catalogue,
            store::store_download,
            store::store_install,
            store::store_report,
            agent::agent_status,
            agent::agent_activity,
            agent::agent_set_enabled,
            agent::agent_reply,
            quit_app,
            show_main_window,
            restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Lattice");
}

/// 桌面上还有组件窗口时，"关掉主窗口"只该是收起来，不是退出
///
/// 没有这一层的话行为是断的：主窗口被销毁，组件窗口还在（所以进程不退），
/// 但没有任何入口能把主窗口要回来 —— 既没有托盘，也没有菜单。
/// 用户只能去任务管理器结束进程。真正退出走设置菜单里的 Quit（`quit_app`）。
fn guard_main_close(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };

    let handle = app.clone();
    let window = main.clone();
    main.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if has_widget_windows(&handle) {
                api.prevent_close();
                let _ = window.hide();
                // hide() 不动尺寸、不触发 Resized：画布上的组件得靠这一句才知道
                // 自己已经不在屏幕上了（否则定时器照跑）
                visibility::sync(&window);
            }
        }
    });
}

fn has_widget_windows(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| label.starts_with(runner::LABEL_PREFIX))
}

/// 真的退出：连同桌面上的组件一起收掉
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 把主窗口翻出来（供设置菜单 / 将来的托盘用）
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    instance::show_main(&app);
}

/// 更新装完之后重启自己。
///
/// 必须 `restart()` 而不是 `exit(0)`：装好的新二进制只有新进程才会跑，
/// 而"更新完应用自己消失了"在用户眼里就是更新失败。`restart` 会重新拉起
/// 一个进程，桌面上的组件窗口跟着重建（`restoreOnLaunch` 那条链路）。
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}
