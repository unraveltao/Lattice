//! 平台级的模型对话（桥方法 `llm.chat`）。
//!
//! # 为什么这件事必须在 Rust 侧
//!
//! 组件是不可信代码：它有 `storage` 就能读到自己的整份数据，有 `network` 就能把
//! 任何字符串发出去。所以**密钥绝不能进组件包**，也不能进组件能读到的任何地方。
//! 正确形状是反过来：密钥留在平台手里（DPAPI 加密落盘，只有本用户的账户能解），
//! 组件只能请求"把这几句话发给模型，把答复给我"。
//!
//! 组件**也决定不了发给谁**：URL 只来自平台设置（`base`），不从请求里读。
//! 否则一个拿到 `llm` 权限的组件只要把 base 指到自己的服务器，"帮你聊天"就变成
//! "把你的密钥和对话一起寄给我" —— 而密钥就在 Authorization 头里。
//!
//! # 和 `agent.rs` 的分工
//!
//! `agent.rs` 是**外面**的 agent 调**平台**（回环 HTTP + 令牌 + 审计，桌面做执行器）；
//! 这里是**组件**调**模型**（`llm.chat`，平台做代理）。两条路不共用代码：
//! 一条是"谁能动我的桌面"，一条是"谁在替我说话"。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::network;
use crate::network_policy;

/// 官方地址。用户可以在设置里换（镜像、代理），但**组件不能**。
const DEFAULT_BASE: &str = "https://api.deepseek.com";

// 上限、模型白名单、失败文案都在 `llm_policy` 里 —— 那部分不依赖运行时，
// 能用 `rustc --test` 单独跑。这里只留"必须连到真实世界才能做"的事。
use crate::llm_policy::{
    is_allowed_model, DEFAULT_MODEL, MAX_MESSAGES, MAX_TOKENS, MIN_INTERVAL_MS,
};

const CHAT_PATH: &str = "/chat/completions";
/// 生成类的响应允许慢一点：解析 / 连接 / 发送 / 接收
const TIMEOUTS: (u32, u32, u32, u32) = (8_000, 8_000, 15_000, 60_000);
/// 一次回复的响应体上限。正常几 KB，1MB 已经够离谱了
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// 落盘的配置。`apiKey` 只在进程内出现，写盘前整个结构会过一遍 DPAPI。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LlmConfig {
    pub api_key: String,
    pub model: String,
    pub base: String,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            model: DEFAULT_MODEL.to_string(),
            base: DEFAULT_BASE.to_string(),
        }
    }
}

/// 前端能看到的配置（**不含密钥本体**，只告诉它配没配）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    pub configured: bool,
    pub model: String,
    pub base: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
    pub model: String,
    pub usage: ChatUsage,
}

/// 进程内的节流状态。只活在内存里：重启之后立刻能用是预期行为
#[derive(Default)]
pub struct Llm {
    config: Mutex<Option<LlmConfig>>,
    last_call: Mutex<Option<Instant>>,
    in_flight: Mutex<bool>,
}

impl Llm {
    /// 惰性加载：第一次用到才读盘，避免启动路径上多一次文件 + DPAPI
    fn config(&self, app: &AppHandle) -> LlmConfig {
        if let Ok(guard) = self.config.lock() {
            if let Some(config) = guard.as_ref() {
                return config.clone();
            }
        }
        let loaded = load(app).unwrap_or_default();
        if let Ok(mut guard) = self.config.lock() {
            *guard = Some(loaded.clone());
        }
        loaded
    }

    fn store(&self, app: &AppHandle, config: LlmConfig) -> Result<(), String> {
        save(app, &config)?;
        if let Ok(mut guard) = self.config.lock() {
            *guard = Some(config);
        }
        Ok(())
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the config directory: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("failed to create the config directory: {error}"))?;
    Ok(dir.join("llm.bin"))
}

fn load(app: &AppHandle) -> Result<LlmConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(LlmConfig::default());
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("failed to read the assistant settings: {error}"))?;
    if bytes.is_empty() {
        return Ok(LlmConfig::default());
    }
    let plain = unprotect(&bytes)?;
    let mut config: LlmConfig = serde_json::from_slice(&plain)
        .map_err(|error| format!("the assistant settings are unreadable: {error}"))?;
    // 地址和模型都夹一遍：文件是能被人手改的，别让一个坏值变成"每次调用都失败"
    if config.base.trim().is_empty() {
        config.base = DEFAULT_BASE.to_string();
    }
    if !is_allowed_model(&config.model) {
        config.model = DEFAULT_MODEL.to_string();
    }
    Ok(config)
}

fn save(app: &AppHandle, config: &LlmConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let plain = serde_json::to_vec(config).map_err(|error| format!("failed to encode the settings: {error}"))?;
    let sealed = protect(&plain)?;
    // 临时文件 + 原子替换：写到一半断电不会留下半截密文（读的时候解不开 = 用不了）
    let temp = path.with_extension("bin.tmp");
    std::fs::write(&temp, &sealed).map_err(|error| format!("failed to write the assistant settings: {error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("failed to replace the assistant settings: {error}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// DPAPI：只给当前 Windows 账户能解。
// 这不是"加密以后就安全了"—— 明文密钥在进程内存里，能被调试器读到；它挡的是
// "把 llm.bin 拷到别的机器 / 别的账户上用"，以及顺手翻 AppData 的人。
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: 入参指针指向本次调用期间有效的切片；输出由系统分配，下面 LocalFree 释放
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("failed to encrypt the assistant settings (DPAPI)".to_string());
    }
    // SAFETY: 成功时 pbData/cbData 由系统填写，拷贝出来再释放
    let sealed = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(sealed)
}

#[cfg(windows)]
fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: sealed.len() as u32,
        pbData: sealed.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: 同 protect
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        // 换过 Windows 账户 / 拷过来的文件会走到这里：当成"没配"，让用户重填
        return Err("the assistant settings cannot be decrypted on this account".to_string());
    }
    // SAFETY: 同上
    let plain = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(plain)
}

#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    Ok(sealed.to_vec())
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

fn status_of(config: &LlmConfig) -> LlmStatus {
    LlmStatus {
        configured: !config.api_key.trim().is_empty(),
        model: config.model.clone(),
        base: config.base.clone(),
    }
}

#[tauri::command]
pub fn llm_status(app: AppHandle, llm: State<'_, Llm>) -> LlmStatus {
    status_of(&llm.config(&app))
}

/// 存设置。`apiKey` 传空串 = 清掉（换机器、换钥匙都走这条）。
#[tauri::command]
pub fn llm_set_config(
    app: AppHandle,
    llm: State<'_, Llm>,
    api_key: Option<String>,
    model: Option<String>,
    base: Option<String>,
) -> Result<LlmStatus, String> {
    let mut config = llm.config(&app);

    if let Some(key) = api_key {
        let key = key.trim().to_string();
        // 只做形状检查，不验真伪 —— 验真伪要发一次请求，那是"测试连接"的事
        if !key.is_empty() && !(key.len() >= 8 && key.len() <= 200 && !key.contains(['\r', '\n', ' '])) {
            return Err("an API key looks like a single word of 8-200 characters".to_string());
        }
        config.api_key = key;
    }

    if let Some(model) = model {
        if !is_allowed_model(&model) {
            return Err(format!("unsupported model \"{model}\""));
        }
        config.model = model;
    }

    if let Some(base) = base {
        let base = base.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            config.base = DEFAULT_BASE.to_string();
        } else {
            // 只允许 https（本机调试走 LATTICE_LLM_BASE，不走这个字段）
            if !base.starts_with("https://") {
                return Err("the assistant endpoint must start with https://".to_string());
            }
            network_policy::parse_url(&format!("{base}{CHAT_PATH}"))
                .map_err(|error| format!("invalid assistant endpoint: {error}"))?;
            config.base = base;
        }
    }

    llm.store(&app, config.clone())?;
    Ok(status_of(&config))
}

/// 真实的地址：设置里的 base，或测试用的环境变量。
///
/// `LATTICE_LLM_BASE` 只给开发和自动化测试用（指向本地假服务），
/// 写进设置界面的按钮就是另一回事了 —— 那等于教用户把密钥交给任意主机。
fn endpoint(config: &LlmConfig) -> String {
    let base = std::env::var("LATTICE_LLM_BASE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.base.clone());
    format!("{}{CHAT_PATH}", base.trim_end_matches('/'))
}

/// 一次对话。**阻塞**在 HTTP 上，所以是 async 命令（Tauri 会把它丢到运行时线程池）。
#[tauri::command]
pub async fn llm_chat(
    app: AppHandle,
    llm: State<'_, Llm>,
    request: ChatRequest,
) -> Result<ChatReply, String> {
    let config = llm.config(&app);
    if config.api_key.trim().is_empty() {
        return Err("no assistant key is configured; open Settings and add one".to_string());
    }

    if request.messages.is_empty() {
        return Err("no messages were sent".to_string());
    }
    if request.messages.len() > MAX_MESSAGES {
        return Err(format!("at most {MAX_MESSAGES} messages per request"));
    }

    let mut total = 0usize;
    let mut messages = Vec::with_capacity(request.messages.len());
    for message in &request.messages {
        let role = llm_policy::parse_role(&message.role)
            .ok_or_else(|| format!("unknown message role \"{}\"", message.role))?;
        // 只有空白就跳过（不是错误）；超长则**拒绝**，和前端一个行为
        let content = llm_policy::trimmed(&message.content);
        if content.is_empty() {
            continue;
        }
        llm_policy::check_message_chars(content)?;
        total += content.chars().count();
        messages.push(serde_json::json!({ "role": role, "content": content }));
    }
    if messages.is_empty() {
        return Err("every message was empty".to_string());
    }
    llm_policy::check_total_chars(total)?;

    // 一次只许一条在飞。组件连点两下不该变成两条并发的请求
    {
        let mut in_flight = llm.in_flight.lock().map_err(|_| "the assistant is busy")?;
        if *in_flight {
            return Err("the assistant is still answering the previous question".to_string());
        }
        *in_flight = true;
    }
    // 无论后面怎么返回都要把闸放开，所以用一个守卫
    struct InFlight<'a>(&'a Mutex<bool>);
    impl Drop for InFlight<'_> {
        fn drop(&mut self) {
            if let Ok(mut guard) = self.0.lock() {
                *guard = false;
            }
        }
    }
    let _guard = InFlight(&llm.in_flight);

    // 节流：两次请求之间至少 MIN_INTERVAL。
    // 组件是被动调用的，做一个防抖就够；真正的上限在平台的余额页上。
    //
    // 这里的 `sleep` 必须搬到阻塞线程池：这是一个 `async fn`，在它里面直接
    // `std::thread::sleep` 会把 tokio 的一个 worker 线程按住 —— 0.7 秒内所有
    // 定时器、别的命令都跟着晚。锁也只在这段里拿，不能跨 `.await`。
    let wait = match llm.last_call.lock() {
        Ok(last) => last.map(|at| at.elapsed()),
        Err(_) => None,
    };
    if let Some(elapsed) = wait.filter(|elapsed| *elapsed < Duration::from_millis(MIN_INTERVAL_MS)) {
        let remaining = Duration::from_millis(MIN_INTERVAL_MS).saturating_sub(elapsed);
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(remaining)).await;
    }

    let url = endpoint(&config);
    let target = network_policy::parse_url(&url)?;

    let temperature = request.temperature.unwrap_or(1.0).clamp(0.0, 2.0);
    let payload = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": false,
        "temperature": temperature,
        "max_tokens": MAX_TOKENS,
    });
    let body = serde_json::to_vec(&payload).map_err(|error| format!("failed to encode the request: {error}"))?;

    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
        // 密钥只在这一次请求里出现，不进日志、不进任何事件载荷
        ("Authorization".to_string(), format!("Bearer {}", config.api_key)),
    ];

    // 网络是阻塞的：放到阻塞线程池，别占着 async 运行时
    let response = tauri::async_runtime::spawn_blocking(move || {
        network::send_with_timeouts(&target, "POST", &headers, Some(&body), MAX_RESPONSE_BYTES, TIMEOUTS)
    })
    .await
    .map_err(|error| format!("the assistant request was cancelled: {error}"))??;

    if let Ok(mut last) = llm.last_call.lock() {
        *last = Some(Instant::now());
    }

    let text = String::from_utf8_lossy(&response.body).to_string();

    if !response.ok {
        return Err(describe_failure(response.status, &text));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("the model returned something that is not JSON: {error}"))?;

    let answer = parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if answer.is_empty() {
        return Err("the model returned an empty answer".to_string());
    }

    Ok(ChatReply {
        text: answer,
        model: parsed["model"].as_str().unwrap_or(&config.model).to_string(),
        usage: ChatUsage {
            prompt_tokens: parsed["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
            completion_tokens: parsed["usage"]["completion_tokens"].as_u64().unwrap_or(0),
        },
    })
}

/// 把服务端的 `{"error":{"message":...}}` 摘出来，交给 `llm_policy` 措辞。
///
/// 拆成两半是因为：摘 JSON 要 serde（`rustc --test` 跑不起来），措辞不要 ——
/// 而措辞才是会被改来改去、会被产品挑毛病的那一半。401 的措辞单独说清楚：
/// 那是最常见的一类失败，而"你的 key 不对"和"网络不通"在界面上的下一步动作
/// 完全不同。
fn describe_failure(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| llm_policy::clip_detail(body));
    llm_policy::failure_message(status, &message)
}
