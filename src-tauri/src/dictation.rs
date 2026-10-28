//! 听写：系统语音语言 → WinRT 本地识别 → 字交回面板 / 打进前台窗口。
//!
//! 设计在 [docs/design/0027-voice-dictation.md](../docs/design/0027-voice-dictation.md)。
//! 这里只落三件事：**识别器**、**六个命令**、**一条事件**。
//!
//! # 为什么结果走事件而不是命令返回值
//!
//! `RecognizeAsync()` 要阻塞到用户说完（几秒），而"用户按停"必须能从**另一个
//! 地方**调得动（它调 `StopRecognitionAsync()` 让那次阻塞提前返回）。所以
//! `dictation_start` 只回"开麦了"，字从 `lattice:dictation` 里来。
//!
//! # 为什么状态只有一份（都在这里）
//!
//! 浮钮和面板都是订阅者，谁也不许自己推断"现在是不是在听"。两处各自维护一份
//! 状态的症状不是报错，是"浮钮亮着、面板里没反应"（0027 §5 最后一行）。
//!
//! # 语言：能设，不只是能读
//!
//! 0027 §7① 写的是"这个 crate 版本的 `SpeechRecognizer` 没有语言 setter，
//! `new()` 一律用系统语音语言"。`windows 0.62.2` 其实有 `SpeechRecognizer::Create(language)`
//! （`SpeechRecognition/mod.rs` 第 1411 行）—— 所以这里先试系统语言，不是中文就
//! 在 `SupportedTopicLanguages()` 里找一个 `zh-*`；都没有才判"不是中文"。
//! 判据仍然是纯函数（`dictation_policy::pick_language`），WinRT 那半只负责把
//! 两个列表喂进去。
//!
//! # 不开麦的时候什么都不碰
//!
//! `dictation.json` 的 `enabled` 默认 `false`，和 agent 端点同一条规矩：关着就
//! 不建浮钮、不注册热键、不碰麦克风。`dictation_status` 可以随时问 —— 它只读
//! 系统语音语言，不开设备。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{HSTRING, Interface};
use windows::Foundation::TimeSpan;
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    SpeechRecognitionScenario, SpeechRecognitionTopicConstraint, SpeechRecognitionResultStatus,
    SpeechRecognizer,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::dictation_policy as policy;

/// 结果事件的名字。两个入口（面板 / 浮钮）和三个命令都只认这一条
pub const EVENT: &str = "lattice:dictation";

/// 设置文件名（`app_config_dir` 下）
const CONFIG_FILE: &str = "dictation.json";

/// 停顿时长：说完了 1 秒没声音就收尾。
///
/// 太长（默认 5 秒）会让用户以为"按了没反应"；太短会把一句话从逗号处切断。
/// 1 秒是 Windows 自己那套听写用的量级。
const END_SILENCE: TimeSpan = TimeSpan {
    Duration: 10_000_000,
};

/// 字交给谁
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// 面板：把字从事件里交回去，由 JS 追加到输入框
    Panel,
    /// 系统级：`SendInput` 打进开听时那个前台窗口
    System,
}

impl Target {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "panel" => Ok(Target::Panel),
            "system" => Ok(Target::System),
            other => Err(format!(
                "\"target\" must be \"panel\" or \"system\", not \"{other}\""
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Target::Panel => "panel",
            Target::System => "system",
        }
    }
}

/// 现在在做什么。**只有这三态**（0027 §5 最后一行：任何分支都要回 idle）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Listening,
}

struct Live {
    phase: Phase,
    target: Target,
    /// 开听那一刻的前台窗口（`system` 那条的焦点判据）
    window: isize,
    /// 已经识别出来、还没交出去的字
    text: String,
    /// 用户按了停。识别循环下一轮就收尾
    stopping: bool,
    /// 用户按了取消。收尾时一个字都不交
    cancelling: bool,
}

impl Live {
    const fn idle() -> Self {
        Self {
            phase: Phase::Idle,
            target: Target::Panel,
            window: 0,
            text: String::new(),
            stopping: false,
            cancelling: false,
        }
    }
}

static LIVE: Mutex<Live> = Mutex::new(Live::idle());

/// 正在跑的那一个识别器。`stop` / `cancel` 要能拿到它调 `StopRecognitionAsync` ——
/// 识别线程正阻塞在 `RecognizeAsync` 上，只有另一个线程能把它打断。
///
/// `windows` 的类型都是 `Send + Sync`（`unsafe impl Send`），所以跨线程没问题。
static RECOGNIZER: Mutex<Option<SpeechRecognizer>> = Mutex::new(None);

/// 热键注册失败的原因。`None` = 没配 / 注册成功
static HOTKEY_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// 语言探测只做一次（`SupportedTopicLanguages()` 要几百毫秒）
static LANGUAGE: Mutex<Option<Probe>> = Mutex::new(None);

/// 探测结果：能用的语言 tag + 系统自己那个
#[derive(Debug, Clone)]
struct Probe {
    /// 实际会用的语言（`None` = 这台机器不支持中文听写）
    usable: Option<String>,
    /// 系统语音语言（设置页要显示出来）
    system: String,
    /// 两套引擎加起来有几种语音识别语言。**0 = 这台机器一条都没有**，
    /// 那和"装了但不是中文"是两句完全不同的话（前者要去装组件，后者要去切语言）
    supported: usize,
    /// 走哪一套引擎（`None` = 一条路都不通）
    engine: Option<Engine>,
}

/// 听写的两套后端。**它们读的不是同一份语言库** —— 详见 `dictation_sapi.rs` 的文件头
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Engine {
    /// WinRT `SpeechRecognizer`，读 `Speech_OneCore`
    WinRt,
    /// 经典 SAPI 5，读 `Speech\Engines\SR`
    Sapi,
}

fn lock_live() -> std::sync::MutexGuard<'static, Live> {
    // 中毒不当回事：里面只有几个标量和一个 String，没有"半个状态"
    LIVE.lock().unwrap_or_else(|error| error.into_inner())
}

fn lock_recognizer() -> std::sync::MutexGuard<'static, Option<SpeechRecognizer>> {
    RECOGNIZER.lock().unwrap_or_else(|error| error.into_inner())
}

/// WinRT 的入口都要 COM。`S_FALSE`（已经初始化过）不算错，所以忽略返回值
fn com() {
    // SAFETY: 只是给当前线程定单元模型；重复调用是幂等的
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// 探一次语言。**不开麦**
///
/// 缓存的是"问过 Windows 的答案"：装语音包要跳去系统设置，回来之后缓存是旧的，
/// 所以设置页那颗「重新检测」必须能把它清掉（`dictation_recheck`）—— 一个不会
/// 重新检测的"重新检测"比没有这个按钮更糟。
fn probe() -> Probe {
    let mut slot = LANGUAGE.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(probe) = slot.as_ref() {
        return probe.clone();
    }
    let probe = detect();
    *slot = Some(probe.clone());
    probe
}

fn detect() -> Probe {
    com();
    // 先问 WinRT。新装的 Win11 + 中文语音包只有这一套能用
    let winrt = detect_winrt();
    let probe = match policy::pick_language(&winrt.system, &winrt.tags) {
        Some(tag) => Probe {
            usable: Some(tag),
            system: winrt.system,
            supported: winrt.tags.len(),
            engine: Some(Engine::WinRt),
        },
        None => {
            // WinRT 没有中文：再问经典 SAPI。从 Win10 升级上来的机器只有这一套能用
            let sapi = crate::dictation_sapi::installed();
            let (system, chinese, total) = match sapi {
                Some(installed) => (installed.system, installed.chinese, installed.total),
                None => (String::new(), Vec::new(), 0),
            };
            let usable = policy::pick_language(&system, &chinese);
            Probe {
                engine: usable.as_ref().map(|_| Engine::Sapi),
                usable,
                system,
                // 两套加起来才是"这台机器装了些什么"：只有 SAPI 有中文时，
                // 报 0 会让用户去装一个其实已经装了的组件
                supported: winrt.tags.len() + total,
            }
        }
    };

    // 探测结果有缓存，这条一辈子只打一次。出事时它是唯一能回答"到底走了哪套
    // 引擎、为什么没有中文"的东西 —— 而这两件事在界面上都只表现为"按钮是灰的"
    eprintln!(
        "[lattice] dictation probe: engine={:?} language={:?} supported={}",
        probe.engine, probe.usable, probe.supported
    );
    probe
}

/// WinRT 那半的探测结果
struct WinRtProbe {
    system: String,
    tags: Vec<String>,
}

fn detect_winrt() -> WinRtProbe {
    let system = match SpeechRecognizer::SystemSpeechLanguage() {
        Ok(language) => match language.LanguageTag() {
            Ok(tag) => tag.to_string(),
            Err(error) => {
                eprintln!("[lattice] SystemSpeechLanguage().LanguageTag() failed: {error}");
                String::new()
            }
        },
        Err(error) => {
            eprintln!("[lattice] SystemSpeechLanguage() failed: {error}");
            String::new()
        }
    };

    let mut tags = Vec::new();
    match SpeechRecognizer::SupportedTopicLanguages() {
        Ok(languages) => {
            if let Ok(size) = languages.Size() {
                for index in 0..size {
                    if let Ok(language) = languages.GetAt(index) {
                        if let Ok(tag) = language.LanguageTag() {
                            tags.push(tag.to_string());
                        }
                    }
                }
            }
        }
        // 列不出来不是"没有"：还有个正在跑的系统语言可以试着用
        Err(error) => eprintln!("[lattice] SupportedTopicLanguages() failed: {error}"),
    }

    WinRtProbe { system, tags }
}

fn recognizer_for(tag: &str) -> Result<SpeechRecognizer, String> {
    let language = Language::CreateLanguage(&HSTRING::from(tag))
        .map_err(|error| format!("could not open the language \"{tag}\": {error}"))?;
    SpeechRecognizer::Create(&language)
        .map_err(|error| format!("could not create a recognizer for \"{tag}\": {error}"))
}

// ---------------------------------------------------------------------------
// 事件与状态
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Update {
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// 已经打进别人窗口的字数（`system` 那条成功时才有）
    #[serde(skip_serializing_if = "Option::is_none")]
    chars: Option<usize>,
}

fn emit(app: &AppHandle, update: Update) {
    if let Err(error) = app.emit(EVENT, update) {
        // 事件发不出去只意味着"这一刻没人听"，不影响听写本身
        eprintln!("[lattice] could not emit the dictation event: {error}");
    }
}

fn emit_phase(app: &AppHandle, phase: &'static str, target: Option<Target>) {
    emit(
        app,
        Update {
            phase,
            target: target.map(Target::as_str),
            text: None,
            code: None,
            error: None,
            chars: None,
        },
    );
}

fn emit_done(app: &AppHandle, text: Option<String>, code: Option<&str>, chars: Option<usize>) {
    emit(
        app,
        Update {
            phase: "done",
            target: None,
            text,
            code: code.map(String::from),
            error: None,
            chars,
        },
    );
}

fn emit_error(app: &AppHandle, code: &str, error: String) {
    emit(
        app,
        Update {
            phase: "error",
            target: None,
            text: None,
            code: Some(code.to_string()),
            error: Some(error),
            chars: None,
        },
    );
}

/// 当前是不是在听。浮钮和面板都只能信这一个
pub fn listening() -> bool {
    lock_live().phase == Phase::Listening
}

// ---------------------------------------------------------------------------
// 设置（dictation.json）
// ---------------------------------------------------------------------------

/// 前端看到的设置。字段名 camelCase，和 `dictation_settings_set` 收的 patch 同形状
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub enabled: bool,
    pub hotkey: String,
    pub dx: i32,
    pub dy: i32,
}

/// `dictation_settings_set` 的入参：**每一项都可选**，给什么改什么。
///
/// 浮钮的位置也走这里（0027 §4「落盘」最后一行）：前端和 Rust 只认这一份，
/// 不新增命令。`show` 在 0032 里删掉了 —— 浮钮跟不跟着出现由听写状态决定，
/// 不再是一个用户开关。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub enabled: Option<bool>,
    pub hotkey: Option<String>,
    pub dx: Option<i32>,
    pub dy: Option<i32>,
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|error| format!("could not find the config folder: {error}"))
}

/// 读一次。坏文件 → 默认值，**不报错、不写回**（这份文件只影响"按钮灰不灰、
/// 浮钮在不在、热键占不占"，没有一份数据会因为读坏它而丢）
fn settings(app: &AppHandle) -> policy::Settings {
    let Ok(path) = config_path(app) else {
        return policy::Settings::default();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return policy::Settings::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        eprintln!("[lattice] dictation.json is not valid JSON; using the defaults");
        return policy::Settings::default();
    };
    let button = value.get("button");
    // 旧文件里的 `button.show` 到这里就没用了（0032 §4）：浮钮跟不跟着出现
    // 由听写状态决定，所以读的时候**直接不取**，下次保存自然消失。
    policy::normalize(
        value.get("enabled").and_then(serde_json::Value::as_bool),
        value.get("hotkey").and_then(serde_json::Value::as_str),
        button
            .and_then(|button| button.get("dx"))
            .and_then(serde_json::Value::as_i64)
            .map(|value| value as i32),
        button
            .and_then(|button| button.get("dy"))
            .and_then(serde_json::Value::as_i64)
            .map(|value| value as i32),
    )
}

fn save(app: &AppHandle, settings: &policy::Settings) -> Result<(), String> {
    let path = config_path(app)?;
    let document = serde_json::json!({
        "schema": 1,
        "enabled": settings.enabled,
        "hotkey": settings.hotkey,
        "button": { "dx": settings.dx, "dy": settings.dy },
    });
    let text = serde_json::to_string_pretty(&document)
        .map_err(|error| format!("could not serialize the dictation settings: {error}"))?;
    // 先建目录（第一次写的时候 `app_config_dir` 可能还不存在）
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text.as_bytes())
        .map_err(|error| format!("could not write {CONFIG_FILE}: {error}"))?;
    std::fs::rename(&temp, &path)
        .map_err(|error| format!("could not replace {CONFIG_FILE}: {error}"))
}

fn view(settings: &policy::Settings) -> SettingsView {
    SettingsView {
        enabled: settings.enabled,
        hotkey: settings.hotkey.clone(),
        dx: settings.dx,
        dy: settings.dy,
    }
}

// ---------------------------------------------------------------------------
// 识别
// ---------------------------------------------------------------------------

/// 开听。
///
/// 失败一律回**错误码字符串**（`wrong_language` / `no_microphone` / ...）并同时发一条
/// `error` 事件：面板从事件里拿文案，`invoke` 的 reject 只用来记日志。
#[tauri::command]
pub fn dictation_start(app: AppHandle, target: String) -> Result<(), String> {
    let target = Target::parse(&target)?;

    {
        let live = lock_live();
        // 已经在听：把"再点一次"当成"停"（浮钮是开关，热键也是）
        if live.phase == Phase::Listening {
            drop(live);
            return dictation_stop();
        }
    }

    let probe = probe();
    let (Some(tag), Some(engine)) = (probe.usable.clone(), probe.engine) else {
        // 两句话必须分开：`SupportedTopicLanguages()` 回 0 是"这台机器没装语音识别组件"，
        // 非 0 但没有中文是"装了、没切过去"。前者要去装，后者要去切 —— 合成一句
        // "把语音语言改成中文"会把第一类用户指到错的地方。
        let message = if probe.supported == 0 {
            "这台机器没有装语音识别语言，本地听写起不来。去「设置 → 时间和语言 → 语言和区域」\
             给中文装上「语音识别」，再回来试。Windows 自带的 Win+H 走的是云端，\
             所以它能用不代表这里能用。"
                .to_string()
        } else {
            format!(
                "系统语音语言是 {}，这台机器上装的语音识别语言里没有中文（共 {} 种）。\
                 把它切成中文(简体)，或者给中文补一个语音识别语言包。",
                if probe.system.is_empty() {
                    "(读不出来)"
                } else {
                    probe.system.as_str()
                },
                probe.supported
            )
        };
        emit_error(&app, "wrong_language", message.clone());
        return Err("wrong_language".to_string());
    };

    // 焦点判据的两端之一：**开听那一刻**的前台窗口（0027 §7③）
    let window = if target == Target::System {
        foreground()
    } else {
        0
    };

    {
        let mut live = lock_live();
        live.phase = Phase::Listening;
        live.target = target;
        live.window = window;
        live.text.clear();
        live.stopping = false;
        live.cancelling = false;
    }

    // 先把"正在听"发出去：开麦那几百毫秒里界面必须已经有反应
    emit_phase(&app, "listening", Some(target));
    crate::dictation_button::set_listening(true);

    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("lattice-dictation".to_string())
        .spawn(move || recognizer_loop(handle, tag, target, engine));

    if let Err(error) = spawned {
        {
            let mut live = lock_live();
            live.phase = Phase::Idle;
        }
        emit_error(&app, "internal", format!("could not start the recognizer thread: {error}"));
        return Err("internal".to_string());
    }
    Ok(())
}

/// 一次开麦尝试的结局
enum Attempt {
    /// 已经收尾了（成功 / 出错 / 取消都由它自己 `finish` 过）
    Handled,
    /// **还没开始听**就失败了 —— 这时候换另一套引擎再试是有意义的
    NotStarted(&'static str, String),
}

/// 识别线程：按 `detect()` 挑出来的引擎开一路，结束即退。
///
/// **一条 `start` 一条线程**。不用常驻线程是因为常驻要回答"它现在算谁的状态" ——
/// 而现在状态只有一份，在 `LIVE` 里。
///
/// # WinRT 起不来就退到 SAPI
///
/// `detect()` 只看"有没有这个语言"，看不到"这个语言能不能真的开麦"。本机就是
/// 典型：WinRT 报 `zh-Hans-CN`、约束也编得过，可一 `RecognizeAsync` 就回
/// `0x80045509`（语音隐私政策没同意）—— 而经典 SAPI **不受这个闸门管**。
/// 所以"WinRT 还没出声就失败"要当成"换个引擎再试"，而不是直接给用户报错。
///
/// 反过来的顺序不成立：SAPI 一旦开始听就听到底，它的失败（没麦克风、没令牌）
/// 换 WinRT 也救不了，所以那一路是终点。
fn recognizer_loop(app: AppHandle, tag: String, target: Target, engine: Engine) {
    com();
    match engine {
        Engine::WinRt => match winrt_loop(&app, &tag, target) {
            Attempt::Handled => {}
            Attempt::NotStarted(code, message) => {
                let fallback = crate::dictation_sapi::installed()
                    .and_then(|installed| installed.chinese.into_iter().next());
                match fallback {
                    Some(sapi_tag) => {
                        eprintln!(
                            "[lattice] WinRT could not start ({message}); falling back to classic SAPI \"{sapi_tag}\""
                        );
                        match crate::dictation_sapi::listen(&app, target, &sapi_tag) {
                            crate::dictation_sapi::Outcome::Done => finish(&app, None, None, None),
                            crate::dictation_sapi::Outcome::Failed(code, message) => {
                                finish(&app, Some(code), Some(message), None)
                            }
                        }
                    }
                    // 另一套也没有中文：那就只能把 WinRT 这个错报出去
                    None => finish(&app, Some(code), Some(message), None),
                }
            }
        },
        Engine::Sapi => match crate::dictation_sapi::listen(&app, target, &tag) {
            crate::dictation_sapi::Outcome::Done => finish(&app, None, None, None),
            crate::dictation_sapi::Outcome::Failed(code, message) => {
                finish(&app, Some(code), Some(message), None)
            }
        },
    }
}

/// WinRT 那一路：建识别器 → 挂听写约束 → 一遍遍 `RecognizeAsync` → 收尾。
fn winrt_loop(app: &AppHandle, tag: &str, target: Target) -> Attempt {
    let recognizer = match recognizer_for(tag) {
        Ok(recognizer) => recognizer,
        Err(error) => return Attempt::NotStarted("wrong_language", error),
    };

    // 听写场景约束：有标点、按句子切。没有它，本地语法给的是"命令词"那一套
    let constraint = match SpeechRecognitionTopicConstraint::Create(
        SpeechRecognitionScenario::Dictation,
        &HSTRING::from("dictation"),
    ) {
        Ok(constraint) => constraint,
        Err(error) => {
            return Attempt::NotStarted(
                "wrong_language",
                format!("could not build the dictation constraint: {error}"),
            )
        }
    };
    let appended = (|| -> windows::core::Result<()> {
        let constraints = recognizer.Constraints()?;
        // `cast` 的目标类型要写明：`Append` 收的是 `ISpeechRecognitionConstraint`
        let as_constraint: windows::Media::SpeechRecognition::ISpeechRecognitionConstraint =
            constraint.cast()?;
        constraints.Append(&as_constraint)?;
        Ok(())
    })();
    if let Err(error) = appended {
        return Attempt::NotStarted(
            "wrong_language",
            format!("could not attach the constraint: {error}"),
        );
    }

    if let Ok(timeouts) = recognizer.Timeouts() {
        let _ = timeouts.SetEndSilenceTimeout(END_SILENCE);
    }

    match recognizer.CompileConstraintsAsync().and_then(|operation| operation.join()) {
        Ok(compiled) => match compiled.Status() {
            // `SpeechRecognitionResultStatus::Success` —— 约束编过了
            Ok(status) if status == SpeechRecognitionResultStatus::Success => {}
            Ok(status) => {
                return Attempt::NotStarted(
                    "wrong_language",
                    format!(
                        "the dictation constraint did not compile (status {}). 这台机器的语音识别不支持听写场景，或者没装对应的语言包。",
                        status.0
                    ),
                )
            }
            Err(error) => {
                return Attempt::NotStarted(
                    "wrong_language",
                    format!("reading the compilation status failed: {error}"),
                )
            }
        },
        Err(error) => {
            return Attempt::NotStarted(
                "wrong_language",
                format!("compiling the constraints failed: {error}"),
            )
        }
    }

    // 从这里开始 `stop` / `cancel` 才拿得到它
    *lock_recognizer() = Some(recognizer.clone());

    let mut heard_any = false;
    let mut empty_rounds = 0u32;
    loop {
        if stopping() {
            break;
        }
        match recognizer.RecognizeAsync().and_then(|operation| operation.join()) {
            Ok(result) => match result.Status() {
                Ok(status) if status == SpeechRecognitionResultStatus::Success => {
                    let text = result
                        .Text()
                        .map(|text| text.to_string())
                        .unwrap_or_default();
                    match policy::heard(&text) {
                        Some(heard) => {
                            let all = append_heard(&heard);
                            heard_any = true;
                            empty_rounds = 0;
                            // 逐字上屏是输入法该干的事：这里只喂面板那行预览（0027 §8）
                            emit_partial(app, target, all);
                        }
                        // 空结果 = 这一轮没听到
                        None => empty_rounds = empty_rounds.saturating_add(1),
                    }
                }
                Ok(status) if status == SpeechRecognitionResultStatus::MicrophoneUnavailable => {
                    finish(
                        &app,
                        Some("no_microphone"),
                        Some("麦克风没有打开 —— 去「设置 → 隐私 → 麦克风」允许桌面应用使用麦克风。".to_string()),
                        None,
                    );
                    return Attempt::Handled;
                }
                // 没人说话 / 说不清 / 被停。三种都按"这一轮没听到"处理：
                // 用户按了停就收尾，没按就接着听下一句
                _ => empty_rounds = empty_rounds.saturating_add(1),
            },
            Err(error) => {
                // 一句都没听到就失败 = 根本没开始听。这多半是环境问题（最典型的是
                // `0x80045509` 语音隐私政策没同意），换 SAPI 还有救
                if !heard_any {
                    *lock_recognizer() = None;
                    return Attempt::NotStarted("internal", start_failure(error));
                }
                finish(&app, Some("internal"), Some(format!("recognition failed: {error}")), None);
                return Attempt::Handled;
            }
        }
        if stopping() {
            break;
        }
        // 一轮都没识别到就空转：两轮之后按"没听到"收尾，而不是永远亮着"正在听"
        if !heard_any && empty_rounds >= 2 {
            finish(&app, None, None, None);
            return Attempt::Handled;
        }
    }

    finish(&app, None, None, None);
    Attempt::Handled
}

/// `RecognizeAsync` 一开口就失败时给用户看的话。
///
/// `0x80045509` 是"语音隐私政策没同意"。它长得像一个内部错误码，而用户要做的
/// 动作其实很具体（去设置里打开语音服务），所以单独翻译一句 —— 直接把这串数字
/// 甩出去，用户只会以为程序坏了。
fn start_failure(error: windows::core::Error) -> String {
    let raw = error.to_string();
    if raw.contains("0x80045509") || raw.contains("privacy policy") {
        "Windows 的「语音隐私政策」还没同意，系统识别器不让开麦。去「设置 → 隐私和安全性 → 语音」把语音服务打开再试。".to_string()
    } else {
        format!("recognition failed: {raw}")
    }
}

/// 把一句已经识别完的话并进 `LIVE.text`，返回并进去之后的全文。
///
/// 两套引擎都走这一条：`\n` 分隔是"每句话一行"，而用户说的结构（逗号、句号）
/// 由识别器自己给，这里不再动。
pub(crate) fn append_heard(heard: &str) -> String {
    let mut live = lock_live();
    if !live.text.is_empty() {
        live.text.push('\n');
    }
    live.text.push_str(heard);
    live.text.clone()
}

/// 只更新"正在听到什么"的预览，**不**并进 `LIVE.text`（没定下来的字不许被当成
/// 结果交出去，0027 §8）
pub(crate) fn emit_partial(app: &AppHandle, target: Target, text: String) {
    emit(
        app,
        Update {
            phase: "partial",
            target: Some(target.as_str()),
            text: Some(text),
            code: None,
            error: None,
            chars: None,
        },
    );
}

pub(crate) fn current_text() -> String {
    lock_live().text.clone()
}

pub(crate) fn stopping() -> bool {
    let live = lock_live();
    live.stopping || live.cancelling
}

/// 收尾。**任何分支都必须走到这里**（0027 §5：按了停止界面还一直"正在听"）
pub(crate) fn finish(
    app: &AppHandle,
    code: Option<&str>,
    error: Option<String>,
    chars: Option<usize>,
) {
    let (text, cancelling, target, window) = {
        let mut live = lock_live();
        let text = live.text.clone();
        let cancelling = live.cancelling;
        let target = live.target;
        let window = live.window;
        live.phase = Phase::Idle;
        live.stopping = false;
        live.cancelling = false;
        live.text.clear();
        live.window = 0;
        (text, cancelling, target, window)
    };
    *lock_recognizer() = None;
    // 浮钮上的"正在听"先从画面上下掉，再发结果 —— 反过来会闪一下
    crate::dictation_button::set_listening(false);

    if cancelling {
        // Esc / 取消：一个字都不落，但状态照样回 idle
        crate::dictation_button::dismiss();
        emit_done(app, None, Some("cancelled"), None);
        return;
    }
    if let Some(error) = error {
        crate::dictation_button::flash_error();
        emit_error(app, code.unwrap_or("internal"), error);
        return;
    }

    let Some(text) = policy::heard(&text) else {
        // 空文本 = 没听到。状态已经回 idle，面板给一句提示就好（0027 §5）
        crate::dictation_button::dismiss();
        emit_done(app, None, None, None);
        return;
    };

    match target {
        Target::Panel => {
            crate::dictation_button::dismiss();
            emit_done(app, Some(text), None, chars)
        }
        Target::System => {
            // 超限**拒绝不截断**：把半句话打进别人的窗口、而用户不知道，比不做更糟
            if policy::too_long(&text) {
                crate::dictation_button::flash_error();
                emit_error(
                    app,
                    "too_long",
                    format!(
                        "这段话超过 {} 个字了，分两次说 —— 一次打完比打一半更难收回。",
                        policy::MAX_TYPE_CHARS
                    ),
                );
                return;
            }
            // 焦点判据：开听时的 HWND == 出字前的 HWND（0027 §7③）
            let now = foreground();
            if !policy::same_window(window, now) {
                crate::dictation_button::flash_error();
                emit_done(app, Some(text), Some("focus_changed"), None);
                return;
            }
            match crate::hands::type_text(&text) {
                Ok(chars) => {
                    crate::dictation_button::dismiss();
                    emit_done(app, None, None, Some(chars))
                }
                Err(error) => {
                    crate::dictation_button::flash_error();
                    emit_error(app, "input_blocked", error);
                }
            }
        }
    }
}

/// 用户按停：让那次 `RecognizeAsync` 提前返回，线程自己收尾
#[tauri::command]
pub fn dictation_stop() -> Result<(), String> {
    {
        let mut live = lock_live();
        if live.phase != Phase::Listening {
            return Ok(());
        }
        live.stopping = true;
    }
    poke();
    Ok(())
}

/// 取消（Esc）：丢掉已经识别出来的字，什么都不交
#[tauri::command]
pub fn dictation_cancel() -> Result<(), String> {
    {
        let mut live = lock_live();
        if live.phase != Phase::Listening {
            return Ok(());
        }
        live.cancelling = true;
    }
    poke();
    Ok(())
}

/// 叫醒阻塞在 `RecognizeAsync` 上的那条线程
fn poke() {
    let recognizer = lock_recognizer().clone();
    if let Some(recognizer) = recognizer {
        // 失败也不要紧：`EndSilenceTimeout` 之后它自己会回来
        let _ = recognizer
            .StopRecognitionAsync()
            .and_then(|operation| operation.join());
    }
}

/// 打开 Windows 自己的语音 / 麦克风设置页。
///
/// `ms-settings:` **不在** `open_policy` 的白名单里（那条只放 http/https，见
/// 不变量 14），所以不能借 `open_external`。这里要跳的是系统页面、字面量由本函数
/// 写死，不是把组件或用户给的字符串交出去。
#[tauri::command]
pub fn dictation_open_settings(page: String) -> Result<(), String> {
    let target = match page.trim() {
        "speech" => "ms-settings:speech",
        "microphone" => "ms-settings:privacy-microphone",
        other => return Err(format!("\"{other}\" is not a dictation settings page")),
    };
    shell_open(target)
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let verb = wide("open");
    let file = wide(target);
    // SAFETY: 两个字符串都活到调用结束，ShellExecuteW 只读它们；不传工作目录和参数
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Win32 文档：返回值大于 32 才算成功，32 及以下都是错误码
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!("Windows refused to open \"{target}\" ({result:?})"))
    }
}

#[cfg(not(windows))]
fn shell_open(_target: &str) -> Result<(), String> {
    Err("dictation is only implemented on Windows".to_string())
}

/// 波形。**这一版没有第二路采集，恒 0** —— 0027 §5 把波形定成装饰：打不开就
/// 一直 0，界面不画波形、不报错、不影响听写。面板据此不画波形。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub level: f32,
}

#[tauri::command]
pub fn dictation_level() -> Level {
    Level { level: 0.0 }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    /// 为什么不能用（0032 §4）：`no_engine` / `no_chinese` / `null`。
    /// 不参与任何判断，只决定设置页和 tooltip 说哪句话
    pub reason: Option<String>,
    pub language: String,
    pub enabled: bool,
    pub hotkey: String,
    pub hotkey_error: Option<String>,
}

#[tauri::command]
pub fn dictation_status(app: AppHandle) -> Status {
    let probe = probe();
    let settings = settings(&app);
    Status {
        available: probe.usable.is_some(),
        reason: policy::unavailable_reason(probe.supported, probe.usable.is_some())
            .map(str::to_string),
        language: probe.usable.clone().unwrap_or_else(|| probe.system.clone()),
        enabled: settings.enabled,
        hotkey: settings.hotkey,
        hotkey_error: HOTKEY_ERROR
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone(),
    }
}

/// 重新问 Windows 一次"能不能听写"。
///
/// 设置页那颗「重新检测」走这一条：装语音包必须先跳去系统设置，回来时缓存还是
/// 旧的 —— 一个不会重新检测的按钮，比没有这个按钮更糟（0032 §5）。
#[tauri::command]
pub fn dictation_recheck(app: AppHandle) -> Status {
    *LANGUAGE.lock().unwrap_or_else(|error| error.into_inner()) = None;
    dictation_status(app)
}

#[tauri::command]
pub fn dictation_settings(app: AppHandle) -> SettingsView {
    view(&settings(&app))
}

/// 改设置。**改了就用**：开/关浮钮、重注册热键、挪位置都在这之后发生
#[tauri::command]
pub fn dictation_settings_set(app: AppHandle, patch: SettingsPatch) -> Result<SettingsView, String> {
    let current = settings(&app);
    let next = policy::normalize(
        patch.enabled.or(Some(current.enabled)),
        Some(patch.hotkey.as_deref().unwrap_or(current.hotkey.as_str())),
        patch.dx.or(Some(current.dx)),
        patch.dy.or(Some(current.dy)),
    );

    // 热键写错了要说出来，但**别拦保存** —— 用户可能只是想把别的先改好
    if let Some(raw) = patch.hotkey.as_deref() {
        if policy::parse_hotkey(raw).is_err() && !raw.trim().is_empty() {
            eprintln!("[lattice] \"{raw}\" is not a usable dictation hotkey; keeping the default");
        }
    }

    save(&app, &next)?;
    // 关掉总开关要当场停手：麦克风、浮钮、热键三样都不许留在后台
    if !next.enabled && listening() {
        let _ = dictation_cancel();
    }
    sync_hotkey(&app, &next);
    crate::dictation_button::apply(&app, &next);
    Ok(view(&next))
}

// ---------------------------------------------------------------------------
// 全局热键
// ---------------------------------------------------------------------------

/// 注册（或重注册）热键。`enabled` 关着时**一条都不注册**
pub(crate) fn sync_hotkey(app: &AppHandle, settings: &policy::Settings) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let _ = app.global_shortcut().unregister_all();
    if !settings.enabled {
        *HOTKEY_ERROR.lock().unwrap_or_else(|error| error.into_inner()) = None;
        return;
    }
    let Ok(hotkey) = policy::parse_hotkey(&settings.hotkey) else {
        *HOTKEY_ERROR.lock().unwrap_or_else(|error| error.into_inner()) = Some(format!(
            "\"{}\" 不是一个能用的组合键",
            settings.hotkey
        ));
        return;
    };
    let shortcut = crate::dictation_button::shortcut_of(hotkey);
    match app.global_shortcut().register(shortcut) {
        Ok(()) => {
            *HOTKEY_ERROR.lock().unwrap_or_else(|error| error.into_inner()) = None;
        }
        Err(error) => {
            // 静默失败是这个功能最常见的死法：用户按了没反应，设置里也没有一句话
            eprintln!("[lattice] could not register the dictation hotkey: {error}");
            *HOTKEY_ERROR.lock().unwrap_or_else(|error| error.into_inner()) =
                Some("这个组合键被别的程序占用了，换一个".to_string());
        }
    }
}

/// 热键按下了：在听就停，没在听就开（`system` 那条）
pub fn toggle_system(app: &AppHandle) {
    if listening() {
        let _ = dictation_stop();
    } else {
        // 开不起来时 `dictation_start` 已经发过 `error` 事件了，这里不再重复
        let _ = dictation_start(app.clone(), "system".to_string());
    }
}

/// 浮钮要用：现在这个前台窗口（判焦点用）
pub fn foreground() -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    // SAFETY: 只是读一个全局的窗口句柄
    unsafe { GetForegroundWindow() as isize }
}

/// 一次"用户要开/停"的切换。浮钮点一下走这里
pub fn toggle(app: &AppHandle) {
    toggle_system(app);
}

/// 记一条"热键注册失败"之外的外部错误（浮钮建不出来时用）
pub(crate) fn record_error(message: String) {
    eprintln!("[lattice] {message}");
}

/// 浮钮被拖到新位置：只改 `dictation.json` 里那两个偏移，别的字段照旧。
///
/// 走 `dictation_settings_set` 那条落盘规矩（先临时文件再改名），但不发事件 ——
/// 拖动是浮钮自己的事，面板不需要知道。
pub(crate) fn remember_button_offset(app: &AppHandle, dx: i32, dy: i32) {
    let mut settings = settings(app);
    settings.dx = dx;
    settings.dy = dy;
    if let Err(error) = save(app, &settings) {
        eprintln!("[lattice] could not remember where the dictation button was dropped: {error}");
    }
}

/// 启动时按磁盘上的设置决定要不要建浮钮、要不要注册热键。
///
/// 关着的时候三样都不做：不建窗口、不占热键、不碰麦克风（0027 §4「落盘」）。
pub fn boot(app: &AppHandle) {
    let settings = settings(app);
    sync_hotkey(app, &settings);
    crate::dictation_button::apply(app, &settings);
}

/// 托盘菜单那一项：「浮钮回到右下角」。
///
/// 拔掉外接屏之后偏移可能落在当前工作区外面 —— 这条永远在托盘里，找得回来。
/// （「隐藏浮钮」那一项在 0032 里删了：钮不再常驻，没有"藏"这回事。）
pub fn reset_button(app: &AppHandle) {
    let mut settings = settings(app);
    settings.dx = policy::DEFAULT_DX;
    settings.dy = policy::DEFAULT_DY;
    if let Err(error) = save(app, &settings) {
        eprintln!("[lattice] could not reset the dictation button: {error}");
    }
    crate::dictation_button::apply(app, &settings);
}

/// 命令里用不到、但测试要对齐的那个常量：注入上限的两处必须是同一个数
#[cfg(test)]
mod tests {
    use super::*;
    use crate::input_policy;

    #[test]
    fn both_type_limits_are_the_same_number() {
        // 两个常量分开写在两个"不许引 crate"的文件里，只能靠这一条钉住
        assert_eq!(
            policy::MAX_TYPE_CHARS,
            input_policy::MAX_TYPE_CHARS,
            "dictation_policy 与 input_policy 的注入上限必须一致"
        );
    }

    #[test]
    fn targets_round_trip() {
        assert_eq!(Target::parse("panel"), Ok(Target::Panel));
        assert_eq!(Target::parse(" system "), Ok(Target::System));
        assert!(Target::parse("system2").is_err());
    }
}
