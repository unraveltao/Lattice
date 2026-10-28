//! assistant 的会话（0003）：**落盘**这一半。
//!
//! 0003 §1 的第一条是"对话只活在面板的一个 ref 里，退出应用就全没了"。这里把它
//! 变成一份份文件：
//!
//!   %APPDATA%\com.iron-tom.lattice\assistant-sessions\<id>.json
//!
//! # 五条约定
//!
//! - **一份会话一个文件**，不是一个大会话表。坏一份只坏那一份（`assistant_sessions`
//!   逐条 try，坏条目照样出现在列表里、可删不可加载），而"一个大会话表"是那种
//!   坏一个字段就整份读不出来的形状。
//! - **原子替换**：先写 `.tmp` 再改名（`state.rs` / `llm.rs` 同一条规矩）。
//! - **额度**在 `assistant_session_policy` 里判：50 份 / 200 条 / 1 MB。满了**拒绝
//!   新建**并提示删旧的 —— 自动删用户的东西是绝不能做的那一条（不变量 11 的近亲）。
//! - **明文**存。用户粘进对话的敏感内容会落到盘上，这件事界面和文档都要说出来，
//!   不能假装没有（0003 §3）。
//! - **`id` 就是文件名**，所以它只在 `assistant_session_policy::id_ok` 一个地方判，
//!   拼路径的那一行不许自己写规则。
//!
//! # 一条已知的例外
//!
//! 消息裁剪**至少留一条**（不然用户看到的是"这段对话空了"）。如果那一条自己就
//! 超过 1 MB（粘进来一整本书），文件会比额度大。宁可超，也不要静默改用户的正文。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::assistant_session_policy as policy;

/// 文件形状的版本。加字段时不用动它（`#[serde(default)]` 都兜得住），
/// 改字段的**含义**才动
const VERSION: u32 = 1;

/// 一次会话的 token 花销（面板把每轮的 `usage` 加总后存这里）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
}

/// 一份会话的完整形状（也就是磁盘上那个文件）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// 毫秒时间戳。**不是秒**：列表要按"昨天下午"排，秒够用但前端到处是毫秒
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// 存的时候用的哪个模型 —— 换档之后回头看老会话，得知道当时是谁答的
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub profile_id: String,
    /// 原样的 OpenAI 消息数组（含 `tool_calls` / `tool_call_id`），**不解释**：
    /// 少一层转译就少一处会和前端不一致的地方
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub usage: Usage,
    /// 上一次保存是不是丢过条目（界面据此显示"这条会话被截断"）
    #[serde(default)]
    pub truncated: bool,
}

/// 列表里的一行。**不带 messages**：50 份会话的全部正文一次读进内存，
/// 只为了画一个列表，那是白花几百毫秒
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    /// 坏文件的标题是空串 —— 界面自己说"损坏的会话"（Rust 不生成给人看的字，
    /// 见 AGENTS §8）
    pub title: String,
    pub updated_at: i64,
    pub message_count: usize,
    pub usage: Usage,
    /// 文件在、但解析不了：可删不可加载
    pub damaged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSaved {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub message_count: usize,
    /// 这次保存丢了几条（0 = 一条没丢）。**不静默**：界面要能说出来
    pub dropped: usize,
}

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not locate the config folder: {error}"))?
        .join("assistant-sessions");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create the sessions folder: {error}"))?;
    Ok(dir)
}

/// `id` → 文件路径。**唯一的入口**：谁要碰某个会话的文件都得从这儿过。
fn session_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !policy::id_ok(id) {
        return Err("that is not a session id".to_string());
    }
    Ok(sessions_dir(app)?.join(format!("{id}.json")))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// 现造一个 id。撞名就换一个后缀重试（同一秒里连开两个会话会撞）。
fn new_id(app: &AppHandle) -> Result<String, String> {
    for _ in 0..8 {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        let entropy = (now.as_nanos() as u64) ^ ((std::process::id() as u64) << 40);
        let suffix = policy::suffix_from(entropy);
        let Some(id) = policy::make_id(now.as_secs() as i64, &suffix) else {
            continue;
        };
        if !session_path(app, &id)?.exists() {
            return Ok(id);
        }
    }
    Err("could not generate a session id — try again".to_string())
}

/// 目录里现有几个会话文件（坏文件也算：它们同样占一个位置）
fn count_files(app: &AppHandle) -> Result<usize, String> {
    let dir = sessions_dir(app)?;
    let entries = std::fs::read_dir(&dir)
        .map_err(|error| format!("failed to list the sessions folder: {error}"))?;
    Ok(entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().map(|ext| ext == "json").unwrap_or(false))
        .count())
}

/// 读一份会话。**保留对象里的未知字段没有意义**（我们就是那份文件的写者），
/// 但**认不出来的消息原样留着** —— 裁剪与标题由 policy 判，见 `messages_to_lines`。
fn read_session(app: &AppHandle, id: &str) -> Option<Session> {
    let path = session_path(app, id).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let mut session = serde_json::from_str::<Session>(&text).ok()?;
    session.id = id.to_string();
    Some(session)
}

fn write_session(app: &AppHandle, session: &Session) -> Result<(), String> {
    let path = session_path(app, &session.id)?;
    let temp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(session)
        .map_err(|error| format!("failed to serialize the session: {error}"))?;
    std::fs::write(&temp, text.as_bytes())
        .map_err(|error| format!("failed to write the session: {error}"))?;
    std::fs::rename(&temp, &path)
        .map_err(|error| format!("failed to replace the session file: {error}"))?;
    Ok(())
}

/// 一条消息 → 纯逻辑那一侧的样子。
///
/// `bytes` 是它自己序列化之后的长度：裁剪要按**真实字节**判，
/// 用 `content.len()` 会漏掉 JSON 转义与工具调用那一大坨。
fn message_line(value: &Value) -> policy::Line {
    let role = value.get("role").and_then(|it| it.as_str()).unwrap_or_default().to_string();
    let text = match value.get("content") {
        Some(Value::String(text)) => text.clone(),
        // 多段正文（`[{type:"text",text:"…"}]`）折成一段，只用来判"有没有字"
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(|it| it.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    // 工具调用那条的 `content` 是 null：正文为空却**合法**
    let has_payload = value.get("tool_calls").map(|it| !it.is_null()).unwrap_or(false)
        || value.get("tool_call_id").map(|it| !it.is_null()).unwrap_or(false);
    policy::Line {
        ok: policy::role_ok(&role) && (!text.trim().is_empty() || has_payload),
        role,
        text,
        bytes: serde_json::to_string(value).map(|text| text.len()).unwrap_or(0),
    }
}

/// 列表：按 `updatedAt` 倒序。**逐条 try** —— 一个坏文件不许把整份列表读崩
/// （0003 §5 第二行）。
#[tauri::command]
pub fn assistant_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    let dir = sessions_dir(&app)?;
    let entries = std::fs::read_dir(&dir)
        .map_err(|error| format!("failed to list the sessions folder: {error}"))?;
    let mut summaries: Vec<SessionSummary> = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path.extension().map(|ext| ext != "json").unwrap_or(true) {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string) else {
            continue;
        };
        // 目录里手放进来的怪文件不该出现在界面上，也不该被当成可删的会话
        if !policy::id_ok(&id) {
            continue;
        }
        let summary = match std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Session>(&text).ok())
        {
            Some(session) => SessionSummary {
                id: id.clone(),
                title: session.title,
                updated_at: session.updated_at,
                message_count: session.messages.len(),
                usage: session.usage,
                damaged: false,
            },
            None => SessionSummary {
                id: id.clone(),
                title: String::new(),
                updated_at: entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_millis() as i64)
                    .unwrap_or(0),
                message_count: 0,
                usage: Usage::default(),
                damaged: true,
            },
        };
        summaries.push(summary);
    }
    summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(summaries)
}

#[tauri::command]
pub fn assistant_session_load(app: AppHandle, id: String) -> Result<Session, String> {
    read_session(&app, &id).ok_or_else(|| {
        "that session could not be read — it may be damaged; delete it and start a new one".to_string()
    })
}

/// 存一份会话。`id` 给了就是"更新那一份"，没给就是"新建"。
///
/// `messages` 是 **JSON 文本**（和 `llm_chat` 的参数同一条约定）：一份会话几千条
/// 消息，走一次 serde 反序列化比让前端拼一个嵌套结构稳。
#[tauri::command]
pub fn assistant_session_save(
    app: AppHandle,
    id: Option<String>,
    title: Option<String>,
    model: String,
    profile_id: Option<String>,
    messages: String,
    usage: Option<Usage>,
) -> Result<SessionSaved, String> {
    let raw = serde_json::from_str::<Value>(&messages)
        .map_err(|error| format!("the messages must be a JSON array: {error}"))?;
    let Value::Array(values) = raw else {
        return Err("the messages must be a JSON array".to_string());
    };

    let existing = id.as_deref().and_then(|id| read_session(&app, id));
    let target = match id.as_deref() {
        // 给了 id 就写那一份（就算文件不在 —— 那是"另存为这一份"，不是新建）
        Some(id) if policy::id_ok(id) => id.to_string(),
        Some(_) => return Err("that is not a session id".to_string()),
        None => {
            if count_files(&app)? >= policy::MAX_FILES {
                return Err(format!(
                    "you already have {} sessions — delete one before starting a new chat",
                    policy::MAX_FILES
                ));
            }
            new_id(&app)?
        }
    };

    let lines: Vec<policy::Line> = values.iter().map(message_line).collect();
    let created_at = existing
        .as_ref()
        .map(|session| session.created_at)
        .filter(|stamp| *stamp > 0)
        .unwrap_or_else(now_ms);
    let title = match title {
        Some(raw) => policy::clean_title(&raw),
        None => existing
            .as_ref()
            .map(|session| session.title.clone())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| policy::title_of(&lines)),
    };
    // 兜底标题**不落盘**：`"New chat"` 是一句给人看的话，该由界面按语言说
    // （Rust 不生成界面文案，见 AGENTS §8）。空串 = "还没有标题"，界面自己挑一句。
    let title = if title == policy::FALLBACK_TITLE { String::new() } else { title };

    // 额度：消息之外那一圈（id / 标题 / 时间 / usage）也占字节，先量出来再分给消息
    let mut session = Session {
        version: VERSION,
        id: target,
        title,
        created_at,
        updated_at: now_ms(),
        model,
        profile_id: profile_id.unwrap_or_default(),
        messages: Vec::new(),
        usage: usage.or(existing.as_ref().map(|session| session.usage)).unwrap_or_default(),
        truncated: false,
    };
    let envelope = serde_json::to_string(&session)
        .map_err(|error| format!("failed to serialize the session: {error}"))?
        .len();
    let budget = policy::MAX_BYTES.saturating_sub(envelope + 64);
    let (keep, dropped) = policy::keep_indices(&lines, budget);
    session.messages = keep.iter().map(|index| values[*index].clone()).collect();
    session.truncated = dropped > 0;

    write_session(&app, &session)?;
    Ok(SessionSaved {
        id: session.id,
        title: session.title,
        updated_at: session.updated_at,
        message_count: session.messages.len(),
        dropped,
    })
}

/// 只改标题：**不碰消息、也不动 `updatedAt`**（`0034` 的会话栏要能重命名）。
///
/// 为什么不让前端"读出来再存一遍"：`assistant_session_save` 会把 `updatedAt`
/// 写成现在，于是改个名字这份会话就跳到侧栏最上面 —— 用户想改的是名字，
/// 不是排序。另起一条命令只为一个字段，是因为那条副作用藏在"保存"这个词里，
/// 不写下来没人会想到。
#[tauri::command]
pub fn assistant_session_rename(app: AppHandle, id: String, title: String) -> Result<String, String> {
    let mut session = read_session(&app, &id)
        .ok_or_else(|| "that chat is not there anymore".to_string())?;
    let cleaned = policy::clean_title(&title);
    // 清空标题 = 交还给"按第一句话起名"，不是留一个空串在侧栏里
    session.title = if cleaned == policy::FALLBACK_TITLE { String::new() } else { cleaned };
    write_session(&app, &session)?;
    Ok(session.title)
}

/// 删一份会话。文件本来就不在也算成功（和 `state_clear` 同一条约定：
/// 用户点"删除"想要的是"它不在了"，不是"报一个 ENOENT 给我看"）
#[tauri::command]
pub fn assistant_session_delete(app: AppHandle, id: String) -> Result<(), String> {
    let path = session_path(&app, &id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to delete the session: {error}")),
    }
}
