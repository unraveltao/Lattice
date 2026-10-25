//! assistant 的手 —— **执行**这一半：文件、命令、网页（这一期），屏幕 / 外部服务在后面。
//!
//! 和 `agent.rs` 的关系：那是"外部 agent 改桌面"的端点，这是"内置 assistant
//! 干活"的命令。两条路共用审计（`agent::audit`）和"返回 `AgentReply` 形状"这一条
//! 约定，但**不共用执行器** —— 桌面动作必须走主窗口的 store（不变量 2），
//! 而这些手只有 Rust 才做得到（渲染进程没有文件系统）。
//!
//! # 三条硬规矩
//!
//! 1. **能力开关在这里**也要查一遍（`hands_policy::Hands`）。只靠前端是"一次
//!    渲染进程的 bug 就能跑命令"。
//! 2. **审批在前端做**，但这一层要保证"没审批就拿不到结果"是不可能的路径：
//!    前端只有在用户点了 Allow 之后才发这条命令（`platform/assistant.ts`）。
//! 3. **审计只记形状**：路径、命令的首段、退出码。不记内容 —— 日志里出现
//!    用户读的那份文件，等于把审计变成第二份泄露面。
//!
//! 形状（成功 / 失败）和 `AgentReply` 一致：`{ok:true,result}` / `{ok:false,code,error}`，
//! 循环那侧不需要认第二种协议。

use std::collections::HashMap;
use std::io::{Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{agent, fs_policy, hands_policy, llm, network, network_policy, shell_policy, web_policy};

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

/// 跑一只手。返回 `AgentReply` 形状的 JSON。
#[tauri::command]
pub async fn assistant_tool(
    app: AppHandle,
    request_id: String,
    name: String,
    args: String,
) -> String {
    let (flag, _guard) = register_cancel(&request_id);
    let task_app = app.clone();
    let task_name = name.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let reply = run(&task_app, &task_name, &args, flag);
        // 审计：成功 / 拒绝各一条。`detail` 只写形状（见 `shape_of`）
        let status = status_of(&reply);
        agent::audit(
            &task_app,
            "assistant.tool",
            &shape_of(&task_name, &args, &reply),
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
        "disabled" | "denied" => 403,
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
    if !state.hands.enabled(group) {
        return fail(
            "disabled",
            format!(
                "the \"{group}\" capability is switched off in Assistant settings, so this tool is not available"
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
}
