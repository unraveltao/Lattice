//! 密封密钥的落盘：**一个文件，一把 DPAPI**。
//!
//! 形状（`%APPDATA%\com.iron-tom.lattice\secrets.bin`）：
//!
//! ```text
//! LATTICESECRET1\n          ← 文件头，见 `secrets_policy::MAGIC`
//! <DPAPI blob>              ← CryptProtectData(UTF-8 JSON)，CRYPTPROTECT_UI_FORBIDDEN
//! ```
//!
//! 明文 JSON 只在内存里存在一次：
//!
//! ```json
//! { "llm.p-1e9ac1": "sk-…", "widget.lattice.related.github": "ghp_…" }
//! ```
//!
//! # DPAPI 挡得住什么，挡不住什么
//!
//! **挡得住**：别的 Windows 账户、以及把 `secrets.bin` 拷到另一台机器上的人
//! （密钥由当前账户的登录凭据派生，换账户 / 重装系统就解不开）。
//!
//! **挡不住**：以**这个用户身份**跑的任何进程 —— 它同样能调
//! `CryptUnprotectData`。这不是密码学意义上的保险箱，想挡本机同账户的程序
//! 只能上口令（每次启动都要输），那会废掉"摆着不用管"这件事。取舍见
//! `docs/design/0026-sealed-secrets.md` §3，**别把它当成"加密了所以安全"**。
//!
//! # 解不开的时候
//!
//! 一条都不删。`secrets.bin` 留着（换回原来那个账户还能用），读出来当"没有
//! 密钥"，界面提示重新填。这里最容易犯的错是"读不出来就当空的、下次保存
//! 顺手覆盖"—— 那会把一份还能救回来的密文彻底变成垃圾，所以
//! `load_checked` 把"文件不在"和"解不开"分成两件事，后者**拒绝任何写入**。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::secrets_policy;

/// 读-改-写必须串行：两个组件同时 `secret.set` 会互相抹掉对方那条
static SECRETS_LOCK: Mutex<()> = Mutex::new(());

/// 上一次失败的原因。设置页要把它显示出来 —— "密钥还没加密保存"这句话
/// 必须带着原因，否则用户只能看到一个没法动手的状态
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn record_error(message: String) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = Some(message);
    }
}

fn clear_error() {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = None;
    }
}

/// 上一次写失败的原因（给界面）
pub(crate) fn last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|slot| slot.clone())
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the config directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create the config directory: {error}"))?;
    Ok(dir.join("secrets.bin"))
}

// ---------------------------------------------------------------------------
// DPAPI
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptProtectData,
    };

    // SAFETY: 两个 BLOB 都指向本次调用期间有效的缓冲；`CryptProtectData` 只在
    // 返回非零时才会给 `pbData` 填一个 LocalAlloc 出来的块，那个块由下面
    // `LocalFree` 还回去。`CRYPTPROTECT_UI_FORBIDDEN` 保证它永远不会弹窗
    // 去问用户口令（那会让"保存密钥"在无人值守时挂住）。
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(format!(
                "DPAPI refused to seal it ({})",
                std::io::Error::last_os_error()
            ));
        }
        let sealed = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok(sealed)
    }
}

#[cfg(windows)]
fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptUnprotectData,
    };

    // SAFETY: 同上。`ppsZDataDescr` 传空表示"不要描述字符串"，这样就不用
    // 再还一块内存
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: sealed.len() as u32,
            pbData: sealed.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(format!(
                "this Windows account cannot open the secrets file ({})",
                std::io::Error::last_os_error()
            ));
        }
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok(plain)
    }
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

/// 读整份密封库。
///
/// 三种情况分开处理，**这正是这一层最要紧的地方**：
///
///   - 文件不在 → 空表（第一次启动，正常）
///   - 文件在但解不开 → `Err`。调用方必须**拒绝写入**：覆盖一份还能救回来的
///     密文，等于把它彻底弄丢
///   - 文件在、解得开、JSON 坏了 → 空表 + 记一行。这一份已经没内容可救了，
///     但也不能因此卡住"重新填一遍"
fn load_checked(app: &AppHandle) -> Result<BTreeMap<String, String>, String> {
    let path = path(app)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(format!("failed to read the secrets file: {error}")),
    };

    let sealed = secrets_policy::unwrap_payload(&bytes).map_err(|error| {
        let message = format!("{error} ({})", path.display());
        record_error(message.clone());
        message
    })?;
    // **这一句必须记下原因**：换 Windows 账户之后就是它失败，而那是用户唯一
    // 需要知道"为什么所有模型都显示没配置"的地方。漏了它，设置页那一行只会
    // 说"存着 0 把钥匙"，看着像"我从来没填过"
    let plain = unprotect(sealed).map_err(|error| {
        record_error(error.clone());
        error
    })?;
    // 解得开就把上一次的失败清掉：那一行说的是"现在加密存着没有"，
    // 不是"历史上有没有失败过"。文件被修好之后还挂着旧原因，用户会去查一个
    // 已经不存在的问题
    clear_error();
    let text = String::from_utf8(plain)
        .map_err(|_| "the secrets file does not hold UTF-8 text".to_string())?;

    let mut map = BTreeMap::new();
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Object(entries)) => {
            for (key, value) in entries {
                if let Some(text) = value.as_str() {
                    map.insert(key, text.to_string());
                }
            }
        }
        // 解得开但内容不是对象：没有一条是能用的，当空表
        Ok(_) => record_error("the secrets file is not a JSON object".to_string()),
        Err(error) => record_error(format!("the secrets file is not valid JSON: {error}")),
    }
    Ok(map)
}

/// 读出来（解不开就是空表）。给"只想知道有没有 key"的地方用 ——
/// 那些地方对"没配"和"解不开"的处理是同一个动作（提示重新填）
fn load(app: &AppHandle) -> BTreeMap<String, String> {
    load_checked(app).unwrap_or_default()
}

/// 先写 `.tmp` 再改名，同一条规矩（`state.rs` / `widget_store.rs`）。
///
/// 覆盖前把旧密文挪到 `secrets.bin.bak`，只留一代。这一步在这儿格外重要：
/// 整份库只有一个文件，写坏了就是**所有**密钥一起没了。
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Ok(previous) = std::fs::read(path) {
        if previous != bytes {
            let backup = path.with_extension("bin.bak");
            if let Err(error) = std::fs::write(&backup, &previous) {
                // 备份失败不拦主写入：这一次的保存比上一代的备份要紧
                eprintln!("[lattice] could not back up the secrets file: {error}");
            }
        }
    }
    let temp = path.with_extension("bin.tmp");
    std::fs::write(&temp, bytes).map_err(|error| format!("failed to write the secrets file: {error}"))?;
    std::fs::rename(&temp, path)
        .map_err(|error| format!("failed to replace the secrets file: {error}"))
}

fn save(app: &AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = path(app)?;
    let text = serde_json::to_string(map)
        .map_err(|error| format!("failed to serialize the secrets: {error}"))?;
    // 写失败也要记原因：那一刻明文还留在 `assistant.json` 里（调用方不删），
    // 所以这不是"丢了"，而是"还没加密" —— 设置页那一行说的就是这件事
    let sealed = protect(text.as_bytes()).map_err(|error| {
        record_error(error.clone());
        error
    })?;
    write_atomic(&path, &secrets_policy::wrap(&sealed)).map_err(|error| {
        record_error(error.clone());
        error
    })?;
    clear_error();
    Ok(())
}

// ---------------------------------------------------------------------------
// 平台内部接口
// ---------------------------------------------------------------------------

/// 整份库的**只读副本**，给"一次要填好几档 key"的地方用。
///
/// `read_config` 每次都要给每一档填 key，逐条 `get` 会把同一个文件读 N 遍、
/// 解 N 次 DPAPI。次数不多但没道理，所以留一个批量入口。
pub(crate) fn all(app: &AppHandle) -> BTreeMap<String, String> {
    load(app)
}

/// 一条密钥。**没有就是 `None`** —— 解不开也当没有，因为调用方要做的动作
/// 是同一个（提示重新填）。想知道为什么解不开，看 `last_error()`
pub(crate) fn get(app: &AppHandle, key: &str) -> Option<String> {
    load(app).get(key).cloned()
}

/// 写一条。值没变就什么都不做（`write_config` 每次保存都会走这里，
/// 不该为此重写一遍文件、挪一次 `.bak`）
pub(crate) fn set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    secrets_policy::check_value(value)?;
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // **解不开就拒绝写**：覆盖一份换回账户还能用的密文，等于把它弄丢
    let mut map = load_checked(app)?;
    if map.get(key).map(|current| current == value).unwrap_or(false) {
        return Ok(());
    }
    if !map.contains_key(key) && map.len() >= secrets_policy::MAX_ENTRIES {
        return Err(format!(
            "the secrets file already holds {} entries (at most {})",
            map.len(),
            secrets_policy::MAX_ENTRIES
        ));
    }
    map.insert(key.to_string(), value.to_string());
    save(app, &map)
}

pub(crate) fn delete(app: &AppHandle, key: &str) -> Result<(), String> {
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut map = load_checked(app)?;
    if map.remove(key).is_none() {
        return Ok(());
    }
    save(app, &map)
}

/// 密封库在不在。设置页要区分"还没存过任何东西"和"存着但打不开"
pub(crate) fn file_exists(app: &AppHandle) -> bool {
    path(app).map(|path| path.exists()).unwrap_or(false)
}

pub(crate) fn file_path(app: &AppHandle) -> String {
    path(app).map(|path| path.display().to_string()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 桥方法（组件用）
// ---------------------------------------------------------------------------

/// 组件能碰的那一条键。**前缀由这里拼**，组件递上来的只是一个名字片段 ——
/// 所以它够不到 `llm.*`，也够不到别的组件
fn widget_key(widget_id: &str, name: &str) -> Result<String, String> {
    secrets_policy::widget_key(widget_id.trim(), name.trim())
}

#[tauri::command]
pub fn secret_set(
    app: AppHandle,
    widget_id: String,
    name: String,
    value: String,
) -> Result<(), String> {
    let key = widget_key(&widget_id, &name)?;
    set(&app, &key, value.trim())
}

#[tauri::command]
pub fn secret_get(app: AppHandle, widget_id: String, name: String) -> Result<Option<String>, String> {
    let key = widget_key(&widget_id, &name)?;
    // 这里**用 load_checked**：组件要能区分"没填过"（`null`）和"这台机器读不出来"
    // （报错）。两者在界面上是两句不同的话
    Ok(load_checked(&app)?.get(&key).cloned())
}

#[tauri::command]
pub fn secret_delete(app: AppHandle, widget_id: String, name: String) -> Result<(), String> {
    let key = widget_key(&widget_id, &name)?;
    delete(&app, &key)
}

/// 密封库的状态，给设置页那一行用。
///
/// 只回**条数**不回名字：名字里有组件 id，而这一行要显示的是"存了几把钥匙"，
/// 不是"你装了什么"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatus {
    pub path: String,
    pub exists: bool,
    pub count: usize,
    /// 上一次失败的原因（DPAPI 拒绝 / 这台账户解不开 / 文件坏了）
    pub error: Option<String>,
}

#[tauri::command]
pub fn secrets_status(app: AppHandle) -> SecretsStatus {
    let exists = file_exists(&app);
    // 探一次读：解不开的时候 `count` 会是 0，但 `error` 会说明原因 ——
    // 用户看到的是"存着但打不开"，不是"一把都没有"
    let count = if exists { load(&app).len() } else { 0 };
    SecretsStatus {
        path: file_path(&app),
        exists,
        count,
        error: last_error(),
    }
}
