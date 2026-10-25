//! 使用记录：每天有多少分钟，某个 Lattice 窗口在前台。
//!
//! # 为什么不是"组件可见"或"桥调用次数"
//!
//! 桌面上的时钟是常驻可见的，组件的心跳也一直在跑 —— 拿这两样当活跃，
//! 每天都会满格，热力图就失去意义。这里的口径是**前台焦点**：一分钟里
//! 至少有一刻，主窗口或某个组件窗口是当前活动窗口。它是一个诚实的
//! 下界：只看不点不算，点进去用了才算。
//!
//! # 为什么由 Rust 数，而不是前端上报
//!
//! 画布在 `WidgetFrame` 里、桌面组件在各自的 webview 里，两边都能报，
//! 但也都能漏、能重。焦点事件只有 Rust 看得到（`WindowEvent::Focused`），
//! 所以计数放在这里；前端只读结果（`usage_read`），桥方法表和权限都不动。
//!
//! # 落盘
//!
//! `%APPDATA%\com.iron-tom.lattice\usage.json`，临时文件 + 原子替换。
//! 内存里累加，每 5 分钟或退出时写一次 —— 最多丢 5 分钟，不丢一天。
//! 不进 `state.json`：那份是前端整体回写的，两个宿主会互相盖。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::usage_policy;

/// 内存里的计数。`dirty` 是"还没落盘的分钟数"
struct Store {
    days: BTreeMap<String, u32>,
    dirty: u32,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static FOCUSED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();

/// 每 5 分钟落一次盘
const FLUSH_EVERY: u32 = 5;

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| {
        Mutex::new(Store {
            days: BTreeMap::new(),
            dirty: 0,
        })
    })
}

fn focused() -> &'static Mutex<HashSet<String>> {
    FOCUSED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn lock<T>(mutex: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        // 上一个持锁的线程 panic 了，数据可能只写了一半。这里没有跨行的
        // 不变量，接着用比让整条记录停摆好
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn ensure_started(app: &AppHandle) -> Result<(), String> {
    if PATH.get().is_some() {
        return Ok(());
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the config directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create the config directory: {error}"))?;
    let path = dir.join("usage.json");
    let days = load(&path);
    {
        let mut guard = lock(store());
        guard.days = days;
    }
    let _ = PATH.set(path);
    Ok(())
}

fn load(path: &Path) -> BTreeMap<String, u32> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        // 文件坏了就当没有：一个统计文件不该挡住档案页
        return BTreeMap::new();
    };

    let mut days = BTreeMap::new();
    let Some(entries) = json.get("days") else {
        return days;
    };
    if let Some(object) = entries.as_object() {
        for (key, value) in object {
            if let Some(minutes) = value.as_u64() {
                if usage_policy::is_day_key(key) && minutes > 0 {
                    days.insert(key.clone(), (minutes as u32).min(usage_policy::MAX_MINUTES));
                }
            }
        }
    } else if let Some(array) = entries.as_array() {
        // 早期形状：`[{ date, minutes }]`
        for item in array {
            let date = item.get("date").and_then(|value| value.as_str());
            let minutes = item.get("minutes").and_then(|value| value.as_u64());
            if let (Some(date), Some(minutes)) = (date, minutes) {
                if usage_policy::is_day_key(date) && minutes > 0 {
                    days.insert(date.to_string(), (minutes as u32).min(usage_policy::MAX_MINUTES));
                }
            }
        }
    }

    usage_policy::prune(&mut days, usage_policy::MAX_DAYS);
    days
}

fn save(path: &Path, days: &BTreeMap<String, u32>) {
    let body = serde_json::json!({ "version": 1, "days": days }).to_string();
    let temp = path.with_extension("json.tmp");
    if let Err(error) = std::fs::write(&temp, body.as_bytes()) {
        eprintln!("[lattice] failed to write usage: {error}");
        return;
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        eprintln!("[lattice] failed to replace usage: {error}");
    }
}

/// 开机启动时调一次：读旧文件、起滴答线程
pub fn start(app: &AppHandle) {
    if let Err(error) = ensure_started(app) {
        eprintln!("[lattice] usage tracking is off: {error}");
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        tick();
    });
}

/// 盯住一个窗口的焦点。主窗口和每个组件窗口各调一次
pub fn watch(window: &WebviewWindow) {
    let label = window.label().to_string();
    if window.is_focused().unwrap_or(false) {
        lock(focused()).insert(label.clone());
    }
    window.on_window_event(move |event| {
        let tauri::WindowEvent::Focused(has_focus) = event else {
            return;
        };
        let mut set = lock(focused());
        if *has_focus {
            set.insert(label.clone());
        } else {
            set.remove(&label);
        }
    });
}

/// 一分钟到点：有窗口在前台就 +1
fn tick() {
    if lock(focused()).is_empty() {
        return;
    }
    let key = today_key();
    let flush = {
        let mut guard = lock(store());
        if !usage_policy::add(&mut guard.days, &key) {
            return;
        }
        guard.dirty += 1;
        if guard.dirty >= FLUSH_EVERY {
            guard.dirty = 0;
            Some(guard.days.clone())
        } else {
            None
        }
    };
    if let (Some(days), Some(path)) = (flush, PATH.get()) {
        save(path, &days);
    }
}

/// 退出前把没落盘的那几分钟写掉。没启动过就什么也不做 ——
/// 否则会在第一次打开设置之前凭空写一个空文件
pub fn flush() {
    let Some(path) = PATH.get() else {
        return;
    };
    let days = {
        let mut guard = lock(store());
        guard.dirty = 0;
        guard.days.clone()
    };
    save(path, &days);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    days: BTreeMap<String, u32>,
    total_minutes: u32,
    since: Option<String>,
}

fn snapshot(days: &BTreeMap<String, u32>) -> UsageSnapshot {
    UsageSnapshot {
        days: days.clone(),
        total_minutes: usage_policy::total(days),
        since: days.keys().next().cloned(),
    }
}

#[tauri::command]
pub fn usage_read(app: AppHandle) -> Result<UsageSnapshot, String> {
    ensure_started(&app)?;
    let guard = lock(store());
    Ok(snapshot(&guard.days))
}

#[tauri::command]
pub fn usage_clear(app: AppHandle) -> Result<(), String> {
    ensure_started(&app)?;
    {
        let mut guard = lock(store());
        guard.days.clear();
        guard.dirty = 0;
    }
    if let Some(path) = PATH.get() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to delete the usage file: {error}")),
        }
    }
    Ok(())
}

/// 当前这一分钟的日键，按**本地时间**。用 `GetLocalTime` 而不是 UTC：
/// 用户看到的"10 月 25 日"是这台电脑上的 25 号，不是 UTC 的 25 号。
#[cfg(windows)]
fn today_key() -> String {
    let mut time: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe {
        windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut time);
    }
    format!("{:04}-{:02}-{:02}", time.wYear, time.wMonth, time.wDay)
}

#[cfg(not(windows))]
fn today_key() -> String {
    "1970-01-01".to_string()
}
