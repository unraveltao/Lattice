//! `file.save`：把组件递来的内容落到**用户自己选的**路径；多个文件就打成一个 zip。
//!
//! 字节布局、文件名规则、单文件还是 zip 这些判据在 `export_policy.rs`（纯逻辑、
//! 能 `rustc --test` 单跑）；这个文件只做三件带依赖的事：**弹保存框**（对话框
//! 插件）、**压缩**（`flate2`）、**写盘**。
//!
//! # 为什么不是 `file.write`
//!
//! `hands.rs` 里的 `file.write` 是"助手直接写盘"：带审批、能覆盖任意路径。这条
//! 相反 —— 每次弹对话框、用户自己选位置。名字混了，后面所有人都会搞混。
//!
//! # 顺序：先全部准备好，再问用户
//!
//! base64 先全部解码、上限先全部判过，**然后**才弹对话框。反过来的话，用户挑好
//! 位置、点了保存，才发现第三张图是坏的 —— 那时能做的只有报错，而对话框里的
//! 那个位置已经被当成了"要写的地方"。
//!
//! # 取消不是错误
//!
//! 用户在对话框里点取消，回给前端的是 `{ok:false, cancelled:true}`。把它报成一条
//! 错误，界面上就会出现一句红字，而用户只是改主意了 —— 这个仓库反复踩过这个坑。

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use flate2::write::DeflateEncoder;
use flate2::Compression;
use tauri_plugin_dialog::DialogExt;

use crate::export_policy::{
    clean_name, decode_base64, dos_datetime, entry_name_ok, wants_zip, with_extension, OutFile, ZipPart,
    MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES,
};

/// 组件递上来的一个文件。`text` 和 `base64` 恰好有一个（两个都缺或都有都是坏参数）
#[derive(Debug, serde::Deserialize)]
pub(crate) struct SaveFileEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    base64: Option<String>,
}

struct Prepared {
    files: Vec<OutFile>,
    /// 和 `files` 一一对应的字节（文本按 UTF-8 编，base64 已解码）
    bytes: Vec<Vec<u8>>,
}

/// 把入参收成"可以写的字节"。任何一处不合格都在弹对话框之前失败。
fn prepare(files: &[SaveFileEntry]) -> Result<Prepared, String> {
    if files.is_empty() {
        return Err("file.save needs at least one file".to_string());
    }
    if files.len() > MAX_FILES {
        return Err(format!("at most {MAX_FILES} files at a time"));
    }

    let mut out = Vec::with_capacity(files.len());
    let mut bytes = Vec::with_capacity(files.len());
    let mut total = 0usize;

    for file in files {
        let entry = OutFile {
            name: file.name.trim().to_string(),
            text: file.text.clone(),
            base64: file.base64.clone(),
        };
        let payload = match (&entry.text, &entry.base64) {
            (Some(text), None) => text.as_bytes().to_vec(),
            (None, Some(base64)) => decode_base64(base64)?,
            _ => {
                return Err(format!(
                    "\"{}\" needs exactly one of text or base64",
                    entry.name
                ))
            }
        };
        if payload.len() > MAX_FILE_BYTES {
            return Err(format!("\"{}\" is larger than {MAX_FILE_BYTES} bytes", entry.name));
        }
        total += payload.len();
        if total > MAX_TOTAL_BYTES {
            return Err(format!("all files together may hold at most {MAX_TOTAL_BYTES} bytes"));
        }
        out.push(entry);
        bytes.push(payload);
    }

    // zip 里的条目名也要判（相对、没有 `..`、没有盘符），而且不许重名 ——
    // 同名两条在解压时是一条覆盖另一条，用户会少一个文件却看不见
    if wants_zip(&out) {
        let mut seen = std::collections::HashSet::new();
        for file in &out {
            if !entry_name_ok(&file.name) {
                return Err(format!("\"{}\" is not a safe zip entry name", file.name));
            }
            if !seen.insert(file.name.as_str()) {
                return Err(format!("\"{}\" shows up twice", file.name));
            }
        }
    }

    Ok(Prepared { files: out, bytes })
}

/// 能压就压，压完更大就存原文（和 `scripts/pack-widget.mjs` 同一条规矩）
fn deflate(bytes: &[u8]) -> (u16, Vec<u8>) {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(9));
    if encoder.write_all(bytes).is_err() {
        return (0, bytes.to_vec());
    }
    match encoder.finish() {
        Ok(packed) if packed.len() < bytes.len() => (8, packed),
        _ => (0, bytes.to_vec()),
    }
}

fn build_zip(prepared: &Prepared) -> Result<Vec<u8>, String> {
    let (time, date) = stamp();
    let mut parts = Vec::with_capacity(prepared.files.len());
    for (file, bytes) in prepared.files.iter().zip(prepared.bytes.iter()) {
        let (method, payload) = deflate(bytes);
        parts.push(ZipPart {
            name: file.name.clone(),
            method,
            payload,
            size: bytes.len(),
            crc: crate::export_policy::crc32(bytes),
            date,
            time,
        });
    }
    Ok(crate::export_policy::zip_bytes(&parts))
}

/// 现在这一刻的 DOS 日期 / 时间两格。
///
/// 走 `GetLocalTime`：`std` 没有本地时区，而 ZIP 里那两个字段是**本地时间**。
#[cfg(windows)]
fn stamp() -> (u16, u16) {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    let mut now: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut now) };
    dos_datetime(
        now.wYear,
        now.wMonth as u8,
        now.wDay as u8,
        now.wHour as u8,
        now.wMinute as u8,
        now.wSecond as u8,
    )
}

#[cfg(not(windows))]
fn stamp() -> (u16, u16) {
    // 这个应用只发布 Windows 版。留一个固定的时间戳只是为了别的目标编得过
    dos_datetime(2026, 1, 1, 0, 0, 0)
}

/// 弹保存框写一个文件（或一个 zip）。
///
/// 参数：`name` 是文件名（不含路径），`files` 是一个或多个文件。返回
/// `{ok:true, path}` 或 `{ok:false, cancelled:true}`；参数 / 落盘失败回 `Err`。
#[tauri::command]
pub(crate) async fn file_save(
    window: tauri::WebviewWindow,
    name: String,
    files: Vec<SaveFileEntry>,
) -> Result<serde_json::Value, String> {
    let clean = clean_name(&name).ok_or_else(|| format!("\"{name}\" is not a usable file name"))?;
    let prepared = prepare(&files)?;
    let zip = wants_zip(&prepared.files);
    let suggested = with_extension(&clean, zip);

    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = window.dialog().file().set_file_name(&suggested);
    builder = if zip {
        builder.add_filter("Zip", &["zip"])
    } else {
        builder.add_filter("Markdown", &["md"])
    };
    // 挂在发起调用的那个窗口上：画布上的组件 → 主窗口，桌面窗口 → 它自己。
    // 不挂 owner 的话，对话框可能开在别的应用后面 —— 用户会以为"点导出没反应"
    builder = builder.set_parent(&window);
    builder.save_file(move |path| {
        let _ = tx.send(path);
    });

    // 对话框在主线程上开、结果从另一条线程回来（插件内部就是这么做的），所以这里
    // 等的是通道而不是主线程。用 `spawn_blocking`：等待期间不占异步运行时的工作线程
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|error| format!("the save dialog could not finish: {error}"))?;
    let Some(picked) = picked else {
        return Ok(serde_json::json!({ "ok": false, "cancelled": true }));
    };
    let path: PathBuf = picked
        .into_path()
        .map_err(|error| format!("that path cannot be used: {error}"))?;

    let data = if zip {
        build_zip(&prepared)?
    } else {
        prepared.bytes.into_iter().next().unwrap_or_default()
    };
    fs::write(&path, &data).map_err(|error| format!("could not write {}: {error}", path.display()))?;

    Ok(serde_json::json!({ "ok": true, "path": path.to_string_lossy() }))
}
