//! 能力体检的探针 —— 把机器上的事实收齐，交给 `capability_policy::evaluate`。
//!
//! # 只在两处跑
//!
//! 启动（`boot`）和用户在设置页按下"重新检查"（`capability_probe(true)`）。
//! **没有定时器，也不该有**：
//!
//! - 这些事实几乎不变 —— 装没装 PowerShell、有没有默认输出设备，一天里不会变几次；
//!   每秒问一遍等于每秒做一次 BitBlt 和一次 COM 枚举，换来的信息量是零。
//! - 更坏的是**它会自己变红**。用户在开会，探针发现屏幕被锁了、于是把"屏幕"
//!   那一行点红 —— 那条红字说的不是"你不能用"，是"我刚才看了一眼，那一瞬间不行"。
//!   体检结果是一个**判断**，不是一条**流水**；判断只该在有人问的时候重做。
//! - 界面上写着"最后检查：09:41"，用户自己决定要不要再查。这比一个会闪的灯诚实。
//!
//! # 探针不许有副作用
//!
//! 每一次探测都必须是只读的：不启动 MCP 服务器（那会拉起用户的 node 进程）、
//! 不开音频流（`audio.rs` 那条采集线程是懒启动的，这里只枚举设备）、不发网络请求
//! （http 型的 MCP 服务器只验地址形状 —— 连一下等于每次启动都替用户拨一次号）。
//! 唯一"动手"的是 1×1 的 BitBlt，它拷 4 个字节到本进程的内存里，谁都不知道。
//!
//! # 缓存
//!
//! 结果存在一个 `Mutex<Option<Report>>` 里，**没有过期时间**。过期时间就是定时器的
//! 另一种写法：`if now - at > 60s { reprobe }` 在用户眼里和定时器没有区别。要新结果
//! 只有一个入口：显式传 `refresh`。

use std::sync::Mutex;

use serde::Serialize;
use tauri::AppHandle;

use crate::capability_policy::{
    self, Facts, LlmFact, ServerFact, ServerState, Verdict,
};

/// 最后一次的结果。`None` = 还没探过（启动那条线程可能还没跑完）
static LAST: Mutex<Option<Report>> = Mutex::new(None);

/// 一行，发给前端。`available` 由 `reason` 算出来 —— 和 `Verdict` 同一条规矩
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub available: bool,
    pub reason: Option<&'static str>,
    /// 具体那个名字：缺的命令、坏在哪儿的服务器、系统原话
    pub detail: Option<String>,
}

/// 一次体检的完整结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// 这次是什么时候探的（Unix 毫秒）。界面拿它显示"最后检查：09:41"，
    /// 也让用户知道眼前这份**不是实时的**
    pub probed_at: u64,
    pub rows: Vec<Row>,
}

/// 启动时探一次。
///
/// 放后台线程：这里要枚举音频设备（COM，十几毫秒）和读几份配置文件，够让主窗口
/// 晚一帧出来。探完之前有人点开设置页也不怕 —— `capability_probe` 发现缓存空着
/// 会自己现探一次。
pub fn boot(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("lattice-capability".to_string())
        .spawn(move || {
            let report = run(&app);
            *lock() = Some(report);
        });
}

/// 设置页要的那一份。`refresh` 为真才重探，否则给缓存。
#[tauri::command]
pub async fn capability_probe(app: AppHandle, refresh: Option<bool>) -> Result<Report, String> {
    if !refresh.unwrap_or(false) {
        if let Some(report) = lock().clone() {
            return Ok(report);
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = run(&handle);
        *lock() = Some(report.clone());
        report
    })
    .await
    .map_err(|error| format!("the capability probe failed: {error}"))
}

fn lock() -> std::sync::MutexGuard<'static, Option<Report>> {
    // 锁中毒不当回事：里面只有一份快照，没有"半个状态"可言
    LAST.lock().unwrap_or_else(|error| error.into_inner())
}

/// 探一次：收事实 → 判 → 转成发给前端的形状
fn run(app: &AppHandle) -> Report {
    let facts = facts(app);
    let rows: Vec<Row> = capability_policy::evaluate(&facts)
        .into_iter()
        .map(row_of)
        .collect();
    Report {
        probed_at: now_millis(),
        rows,
    }
}

fn row_of(verdict: Verdict) -> Row {
    Row {
        available: verdict.available(),
        id: verdict.id,
        reason: verdict.reason,
        detail: verdict.detail,
    }
}

// ---------------------------------------------------------------------------
// 收事实
// ---------------------------------------------------------------------------

fn facts(app: &AppHandle) -> Facts {
    let hands = crate::hands::effective_hands_now(app);
    Facts {
        // 顺序同 `capability_policy::HANDS`。写成一个数组字面量而不是循环：
        // 漏一项编译就红，循环漏一项是静默的 `false`（= "关着"）
        hands: [
            hands.files,
            hands.shell,
            hands.web,
            hands.screen,
            hands.input,
            hands.mcp,
        ],
        shell: shell_found(),
        screen_error: crate::hands::grab_screen(0, 0, 1, 1).err(),
        mcp: mcp_facts(app),
        llm: llm_fact(app),
        audio_device: crate::audio::output_device().is_ok(),
        secrets_error: crate::secrets::secrets_status(app.clone()).error,
    }
}

/// 找到的那个 shell。
///
/// **顺序和兜底必须和 `hands::shell_program` 一致**：那边找不到时给一个写死的
/// `System32` 路径（GUI 进程的 PATH 不一定有 System32），这里也认那一条 ——
/// 不然体检会说"没有 shell"，而助手明明跑得动命令。
fn shell_found() -> Option<String> {
    for name in ["pwsh.exe", "powershell.exe"] {
        if let Some(path) = crate::hands::find_on_path(name) {
            return Some(path);
        }
    }
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let fallback = format!("{system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    std::path::Path::new(&fallback).is_file().then_some(fallback)
}

fn mcp_facts(app: &AppHandle) -> Vec<ServerFact> {
    crate::mcp::mcp_servers(app.clone())
        .into_iter()
        .map(|server| ServerFact {
            id: server.id.clone(),
            state: server_state(&server),
        })
        .collect()
}

fn server_state(server: &crate::mcp::McpServer) -> ServerState {
    if server.transport == "http" {
        let url = server.url.trim();
        if url.is_empty() {
            return ServerState::BadConfig("the address is empty".to_string());
        }
        // 只验形状，**不拨号**：连一下等于每次启动都替用户往外发一次请求，
        // 而"那台服务现在活着吗"是助手真去调的时候才知道的事
        return match crate::network_policy::parse_url(url) {
            Ok(_) => ServerState::Ready,
            Err(error) => ServerState::BadConfig(error),
        };
    }

    let command = server.command.trim();
    if command.is_empty() {
        return ServerState::BadConfig("no command".to_string());
    }
    if command_resolves(command) {
        ServerState::Ready
    } else {
        ServerState::MissingCommand(command.to_string())
    }
}

/// 这条命令起得来吗。
///
/// 带路径的按路径判；光一个名字的按 PATH 判，并且把 Windows 那三种后缀都试一遍
/// —— `npx` 在磁盘上叫 `npx.cmd`，只试 `npx` 会把最常见的那个 MCP 服务器判死。
fn command_resolves(command: &str) -> bool {
    let path = std::path::Path::new(command);
    if path.is_absolute() || command.contains('\\') || command.contains('/') {
        return path.is_file();
    }
    ["", ".exe", ".cmd", ".bat"]
        .iter()
        .any(|suffix| crate::hands::find_on_path(&format!("{command}{suffix}")).is_some())
}

fn llm_fact(app: &AppHandle) -> LlmFact {
    let view = crate::llm::llm_profiles(app.clone());
    let Some(active) = view
        .profiles
        .iter()
        .find(|profile| profile.id == view.active_id)
    else {
        return LlmFact::NoProfile;
    };
    if active.configured {
        return LlmFact::Ready;
    }
    // `configured` 把三件事混成了一个 false，分开报 —— 它们要做的动作不一样：
    // 填地址、填模型名、粘 key。按"先填哪一栏"的顺序判，用户一次补一处就往前走一格
    if active.base_url.trim().is_empty() {
        return LlmFact::Incomplete("address");
    }
    if active.model.trim().is_empty() {
        return LlmFact::Incomplete("model");
    }
    if active.auth != "none" && active.key_hint.trim().is_empty() {
        return LlmFact::NoKey;
    }
    // 三样都在、`configured` 仍然是 false：地址形状不对（`normalize_base` 不认）。
    // 归到"地址"那一栏 —— 用户要改的就是它
    LlmFact::Incomplete("address")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}
