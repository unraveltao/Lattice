//! assistant 的第六只手：MCP（外部服务）。
//!
//! 一个 MCP 服务器就是"一包工具"：它自己声明 `tools/list`，我们把这些工具按
//! `mcp.<server>.<tool>` 递给模型，**每一次调用都要用户点头**（0004 §6：服务器的
//! 语义会随升级而变，所以"允许这个服务器"不是一次性的决定）。
//!
//! # 三种传输，这一版接两种
//!
//! - **stdio**：`cmd /C <命令> <参数...>`，一行一个 JSON-RPC。服务器由**用户自己
//!   配的**命令启动，跑在用户账户下 —— 和 `shell.run` 同一条边界：没有沙箱。
//! - **streamable HTTP**：POST JSON-RPC，响应可能是 `application/json`，也可能是
//!   一条 SSE（`data: {...}`）。`Mcp-Session-Id` 要原样带回去。
//! - websocket：MCP 的旧传输，**不做**（新服务器都用前两个）。
//!
//! # 每次调用都重新起进程，为什么不常驻
//!
//! 常驻要回答一堆生命周期问题（服务器崩了、被升级了、用户改了配置、应用退出），
//! 而这里一次调用的代价主要是 `npx` 的启动时间。所以：
//! **发现一次、缓存工具表；每次调用起一个新进程、跑完就关**。
//! 代价写在 AGENTS.md §8：第一次调用会慢（`npx` 要联网），慢到用户以为卡住了
//! 就是这一版已知的毛病。要改成常驻池，先想清楚上面那四个问题。
//!
//! # 工具名为什么要压一遍
//!
//! 真服务器会返回 `readFile`、`fs.read`、带表情的名字。工具名要同时当**审计日志
//! 的键**和 OpenAI 的 function name（`^[a-zA-Z0-9_-]{1,64}$`），所以统一压成
//! `mcp.<server>.<sanitized>`，并且去重（见 `mcp_policy`）。原始名字留在缓存里，
//! 调用的那一刻再换回去。

use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{mcp_policy, network, network_policy};

/// 等 `initialize` / `tools/list` 的上限。`npx` 要联网装包，30 秒是给它的
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// 一次 `tools/call` 的上限。服务器可能在后面接一个很慢的 API
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// 一个工具的结果最多给模型多少字（和 `web.fetch` 同一个数量级）
const MAX_TEXT_CHARS: usize = 40_000;
/// 描述最多多少字。提示词里的工具表不是文档，长了会把上下文吃光
const MAX_DESCRIPTION_CHARS: usize = 300;
/// 一条请求最多等多少条无关消息（服务器可以主动发通知）
const MAX_NOISE_LINES: usize = 500;

// ---------------------------------------------------------------------------
// 配置：`%APPDATA%\com.iron-tom.lattice\mcp.json`
// ---------------------------------------------------------------------------
//
// 为什么不塞进 `assistant.json`：那份是模型档 + 六只手的开关，`llm.rs` 独占它。
// 服务器列表是**另一种东西**（有命令、有 URL），写在一起会让两边抢同一把锁；
// 而且它坏了不该让"模型档读不出来"。

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    /// 本地生成的 id（`[a-z0-9]`，≤32），进工具名的第一段
    #[serde(default)]
    pub id: String,
    /// 界面上显示的名字。**不进工具名**（可能有空格与中文）
    #[serde(default)]
    pub label: String,
    /// `"stdio"` 或 `"http"`。别的值一律按 stdio
    #[serde(default)]
    pub transport: String,
    /// stdio：可执行文件或 `npx` 这类（走 `cmd /C`）
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// http：完整的地址
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    servers: Vec<McpServer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    /// 已经压好的完整名字：`mcp.<server>.<tool>`
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTools {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub error: String,
    pub tools: Vec<McpTool>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscover {
    pub servers: Vec<ServerTools>,
}

fn file_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("mcp.json"))
        .map_err(|error| format!("could not locate the config folder: {error}"))
}

fn load(app: &AppHandle) -> McpFile {
    let Ok(path) = file_path(app) else {
        return McpFile::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return McpFile::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save(app: &AppHandle, file: &McpFile) -> Result<(), String> {
    let path = file_path(app)?;
    let text = serde_json::to_string_pretty(file).map_err(|error| format!("{error}"))?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    /* 临时文件 + 原子替换：和 `assistant.json` / `state.json` 同一条规矩 */
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text.as_bytes())
        .map_err(|error| format!("could not write the server list: {error}"))?;
    std::fs::rename(&temp, &path)
        .map_err(|error| format!("could not replace the server list: {error}"))
}

/// 服务器定义洗一遍：id 缺失/非法就重新生成，名字与命令去空白，传输只认两种。
/// **不做"自动修好用户写错的命令"** —— 那只会把错误藏起来
fn normalize(mut servers: Vec<McpServer>) -> Vec<McpServer> {
    let mut taken: Vec<String> = Vec::new();
    for server in &mut servers {
        server.label = server.label.trim().to_string();
        server.command = server.command.trim().to_string();
        server.url = server.url.trim().to_string();
        server.transport = if server.transport.trim() == "http" {
            "http".to_string()
        } else {
            "stdio".to_string()
        };
        server.args = server
            .args
            .iter()
            .map(|arg| arg.to_string())
            .filter(|arg| !arg.is_empty())
            .collect();
        if !segment_id_ok(&server.id) || taken.iter().any(|id| id == &server.id) {
            server.id = fresh_id(&taken);
        }
        taken.push(server.id.clone());
        if server.label.is_empty() {
            server.label = if server.transport == "http" {
                server.url.clone()
            } else {
                server.command.clone()
            };
        }
        if server.label.is_empty() {
            server.label = "MCP server".to_string();
        }
    }
    servers
}

fn segment_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
}

fn fresh_id(taken: &[String]) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|gap| gap.as_nanos() as u64)
        .unwrap_or(1);
    for attempt in 0..1000 {
        let candidate = format!("s{:08x}", (nanos.wrapping_mul(31).wrapping_add(attempt)) & 0xffff_ffff);
        if !taken.iter().any(|id| id == &candidate) {
            return candidate;
        }
    }
    "s00000000".to_string()
}

// ---------------------------------------------------------------------------
// 工具发现缓存：同一个服务器一次运行里只问一次（用户点 Refresh 才重问）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct CachedTool {
    /// 服务器声明的原样名字，调用时用它
    raw: String,
    /// 压过、去过重的那一段（不含前缀）
    exposed: String,
    description: String,
    parameters: Value,
}

static CACHE: Mutex<Vec<(String, Vec<CachedTool>)>> = Mutex::new(Vec::new());

fn cache_get(server: &str) -> Option<Vec<CachedTool>> {
    let cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    cache
        .iter()
        .find(|(id, _)| id == server)
        .map(|(_, tools)| tools.clone())
}

fn cache_put(server: &str, tools: Vec<CachedTool>) {
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    match cache.iter_mut().find(|(id, _)| id == server) {
        Some(entry) => entry.1 = tools,
        None => cache.push((server.to_string(), tools)),
    }
}

fn cache_clear() {
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    cache.clear();
}

// ---------------------------------------------------------------------------
// 一次会话
// ---------------------------------------------------------------------------

/// 一次 JSON-RPC 往返。`id` 由会话自己发，**每一条请求一个新号**
enum Call<'a> {
    Initialize,
    ToolsList,
    ToolsCall { tool: &'a str, args: &'a str },
}

fn line_of(call: Call<'_>, id: i64) -> String {
    match call {
        Call::Initialize => mcp_policy::initialize(id),
        Call::ToolsList => mcp_policy::list_tools(id),
        Call::ToolsCall { tool, args } => mcp_policy::call_tool(id, tool, args),
    }
}

enum Session {
    Stdio(StdioSession),
    Http(HttpSession),
}

struct StdioSession {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    /// 服务器打到 stderr 的字（最后一段），失败时贴给用户看
    stderr: std::sync::Arc<Mutex<String>>,
    next_id: i64,
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        /* 先关 stdin：守规矩的服务器看到 EOF 就自己退了。等 300ms 还没退才 kill ——
         * 直接 kill 时 `cmd` 死了、它拉起来的 `node` 可能还活着（`shell.run` 同一个坑） */
        self.stdin.take();
        for _ in 0..30 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct HttpSession {
    url: String,
    session: Option<String>,
    next_id: i64,
}

impl Session {
    fn open(server: &McpServer) -> Result<Session, String> {
        if server.transport == "http" {
            if server.url.is_empty() {
                return Err("this server has no URL".to_string());
            }
            network_policy::parse_url(&server.url)?;
            return Ok(Session::Http(HttpSession {
                url: server.url.clone(),
                session: None,
                next_id: 1,
            }));
        }
        if server.command.is_empty() {
            return Err("this server has no command".to_string());
        }
        Ok(Session::Stdio(spawn_stdio(server)?))
    }

    /// 握手：`initialize` → `notifications/initialized`。**顺序不能换**
    fn handshake(&mut self) -> Result<(), String> {
        let _ = self.round_trip(Call::Initialize, HANDSHAKE_TIMEOUT)?;
        self.notify()?;
        Ok(())
    }

    fn round_trip(&mut self, call: Call<'_>, timeout: Duration) -> Result<Value, String> {
        match self {
            Session::Stdio(session) => stdio_round_trip(session, call, timeout),
            Session::Http(session) => http_round_trip(session, call, timeout),
        }
    }

    fn notify(&mut self) -> Result<(), String> {
        let line = mcp_policy::initialized_note();
        match self {
            Session::Stdio(session) => {
                let stdin = session.stdin.as_mut().ok_or("the server closed its input")?;
                writeln!(stdin, "{line}").map_err(|error| format!("could not write to the server: {error}"))?;
                stdin.flush().ok();
                Ok(())
            }
            Session::Http(session) => {
                // 服务器对通知回 202，没有 body；失败不算致命（有的实现直接 204）
                let _ = post(session, &line);
                Ok(())
            }
        }
    }
}

fn spawn_stdio(server: &McpServer) -> Result<StdioSession, String> {
    use std::os::windows::process::CommandExt;
    /// `CREATE_NO_WINDOW`：不给每个 MCP 进程闪一个黑框
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let line = mcp_policy::command_line(&server.command, &server.args);
    let mut child = Command::new("cmd")
        .raw_arg(format!("/C {line}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("could not start \"{}\": {error}", server.command))?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("the server has no stdout")?;
    let stderr_pipe = child.stderr.take();

    let (sender, lines) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            /* 按字节攒到一整行再交出去：管道完全可能从多字节字符中间切开 */
            loop {
                let mut byte = [0u8; 1];
                match reader.read(&mut byte) {
                    Ok(0) => return,
                    Ok(_) => {
                        if byte[0] == b'\n' {
                            break;
                        }
                        buffer.push(byte[0]);
                        if buffer.len() > mcp_policy::MAX_LINE {
                            let _ = sender.send("{\"error\":{\"message\":\"line too long\"}}".to_string());
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
            if buffer.last() == Some(&b'\r') {
                buffer.pop();
            }
            let Ok(text) = String::from_utf8(buffer.clone()) else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            if sender.send(text).is_err() {
                return;
            }
        }
    });

    let stderr = std::sync::Arc::new(Mutex::new(String::new()));
    if let Some(mut pipe) = stderr_pipe {
        let sink = stderr.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            let mut slot = sink.lock().unwrap_or_else(|error| error.into_inner());
            let tail: String = text.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
            *slot = tail;
        });
    }

    Ok(StdioSession {
        child,
        stdin,
        lines,
        stderr,
        next_id: 1,
    })
}

fn stdio_round_trip(
    session: &mut StdioSession,
    call: Call<'_>,
    timeout: Duration,
) -> Result<Value, String> {
    let id = session.next_id;
    session.next_id += 1;
    let line = line_of(call, id);
    {
        let stdin = session
            .stdin
            .as_mut()
            .ok_or("the server closed its input")?;
        writeln!(stdin, "{line}").map_err(|error| format!("could not write to the server: {error}"))?;
        stdin.flush().ok();
    }

    for _ in 0..MAX_NOISE_LINES {
        let answered = session
            .lines
            .recv_timeout(timeout)
            .map_err(|_| {
                format!(
                    "the server did not answer within {}s{}",
                    timeout.as_secs(),
                    stderr_hint(&session.stderr)
                )
            })?;
        if mcp_policy::id_of(&answered) != Some(id) {
            continue;
        }
        return answer_of(&answered);
    }
    Err("the server flooded the pipe without answering".to_string())
}

fn http_round_trip(
    session: &mut HttpSession,
    call: Call<'_>,
    _timeout: Duration,
) -> Result<Value, String> {
    let id = session.next_id;
    session.next_id += 1;
    let line = line_of(call, id);
    let (status, headers, body) = post(session, &line)?;
    if !(200..300).contains(&status) {
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("the server answered HTTP {status}: {snippet}"));
    }
    let content_type = headers
        .get("content-type")
        .cloned()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let parsed = if content_type.contains("event-stream") {
        value_of_sse(&body, id)
    } else {
        serde_json::from_str::<Value>(&body).ok()
    };
    let Some(value) = parsed else {
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("could not read the server's answer: {snippet}"));
    };
    let answered = value.get("id").and_then(Value::as_i64) == Some(id);
    if answered || value.get("result").is_some() || value.get("error").is_some() {
        return answer_of_value(value);
    }
    Err("the server answered a different request".to_string())
}

fn post(
    session: &mut HttpSession,
    line: &str,
) -> Result<(u16, std::collections::BTreeMap<String, String>, String), String> {
    let target = network_policy::parse_url(&session.url)?;
    let mut headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        (
            "Accept".to_string(),
            "application/json, text/event-stream".to_string(),
        ),
        (
            "MCP-Protocol-Version".to_string(),
            mcp_policy::PROTOCOL_VERSION.to_string(),
        ),
    ];
    if let Some(id) = &session.session {
        headers.push(("Mcp-Session-Id".to_string(), id.clone()));
    }
    let response = network::send(&target, "POST", &headers, Some(line.as_bytes()), 1024 * 1024)?;
    if let Some(id) = response.headers.get("mcp-session-id") {
        session.session = Some(id.clone());
    }
    Ok((
        response.status,
        response.headers,
        String::from_utf8_lossy(&response.body).to_string(),
    ))
}

/// SSE 里挑出 id 对得上的那个 JSON。没有就取最后一个能解析的
fn value_of_sse(body: &str, id: i64) -> Option<Value> {
    let mut last: Option<Value> = None;
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if mcp_policy::id_of(data) == Some(id) {
                return Some(value);
            }
            last = Some(value);
        }
    }
    last
}

fn stderr_hint(stderr: &std::sync::Arc<Mutex<String>>) -> String {
    let text = stderr.lock().unwrap_or_else(|error| error.into_inner());
    let text = text.trim();
    if text.is_empty() {
        String::new()
    } else {
        format!("; the server said: {text}")
    }
}

/// JSON-RPC 的答案 → `result`，或者一句人话
fn answer_of(line: &str) -> Result<Value, String> {
    let value = serde_json::from_str::<Value>(line)
        .map_err(|_| format!("the server sent something that is not JSON: {}", first_chars(line, 200)))?;
    answer_of_value(value)
}

fn answer_of_value(value: Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the server reported an error");
        return Err(message.to_string());
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

fn first_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// ---------------------------------------------------------------------------
// 发现与调用
// ---------------------------------------------------------------------------

/// 问一个服务器要工具表。**不缓存**：调用方决定什么时候缓存
fn discover(server: &McpServer) -> Result<Vec<CachedTool>, String> {
    let mut session = Session::open(server)?;
    session.handshake()?;
    let result = session.round_trip(Call::ToolsList, HANDSHAKE_TIMEOUT)?;
    let Some(items) = result.get("tools").and_then(Value::as_array) else {
        return Err("the server did not return a tool list".to_string());
    };
    let mut tools = Vec::new();
    let mut taken: Vec<String> = Vec::new();
    for item in items {
        let raw = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if raw.is_empty() {
            continue;
        }
        let exposed = mcp_policy::dedupe(&taken, &mcp_policy::sanitize_tool(&raw));
        taken.push(exposed.clone());
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let description = first_chars(&description, MAX_DESCRIPTION_CHARS);
        let mut parameters = item
            .get("inputSchema")
            .cloned()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        /* 模型那边只认 object 形状的 schema；服务器给的 `"type":"object"` 缺了就补上 */
        if parameters.get("type").is_none() {
            parameters["type"] = json!("object");
        }
        tools.push(CachedTool {
            raw,
            exposed,
            description,
            parameters,
        });
    }
    Ok(tools)
}

fn tools_of(server: &McpServer, tools: &[CachedTool]) -> Vec<McpTool> {
    tools
        .iter()
        .map(|tool| McpTool {
            name: mcp_policy::expose(&server.id, &tool.exposed),
            description: tool.description.clone(),
            parameters: tool.parameters.clone(),
        })
        .collect()
}

fn discover_one(server: &McpServer) -> ServerTools {
    match discover(server) {
        Ok(tools) => {
            cache_put(&server.id, tools.clone());
            ServerTools {
                id: server.id.clone(),
                label: server.label.clone(),
                ok: true,
                error: String::new(),
                tools: tools_of(server, &tools),
            }
        }
        Err(error) => ServerTools {
            id: server.id.clone(),
            label: server.label.clone(),
            ok: false,
            error,
            tools: Vec::new(),
        },
    }
}

fn discover_all(app: &AppHandle, refresh: bool) -> McpDiscover {
    let servers = load(app).servers;
    let mut results = Vec::new();
    for server in servers {
        if !refresh {
            if let Some(tools) = cache_get(&server.id) {
                results.push(ServerTools {
                    id: server.id.clone(),
                    label: server.label.clone(),
                    ok: true,
                    error: String::new(),
                    tools: tools_of(&server, &tools),
                });
                continue;
            }
        }
        results.push(discover_one(&server));
    }
    McpDiscover { servers: results }
}

fn fail(code: &str, message: impl Into<String>) -> String {
    json!({ "ok": false, "code": code, "error": message.into() }).to_string()
}

/// `assistant_tool` 里 `mcp.*` 的分支。返回 `AgentReply` 形状的 JSON 字符串
pub(crate) fn run_tool(app: &AppHandle, name: &str, args: &Value) -> String {
    let Some((server_id, exposed)) = mcp_policy::parse_name(name) else {
        return fail("bad_args", format!("\"{name}\" is not a valid mcp tool name"));
    };
    let Some(server) = load(app)
        .servers
        .into_iter()
        .find(|server| server.id == server_id)
    else {
        return fail(
            "unknown_server",
            format!("no MCP server is configured with the id \"{server_id}\""),
        );
    };

    let tools = match cache_get(&server_id) {
        Some(tools) => tools,
        None => match discover(&server) {
            Ok(tools) => {
                cache_put(&server_id, tools.clone());
                tools
            }
            Err(error) => return fail("mcp_error", error),
        },
    };
    let Some(tool) = tools.into_iter().find(|tool| tool.exposed == exposed) else {
        return fail(
            "unknown_tool",
            format!(
                "\"{}\" does not declare a tool called \"{exposed}\" any more — refresh the tool list in Assistant settings",
                server.label
            ),
        );
    };

    let args_json = serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string());
    let mut session = match Session::open(&server) {
        Ok(session) => session,
        Err(error) => return fail("mcp_error", error),
    };
    if let Err(error) = session.handshake() {
        return fail("mcp_error", error);
    }
    let result = match session.round_trip(
        Call::ToolsCall {
            tool: &tool.raw,
            args: &args_json,
        },
        CALL_TIMEOUT,
    ) {
        Ok(result) => result,
        Err(error) => return fail("mcp_error", error),
    };

    let (text, truncated) = text_of(&result);
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_error {
        return fail("tool_error", text);
    }
    json!({
        "ok": true,
        "server": server.label,
        "tool": tool.raw,
        "text": text,
        "truncated": truncated,
    })
    .to_string()
}

/// `tools/call` 的结果折成一段字。MCP 的 `content` 是数组（text / image / resource）
fn text_of(result: &Value) -> (String, bool) {
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = result.get("content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => parts.push(
                    item.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ),
                "image" => parts.push("[image]".to_string()),
                "resource" => {
                    let uri = item
                        .get("resource")
                        .and_then(|resource| resource.get("uri"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    parts.push(format!("[resource {uri}]"));
                }
                other => parts.push(format!("[{other}]")),
            }
        }
    }
    if parts.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            parts.push(serde_json::to_string(structured).unwrap_or_default());
        }
    }
    let text = parts.join("\n");
    let text = text.trim().to_string();
    if text.chars().count() > MAX_TEXT_CHARS {
        return (first_chars(&text, MAX_TEXT_CHARS), true);
    }
    (text, false)
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mcp_servers(app: AppHandle) -> Vec<McpServer> {
    load(&app).servers
}

/// 保存整份列表。**每次保存都清缓存**：用户改了命令/URL，旧工具表就不再代表这个服务器
#[tauri::command]
pub fn mcp_servers_save(app: AppHandle, servers: Vec<McpServer>) -> Result<Vec<McpServer>, String> {
    let servers = normalize(servers);
    let file = McpFile {
        version: 1,
        servers: servers.clone(),
    };
    save(&app, &file)?;
    cache_clear();
    Ok(servers)
}

/// 发现工具。`refresh` 为真时连缓存一起重问（设置面板上那个按钮）
#[tauri::command]
pub async fn mcp_tools(app: AppHandle, refresh: Option<bool>) -> Result<McpDiscover, String> {
    let refresh = refresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || discover_all(&app, refresh))
        .await
        .map_err(|error| format!("the MCP discovery task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_results_fold_into_text() {
        let result = json!({
            "content": [
                { "type": "text", "text": "line one" },
                { "type": "text", "text": "line two" }
            ]
        });
        let (text, truncated) = text_of(&result);
        assert_eq!(text, "line one\nline two");
        assert!(!truncated);
    }

    #[test]
    fn images_are_labelled_not_dumped() {
        // 模型看不见图（0004 §3），所以截图类结果只能给一个标记
        let result = json!({ "content": [ { "type": "image", "data": "AAAA" } ] });
        assert_eq!(text_of(&result).0, "[image]");
    }

    #[test]
    fn long_results_are_cut_and_marked() {
        let long = "x".repeat(MAX_TEXT_CHARS + 10);
        let result = json!({ "content": [ { "type": "text", "text": long } ] });
        let (text, truncated) = text_of(&result);
        assert!(truncated);
        assert_eq!(text.chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn errors_come_back_as_an_error_not_a_result() {
        let value = json!({ "error": { "code": -32601, "message": "no such tool" } });
        assert_eq!(answer_of_value(value).unwrap_err(), "no such tool");
    }

    #[test]
    fn an_empty_result_is_null() {
        assert_eq!(answer_of_value(json!({ "id": 1 })).unwrap(), Value::Null);
    }

    #[test]
    fn sse_answers_are_found_by_id() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n";
        let value = value_of_sse(body, 2).unwrap();
        assert_eq!(value["result"]["ok"], true);
        assert!(value_of_sse(body, 9).is_some(), "fallback returns the last one");
        assert!(value_of_sse("event: ping\n", 2).is_none());
    }

    #[test]
    fn servers_get_clean_ids_and_labels() {
        let servers = normalize(vec![
            McpServer {
                id: "BAD ID".to_string(),
                label: "  ".to_string(),
                transport: "weird".to_string(),
                command: " npx ".to_string(),
                args: vec!["".to_string(), "-y".to_string()],
                url: String::new(),
            },
            McpServer {
                id: "http".to_string(),
                label: "remote".to_string(),
                transport: "http".to_string(),
                command: String::new(),
                args: vec![],
                url: " https://example.com/mcp ".to_string(),
            },
        ]);
        assert_eq!(servers[0].transport, "stdio");
        assert_eq!(servers[0].command, "npx");
        assert_eq!(servers[0].label, "npx");
        assert_eq!(servers[0].args, vec!["-y".to_string()]);
        assert_eq!(servers[1].transport, "http");
        assert_eq!(servers[1].url, "https://example.com/mcp");
        for server in &servers {
            assert!(segment_id_ok(&server.id), "{}", server.id);
        }
    }

    #[test]
    fn duplicate_ids_are_replaced() {
        let mut servers = Vec::new();
        for _ in 0..3 {
            servers.push(McpServer {
                id: "same".to_string(),
                label: "x".to_string(),
                transport: "stdio".to_string(),
                command: "node".to_string(),
                args: vec![],
                url: String::new(),
            });
        }
        let servers = normalize(servers);
        let ids: Vec<&str> = servers.iter().map(|server| server.id.as_str()).collect();
        assert_eq!(ids.iter().filter(|id| **id == "same").count(), 1);
        assert_eq!(ids.len(), 3);
    }
}
