//! 终端组件（`lattice.term`）的执行面：**一个实例一条常驻 shell**。
//!
//! 组件是这条 shell 的皮肤，不是终端模拟器。没有 PTY、没有 ANSI、没有 xterm.js ——
//! 它做的是"把一张卡片接到真的 PowerShell 上"，所以 `cd` 保留、`$env:` 保留、
//! 输出是真的，代价是跑不了 `vim` / `ssh` / 任何要控制台的程序（设计里的能力边界，
//! 见 [design/0010](../../docs/design/0010-terminal-widget.md) §3）。
//!
//! # 为什么不每条命令起一个进程
//!
//! 实测：新起一个 `powershell -Command …` 是 **480ms 左右**（四次取整 489 / 472 /
//! 469 / 501）。常驻进程之后每条命令约 40ms —— 终端最不能忍的就是"每敲一条等半秒"。
//!
//! # 三条不能拆的东西
//!
//! 1. **结束靠哨兵**，不靠进程退出：这条 shell 不会退出。命令末尾追加一行
//!    `Write-Output ([char]0x1E + "LATTICE:<id>:…")`，读到它才算这一条跑完。
//!    形状与理由在 `term_policy.rs` 的文件头（base64 通道、`[char]0x1E`、独立一行）。
//! 2. **输出走事件，不走命令返回值**。桥是一问一答的，`ping -n 10` 要一行一行冒出来，
//!    只能 `emit`。事件带 `seq`，窗口藏起来回来时按它补齐（`term_state` 的 `since`）。
//! 3. **两条杀进程的路**：实例销毁（`term_dispose`，宿主页卸载时调）和应用退出
//!    （`RunEvent::Exit` → `kill_all`）。少一条的后果是任务管理器里一排
//!    `powershell.exe`，而用户只是关了个组件。
//!
//! # 审计
//!
//! 设 `LATTICE_TERM_TRACE=1` 会把每条命令和它的退出码打到 stderr。默认静默：
//! 组件里敲的东西属于用户，不进日志文件（和 `hands.rs` 同一条规矩）。

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::{shell_policy, term_policy};

/// Rust → 宿主页 → iframe 的那条事件。宿主页按 `instanceId` 过滤（不变量 9：`emit` 是广播）
pub const EVENT: &str = "lattice:term";

/// `CREATE_NO_WINDOW`：别弹一个黑框出来。组件是卡片，不是控制台
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Pending {
    id: String,
    /// 这一条已经发出去多少字节（截断额度按条算）
    emitted: usize,
    truncated: bool,
}

struct Buffered {
    seq: u64,
    payload: Value,
}

struct Core {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// 在飞的命令，先进先出。哨兵按 id 认领，所以两条前后脚进来也不会串
    queue: VecDeque<Pending>,
    /// 事件序号。`term_state` 拿它跟客户端对账
    seq: u64,
    /// 命令编号，只增不减
    next_id: u64,
    cwd: String,
    program: String,
    /// 最近发出去的事件，给"藏起来又回来"补用
    ring: VecDeque<Buffered>,
    ring_bytes: usize,
    /// `stop` / EOF / dispose 之后置 false：读线程据此不再发东西
    alive: bool,
}

struct Shell {
    instance: String,
    app: AppHandle,
    core: Mutex<Core>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // 一个线程 panic 不该让整条终端永久锁死：拿回内部值继续用
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn shells() -> &'static Mutex<HashMap<String, Arc<Shell>>> {
    static SHELLS: OnceLock<Mutex<HashMap<String, Arc<Shell>>>> = OnceLock::new();
    SHELLS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// 起进程
// ---------------------------------------------------------------------------

/// 用哪一个 PowerShell。
///
/// **优先系统自带的 5.1**：这台机器上验过的就是它（`-Command -` 的行模式、
/// `[char]0x1E`、base64 通道全部实测过）。`pwsh` 只在 5.1 找不到时兜底 ——
/// 装没装、行为一不一致，没在这台机器上验过，不该让它当默认。
fn shell_program() -> (String, &'static str) {
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let builtin = format!("{system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if std::path::Path::new(&builtin).is_file() {
        return (builtin, "powershell");
    }
    if let Some(path) = find_on_path("powershell.exe") {
        return (path, "powershell");
    }
    if let Some(path) = find_on_path("pwsh.exe") {
        return (path, "pwsh");
    }
    (builtin, "powershell")
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

/// shell 从哪个目录起步。用户的家目录最像"终端该开在哪"
fn start_dir() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("C:\\"))
}

fn spawn(app: &AppHandle, instance: &str) -> Result<Arc<Shell>, String> {
    let (program, label) = shell_program();
    let dir = start_dir();

    let mut command = Command::new(&program);
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", "-"])
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start {label}: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "the shell came up without a stdin".to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let shell = Arc::new(Shell {
        instance: instance.to_string(),
        app: app.clone(),
        core: Mutex::new(Core {
            child: Some(child),
            stdin: Some(stdin),
            queue: VecDeque::new(),
            seq: 0,
            next_id: 0,
            cwd: dir.display().to_string(),
            program: label.to_string(),
            ring: VecDeque::new(),
            ring_bytes: 0,
            alive: true,
        }),
    });

    // 输出编码：中文走 UTF-8，否则 PS 5.1 按控制台代码页（这台机器上是 GBK）写，
    // 卡片上是问号。命令**输入**那一半靠 base64 通道，和这一行无关（见 term_policy）
    {
        let mut core = lock(&shell.core);
        if let Some(stdin) = core.stdin.as_mut() {
            let _ = stdin.write_all(term_policy::preamble().as_bytes());
            let _ = stdin.write_all(b"\r\n");
            let _ = stdin.flush();
        }
    }

    if let Some(reader) = stdout {
        let handle = shell.clone();
        std::thread::spawn(move || pump_stdout(handle, reader));
    }
    if let Some(reader) = stderr {
        let handle = shell.clone();
        std::thread::spawn(move || pump_stderr(handle, reader));
    }
    Ok(shell)
}

/// 拿这个实例的 shell；没有就起一条。已经死掉的那条先摘掉
fn handle(app: &AppHandle, instance: &str) -> Result<Arc<Shell>, String> {
    let mut map = lock(shells());
    if let Some(shell) = map.get(instance) {
        if lock(&shell.core).alive {
            return Ok(shell.clone());
        }
        map.remove(instance);
    }
    let shell = spawn(app, instance)?;
    map.insert(instance.to_string(), shell.clone());
    Ok(shell)
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

fn text_bytes(payload: &Value) -> usize {
    payload
        .get("text")
        .and_then(Value::as_str)
        .map(|text| text.len())
        .unwrap_or(0)
}

/// 发一条事件：补上 `seq`、进补发缓冲、再 `emit`。
///
/// 顺序是"先记账再发"：反过来的话，一次恰好落在两步之间的 `term_state` 会报一个
/// 比实际大的 `seq`，客户端于是等着一条永远不会来的事件
fn push_event(shell: &Shell, mut payload: Value) -> u64 {
    let seq = {
        let mut core = lock(&shell.core);
        core.seq += 1;
        let seq = core.seq;
        payload["seq"] = json!(seq);
        core.ring_bytes += text_bytes(&payload);
        core.ring.push_back(Buffered {
            seq,
            payload: payload.clone(),
        });
        while core.ring.len() > term_policy::RING_EVENTS || core.ring_bytes > term_policy::RING_BYTES {
            let Some(old) = core.ring.pop_front() else {
                break;
            };
            core.ring_bytes = core.ring_bytes.saturating_sub(text_bytes(&old.payload));
        }
        seq
    };
    let _ = shell.app.emit(EVENT, payload);
    seq
}

fn chunk_payload(instance: &str, id: &str, stream: &str, text: &str) -> Value {
    json!({
        "instanceId": instance,
        "id": id,
        "kind": "chunk",
        "stream": stream,
        "text": text,
    })
}

fn done_payload(instance: &str, id: &str, code: Option<i32>, truncated: bool) -> Value {
    json!({
        "instanceId": instance,
        "id": id,
        "kind": "done",
        "code": code,
        "truncated": truncated,
    })
}

fn lost_payload(instance: &str, id: &str) -> Value {
    json!({
        "instanceId": instance,
        "id": id,
        "kind": "lost",
    })
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

fn pump_stdout(shell: Arc<Shell>, mut reader: impl Read) {
    let mut buf: Vec<u8> = Vec::new();
    let mut read = [0u8; 8192];
    loop {
        match reader.read(&mut read) {
            Ok(0) => break,
            Ok(count) => {
                buf.extend_from_slice(&read[..count]);
                drain_stdout(&shell, &mut buf);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    on_eof(&shell);
}

/// 把 stdout 缓冲区里能发的东西发掉：先找哨兵，找不齐就发安全前缀（这就是"一行一行冒出来"）
fn drain_stdout(shell: &Shell, buf: &mut Vec<u8>) {
    loop {
        let front = {
            let core = lock(&shell.core);
            core.queue.front().map(|pending| pending.id.clone())
        };
        let Some(id) = front else {
            // 没有在飞的命令：空闲时的输出（提示符、上一条的尾巴）没有主人，丢掉
            buf.clear();
            return;
        };
        let marker = format!("{}{id}:", term_policy::SENTINEL_PREFIX);

        if let Some((start, end, done)) = term_policy::find_done(buf, &id) {
            let text = String::from_utf8_lossy(&buf[..start]).into_owned();
            buf.drain(..end);
            emit_text(shell, &id, "stdout", &text);
            finish(shell, &id, done);
            continue;
        }

        let safe = term_policy::safe_prefix_len(buf, marker.as_bytes());
        if safe == 0 {
            return;
        }
        let text = String::from_utf8_lossy(&buf[..safe]).into_owned();
        buf.drain(..safe);
        emit_text(shell, &id, "stdout", &text);
    }
}

fn pump_stderr(shell: Arc<Shell>, mut reader: impl Read) {
    let mut buf: Vec<u8> = Vec::new();
    let mut read = [0u8; 4096];
    loop {
        let count = match reader.read(&mut read) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        buf.extend_from_slice(&read[..count]);
        let id = {
            let core = lock(&shell.core);
            core.queue.front().map(|pending| pending.id.clone())
        };
        let Some(id) = id else {
            buf.clear();
            continue;
        };
        // 和中文字符串一样：别把最后一个汉字劈成两半发出去
        let safe = term_policy::safe_prefix_len(&buf, b"");
        if safe == 0 {
            continue;
        }
        let text = String::from_utf8_lossy(&buf[..safe]).into_owned();
        buf.drain(..safe);
        emit_text(&shell, &id, "stderr", &text);
    }
}

/// 发一段输出。截断额度按**当前这一条命令**算，两条命令不会互相吃掉额度
fn emit_text(shell: &Shell, id: &str, stream: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let normalized = term_policy::normalize_lines(text);
    let kept = {
        let mut core = lock(&shell.core);
        let Some(front) = core.queue.front_mut() else {
            return;
        };
        // 队列头已经不是它了：这段属于上一条的尾巴，丢掉而不是记到别人头上
        if front.id != id {
            return;
        }
        let (kept, used, cut) = term_policy::clamp_chunk(&normalized, front.emitted);
        front.emitted = used;
        front.truncated |= cut;
        kept
    };
    if !kept.is_empty() {
        push_event(shell, chunk_payload(&shell.instance, id, stream, &kept));
    }
}

/// 一条命令跑完了：弹队列、记 cwd、发 `done`
fn finish(shell: &Shell, id: &str, done: term_policy::Done) {
    let (truncated, code) = {
        let mut core = lock(&shell.core);
        core.cwd = done.cwd.clone();
        let mut truncated = false;
        if core.queue.front().map(|pending| pending.id.as_str()) == Some(id) {
            if let Some(pending) = core.queue.pop_front() {
                truncated = pending.truncated;
            }
        } else if let Some(index) = core.queue.iter().position(|pending| pending.id == id) {
            // 不该走到这里（哨兵按顺序来），真走到了也别让队列卡住
            if let Some(pending) = core.queue.remove(index) {
                truncated = pending.truncated;
            }
        }
        (truncated, done.code)
    };
    if std::env::var("LATTICE_TERM_TRACE").is_ok() {
        eprintln!("[lattice] term {id} finished (code {code:?}, truncated {truncated})");
    }
    push_event(
        shell,
        done_payload(&shell.instance, id, code, truncated),
    );
}

/// shell 自己没了（`exit`、崩了、被杀软干掉）
fn on_eof(shell: &Arc<Shell>) {
    let pending: Vec<String> = {
        let mut core = lock(&shell.core);
        if !core.alive {
            // `stop` / `dispose` / 退出已经收拾过了，别重复发 `lost`
            return;
        }
        core.alive = false;
        core.stdin = None;
        core.child = None;
        core.queue.drain(..).map(|pending| pending.id).collect()
    };
    for id in pending {
        push_event(shell, lost_payload(&shell.instance, &id));
    }
    // 从注册表摘掉，下一条命令会起一条新的
    if let Ok(mut map) = shells().lock() {
        if map
            .get(&shell.instance)
            .map(|current| Arc::ptr_eq(current, shell))
            .unwrap_or(false)
        {
            map.remove(&shell.instance);
        }
    }
}

// ---------------------------------------------------------------------------
// 杀
// ---------------------------------------------------------------------------

fn stop_instance(instance: &str, notify: bool) {
    let shell = {
        let mut map = lock(shells());
        map.remove(instance)
    };
    let Some(shell) = shell else {
        return;
    };
    let pending: Vec<String> = {
        let mut core = lock(&shell.core);
        core.alive = false;
        let pending = core.queue.drain(..).map(|pending| pending.id).collect();
        core.stdin = None;
        if let Some(child) = core.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        core.child = None;
        pending
    };
    if notify {
        for id in pending {
            push_event(&shell, lost_payload(&shell.instance, &id));
        }
    }
}

/// 一个桌面窗口销毁了：它那条 shell 跟着走。
///
/// 窗口销毁是**最可靠**的那条路（`runner.rs` 在 `WindowEvent::Destroyed` 里调它）：
/// 宿主页可能来不及发 `term_dispose`（进程被杀、渲染进程崩），窗口本身却一定会
/// 被 Tauri 收掉。
pub fn kill_instance(instance: &str) {
    stop_instance(instance, false);
}

/// 应用退出：一个都不许剩。
///
/// 这一条和 `term_dispose` 是**两条不同的路**：那个组件早就被删掉、但 shell 还活着的
/// 情况永远会遇到（进程被杀、宿主页崩过），而退出是最后一次兜底
pub fn kill_all() {
    let all: Vec<Arc<Shell>> = {
        let mut map = lock(shells());
        map.drain().map(|(_, shell)| shell).collect()
    };
    for shell in all {
        let mut core = lock(&shell.core);
        core.alive = false;
        core.queue.clear();
        core.stdin = None;
        if let Some(child) = core.child.as_mut() {
            let _ = child.kill();
        }
        core.child = None;
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

fn write_command(app: &AppHandle, instance: &str, command: &str) -> Result<Value, String> {
    let shell = handle(app, instance)?;
    let mut core = lock(&shell.core);
    core.next_id += 1;
    let id = term_policy::command_id(core.next_id);
    let script = term_policy::script_for(&id, command);
    let line = term_policy::wrapper_line(&term_policy::base64_encode(script.as_bytes()));

    {
        let stdin = core
            .stdin
            .as_mut()
            .ok_or_else(|| "the shell has no stdin".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\r\n"))
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("could not write to the shell: {error}"))?;
    }
    // 先写再排队：读线程看到队列头才敢把输出算到它头上，顺序反了会丢开头几个字节
    core.queue.push_back(Pending {
        id: id.clone(),
        emitted: 0,
        truncated: false,
    });
    drop(core);
    if std::env::var("LATTICE_TERM_TRACE").is_ok() {
        eprintln!("[lattice] term {id}: {command}");
    }
    Ok(json!({ "id": id }))
}

/// 跑一条命令。返回**编号**，输出走 `lattice:term` 事件一条条回来
#[tauri::command]
pub async fn term_write(
    app: AppHandle,
    instance_id: String,
    command: String,
) -> Result<Value, String> {
    // 命令形状复用 `shell_policy`（空 / NUL / 回车 / 超长），不另写一套判据
    let command = shell_policy::command_ok(&command)?;
    tauri::async_runtime::spawn_blocking(move || write_command(&app, &instance_id, &command))
        .await
        .map_err(|error| format!("terminal task failed: {error}"))?
}

/// 杀掉这条 shell。下一条命令会自动起一条新的（`cd` 和变量会丢，这是代价）
#[tauri::command]
pub async fn term_stop(instance_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || stop_instance(&instance_id, true))
        .await
        .map_err(|error| format!("terminal task failed: {error}"))?;
    Ok(json!({ "ok": true }))
}

/// 实例销毁（宿主页卸载时由宿主调）：杀进程，不打扰已经没了的 iframe
#[tauri::command]
pub async fn term_dispose(instance_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || stop_instance(&instance_id, false))
        .await
        .map_err(|error| format!("terminal task failed: {error}"))?;
    Ok(json!({ "ok": true }))
}

/// 这条终端现在什么样。
///
/// `since`（可选）是"我手里已经有到第几号事件了" —— 有它在，平台会把之后缓冲的
/// 那些重发一遍。窗口藏起来又回来、权限变更重载 iframe，都靠这一条把中间那段补上；
/// 不传就只报状态，不重发（正常轮询不该收到一整段旧输出）
#[tauri::command]
pub async fn term_state(
    instance_id: String,
    since: Option<u64>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || state_of(&instance_id, since))
        .await
        .map_err(|error| format!("terminal task failed: {error}"))
}

fn state_of(instance: &str, since: Option<u64>) -> Value {
    let shell = {
        let map = lock(shells());
        map.get(instance).cloned()
    };
    let Some(shell) = shell else {
        return json!({
            "running": false,
            "cwd": "",
            "shell": "powershell",
            "seq": 0,
        });
    };
    let (running, cwd, program, seq, replay) = {
        let core = lock(&shell.core);
        let replay: Vec<Value> = match since {
            Some(since) => core
                .ring
                .iter()
                .filter(|buffered| buffered.seq > since)
                .map(|buffered| buffered.payload.clone())
                .collect(),
            None => Vec::new(),
        };
        (
            core.alive,
            core.cwd.clone(),
            core.program.clone(),
            core.seq,
            replay,
        )
    };
    for payload in replay {
        // 重发不重新记账：它们的 seq 本来就是那一刻的
        let _ = shell.app.emit(EVENT, payload);
    }
    json!({
        "running": running,
        "cwd": cwd,
        "shell": program,
        "seq": seq,
    })
}

#[cfg(test)]
mod tests {
    //! 这一层要真起进程，`cargo test` 在 CI 上跑；本机的 `rustc --test` 只跑
    //! `term_policy.rs`（那 16 条不需要进程）。这里留了一条只依赖纯逻辑的断言，
    //! 免得整个文件看起来像"一行测试都没有"。

    use crate::term_policy;

    #[test]
    fn the_preamble_sets_both_encodings() {
        // 只设 `[Console]::OutputEncoding` 的话，喂给下一个程序的那一段还是 GBK
        let preamble = term_policy::preamble();
        assert!(preamble.contains("[Console]::OutputEncoding"));
        assert!(preamble.contains("$OutputEncoding"));
        assert!(preamble.contains("UTF8"));
    }
}
