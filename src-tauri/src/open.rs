//! 把组件想打开的网址交给系统默认浏览器。
//!
//! 权限（`shell:open`）由 `runtime/bridge.ts` 在桥那一层 gate 住 —— 组件没有
//! 授权时，这条命令根本不会被调用。这里只做两件事：
//!
//! 1. 用 `open_policy::normalize` 卡住协议（**这是真正的安全边界**，见那边的注释：
//!    opener 插件不认协议，`file:` / `ms-settings:` 都能执行）；
//! 2. 交给插件，失败时把原因原样回给组件 —— 组件会显示在卡片上。
//!
//! 为什么不用 `tauri-plugin-opener` 的 JS 端：那条路要组件窗口自己有
//! `opener:default` 能力，等于把"打开任意东西"直接给到组件所在的 webview。
//! 走 IPC 命令则永远先过桥的权限与这里的两道判断。

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// 打开一个 http/https 链接。返回 `Ok(())` 只代表"交给系统了"，
/// 不代表浏览器真的起来了（ShellExecuteW 不告诉我们这件事）。
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let target = crate::open_policy::normalize(&url)?;
    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|error| format!("could not hand the link to the browser: {error}"))
}
