//! 平台状态的落盘。
//!
//! 为什么不直接用 localStorage：这台机器上的 WebView2 把 localStorage 全放在
//! 内存里，进程一退就没了（`EBWebView/Default/Local Storage` 从来没被创建过）。
//! 对一个"记住你桌面怎么摆"的平台来说这是硬伤，所以状态改成显式写文件：
//!
//!   %APPDATA%\com.iron-tom.lattice\state.json
//!
//! 好处是顺带可见、可备份、可手改。写入走"临时文件 + 原子替换"，
//! 免得写到一半断电留下半截 JSON 把下次启动直接搞崩。

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the config directory: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("failed to create the config directory: {error}"))?;
    Ok(dir.join("state.json"))
}

/// 读回上次存下的状态。文件不存在算正常情况（第一次启动），返回 None。
///
/// **BOM 要在这里剥掉**。这份文件是可以手改、可以备份回去的，而记事本 /
/// `Set-Content -Encoding utf8` 这类工具会在开头写一个 `EF BB BF`。前端拿到
/// 带 BOM 的文本 `JSON.parse` 会直接抛，hydrate 落到默认值，然后（因为
/// `hydrated` 已经置真）把默认值写回磁盘 —— 用户的摆放、授权、已装列表**静默
/// 归零**。这条已经在本机发生过一次，所以宁可在这一个边界上吃掉它。
#[tauri::command]
pub fn state_read(app: AppHandle) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text.trim_start_matches('\u{feff}').to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read state: {error}")),
    }
}

/// 覆盖写入状态。先写 .tmp 再改名，改名在同一个卷上是原子的。
#[tauri::command]
pub fn state_write(app: AppHandle, json: String) -> Result<(), String> {
    let path = state_path(&app)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json.as_bytes()).map_err(|error| format!("failed to write state: {error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("failed to replace the state file: {error}"))?;
    Ok(())
}

/// 清空状态（留给"恢复出厂设置"用）。
#[tauri::command]
pub fn state_clear(app: AppHandle) -> Result<(), String> {
    let path = state_path(&app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to delete the state file: {error}")),
    }
}
