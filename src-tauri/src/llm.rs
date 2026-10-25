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
//! # 为什么要"档"（profile）
//!
//! 一个人可能同时留着公司中转站和本机 Ollama。单档配置下，切一次要重粘一次 key、
//! 改一次地址，切回来再粘一次 —— 而本机模型压根不要 key，单档那条路连"配置好"
//! 都判不出来。所以 `assistant.json` 升到 v2：一条档 = 一个端点 + 自己的鉴权
//! 形状 + 自己的 key + 自己的模型。取舍见 `docs/design/0002-model-profiles.md`。
//!
//! # 谁在用
//!
//! - 主窗口的 assistant 面板（带 `tools`，能改桌面）
//! - 组件（**不带** `tools`，只说话；见 `runtime/bridge.ts` 的 `llm.chat`）
//! - 桌面上的 assistant 小窗（和面板共用同一份实现）

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

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

/// 出厂温度。0.6 是"能干活、又不会每句话都不一样"的经验值
const DEFAULT_TEMPERATURE: f64 = 0.6;

/// 磁盘上的一档。**key 和其它字段放同一个文件**：拆成两个文件不会更安全
/// （同一个目录、同一个账户），只会多一处"改了一半"的机会
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    base_url: String,
    /// `bearer` / `api-key-header` / `none`。存字符串而不是枚举：多一个值不用迁移
    #[serde(default)]
    auth: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    temperature: Option<f64>,
    /// 上次「测试连接」列出来的模型，只用来做下拉提示
    #[serde(default)]
    models: Vec<String>,
}

impl Profile {
    fn temperature(&self) -> f64 {
        self.temperature.unwrap_or(DEFAULT_TEMPERATURE).clamp(0.0, 2.0)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssistantConfig {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    active_id: String,
    #[serde(default)]
    profiles: Vec<Profile>,
}

/// v1 的形状：四个平铺字段。**只用来读**，写出去永远是 v2
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyConfig {
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default)]
    api_key: String,
}

/// 前端看到的一档。**没有 `apiKey` 字段**，只有掩码
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub auth: String,
    pub model: String,
    pub temperature: f64,
    pub models: Vec<String>,
    pub key_hint: String,
    pub configured: bool,
    pub key_source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesView {
    pub active_id: String,
    pub profiles: Vec<ProfileView>,
}

/// 保存一档之后的两样东西：**这次存的是哪一条**（新建时前端还不知道 id），
/// 以及刷新后的整份清单。合成一个返回值，省掉"存完再读一遍、靠 diff 猜 id"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProfile {
    pub id: String,
    pub view: ProfilesView,
}

/// 一次流式请求的取消标志登记表。**只存"还在飞的那几轮"**：命令结束时
/// （成功、失败、取消都一样）由 `CancelHandle` 的 Drop 摘掉，所以这里不会越攒越多。
fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 登记一条取消标志，离开作用域时自动摘掉 —— 手写"每个 return 前删一次"
/// 一定会漏掉一条，而漏掉的那条会让同名 id 下一次直接是"已被取消"。
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

/// 增量事件名。载荷带 `requestId`：`emit` 是广播（不变量 9），抽屉和桌面小窗
/// 可能同时各跑一轮，谁的字归谁只能靠这个 id 分
const DELTA_EVENT: &str = "lattice:llm-delta";

fn emit_delta(app: &AppHandle, request_id: &str, text: &str) {
    let _ = app.emit(
        DELTA_EVENT,
        serde_json::json!({ "requestId": request_id, "text": text }),
    );
}

/// 这次请求真正要用的那一份配置。`profile_id` 为空 = 当前那条档。
///
/// 环境变量只盖**当前这一档**：传了一个明确的 id 时，除非那正好是 active，
/// 否则不去碰它 —— "我设了 `LATTICE_LLM_KEY`，怎么另一条档也亮了"会是一个
/// 解释不清的状态。
fn prepare(app: &AppHandle, profile_id: Option<&str>) -> Result<Profile, String> {
    let config = read_config(app);
    let env = env_overrides();
    let wanted = profile_id.map(str::trim).filter(|value| !value.is_empty());

    let profile = match wanted {
        Some(id) => {
            if !llm_policy::profile_id_ok(id) {
                return Err("that is not a profile id".to_string());
            }
            if id == config.active_id {
                resolve_active(&config, &env).map(|(profile, _)| profile)
            } else {
                config.profiles.iter().find(|profile| profile.id == id).cloned()
            }
            .ok_or_else(|| "that profile is gone — reload the assistant".to_string())?
        }
        None => resolve_active(&config, &env)
            .map(|(profile, _)| profile)
            .ok_or_else(|| {
                "no model profile yet — open the assistant settings and add one".to_string()
            })?,
    };

    let auth = llm_policy::normalize_auth(&profile.auth);
    if auth != "none" && profile.api_key.trim().is_empty() {
        return Err(
            "no key for this profile yet — open the assistant settings and paste one".to_string(),
        );
    }
    if profile.model.trim().is_empty() {
        return Err("the assistant has no model configured — open the assistant settings".to_string());
    }
    Ok(profile)
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
        Ok(text) => parse_config(&text),
        // 坏文件不该让应用起不来，也不该把用户的 key 悄悄清掉 —— 读不出来就当没配。
        // **注意：这里绝不写回**（见 parse_config 的注释）
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

/// 把磁盘上的文本读成配置。**纯函数**（有单测）：v2 直接用，v1 就地迁移。
///
/// 读失败 / 坏档一律"当它没有"，但**不写回**：只有用户下一次保存才落盘。
/// 顺手写一次空配置的后果是"一次解析失败永久丢 key"，而 key 换不了。
fn parse_config(text: &str) -> AssistantConfig {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return AssistantConfig::default();
    };
    let mut config = if value.get("profiles").map(|it| it.is_array()).unwrap_or(false) {
        serde_json::from_value::<AssistantConfig>(value.clone()).unwrap_or_default()
    } else {
        migrate_legacy(&value)
    };
    normalize(&mut config);
    config
}

/// v1 → v2：包成一条档。地址不合法（比如以前存进去的明文 http 远程地址）就当没配。
fn migrate_legacy(value: &serde_json::Value) -> AssistantConfig {
    let Ok(old) = serde_json::from_value::<LegacyConfig>(value.clone()) else {
        return AssistantConfig::default();
    };
    let Ok(base) = llm_policy::normalize_base(&old.base_url) else {
        return AssistantConfig::default();
    };
    // v1 只有在 key 齐了时才算"配置好"，所以没有 key 的老文件基本是本机模型。
    // 迁成 `none` 而不是 `bearer`：本机模型挂一个空 Bearer 只会换来 401
    let auth = if old.api_key.trim().is_empty() { "none" } else { "bearer" };
    let profile = Profile {
        id: "p-legacy".to_string(),
        label: llm_policy::profile_label(&base),
        base_url: base,
        auth: auth.to_string(),
        api_key: old.api_key,
        model: old.model.trim().to_string(),
        temperature: old.temperature,
        models: Vec::new(),
    };
    AssistantConfig {
        version: 2,
        active_id: profile.id.clone(),
        profiles: vec![profile],
    }
}

/// 归一化：坏档逐条丢、名字补上、active 不能悬空。**原地改，不写盘**。
fn normalize(config: &mut AssistantConfig) {
    config.version = 2;

    let mut seen: Vec<String> = Vec::new();
    config.profiles.retain_mut(|profile| {
        if !llm_policy::profile_id_ok(&profile.id) {
            return false;
        }
        let Ok(base) = llm_policy::normalize_base(&profile.base_url) else {
            return false;
        };
        if seen.contains(&profile.id) {
            return false;
        }
        seen.push(profile.id.clone());
        profile.base_url = base;
        profile.auth = llm_policy::normalize_auth(&profile.auth).to_string();
        profile.model = profile.model.trim().to_string();
        if profile.label.trim().is_empty() {
            profile.label = llm_policy::profile_label(&profile.base_url);
        }
        // 列表最多留 40 个候选模型：它只是下拉提示，不是数据
        profile.models.truncate(40);
        true
    });

    if config.profiles.is_empty() {
        config.active_id.clear();
    } else if !config.profiles.iter().any(|profile| profile.id == config.active_id) {
        config.active_id = config.profiles[0].id.clone();
    }
}

/// 环境变量覆盖（CI 与临时试验）。**只作用于 active 那一档** —— 否则"我设了
/// `LATTICE_LLM_KEY`，怎么所有档都亮了"会变成一个解释不清的状态
#[derive(Default, Clone)]
struct EnvOverrides {
    base: Option<String>,
    model: Option<String>,
    key: Option<String>,
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_overrides() -> EnvOverrides {
    EnvOverrides {
        base: env_value("LATTICE_LLM_BASE_URL"),
        model: env_value("LATTICE_LLM_MODEL"),
        key: env_value("LATTICE_LLM_KEY"),
    }
}

/// 把 active 那一档和环境变量合成"这次真正要用的那一份"
fn resolve_active(config: &AssistantConfig, env: &EnvOverrides) -> Option<(Profile, &'static str)> {
    let profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == config.active_id)?
        .clone();
    let mut source = if profile.api_key.trim().is_empty() { "none" } else { "file" };
    let mut profile = profile;
    if let Some(base) = env.base.clone() {
        profile.base_url = base;
    }
    if let Some(model) = env.model.clone() {
        profile.model = model;
    }
    if let Some(key) = env.key.clone() {
        profile.api_key = key;
        source = "env";
    }
    Some((profile, source))
}

fn profile_view(profile: &Profile, source: &str) -> ProfileView {
    let base = llm_policy::normalize_base(&profile.base_url).unwrap_or_default();
    let has_key = !profile.api_key.trim().is_empty();
    let auth = llm_policy::normalize_auth(&profile.auth);
    ProfileView {
        id: profile.id.clone(),
        label: profile.label.clone(),
        base_url: profile.base_url.clone(),
        auth: auth.to_string(),
        model: profile.model.clone(),
        temperature: profile.temperature(),
        models: profile.models.clone(),
        key_hint: llm_policy::mask_key(&profile.api_key),
        // `none` 的档不看 key：本机模型就是没有 key 也该算配好了
        configured: !base.is_empty() && !profile.model.trim().is_empty() && (auth == "none" || has_key),
        key_source: source.to_string(),
    }
}

fn views(config: &AssistantConfig, env: &EnvOverrides) -> ProfilesView {
    let profiles = config
        .profiles
        .iter()
        .map(|stored| {
            if stored.id != config.active_id {
                let source = if stored.api_key.trim().is_empty() { "none" } else { "file" };
                return profile_view(stored, source);
            }
            match resolve_active(config, env) {
                Some((profile, source)) => profile_view(&profile, source),
                None => profile_view(stored, "none"),
            }
        })
        .collect();
    ProfilesView {
        active_id: config.active_id.clone(),
        profiles,
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn fresh_id(config: &AssistantConfig) -> String {
    let seed = now_millis();
    let mut serial = config.profiles.len() as u32 + 1;
    loop {
        let id = llm_policy::profile_id(seed, serial);
        if !config.profiles.iter().any(|profile| profile.id == id) {
            return id;
        }
        serial += 1;
    }
}

#[tauri::command]
pub fn llm_profiles(app: AppHandle) -> ProfilesView {
    let config = read_config(&app);
    views(&config, &env_overrides())
}

/// 存一档。`id` 为空 = 新建。**key 不走这里**：改个模型名不该要求用户重新粘 key
#[tauri::command]
pub fn llm_profile_save(
    app: AppHandle,
    id: Option<String>,
    label: String,
    base_url: String,
    auth: Option<String>,
    model: String,
    temperature: Option<f64>,
) -> Result<SavedProfile, String> {
    let base = llm_policy::normalize_base(&base_url)?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("the model name is empty".to_string());
    }
    let auth = llm_policy::normalize_auth(auth.as_deref().unwrap_or("bearer")).to_string();
    let label = label.trim().to_string();

    let mut config = read_config(&app);
    let saved_id = match id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        Some(id) => {
            if !llm_policy::profile_id_ok(&id) {
                return Err("that is not a profile id".to_string());
            }
            let profile = config
                .profiles
                .iter_mut()
                .find(|profile| profile.id == id)
                .ok_or_else(|| "that profile is gone — reload the assistant".to_string())?;
            profile.label = if label.is_empty() {
                llm_policy::profile_label(&base)
            } else {
                label
            };
            profile.base_url = base;
            profile.auth = auth;
            profile.model = model;
            profile.temperature = temperature.map(|value| value.clamp(0.0, 2.0));
            profile.models.clear();
            profile.id.clone()
        }
        None => {
            let id = fresh_id(&config);
            config.profiles.push(Profile {
                id: id.clone(),
                label: if label.is_empty() { llm_policy::profile_label(&base) } else { label },
                base_url: base,
                auth,
                api_key: String::new(),
                model,
                temperature: temperature.map(|value| value.clamp(0.0, 2.0)),
                models: Vec::new(),
            });
            if config.active_id.is_empty() {
                config.active_id = id.clone();
            }
            id
        }
    };

    write_config(&app, &config)?;
    Ok(SavedProfile {
        id: saved_id,
        view: views(&config, &env_overrides()),
    })
}

#[tauri::command]
pub fn llm_profile_remove(app: AppHandle, id: String) -> Result<ProfilesView, String> {
    if !llm_policy::profile_id_ok(&id) {
        return Err("that is not a profile id".to_string());
    }
    let mut config = read_config(&app);
    config.profiles.retain(|profile| profile.id != id);
    if config.active_id == id {
        config.active_id = config.profiles.first().map(|profile| profile.id.clone()).unwrap_or_default();
    }
    write_config(&app, &config)?;
    Ok(views(&config, &env_overrides()))
}

#[tauri::command]
pub fn llm_profile_activate(app: AppHandle, id: String) -> Result<ProfilesView, String> {
    if !llm_policy::profile_id_ok(&id) {
        return Err("that is not a profile id".to_string());
    }
    let mut config = read_config(&app);
    if !config.profiles.iter().any(|profile| profile.id == id) {
        return Err("that profile is gone — reload the assistant".to_string());
    }
    config.active_id = id;
    write_config(&app, &config)?;
    Ok(views(&config, &env_overrides()))
}

/// 存 / 清这一档的 key。空串表示"删掉"。存进去的**不再回传**，只回掩码
#[tauri::command]
pub fn llm_set_key(app: AppHandle, id: String, key: String) -> Result<ProfilesView, String> {
    if !llm_policy::profile_id_ok(&id) {
        return Err("that is not a profile id".to_string());
    }
    let trimmed = key.trim().to_string();
    // 粘进来时常常带换行和首尾空格；长度给个上限，别把整段剪贴板塞进文件
    if trimmed.chars().count() > 512 {
        return Err("that does not look like an API key (more than 512 characters)".to_string());
    }
    let mut config = read_config(&app);
    let profile = config
        .profiles
        .iter_mut()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "that profile is gone — reload the assistant".to_string())?;
    profile.api_key = trimmed;
    write_config(&app, &config)?;
    Ok(views(&config, &env_overrides()))
}

/// 节流：离上一次请求太近就返回要等多久。
///
/// 等待本身由调用方在阻塞线程里 `sleep` —— `thread::sleep` 放在异步线程上
/// 会占住一个 worker。流式那条路也要过这一道：它比整包请求更容易被写循环刷爆。
fn throttle() -> Result<Duration, String> {
    let mut last = last_call()
        .lock()
        .map_err(|_| "the assistant lock is poisoned".to_string())?;
    let now = Instant::now();
    let wait = last
        .map(|previous| MIN_GAP.saturating_sub(now.saturating_duration_since(previous)))
        .unwrap_or_default();
    *last = Some(now + wait);
    Ok(wait)
}

/// 把一次 HTTP 往返跑完，返回 (状态码, 响应体)。
///
/// 抽出来是因为 chat 和 models 两条路只有 URL、请求体、解析不一样，
/// 传输细节（超时、上限、错误翻译）必须一模一样。
async fn call(
    url: String,
    method: &'static str,
    auth: &str,
    key: &str,
    body: Option<String>,
) -> Result<(u16, String), String> {
    let target = parse_url(&url)?;
    let headers = request_headers(auth, key, "application/json");
    let payload = body.map(|text| text.into_bytes());
    let wait = throttle()?;

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

/// 拉模型列表。**这就是"测试连接"**：它 200，说明地址和鉴权都对。
///
/// 三种调用方式：
///   - 传 `baseUrl`（可能还没保存）：试一个草稿，试好了再存
///   - 传 `profileId`：用已存的那一档（key 由 Rust 读，前端看不见）
///   - 都不传：用 active 那一档
#[tauri::command]
pub async fn llm_models(
    app: AppHandle,
    profile_id: Option<String>,
    base_url: Option<String>,
    auth: Option<String>,
    key: Option<String>,
) -> Result<Vec<String>, String> {
    let config = read_config(&app);
    let env = env_overrides();

    let draft = base_url
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    // 存进缓存时要记住是哪一档（草稿不记 —— 它还没有 id）
    let mut remember: Option<String> = None;
    let (base, auth, key) = match draft {
        Some(raw) => {
            let base = llm_policy::normalize_base(&raw)?;
            let auth = llm_policy::normalize_auth(auth.as_deref().unwrap_or("bearer")).to_string();
            let mut key = key.unwrap_or_default().trim().to_string();
            // 改了地址但没重新粘 key：编辑已有的档时用存着的那一把
            if key.is_empty() {
                if let Some(id) = profile_id
                    .as_deref()
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .filter(|value| llm_policy::profile_id_ok(value))
                {
                    if let Some(profile) = config.profiles.iter().find(|profile| profile.id == id) {
                        key = profile.api_key.clone();
                        remember = Some(id.to_string());
                    }
                }
            }
            (base, auth, key)
        }
        None => {
            let wanted = profile_id
                .as_deref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let stored = match wanted.as_deref() {
                Some(id) => {
                    if !llm_policy::profile_id_ok(id) {
                        return Err("that is not a profile id".to_string());
                    }
                    config.profiles.iter().find(|profile| profile.id == id).cloned()
                }
                None => None,
            };
            let (profile, _) = match stored {
                Some(profile) => {
                    remember = Some(profile.id.clone());
                    let source = if profile.api_key.trim().is_empty() { "none" } else { "file" };
                    (profile, source)
                }
                None => resolve_active(&config, &env)
                    .ok_or_else(|| "no model profile yet — add one in the assistant settings".to_string())?,
            };
            let base = llm_policy::normalize_base(&profile.base_url)?;
            let auth = llm_policy::normalize_auth(&profile.auth).to_string();
            (base, auth, profile.api_key)
        }
    };

    if llm_policy::normalize_auth(&auth) != "none" && key.trim().is_empty() {
        return Err("no key for this profile yet — paste one first".to_string());
    }

    let url = llm_policy::models_url(&base);
    let started = Instant::now();
    let (status, body) = call(url, "GET", &auth, &key, None).await?;
    let ms = started.elapsed().as_millis();
    if !(200..300).contains(&status) {
        crate::agent::audit(&app, "assistant.models", &base, status, ms);
        return Err(llm_policy::describe_status(status, &body));
    }
    crate::agent::audit(&app, "assistant.models", &base, status, ms);

    let models = llm_policy::parse_models(&body)?;
    // 记住了下次就能做下拉提示；写盘失败不影响这次的结果
    if let Some(id) = remember {
        let mut config = read_config(&app);
        if let Some(profile) = config.profiles.iter_mut().find(|profile| profile.id == id) {
            profile.models = models.iter().take(40).cloned().collect();
            let _ = write_config(&app, &config);
        }
    }
    Ok(models)
}

fn request_headers(auth: &str, key: &str, accept: &str) -> Vec<(String, String)> {
    let mut headers = vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("accept".to_string(), accept.to_string()),
    ];
    if let Some((name, value)) = llm_policy::auth_header(auth, key) {
        headers.push((name.to_string(), value));
    }
    headers
}

/// 一次对话往返（整包）。
///
/// `messages` / `tools` 是 JSON **字符串**，不是结构体：消息的形状本来就是
/// OpenAI 的协议，多一层 Rust 结构体只是给它做个副本，还得跟着协议版本改。
/// 校验在这里做（`check_messages`），不合法就拒，不静默截断。
#[tauri::command]
pub async fn llm_chat(
    app: AppHandle,
    messages: String,
    tools: Option<String>,
    profile_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let profile = prepare(&app, profile_id.as_deref())?;
    let auth = llm_policy::normalize_auth(&profile.auth);
    let base = llm_policy::normalize_base(&profile.base_url)?;

    // 校验放在 policy 里（那边有测试），这里只负责"不合法的输入不进网络"
    llm_policy::check_messages(&messages)?;
    if let Some(tools) = tools.as_deref() {
        llm_policy::check_tools(tools)?;
    }

    let body = llm_policy::build_body(
        profile.model.trim(),
        &messages,
        tools.as_deref(),
        profile.temperature(),
        llm_policy::MAX_OUTPUT_TOKENS,
        false,
    );
    let url = llm_policy::chat_url(&base);

    let started = Instant::now();
    let (status, text) = call(url, "POST", auth, &profile.api_key, Some(body)).await?;
    let ms = started.elapsed().as_millis();

    if !(200..300).contains(&status) {
        crate::agent::audit(&app, "assistant.chat", &format!("{} (HTTP {status})", profile.model.trim()), status, ms);
        return Err(llm_policy::describe_status(status, &text));
    }

    let reply = llm_policy::parse_chat(&text)?;
    audit_reply(&app, &profile.model, &reply, status, ms, None);

    // 用 Value 手拼，而不是给 policy 的结构体加 serde：那一层要保持
    // "不依赖任何 crate"（见 llm_policy.rs 的开头），序列化形状归这里
    Ok(reply_json(&reply))
}

/// 审计一行。只记"模型说了几个字 / 要做几件事"，**不记内容** —— 用户的对话
/// 不该因为开了个审计开关就变成一份可读的聊天记录。
fn audit_reply(
    app: &AppHandle,
    model: &str,
    reply: &llm_policy::ChatReply,
    status: u16,
    ms: u128,
    stopped: Option<usize>,
) {
    let model = model.trim();
    let detail = if !reply.tool_calls.is_empty() {
        let names: Vec<&str> = reply.tool_calls.iter().map(|call| call.name.as_str()).collect();
        format!("{model} · tools: {}", names.join(", "))
    } else if let Some(chars) = stopped {
        format!("{model} · stopped after {chars} chars")
    } else {
        format!("{model} · {} chars", reply.text.chars().count())
    };
    crate::agent::audit(app, "assistant.chat", &detail, status, ms);
}

fn reply_json(reply: &llm_policy::ChatReply) -> serde_json::Value {
    serde_json::json!({
        "text": reply.text,
        "toolCalls": reply.tool_calls.iter().map(|call| serde_json::json!({
            "id": call.id,
            "name": call.name,
            "arguments": call.arguments,
        })).collect::<Vec<_>>(),
        "finish": reply.finish,
        "usage": reply.usage.as_ref().map(|usage| serde_json::json!({
            "promptTokens": usage.prompt_tokens,
            "completionTokens": usage.completion_tokens,
        })),
    })
}

/// 一轮**流式**对话。
///
/// 形状和 `llm_chat` 一样（结束时返回拼好的整条消息），区别只在过程中会往
/// `lattice:llm-delta` 上推增量。三条：
///
/// 1. **增量只是"让用户先看见字"**，权威结果仍然是这个命令的返回值。所以
///    前端不会拿增量拼出最终消息 —— 它只在气泡里滚，最后用返回的那份覆盖。
/// 2. **工具参数不进事件**。SSE 里它的参数是分片的，拼到一半的 JSON 对界面
///    没有意义（也没法解析）；按 `index` 拼完整后随返回值一次回来。
/// 3. **取消靠 1 秒读超时 + 标志位**，不是关句柄。见 `network::stream`。
#[tauri::command]
pub async fn llm_chat_stream(
    app: AppHandle,
    request_id: String,
    messages: String,
    tools: Option<String>,
    profile_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let request_id = request_id.trim().to_string();
    if !llm_policy::request_id_ok(&request_id) {
        return Err("that is not a request id".to_string());
    }
    let profile = prepare(&app, profile_id.as_deref())?;
    let auth = llm_policy::normalize_auth(&profile.auth);
    let base = llm_policy::normalize_base(&profile.base_url)?;

    llm_policy::check_messages(&messages)?;
    if let Some(tools) = tools.as_deref() {
        llm_policy::check_tools(tools)?;
    }

    let body = llm_policy::build_body(
        profile.model.trim(),
        &messages,
        tools.as_deref(),
        profile.temperature(),
        llm_policy::MAX_OUTPUT_TOKENS,
        true,
    );
    let url = llm_policy::chat_url(&base);
    let headers = request_headers(auth, &profile.api_key, "text/event-stream");
    let wait = throttle()?;

    let (cancel, _handle) = register_cancel(&request_id);
    let started = Instant::now();
    let app_for_read = app.clone();
    let id_for_read = request_id.clone();
    let model = profile.model.trim().to_string();

    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<(llm_policy::ChatReply, u16, Option<usize>), String> {
        let target = parse_url(&url)?;
        let payload = body.into_bytes();
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }

        let mut sse = llm_policy::SseBuffer::new();
        let mut acc = llm_policy::StreamAcc::new();
        // 攒一会儿再发：一个字一个事件 = 一次 IPC + 一次 React 重渲染
        let mut pending = String::new();
        let mut last_emit = Instant::now();
        let mut frames = 0usize;
        let mut failure: Option<String> = None;

        let response = {
            let mut on_chunk = |piece: &[u8]| -> bool {
                let mut payloads: Vec<String> = Vec::new();
                sse.push(piece, &mut payloads);
                for payload in payloads {
                    frames += 1;
                    match acc.apply(&payload) {
                        Ok(Some(text)) => pending.push_str(&text),
                        Ok(None) => {}
                        Err(message) => {
                            failure = Some(message);
                            return false;
                        }
                    }
                    if acc.done {
                        break;
                    }
                }
                if !pending.is_empty()
                    && (pending.chars().count() >= 24 || last_emit.elapsed() >= Duration::from_millis(60))
                {
                    let text = std::mem::take(&mut pending);
                    emit_delta(&app_for_read, &id_for_read, &text);
                    last_emit = Instant::now();
                }
                failure.is_none() && !acc.done
            };
            let mut on_idle = || -> bool { !cancel.load(Ordering::SeqCst) };
            let mut sink = network::StreamSink {
                chunk: &mut on_chunk,
                idle: &mut on_idle,
            };
            network::stream(
                &target,
                "POST",
                &headers,
                Some(&payload),
                llm_policy::MAX_RESPONSE_BYTES,
                &mut sink,
            )
        }
        .map_err(|error| llm_policy::describe_failure(&error))?;

        if !response.ok {
            // 错误响应是普通 JSON，不是事件流：原样的 `describe_status` 才说得清
            let text = String::from_utf8_lossy(&response.body).to_string();
            return Err(llm_policy::describe_status(response.status, &text));
        }
        if response.truncated {
            return Err("the provider's response was too large to read".to_string());
        }
        if let Some(message) = failure {
            return Err(message);
        }

        // 流结束时最后一条可能没等到空行
        if let Some(tail) = sse.flush() {
            frames += 1;
            acc.apply(&tail)?;
        }
        if !pending.is_empty() {
            emit_delta(&app_for_read, &id_for_read, &pending);
        }

        // 有的中转站会无视 `stream: true`，直接回一整包 JSON。那就按整包读 ——
        // 否则界面上一片空白，而错误也没有任何地方能冒出来
        let reply = if frames == 0 {
            let text = String::from_utf8_lossy(&response.body).to_string();
            llm_policy::parse_chat(&text).unwrap_or_else(|_| acc.finish_reply())
        } else {
            acc.finish_reply()
        };

        // 用户按了停止（不是 `[DONE]`）：记一下停在第几个字
        let stopped = if response.cancelled && !acc.done {
            Some(reply.text.chars().count())
        } else {
            None
        };
        Ok((reply, response.status, stopped))
    })
    .await
    .map_err(|error| format!("the request task failed: {error}"))??;

    let (reply, status, stopped) = outcome;
    audit_reply(&app, &model, &reply, status, started.elapsed().as_millis(), stopped);
    Ok(reply_json(&reply))
}

/// 叫停一轮流式对话。**幂等**：那一轮已经结束（或者 id 已经不存在）时返回
/// `false`，界面不用把它当错误。
#[tauri::command]
pub fn llm_chat_cancel(request_id: String) -> bool {
    let Ok(map) = cancels().lock() else {
        return false;
    };
    match map.get(request_id.trim()) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    /*
     * 这几条要 `cargo test`（`llm_policy.rs` 那 25 条才能用 `rustc --test` 单跑）：
     * 迁移与归一化要读 JSON，而那一层刻意不引 serde。本机跑不了 `cargo test`
     * 的机器上，这里靠"读代码 + 真机验"兜着（见 AGENTS §11）。
     */
    use super::*;

    #[test]
    fn a_v1_file_becomes_one_profile() {
        let config = parse_config(
            r#"{"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat",
                "temperature":0.4,"apiKey":"sk-abc"}"#,
        );
        assert_eq!(config.version, 2);
        assert_eq!(config.profiles.len(), 1);
        assert_eq!(config.active_id, "p-legacy");
        let profile = &config.profiles[0];
        assert_eq!(profile.base_url, "https://api.deepseek.com/v1");
        assert_eq!(profile.model, "deepseek-chat");
        assert_eq!(profile.api_key, "sk-abc");
        assert_eq!(profile.auth, "bearer");
        assert_eq!(profile.label, "api.deepseek.com");
    }

    #[test]
    fn a_v1_file_without_a_key_is_a_local_model() {
        let config = parse_config(r#"{"baseUrl":"http://127.0.0.1:11434/v1","model":"llama3"}"#);
        assert_eq!(config.profiles[0].auth, "none");
        assert_eq!(config.profiles[0].label, "Local model");
    }

    #[test]
    fn bad_profiles_are_dropped_one_by_one() {
        let config = parse_config(
            r#"{"version":2,"activeId":"p-1","profiles":[
                {"id":"p-1","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat"},
                {"id":"nope","baseUrl":"https://api.example.com/v1","model":"x"},
                {"id":"p-2","baseUrl":"http://api.example.com/v1","model":"x"},
                {"id":"p-3","baseUrl":"https://api.example.com/v1","model":"x"},
                {"id":"p-3","baseUrl":"https://api.example.com/v2","model":"x"}]}"#,
        );
        let ids: Vec<&str> = config.profiles.iter().map(|profile| profile.id.as_str()).collect();
        assert_eq!(ids, ["p-1", "p-3"]);
        assert_eq!(config.profiles[0].label, "api.deepseek.com");
    }

    #[test]
    fn a_dangling_active_id_falls_back_to_the_first_profile() {
        let config = parse_config(
            r#"{"version":2,"activeId":"p-9","profiles":[
                {"id":"p-1","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat"}]}"#,
        );
        assert_eq!(config.active_id, "p-1");
    }

    #[test]
    fn a_broken_file_is_empty_but_never_rewritten() {
        // parse_config 只读不写 —— 这条断言的是"读坏不许变成写空"这个约定
        assert!(parse_config("{not json").profiles.is_empty());
        assert!(parse_config("{}").profiles.is_empty());
    }

    #[test]
    fn none_auth_needs_no_key_to_be_configured() {
        let profile = Profile {
            id: "p-1".into(),
            label: "Local model".into(),
            base_url: "http://127.0.0.1:11434/v1".into(),
            auth: "none".into(),
            model: "llama3".into(),
            ..Profile::default()
        };
        assert!(profile_view(&profile, "none").configured);

        let remote = Profile {
            auth: "bearer".into(),
            ..profile
        };
        assert!(!profile_view(&remote, "none").configured);
    }
}
