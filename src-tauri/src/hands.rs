//! assistant 的手 —— **执行**这一半：文件、命令、网页、屏幕、键鼠（这一期），
//! 外部服务（MCP）在后面。
//!
//! 和 `agent.rs` 的关系：那是"外部 agent 改桌面"的端点，这是"内置 assistant
//! 干活"的命令。两条路共用审计（`agent::audit`）和"返回 `AgentReply` 形状"这一条
//! 约定，但**不共用执行器** —— 桌面动作必须走主窗口的 store（不变量 2），
//! 而这些手只有 Rust 才做得到（渲染进程没有文件系统、没有 SendInput）。
//!
//! # 三条硬规矩
//!
//! 1. **能力开关在这里**也要查一遍（`hands_policy::Hands`）。只靠前端是"一次
//!    渲染进程的 bug 就能跑命令"。
//! 2. **审批在前端做**，但这一层要保证"没审批就拿不到结果"是不可能的路径：
//!    前端只有在用户点了 Allow 之后才发这条命令（`platform/assistant.ts`）。
//! 3. **审计只记形状**：路径、命令的首段、URL 的主机、点击的坐标、敲了多少个字。
//!    不记内容 —— 日志里出现用户读的那份文件或敲进输入框的那句话，等于把审计
//!    变成第二份泄露面。
//!
//! 形状（成功 / 失败）和 `AgentReply` 一致：`{ok:true,result}` / `{ok:false,code,error}`，
//! 循环那侧不需要认第二种协议。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use tauri::AppHandle;
use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetSystemMetrics, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::{
    agent, fs_policy, hands_policy, input_policy, llm, network, network_policy, screen_policy,
    shell_policy, web_policy,
};

fn ok(result: Value) -> String {
    json!({ "ok": true, "result": result }).to_string()
}

fn fail(code: &str, error: impl Into<String>) -> String {
    json!({ "ok": false, "code": code, "error": error.into() }).to_string()
}

/// 在飞的那几只手的取消标志。和 `llm.rs` 的 `cancels()` 同一套做法：
/// 命令结束时由 `CancelHandle` 的 Drop 摘掉，不会越攒越多
fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct CancelHandle(String);

impl Drop for CancelHandle {
    fn drop(&mut self) {
        if let Ok(mut map) = cancels().lock() {
            map.remove(&self.0);
        }
    }
}

fn register_cancel(request_id: &str) -> (Arc<AtomicBool>, CancelHandle) {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = cancels().lock() {
        map.insert(request_id.to_string(), flag.clone());
    }
    (flag, CancelHandle(request_id.to_string()))
}

/// 用户按了停止：把这一轮的标志点起来。
///
/// **幂等**：那一轮已经结束（标志随着命令结束被摘掉）时返回 `false`，
/// 界面不该因为"按晚了一步"弹错误
#[tauri::command]
pub fn hands_cancel(request_id: String) -> bool {
    let Ok(map) = cancels().lock() else {
        return false;
    };
    match map.get(&request_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// 两个模式（0009）—— 内部 / 全部
// ---------------------------------------------------------------------------
//
// 模式**存盘**（`assistant.json` v4 的 `mode`），所以重启之后还在 —— 这是它和
// 0006 那个定时授权最大的区别，也是它唯一的价格：会忘。代价用**常驻可见**兜
// （面板顶部那条模式条 + 窗口标题栏那个点），不用中断兜。
//
// 这里的两个函数都不缓存：每次调用现读一次配置。"每轮开头查一次"是不够的 ——
// 会话里正在飞的那一轮会拿着一张旧工具表，用户切回内部之后它还能读文件。

/// 现在是什么模式（坏值/读不到一律内部，见 `hands_policy::normalize_mode`）
pub fn mode_now(app: &AppHandle) -> &'static str {
    hands_policy::normalize_mode(&llm::hands_state(app).mode)
}

/// 跑一只手。返回 `AgentReply` 形状的 JSON。
#[tauri::command]
pub async fn assistant_tool(
    app: AppHandle,
    request_id: String,
    name: String,
    args: String,
) -> String {
    // 完全访问下审计是**唯一剩下的那道痕迹**，所以它从"记录"变成了"闸门"：
    // 写不进去就不动手。别的模式不受影响 —— 审计不该成为普通路径的故障点
    let mode = mode_now(&app);
    let elevated = hands_policy::mode_ignores_switches(mode);
    if elevated && !agent::can_audit(&app) {
        return fail(
            "audit",
            "everything mode needs a writable audit log, and the log cannot be written right now — switch back to internal or fix the folder permission",
        );
    }
    let (flag, _guard) = register_cancel(&request_id);
    let task_app = app.clone();
    let task_name = name.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let reply = run(&task_app, &task_name, &args, flag);
        // 审计：成功 / 拒绝各一条。`detail` 只写形状（见 `shape_of`）
        let status = status_of(&reply);
        let detail = hands_policy::mark_everything(&shape_of(&task_name, &args, &reply), mode);
        agent::audit(
            &task_app,
            "assistant.tool",
            &detail,
            status,
            started.elapsed().as_millis(),
        );
        reply
    })
    .await;
    match joined {
        Ok(text) => text,
        Err(error) => fail("internal", format!("the tool task did not finish: {error}")),
    }
}

/// 成功是 200，被开关拦住是 403，参数/执行错是 400
fn status_of(reply: &str) -> u16 {
    let Ok(value) = serde_json::from_str::<Value>(reply) else {
        return 500;
    };
    if value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return 200;
    }
    match value.get("code").and_then(Value::as_str).unwrap_or("") {
        "disabled" | "denied" | "readonly" | "audit" => 403,
        "" => 500,
        _ => 400,
    }
}

/// 审计那一栏。**只记形状**：哪只手、碰了哪个路径 / 跑了哪个程序、成没成
fn shape_of(name: &str, args: &str, reply: &str) -> String {
    let parsed = serde_json::from_str::<Value>(args).unwrap_or(Value::Null);
    let text = |key: &str| {
        parsed
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let target = match name {
        "file.list" | "file.read" | "file.search" | "file.write" => text("path"),
        "shell.run" => {
            let command = text("command");
            let head = command.lines().next().unwrap_or("").trim();
            let head: String = head.chars().take(60).collect();
            format!("{head}")
        }
        // 审计只记**哪一台主机**：完整 URL 里的 query 可能就是用户在找的东西
        "web.fetch" => network_policy::parse_url(&text("url"))
            .map(|target| target.host)
            .unwrap_or_default(),
        "screen.windows" => "list".to_string(),
        // 截图记的是**存到哪个文件**（默认给的是文件夹）
        "screen.capture" => text("path"),
        "input.click" => {
            let number = |key: &str| parsed.get(key).and_then(Value::as_i64);
            match (number("x"), number("y")) {
                (Some(x), Some(y)) => format!("at {x}, {y}"),
                _ => String::new(),
            }
        }
        // **只记字数**。敲进输入框的那句话可能是密码、可能是用户刚写的半封信
        "input.type" => {
            let count = text("text").chars().count();
            format!("{count} chars")
        }
        "input.key" => {
            let chord = text("key");
            let chord: String = chord.chars().take(24).collect();
            chord
        }
        other if other.starts_with(crate::mcp_policy::PREFIX) => other.to_string(),
        _ => String::new(),
    };
    let ok = serde_json::from_str::<Value>(reply)
        .ok()
        .and_then(|value| value.get("ok").and_then(Value::as_bool))
        .unwrap_or(false);
    let verdict = if ok { "" } else { " · failed" };
    format!("{name} · {target}{verdict}")
}

/// 真正的分发。能力组关着 → `disabled`（前端也应该没把这张表给模型，
/// 这一句是给"前端有 bug"和"以后有人绕过前端"兜底的）
fn run(app: &AppHandle, name: &str, raw_args: &str, cancel: Arc<AtomicBool>) -> String {
    let Some(group) = hands_policy::group_of(name) else {
        return fail(
            "unknown_tool",
            format!("there is no tool called \"{name}\""),
        );
    };
    let state = llm::hands_state(app);
    // 完全访问下**六组一律算开**（这里只算，不写盘；面板那道确认会把六组真的
    // 拨开、把 `mode` 写下去，所以用户按完看得见它拿到了什么），`readonly` 优先 ——
    // 界面会把开关画成"由模式强制打开"，但这里才是那条真正的判定：
    // 一次渲染进程的 bug 不该变成"模式开着但我没拨开关，所以照跑"。
    // 注意是**每次调用现查模式**，不是每轮开头查一次：会话里正在飞的那一轮
    // 会拿着一张旧工具表，用户切回内部之后它不该还能读文件
    let mode = mode_now(app);
    let effective = hands_policy::everything_overrides(state.approval, mode);
    let hands = hands_policy::effective_hands(state.hands, if effective { "everything" } else { "internal" });
    if !hands.enabled(group) {
        return fail(
            "disabled",
            format!(
                "the \"{group}\" capability is switched off in Assistant settings, so this tool is not available — switch to everything mode or turn that capability on"
            ),
        );
    }
    // 只读档的第二道闸（0003 §3）。前端那张表已经把这些工具裁掉了，这里是
    // "一次渲染进程的 bug 不该变成一条写盘命令"的那一条
    if hands_policy::readonly_blocks(state.approval, name) {
        return fail(
            "readonly",
            format!(
                "the assistant is in read-only mode, so \"{name}\" is not available — change the approval mode in Assistant settings first"
            ),
        );
    }

    let args = if raw_args.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str::<Value>(raw_args) {
            Ok(value) if value.is_object() => value,
            Ok(_) => return fail("bad_args", "arguments must be a JSON object"),
            Err(error) => return fail("bad_args", format!("arguments are not valid JSON: {error}")),
        }
    };

    match name {
        "file.list" => file_list(app, &args),
        "file.read" => file_read(app, &args),
        "file.search" => file_search(app, &args),
        "file.write" => file_write(app, &args),
        "shell.run" => shell_run(app, &args, &cancel),
        "web.fetch" => web_fetch(&args),
        "screen.windows" => screen_windows(),
        "screen.capture" => screen_capture(app, &args),
        "input.click" => input_click(&args),
        "input.type" => input_type(&args),
        "input.key" => input_key(&args),
        other if other.starts_with(crate::mcp_policy::PREFIX) => crate::mcp::run_tool(app, other, &args),
        other => fail(
            "unknown_tool",
            format!("\"{other}\" is not implemented yet in this build"),
        ),
    }
}

// ---------------------------------------------------------------------------
// 参数小工具
// ---------------------------------------------------------------------------

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    match args.get(key) {
        Some(Value::String(text)) => Ok(text),
        Some(_) => Err(format!("\"{key}\" must be a string")),
        None => Err(format!("\"{key}\" is required")),
    }
}

fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn optional_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

/// 相对路径落在工作目录里（没配工作目录时就是一条明确的错）。
/// **绝对路径照用** —— 用户选的是"读可以全盘"
fn resolve_path(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    let text = fs_policy::normalize_path(raw)?;
    let path = PathBuf::from(&text);
    if path.is_absolute() {
        return Ok(path);
    }
    let state = llm::hands_state(app);
    if state.workspace.trim().is_empty() {
        return Err(format!(
            "\"{text}\" is relative, and no workspace folder is set — pass an absolute path, or set one in Assistant settings"
        ));
    }
    Ok(PathBuf::from(&state.workspace).join(text))
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

fn file_list(app: &AppHandle, args: &Value) -> String {
    let path = match resolve_path(app, string_arg(args, "path").unwrap_or(".")) {
        Ok(path) => path,
        Err(error) => return fail("bad_args", error),
    };
    let entries = match std::fs::read_dir(&path) {
        Ok(entries) => entries,
        Err(error) => return fail("not_found", format!("could not list {}: {error}", display(&path))),
    };

    let mut rows: Vec<(bool, String, Option<u64>)> = Vec::new();
    let mut truncated = false;
    for entry in entries.flatten() {
        if rows.len() >= fs_policy::LIST_MAX {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // 目录大小要递归算，也就是要遍历一遍子树 —— 列个目录不该这么贵
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|meta| meta.is_dir()).unwrap_or(false);
        let size = if is_dir {
            None
        } else {
            meta.as_ref().map(|meta| meta.len())
        };
        rows.push((is_dir, name, size));
    }

    // 目录在前、然后按名字：用户和模型看列表时都按这个顺序找东西
    rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));

    let payload: Vec<Value> = rows
        .into_iter()
        .map(|(is_dir, name, size)| {
            json!({ "name": name, "dir": is_dir, "size": size.map(Value::from).unwrap_or(Value::Null) })
        })
        .collect();

    ok(json!({
        "path": display(&path),
        "entries": payload,
        "truncated": truncated,
    }))
}

fn file_read(app: &AppHandle, args: &Value) -> String {
    let path = match string_arg(args, "path").and_then(|raw| resolve_path(app, raw)) {
        Ok(path) => path,
        Err(error) => {
            // `path` 缺失是 bad_args，解析失败也是 —— 两者对模型都一样：改参数重来
            return fail("bad_args", error);
        }
    };
    let offset = optional_usize(args, "offset").unwrap_or(0);
    let limit = optional_usize(args, "limit").unwrap_or(fs_policy::READ_MAX_LINES);

    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) => return fail("not_found", format!("could not read {}: {error}", display(&path))),
    };
    if meta.is_dir() {
        return fail(
            "bad_args",
            format!("{} is a directory — use file.list", display(&path)),
        );
    }

    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) => return fail("not_found", format!("could not read {}: {error}", display(&path))),
    };

    // 按字节上限读：一个 2 GB 的日志不该被整个塞进内存。上限之外的部分
    // 标记成 truncated，模型自己会决定要不要用 offset 继续
    let mut bytes = Vec::new();
    let mut handle = file.take(fs_policy::MAX_READ_BYTES);
    if let Err(error) = handle.read_to_end(&mut bytes) {
        return fail("internal", format!("could not read {}: {error}", display(&path)));
    }
    let capped = bytes.len() as u64 >= fs_policy::MAX_READ_BYTES && meta.len() > fs_policy::MAX_READ_BYTES;

    if fs_policy::looks_binary(&bytes) {
        return fail(
            "binary",
            format!(
                "{} looks like a binary file ({} bytes) — I can only read text",
                display(&path),
                meta.len()
            ),
        );
    }

    let text = String::from_utf8_lossy(&bytes).to_string();
    let (body, lines, more) = fs_policy::take_lines(&text, offset, limit);
    ok(json!({
        "path": display(&path),
        "text": body,
        "lines": lines,
        "offset": offset,
        "truncated": more || capped,
        "bytes": meta.len(),
    }))
}

fn file_search(app: &AppHandle, args: &Value) -> String {
    let query = match string_arg(args, "query") {
        Ok(query) if !query.trim().is_empty() => query.to_string(),
        Ok(_) => return fail("bad_args", "\"query\" must not be empty"),
        Err(error) => return fail("bad_args", error),
    };
    if query.chars().count() > 200 {
        return fail("bad_args", "\"query\" may hold at most 200 characters");
    }
    let root = match optional_string(args, "path") {
        Some(raw) => match resolve_path(app, &raw) {
            Ok(path) => path,
            Err(error) => return fail("bad_args", error),
        },
        None => match resolve_path(app, ".") {
            Ok(path) => path,
            Err(error) => return fail("bad_args", error),
        },
    };
    let needle = query.to_lowercase();

    let mut matches: Vec<Value> = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    let mut stack = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        if scanned >= fs_policy::SEARCH_MAX_FILES || matches.len() >= fs_policy::SEARCH_MAX_MATCHES {
            truncated = true;
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if scanned >= fs_policy::SEARCH_MAX_FILES {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                if !fs_policy::should_skip_dir(&name) {
                    stack.push(entry.path());
                }
                continue;
            }
            if meta.len() > fs_policy::SEARCH_MAX_BYTES {
                continue;
            }
            scanned += 1;
            let Ok(file) = std::fs::File::open(entry.path()) else {
                continue;
            };
            let mut bytes = Vec::new();
            if file.take(fs_policy::SEARCH_MAX_BYTES).read_to_end(&mut bytes).is_err() {
                continue;
            }
            if fs_policy::looks_binary(&bytes) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            for (index, line) in text.lines().enumerate() {
                if !line.to_lowercase().contains(&needle) {
                    continue;
                }
                matches.push(json!({
                    "path": display(&entry.path()),
                    "line": index + 1,
                    "text": fs_policy::clip_line(line, fs_policy::SEARCH_LINE_CHARS),
                }));
                if matches.len() >= fs_policy::SEARCH_MAX_MATCHES {
                    truncated = true;
                    break;
                }
            }
            if truncated {
                break;
            }
        }
    }

    ok(json!({
        "root": display(&root),
        "query": query,
        "matches": matches,
        "scanned": scanned,
        "truncated": truncated,
    }))
}

fn file_write(app: &AppHandle, args: &Value) -> String {
    let path = match string_arg(args, "path").and_then(|raw| resolve_path(app, raw)) {
        Ok(path) => path,
        Err(error) => return fail("bad_args", error),
    };
    let text = match string_arg(args, "text") {
        Ok(text) => text,
        Err(error) => return fail("bad_args", error),
    };
    if text.len() > fs_policy::MAX_WRITE_BYTES {
        return fail(
            "too_large",
            format!(
                "\"text\" may hold at most {} bytes; split the write into several calls",
                fs_policy::MAX_WRITE_BYTES
            ),
        );
    }
    if text.contains('\0') {
        return fail("bad_args", "\"text\" must not contain a NUL byte");
    }
    let parents = args.get("parents").and_then(Value::as_bool).unwrap_or(false);
    let existed = path.exists();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            if !parents {
                return fail(
                    "not_found",
                    format!(
                        "the folder {} does not exist — pass \"parents\": true to create it",
                        display(parent)
                    ),
                );
            }
            if let Err(error) = std::fs::create_dir_all(parent) {
                return fail("internal", format!("could not create {}: {error}", display(parent)));
            }
        }
    }

    // 和 `state.rs` 同一条规矩：先写临时文件再换名。半个文件比没有文件更糟 ——
    // 用户下一次读到的是一段既不是旧版也不是新版的东西
    let temp = path.with_extension("lattice-tmp");
    if let Err(error) = std::fs::write(&temp, text.as_bytes()) {
        return fail("internal", format!("could not write {}: {error}", display(&temp)));
    }
    if let Err(error) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return fail("internal", format!("could not replace {}: {error}", display(&path)));
    }

    ok(json!({
        "path": display(&path),
        "bytes": text.len(),
        "created": !existed,
    }))
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 走哪个 shell：优先 PowerShell 7（`pwsh`），没有就用系统自带的 5.1。
/// 两个都按绝对路径找一遍 —— GUI 进程的 PATH 和用户在终端里的那份不一定一样
fn shell_program() -> String {
    for name in ["pwsh.exe", "powershell.exe"] {
        if let Some(path) = find_on_path(name) {
            return path;
        }
    }
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    format!("{system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
}

fn find_on_path(exe: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate.display().to_string());
        }
    }
    None
}

/// 读一个管道，最多留 `cap` 字节，其余读掉丢弃（不读的话子进程会写满管道后卡死）
fn drain<R: Read + Send + 'static>(mut reader: R, cap: usize) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    if kept.len() < cap {
                        let room = cap - kept.len();
                        let take = room.min(count);
                        kept.extend_from_slice(&chunk[..take]);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        kept
    })
}

fn shell_run(app: &AppHandle, args: &Value, cancel: &Arc<AtomicBool>) -> String {
    let command = match string_arg(args, "command").and_then(shell_policy::command_ok) {
        Ok(command) => command,
        Err(error) => return fail("bad_args", error),
    };
    let cwd = match optional_string(args, "cwd") {
        Some(raw) => match resolve_path(app, &raw) {
            Ok(path) if path.is_dir() => path,
            Ok(path) => {
                return fail("bad_args", format!("{} is not a folder", display(&path)));
            }
            Err(error) => return fail("bad_args", error),
        },
        None => {
            let state = llm::hands_state(app);
            if state.workspace.trim().is_empty() {
                std::env::temp_dir()
            } else {
                PathBuf::from(&state.workspace)
            }
        }
    };
    let timeout = Duration::from_millis(shell_policy::clamp_timeout(
        args.get("timeoutMs").and_then(Value::as_u64),
    ));

    // `[Console]::OutputEncoding` 是必须的：Windows PowerShell 5.1 默认按控制台
    // 代码页（这台机器上是 GBK）编码管道输出，中文会变成一串问号/乱码。
    // `$OutputEncoding` 管的是"往下一个程序送"，两个都设上才不会只对一半
    let wrapped = format!(
        "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; {command}"
    );

    let mut child = match Command::new(shell_program())
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &wrapped])
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return fail("internal", format!("could not start a shell: {error}")),
    };

    let cap = shell_policy::MAX_OUTPUT_CHARS * 4;
    let stdout = child.stdout.take().map(|pipe| drain(pipe, cap));
    let stderr = child.stderr.take().map(|pipe| drain(pipe, cap));

    let started = Instant::now();
    let mut code: Option<i32> = None;
    let mut timed_out = false;
    let mut cancelled = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code();
                break;
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                return fail("internal", format!("lost track of the command: {error}"));
            }
        }
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // 进程没了之后管道才会 EOF，这两行 join 是"把剩下的输出收干净"
    let stdout = stdout.map(|handle| join_bytes(handle)).unwrap_or_default();
    let stderr = stderr.map(|handle| join_bytes(handle)).unwrap_or_default();

    let (out_text, out_cut) = shell_policy::truncate_output(
        &String::from_utf8_lossy(&stdout),
        shell_policy::MAX_OUTPUT_CHARS,
    );
    let (err_text, err_cut) = shell_policy::truncate_output(
        &String::from_utf8_lossy(&stderr),
        shell_policy::MAX_OUTPUT_CHARS,
    );

    if cancelled {
        return fail(
            "cancelled",
            format!("the command was stopped by the user after {} ms", started.elapsed().as_millis()),
        );
    }

    ok(json!({
        "code": code,
        "stdout": out_text,
        "stderr": err_text,
        "timedOut": timed_out,
        "truncated": out_cut || err_cut,
        "ms": started.elapsed().as_millis(),
        "shell": shell_program(),
    }))
}

fn join_bytes(handle: std::thread::JoinHandle<Vec<u8>>) -> Vec<u8> {
    handle.join().unwrap_or_default()
}

/// `web.fetch`：取一个页面，把 HTML 折成正文。
///
/// 出网这道闸和组件那条路不一样：**没有白名单**（用户只勾了一个"网页"开关，
/// 他要的就是"能看任何页面"，再让他逐站列白名单等于把这功能变成配置作业）。
/// 真正收窄它的是三件事：只认 http/https、逐跳最多 5 次、正文 40k 字。
///
/// 重定向自己跟**是必须的**：`network.rs` 把 WinHTTP 的自动跟随关了（那是给
/// 组件白名单用的），所以 3xx 会原样回来 —— 这里决定跟不跟，并且每一跳都重新
/// 解析一遍协议（`javascript:` / `file:` 这类永远进不来）。
fn web_fetch(args: &Value) -> String {
    let raw = match string_arg(args, "url") {
        Ok(raw) => raw.trim(),
        Err(error) => return fail("bad_args", error),
    };
    if let Err(error) = network_policy::parse_url(raw) {
        return fail("bad_args", error);
    }
    let limit = web_policy::charset_limit(optional_usize(args, "maxChars"));

    let headers = vec![
        (
            "Accept".to_string(),
            "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5".to_string(),
        ),
        ("Accept-Language".to_string(), "en,zh;q=0.8".to_string()),
    ];

    let mut url = raw.to_string();
    let mut hops = 0;
    loop {
        let target = match network_policy::parse_url(&url) {
            Ok(target) => target,
            Err(error) => return fail("bad_args", error),
        };
        let response = match network::send(
            &target,
            "GET",
            &headers,
            None,
            web_policy::MAX_BODY_BYTES,
        ) {
            Ok(response) => response,
            Err(error) => return fail("network", error),
        };

        if web_policy::is_redirect(response.status) {
            let location = response.headers.get("location").cloned().unwrap_or_default();
            let next = match web_policy::resolve(&url, &location) {
                Some(next) => next,
                None => {
                    return fail(
                        "bad_redirect",
                        format!(
                            "{} redirected (HTTP {}) to an address I cannot follow: {location}",
                            url, response.status
                        ),
                    )
                }
            };
            if hops >= web_policy::MAX_REDIRECTS {
                return fail(
                    "too_many_redirects",
                    format!("{raw} redirected {hops} times — I stopped there"),
                );
            }
            hops += 1;
            url = next;
            continue;
        }

        let content_type = response
            .headers
            .get("content-type")
            .cloned()
            .unwrap_or_default();
        let text = web_policy::text_of(&content_type, &String::from_utf8_lossy(&response.body));
        let (text, cut) = web_policy::take_chars(&text, limit);

        return ok(json!({
            "url": url,
            "status": response.status,
            "contentType": content_type,
            "text": text,
            "truncated": cut || response.truncated,
        }));
    }
}

// ---------------------------------------------------------------------------
// 屏幕
// ---------------------------------------------------------------------------

/// 一块屏幕范围内的候选窗口。字段都是"已经读过 Win32"的原始值，
/// 判据在 `screen_policy` 里（那边能单测）。
struct FoundWindow {
    title: String,
    class: String,
    pid: u32,
    focused: bool,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    let status = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    // 非 0 是失败（老系统不认这个属性）—— 失败就当没 cloak
    status == 0 && cloaked != 0
}

/// `EnumWindows` 的回调。每条都要自己认领：不可见、被 cloak、没标题、
/// 零尺寸的一律跳过（`screen_policy::keep_window` 是这条判据的家）。
unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> i32 {
    unsafe {
        let rows = &mut *(lparam as *mut Vec<FoundWindow>);
        if rows.len() >= screen_policy::MAX_WINDOWS {
            return 0; // 停：满了再枚举也没地方放
        }

        let visible = IsWindowVisible(hwnd) != 0;
        let cloaked = is_cloaked(hwnd);

        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return 1;
        }
        let mut title_buffer = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        if copied <= 0 {
            return 1;
        }
        let title = String::from_utf16_lossy(&title_buffer[..copied as usize]);

        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return 1;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if !screen_policy::keep_window(visible, cloaked, &title, width, height) {
            return 1;
        }

        let mut class_buffer = [0u16; 128];
        let class_length = GetClassNameW(hwnd, class_buffer.as_mut_ptr(), class_buffer.len() as i32);
        let class = if class_length > 0 {
            String::from_utf16_lossy(&class_buffer[..class_length as usize])
        } else {
            String::new()
        };

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);

        rows.push(FoundWindow {
            title: screen_policy::clip_title(&title),
            class: screen_policy::clip_class(&class),
            pid,
            focused: hwnd == GetForegroundWindow(),
            left: rect.left,
            top: rect.top,
            width,
            height,
        });
        1
    }
}

/// 虚拟桌面（所有显示器合起来那一块）。**`SendInput` 的绝对坐标按它归一化**，
/// 也用它判断"这个点还在屏幕里吗"。
fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

fn screen_windows() -> String {
    let mut rows: Vec<FoundWindow> = Vec::new();
    let collector = &mut rows as *mut Vec<FoundWindow> as LPARAM;
    unsafe {
        EnumWindows(Some(collect_window), collector);
    }

    // 焦点窗口排第一：模型读列表时第一个就是"用户正在看的那个"
    rows.sort_by_key(|window| screen_policy::rank(window.focused));

    let (left, top, width, height) = virtual_screen();
    let payload: Vec<Value> = rows
        .iter()
        .map(|window| {
            json!({
                "title": window.title,
                "class": window.class,
                "pid": window.pid,
                "focused": window.focused,
                "rect": {
                    "x": window.left,
                    "y": window.top,
                    "width": window.width,
                    "height": window.height,
                },
            })
        })
        .collect();

    ok(json!({
        "windows": payload,
        // 屏幕矩形也一并给出去：模型要算"点哪儿"就绕不开它
        "screen": { "x": left, "y": top, "width": width, "height": height },
    }))
}

/// 屏幕像素 → RGBA，行优先、自上而下。
///
/// `BitBlt(GetDC(NULL))` 拿的是"屏幕上此刻可见的东西"（这正好是截图的定义，
/// 和壁纸那条路不同 —— 壁纸要的是"没有窗口的桌面"）。
fn grab_screen(left: i32, top: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("could not get the screen device context".to_string());
        }
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if memory.is_null() || bitmap.is_null() {
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            if !memory.is_null() {
                DeleteDC(memory);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("could not create an off-screen bitmap".to_string());
        }

        let previous = SelectObject(memory, bitmap);
        // CAPTUREBLT：连分层窗口一起截。不带它的话，带透明/阴影的窗口
        // 会在图上留下一块块黑洞，看着像截图坏了
        const CAPTUREBLT: u32 = 0x4000_0000;
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            left,
            top,
            SRCCOPY | CAPTUREBLT,
        );

        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        // 负高度 = 自上而下，省得每行都翻
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;

        let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        let rows = GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut core::ffi::c_void,
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);

        if copied == 0 {
            return Err("BitBlt could not copy the screen".to_string());
        }
        if rows == 0 {
            return Err("GetDIBits returned no pixels".to_string());
        }

        // 屏幕 DC 给的第四字节是 0。直接当 RGBA 交出去，整张图是全透明的 ——
        // 浏览器里看着是白的，看图工具里是棋盘格，都不是截图
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok(pixels)
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

fn screen_capture(app: &AppHandle, args: &Value) -> String {
    let (left, top, width, height) = virtual_screen();
    if width <= 0 || height <= 0 {
        return fail("internal", "could not read the screen size");
    }
    if width as u64 * height as u64 > screen_policy::MAX_PIXELS {
        return fail(
            "too_large",
            format!("that screen is {width}×{height} pixels — too big to capture"),
        );
    }

    let rgba = match grab_screen(left, top, width, height) {
        Ok(pixels) => pixels,
        Err(error) => return fail("internal", error),
    };

    let lines = screen_policy::scanlines(&rgba, width as u32, height as u32);
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    if let Err(error) = encoder.write_all(&lines) {
        return fail("internal", format!("could not compress the screenshot: {error}"));
    }
    let idat = match encoder.finish() {
        Ok(bytes) => bytes,
        Err(error) => {
            return fail("internal", format!("could not compress the screenshot: {error}"))
        }
    };
    let body = screen_policy::png(width as u32, height as u32, &idat);

    let state = llm::hands_state(app);
    let fallback = if state.workspace.trim().is_empty() {
        std::env::temp_dir().display().to_string()
    } else {
        state.workspace.clone()
    };
    let name = screen_policy::screenshot_name(now_ms());
    let target = screen_policy::screenshot_target(optional_string(args, "path").as_deref(), &fallback, &name);

    let path = PathBuf::from(&target);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::write(&path, &body) {
        return fail("not_found", format!("could not write {target}: {error}"));
    }

    ok(json!({
        "path": target,
        "width": width,
        "height": height,
        "bytes": body.len(),
        // 这一版没有任何一条模型档收得到图片（0004 §3：网关对带图的请求直接
        // 400），所以这里**诚实地**写 false —— 模型照着这个回答用户
        // "我看不见图"，而不是编一段截图内容
        "vision": false,
    }))
}

// ---------------------------------------------------------------------------
// 键鼠
// ---------------------------------------------------------------------------

fn key_input(vk: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn mouse_input(dx: i32, dy: i32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// 一口气发完：分几次发，中间就可能被别的窗口抢走焦点。
fn send_inputs(events: &[INPUT]) -> Result<(), String> {
    let sent = unsafe {
        SendInput(
            events.len() as u32,
            events.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent as usize == events.len() {
        Ok(())
    } else {
        Err(format!(
            "Windows took {sent} of {} input events — a window running as administrator can block these",
            events.len()
        ))
    }
}

fn int_arg(args: &Value, key: &str) -> Result<i32, String> {
    match args.get(key) {
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value) if (-1_000_000..=1_000_000).contains(&value) => Ok(value as i32),
            _ => Err(format!("\"{key}\" is not a sensible pixel coordinate")),
        },
        Some(_) => Err(format!("\"{key}\" must be a number")),
        None => Err(format!("\"{key}\" is required")),
    }
}

fn input_click(args: &Value) -> String {
    let (x, y) = match (int_arg(args, "x"), int_arg(args, "y")) {
        (Ok(x), Ok(y)) => (x, y),
        (Err(error), _) | (_, Err(error)) => return fail("bad_args", error),
    };
    let double = args.get("double").and_then(Value::as_bool).unwrap_or(false);

    let (left, top, width, height) = virtual_screen();
    let Some((ax, ay)) = input_policy::absolute(x, y, left, top, width, height) else {
        return fail(
            "bad_args",
            format!("({x}, {y}) is not on any screen — the desktop is {width}×{height} at ({left}, {top})"),
        );
    };

    let mut events = vec![mouse_input(
        ax,
        ay,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    )];
    for _ in 0..if double { 2 } else { 1 } {
        events.push(mouse_input(0, 0, MOUSEEVENTF_LEFTDOWN));
        events.push(mouse_input(0, 0, MOUSEEVENTF_LEFTUP));
    }
    if let Err(error) = send_inputs(&events) {
        return fail("internal", error);
    }

    ok(json!({ "done": true, "x": x, "y": y, "double": double }))
}

fn input_type(args: &Value) -> String {
    let text = match string_arg(args, "text") {
        Ok(text) => text,
        Err(error) => return fail("bad_args", error),
    };
    let events = match type_events(text) {
        Ok(events) => events,
        Err(error) => return fail("bad_args", error),
    };
    if let Err(error) = send_inputs(&events) {
        return fail("internal", error);
    }

    ok(json!({ "done": true, "characters": text.chars().count() }))
}

/// 文字 → 一串按键事件。中文 / emoji 全走 `KEYEVENTF_UNICODE`
fn type_events(text: &str) -> Result<Vec<INPUT>, String> {
    let plan = input_policy::type_plan(text)?;

    let mut events = Vec::with_capacity(plan.len() * 2);
    for step in plan.iter() {
        match step {
            // KEYEVENTF_UNICODE 走的是"这个码点"，不是布局上的那个键：
            // 中文、emoji 都只能这么发，`wVk` 必须留 0
            input_policy::Step::Unit(unit) => {
                events.push(key_input(0, *unit, KEYEVENTF_UNICODE));
                events.push(key_input(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            input_policy::Step::Virtual(vk) => {
                let mut flags = 0;
                if input_policy::needs_extended(*vk) {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                events.push(key_input(*vk, 0, flags));
                events.push(key_input(*vk, 0, flags | KEYEVENTF_KEYUP));
            }
        }
    }
    Ok(events)
}

/// 把一段文字打进**当前前台窗口**。
///
/// 听写那条路（`dictation.rs`）用它：判焦点是调用方的事（开听时的 HWND 要等于
/// 出字前的 HWND），这里只管敲。返回打出去的字符数 —— `Ctrl+Z` 撤几次是用户那边
/// 的事，我们自己至少要知道"发了多少"。
pub fn type_text(text: &str) -> Result<usize, String> {
    let events = type_events(text)?;
    send_inputs(&events)?;
    Ok(text.chars().count())
}

fn input_key(args: &Value) -> String {
    let raw = match string_arg(args, "key") {
        Ok(raw) => raw,
        Err(error) => return fail("bad_args", error),
    };
    let chord = match input_policy::parse_chord(raw) {
        Ok(chord) => chord,
        Err(error) => return fail("bad_args", error),
    };

    let modifiers = chord.modifiers();
    let mut events = Vec::with_capacity(modifiers.len() * 2 + 2);
    for modifier in modifiers.iter() {
        events.push(key_input(*modifier, 0, 0));
    }
    let mut flags = 0;
    if input_policy::needs_extended(chord.vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    events.push(key_input(chord.vk, 0, flags));
    events.push(key_input(chord.vk, 0, flags | KEYEVENTF_KEYUP));
    // 修饰键反序松开：`Ctrl+S` 先松 S 再松 Ctrl
    for modifier in modifiers.iter().rev() {
        events.push(key_input(*modifier, 0, KEYEVENTF_KEYUP));
    }
    if let Err(error) = send_inputs(&events) {
        return fail("internal", error);
    }

    ok(json!({ "done": true, "key": raw }))
}

#[cfg(test)]
mod tests {
    /*
     * 这一份只钉**形状**：`status_of` / `shape_of` 是纯函数。
     * 真正碰磁盘与进程的东西在真机上验（0004 §8 的手工验收），
     * 能在这里跑的是 `hands_policy.rs` / `fs_policy.rs` / `shell_policy.rs` / `web_policy.rs` 那四份纯逻辑。
     */
    use super::*;

    #[test]
    fn a_successful_reply_is_200() {
        assert_eq!(status_of(r#"{"ok":true,"result":{}}"#), 200);
    }

    #[test]
    fn a_switched_off_hand_is_403() {
        assert_eq!(status_of(r#"{"ok":false,"code":"disabled","error":"x"}"#), 403);
        assert_eq!(status_of(r#"{"ok":false,"code":"denied","error":"x"}"#), 403);
    }

    #[test]
    fn a_bad_argument_is_400() {
        assert_eq!(status_of(r#"{"ok":false,"code":"bad_args","error":"x"}"#), 400);
        assert_eq!(status_of("not json"), 500);
    }

    #[test]
    fn the_audit_line_carries_the_target_but_not_the_content() {
        let line = shape_of(
            "file.read",
            r#"{"path":"C:\\work\\a.txt"}"#,
            r#"{"ok":true,"result":{"text":"secret"}}"#,
        );
        assert!(line.contains("file.read"));
        assert!(line.contains("a.txt"));
        assert!(!line.contains("secret"));
    }

    #[test]
    fn the_audit_line_marks_a_failure() {
        let line = shape_of("file.write", r#"{"path":"x"}"#, r#"{"ok":false,"error":"no"}"#);
        assert!(line.ends_with("failed"));
    }

    #[test]
    fn typing_is_audited_as_a_length_not_as_the_text() {
        // 敲进输入框的那句话可能是密码 —— 审计里只能出现字数
        let line = shape_of(
            "input.type",
            r#"{"text":"hunter2"}"#,
            r#"{"ok":true,"result":{"done":true}}"#,
        );
        assert!(line.contains("7 chars"), "{line}");
        assert!(!line.contains("hunter2"));
    }

    #[test]
    fn a_click_is_audited_as_its_point() {
        let line = shape_of(
            "input.click",
            r#"{"x":10,"y":20}"#,
            r#"{"ok":true,"result":{"done":true}}"#,
        );
        assert!(line.contains("at 10, 20"), "{line}");
    }
}
