//! 内置 assistant 的**传输层**：OpenAI 兼容的 `/chat/completions`。
//!
//! # 为什么在这里，而不是让前端 `fetch`
//!
//! 三件事只有 Rust 做得到：
//!
//! 1. **key 不进前端**。它落在 `%APPDATA%\com.iron-tom.lattice\assistant.json`，
//!    前端拿到的永远只有 `sk-1…cdef` 这种掩码。key 一旦进了 JS 状态，就会跟着
//!    调试面板、截图、某次 `JSON.stringify` 一起外泄，而它换不了（用户得去后台吊销）。
//! 2. **出网只有一个出口**。请求走 `network::send`（WinHTTP），和组件联网**同一条**
//!    实现：关掉自动重定向、限时限量、错误码统一。前端的 `fetch` 会绕过这套，
//!    还得给主窗口的 CSP 开一个口子 —— 那个口子开出去就收不回来了。
//! 3. **组件调不到 key**。组件的 `llm.chat` 走桥 → 桥上查 `llm:chat` 权限 →
//!    这里读 key 发请求。组件全程看不见 key，也没法自己拼一个 baseUrl 出去。
//!
//! # 谁在用
//!
//! - 主窗口的 assistant 面板（带 `tools`，能改桌面）
//! - 组件（**不带** `tools`，只说话；见 `runtime/bridge.ts` 的 `llm.chat`）
//!
//! 两条路共用这一个出口，区别只在 `tools` 参数 —— 组件的"手"从哪来这件事，
//! 在 `docs/AGENT_ACCESS.md` 里写过一遍：不给。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::llm_policy;
use crate::network;
use crate::network_policy::parse_url;

/// 两次请求之间至少隔这么久。组件的 `llm.chat` 也是走这条路 —— 没有这一层，
/// 一个写坏的组件可以在循环里把用户的额度刷干净
const MIN_GAP: Duration = Duration::from_millis(300);

fn last_call() -> &'static Mutex<Option<Instant>> {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// 磁盘上的形状。**key 和其它字段放同一个文件**：拆成两个文件不会更安全
/// （同一个目录、同一个账户），只会多一处"改了一半"的机会
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssistantConfig {
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default)]
    api_key: String,
}

impl AssistantConfig {
    fn temperature(&self) -> f64 {
        self.temperature.unwrap_or(DEFAULT_TEMPERATURE).clamp(0.0, 2.0)
    }
}

/// 出厂温度。0.6 是"能干活、又不会每句话都不一样"的经验值
const DEFAULT_TEMPERATURE: f64 = 0.6;

/// 前端看到的状态。**没有 `apiKey` 字段**，只有掩码
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    /// 三项齐了才算配置好（base + model + key）
    pub configured: bool,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    /// `sk-1…cdef`；没配就是空串
    pub key_hint: String,
    /// `file` / `env` / `none`。`env` 是给开发用的（见 `LATTICE_LLM_KEY`）
    pub key_source: String,
    /// 真正会去敲的地址（归一化之后）。给"测试连接"显示用
    pub endpoint: String,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the config directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create the config directory: {error}"))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("assistant.json"))
}

fn read_config(app: &AppHandle) -> AssistantConfig {
    let Ok(path) = config_path(app) else {
        return AssistantConfig::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        // 坏文件不该让应用起不来，也不该把用户的 key 悄悄清掉 —— 读不出来就当没配
        Err(_) => AssistantConfig::default(),
    }
}

/// 先写 `.tmp` 再改名，和 `state.rs` 同一条规矩
fn write_config(app: &AppHandle, config: &AssistantConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let temp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| format!("failed to serialize the assistant settings: {error}"))?;
    std::fs::write(&temp, text.as_bytes())
        .map_err(|error| format!("failed to write the assistant settings: {error}"))?;
    std::fs::rename(&temp, &path)
        .map_err(|error| format!("failed to replace the assistant settings: {error}"))?;
    Ok(())
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 环境变量优先：它的用途是"不想把 key 写进磁盘"和自动化测试。
/// 界面上会标成 `env`，免得用户改了设置却发现没生效
fn resolved(app: &AppHandle) -> (AssistantConfig, &'static str) {
    let mut config = read_config(app);
    let mut source = if config.api_key.trim().is_empty() {
        "none"
    } else {
        "file"
    };
    if let Some(base) = env_value("LATTICE_LLM_BASE_URL") {
        config.base_url = base;
    }
    if let Some(model) = env_value("LATTICE_LLM_MODEL") {
        config.model = model;
    }
    if let Some(key) = env_value("LATTICE_LLM_KEY") {
        config.api_key = key;
        source = "env";
    }
    (config, source)
}

fn status_of(config: &AssistantConfig, source: &str) -> LlmStatus {
    let base = llm_policy::normalize_base(&config.base_url).unwrap_or_default();
    let endpoint = if base.is_empty() {
        String::new()
    } else {
        llm_policy::chat_url(&base)
    };
    LlmStatus {
        configured: !base.is_empty() && !config.model.trim().is_empty() && !config.api_key.trim().is_empty(),
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        temperature: config.temperature(),
        key_hint: llm_policy::mask_key(&config.api_key),
        key_source: source.to_string(),
        endpoint,
    }
}

#[tauri::command]
pub fn llm_status(app: AppHandle) -> LlmStatus {
    let (config, source) = resolved(&app);
    status_of(&config, &source)
}

/// 存 base / model / temperature。key 走 `llm_set_key`，两条路分开是因为
/// 界面上的输入框也是分开的：改个模型名不该要求用户重新粘一次 key
#[tauri::command]
pub fn llm_save(app: AppHandle, base_url: String, model: String, temperature: f64) -> Result<LlmStatus, String> {
    let base = llm_policy::normalize_base(&base_url)?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("the model name is empty".to_string());
    }
    let mut config = read_config(&app);
    config.base_url = base;
    config.model = model;
    config.temperature = Some(temperature.clamp(0.0, 2.0));
    write_config(&app, &config)?;
    let (config, source) = resolved(&app);
    Ok(status_of(&config, &source))
}

/// 存 / 清 key。空串表示"删掉"。存进去的**不再回传**，只回掩码
#[tauri::command]
pub fn llm_set_key(app: AppHandle, key: String) -> Result<LlmStatus, String> {
    let mut config = read_config(&app);
    let trimmed = key.trim().to_string();
    // 粘进来时常常带换行和首尾空格；长度给个上限，别把整段剪贴板塞进文件
    if trimmed.chars().count() > 512 {
        return Err("that does not look like an API key (more than 512 characters)".to_string());
    }
    config.api_key = trimmed;
    write_config(&app, &config)?;
    let (config, source) = resolved(&app);
    Ok(status_of(&config, &source))
}

fn request_headers(key: &str) -> Vec<(String, String)> {
    vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("accept".to_string(), "application/json".to_string()),
        ("authorization".to_string(), format!("Bearer {key}")),
    ]
}

/// 把一次 HTTP 往返跑完，返回 (状态码, 响应体)。
///
/// 抽出来是因为 chat 和 models 两条路只有 URL、请求体、解析不一样，
/// 传输细节（超时、上限、错误翻译）必须一模一样。
async fn call(url: String, method: &'static str, key: String, body: Option<String>) -> Result<(u16, String), String> {
    let target = parse_url(&url)?;
    let headers = request_headers(&key);
    let payload = body.map(|text| text.into_bytes());

    // 节流：离上一次太近就等一会儿。等待放在阻塞线程里 —— `thread::sleep`
    // 在异步线程上会占住一个 worker
    let wait = {
        let mut last = last_call()
            .lock()
            .map_err(|_| "the assistant lock is poisoned".to_string())?;
        let now = Instant::now();
        let wait = last
            .map(|previous| MIN_GAP.saturating_sub(now.saturating_duration_since(previous)))
            .unwrap_or_default();
        *last = Some(now + wait);
        wait
    };

    // WinHTTP 是阻塞 API：扔到线程池，别占异步运行时的线程
    let response = tauri::async_runtime::spawn_blocking(move || {
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        network::send(
            &target,
            method,
            &headers,
            payload.as_deref(),
            llm_policy::MAX_RESPONSE_BYTES,
        )
    })
    .await
    .map_err(|error| format!("the request task failed: {error}"))?
    .map_err(|error| llm_policy::describe_failure(&error))?;

    let text = String::from_utf8_lossy(&response.body).to_string();
    if !response.ok {
        // 状态码在调用方决定怎么说话（models 和 chat 的 401 是同一句话，
        // 但 404 的提示不一样）
        return Ok((response.status, text));
    }
    if response.truncated {
        return Err("the provider's response was too large to read".to_string());
    }
    Ok((response.status, text))
}

/// 拉模型列表。**这就是"测试连接"**：它 200，说明地址和 key 都对
#[tauri::command]
pub async fn llm_models(app: AppHandle, base_url: Option<String>, key: Option<String>) -> Result<Vec<String>, String> {
    let (config, _) = resolved(&app);
    let raw_base = base_url.unwrap_or_else(|| config.base_url.clone());
    let base = llm_policy::normalize_base(&raw_base)?;
    let key = key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| config.api_key.clone());
    if key.trim().is_empty() {
        return Err("no assistant key yet — paste one first".to_string());
    }

    let url = llm_policy::models_url(&base);
    let started = Instant::now();
    let (status, body) = call(url, "GET", key, None).await?;
    let ms = started.elapsed().as_millis();
    if !(200..300).contains(&status) {
        crate::agent::audit(&app, "assistant.models", &base, status, ms);
        return Err(llm_policy::describe_status(status, &body));
    }
    crate::agent::audit(&app, "assistant.models", &base, status, ms);
    llm_policy::parse_models(&body)
}

/// 一次对话往返。
///
/// `messages` / `tools` 是 JSON **字符串**，不是结构体：消息的形状本来就是
/// OpenAI 的协议，多一层 Rust 结构体只是给它做个副本，还得跟着协议版本改。
/// 校验在这里做（`check_messages`），不合法就拒，不静默截断。
#[tauri::command]
pub async fn llm_chat(app: AppHandle, messages: String, tools: Option<String>) -> Result<serde_json::Value, String> {
    let (config, source) = resolved(&app);
    if config.api_key.trim().is_empty() {
        return Err("no assistant key yet — open Settings → AI assistant and paste one".to_string());
    }
    if config.model.trim().is_empty() {
        return Err("the assistant has no model configured — open Settings → AI assistant".to_string());
    }
    let base = llm_policy::normalize_base(&config.base_url)?;

    // 校验放在 policy 里（那边有测试），这里只负责"不合法的输入不进网络"
    llm_policy::check_messages(&messages)?;
    if let Some(tools) = tools.as_deref() {
        llm_policy::check_tools(tools)?;
    }

    let body = llm_policy::build_body(
        config.model.trim(),
        &messages,
        tools.as_deref(),
        config.temperature(),
        llm_policy::MAX_OUTPUT_TOKENS,
    );
    let url = llm_policy::chat_url(&base);

    let started = Instant::now();
    let (status, text) = call(url, "POST", config.api_key.clone(), Some(body)).await?;
    let ms = started.elapsed().as_millis();

    if !(200..300).contains(&status) {
        crate::agent::audit(&app, "assistant.chat", &format!("{} (HTTP {status})", config.model.trim()), status, ms);
        return Err(llm_policy::describe_status(status, &text));
    }

    let reply = llm_policy::parse_chat(&text)?;
    /*
     * 写一行审计：看板组件（`lattice.agent`）读的就是这份日志。
     *
     * 只记"模型说了几个字 / 要做几件事"，**不记内容** —— 用户的对话不该
     * 因为开了个审计开关就变成一份可读的聊天记录。工具的每一步由前端在
     * 执行时各自记（那个有 `op: act` 的现成通道）。
     */
    let detail = if reply.tool_calls.is_empty() {
        format!("{} · {} chars", config.model.trim(), reply.text.chars().count())
    } else {
        let names: Vec<&str> = reply.tool_calls.iter().map(|call| call.name.as_str()).collect();
        format!("{} · tools: {}", config.model.trim(), names.join(", "))
    };
    let _ = source; // 来源只影响界面提示，不进日志
    crate::agent::audit(&app, "assistant.chat", &detail, status, ms);

    // 用 Value 手拼，而不是给 policy 的结构体加 serde：那一层要保持
    // "不依赖任何 crate"（见 llm_policy.rs 的开头），序列化形状归这里
    Ok(serde_json::json!({
        "text": reply.text,
        "toolCalls": reply.tool_calls.iter().map(|call| serde_json::json!({
            "id": call.id,
            "name": call.name,
            "arguments": call.arguments,
        })).collect::<Vec<_>>(),
        "finish": reply.finish,
        "usage": reply.usage.map(|usage| serde_json::json!({
            "promptTokens": usage.prompt_tokens,
            "completionTokens": usage.completion_tokens,
        })),
    }))
}
