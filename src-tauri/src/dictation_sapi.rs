//! 经典 SAPI 5（桌面识别器）—— 听写的第二套引擎。
//!
//! # 为什么会有第二个后端
//!
//! WinRT 的 `SpeechRecognizer` 和经典 SAPI **读的不是同一份语言库**：
//!
//! | | 注册表 | 语言数据 |
//! |---|---|---|
//! | WinRT | `HKLM\SOFTWARE\Microsoft\Speech_OneCore\Recognizers` | `%windir%\Speech_OneCore\Engines\SR\<tag>` |
//! | SAPI | `HKLM\SOFTWARE\Microsoft\Speech\Recognizers\Tokens` | `%windir%\Speech\Engines\SR\<tag>` |
//!
//! 同一台机器上**可以只有其中一套**，而两套都"看起来像装了语音识别"：
//!
//! - 从 Win10 升级上来的机器（本机就是）：`Speech\Engines\SR\zh-CN` 有 54 MB 声学
//!   和语言模型，`Speech_OneCore\Engines\SR` 一个语言目录都没有。WinRT 于是永远报
//!   "零种语言"，而 `Win+H` 照样能用 —— 它走云端，和这两套都没关系。
//! - 新装的 Win11 + 中文语音包：反过来，OneCore 有、经典那套没有。
//!
//! 所以"哪一套能用"不能写死。`dictation::detect()` 先问 WinRT，问不到中文再来问
//! 这里。两条路都走不通才判"这台机器没有语音识别"。
//!
//! # 三个只有踩过才知道的地方
//!
//! 1. **`LoadDictation` 只认 `SPLO_STATIC`**。传 `SPLO_DYNAMIC` 得到的是
//!    `E_INVALIDARG (0x80070057)`，而这个错误码看起来像"参数写错了"而不是
//!    "这个枚举值不支持" —— 会让人去怀疑 `pszTopicName`。
//! 2. **`Language` 属性是十六进制**，而且可以是分号分隔的一串（本机英文令牌是
//!    `409;9`）。按十进制读会把 `804` 读成 0x324，于是"有中文"变成"没中文"。
//! 3. **进程内识别器不会自己去听默认麦克风**。必须 `SetInput` 一个
//!    `CLSID_SpMMAudioIn`，否则 `LoadDictation` 全成功、`SPEI_*` 事件一个都不来，
//!    症状是"浮钮亮着、永远没有字"。

use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::{w, GUID, Interface, IUnknown, PCWSTR, PWSTR};
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Media::Speech::{
    ISpObjectToken, ISpObjectTokenCategory, ISpRecoContext, ISpRecoGrammar, ISpRecoResult,
    ISpRecognizer, SPCAT_RECOGNIZERS, SPEI_HYPOTHESIS, SPEI_RECOGNITION, SPEI_SOUND_START, SPEVENT,
    SPRECOGNIZERSTATUS, SPLO_STATIC, SPRS_ACTIVE, SPRS_INACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::Threading::WaitForSingleObject;

use crate::dictation::{self, Target};
use crate::dictation_policy as policy;

// `windows` crate 的元数据里没有 Speech 的 CLSID，只能手写。
const CLSID_SP_INPROC_RECOGNIZER: GUID = GUID::from_u128(0x41B89B6B_9399_11D2_9623_00C04F8EE628);
const CLSID_SP_MM_AUDIO_IN: GUID = GUID::from_u128(0xCF3D2E50_53F2_11D2_960C_00C04F8EE628);
const CLSID_SP_OBJECT_TOKEN_CATEGORY: GUID =
    GUID::from_u128(0xA910187F_0C7A_45AC_92CC_59EDAFB77B53);

/// 等事件的粒度。
///
/// SAPI 没有"打断一次阻塞调用"的接口（WinRT 那边是 `StopRecognitionAsync`），
/// 所以"用户按停"只能靠这个循环自己发现 —— 100 ms 是"人感觉不到延迟"和
/// "不空转烧 CPU"之间的取值。`dictation_stop` 只改标志位，不需要再叫醒谁。
const WAIT_SLICE: u32 = 100;

/// 一次会话最长多久。
///
/// **不用"没声音就收尾"那套**：`SPEI_SOUND_START` 这个识别器压根不发（实测整场
/// `sound events = 0`），而 `dwAudioLevel` 在安静房间里也不是恒 0（本机采到 1），
/// 拿它当"有没有人说话"会两头出错 —— 阈值低了永远不收尾，高了把说话的人掐掉。
///
/// 所以只留一条**硬上限**：到点就收，不管听没听到。用户按停是主路径（浮钮 /
/// 热键 / 面板都能停），这个上限只负责"用户走开了、麦克风别一直开着"。
const MAX_SESSION: Duration = Duration::from_secs(120);

/// 每多少个等待片采一次音频电平（10 × 100 ms = 1 秒）。**只用来记日志**
const LEVEL_EVERY: u32 = 10;

/// 一次会话的计数，收尾时打一行日志。
///
/// 这个功能"没出字"的原因太多（语言、麦克风、隐私政策、事件没来），而界面上
/// 它们全都只表现为一句「没听到」。一行计数就能把范围缩到一处。
#[derive(Default)]
struct Stats {
    sound_events: u32,
    recognitions: u32,
    hypotheses: u32,
    /// 整场会话里见过的最大音频电平。恒 0 = 根本没拿到音频
    peak_level: u32,
}

/// 这台机器上装了哪些识别器。`None` = 经典 SAPI 这条路整个不可用
pub(crate) struct Installed {
    /// 默认那个识别器的语言（中文给 tag，别的给语言名，读不出来给空串）
    pub system: String,
    /// 中文令牌的 tag，可能不止一个（简体 + 繁体）
    pub chinese: Vec<String>,
    /// 令牌总数。0 和"有令牌但没中文"要分开报（0032 §4 的 `no_engine` / `no_chinese`）
    pub total: usize,
}

/// 枚举一次识别器令牌。**不开麦**
pub(crate) fn installed() -> Option<Installed> {
    let category: ISpObjectTokenCategory =
        unsafe { CoCreateInstance(&CLSID_SP_OBJECT_TOKEN_CATEGORY, None, CLSCTX_ALL) }.ok()?;
    unsafe { category.SetId(SPCAT_RECOGNIZERS, false) }.ok()?;
    let tokens = unsafe { category.EnumTokens(PCWSTR::null(), PCWSTR::null()) }.ok()?;

    let mut total = 0u32;
    unsafe { tokens.GetCount(&mut total) }.ok()?;

    let mut chinese = Vec::new();
    for index in 0..total {
        let Ok(token) = (unsafe { tokens.Item(index) }) else {
            continue;
        };
        if let Some(tag) = policy::lcid_tag(&language_of(&token)) {
            chinese.push(tag);
        }
    }

    Some(Installed {
        system: default_language(),
        chinese,
        total: total as usize,
    })
}

/// 令牌的 `Language` 属性。属性在 `Attributes` 子键下，不在令牌本身 ——
/// 直接在令牌上 `GetStringValue("Language")` 会一路返回失败
fn language_of(token: &ISpObjectToken) -> String {
    // SAFETY: `token` 是一个活着的 COM 接口指针；回填的 PWSTR 由 COM 分配，
    // `take` 里用 CoTaskMemFree 还回去
    unsafe {
        let Ok(attributes) = token.OpenKey(w!("Attributes")) else {
            return String::new();
        };
        match attributes.GetStringValue(w!("Language")) {
            Ok(raw) => take(raw),
            Err(_) => String::new(),
        }
    }
}

/// 默认识别器说的是什么语言。
///
/// 建一个进程内识别器**不调** `SetRecognizer`，`GetRecognizer()` 回的就是默认令牌。
/// 这条路比 `GetDefaultTokenId()` 省事：那个只给一个注册表路径字符串，还得再拿它
/// 反查令牌才能读到属性。
fn default_language() -> String {
    unsafe {
        let Ok(recognizer) = CoCreateInstance::<_, ISpRecognizer>(
            &CLSID_SP_INPROC_RECOGNIZER,
            None,
            CLSCTX_ALL,
        ) else {
            return String::new();
        };
        let Ok(token) = recognizer.GetRecognizer() else {
            return String::new();
        };
        let raw = language_of(&token);
        policy::lcid_tag(&raw)
            .or_else(|| policy::lcid_language(&raw).map(String::from))
            .unwrap_or_default()
    }
}

/// 找一个语言是 `tag` 的令牌
fn token_for(tag: &str) -> Option<ISpObjectToken> {
    let category: ISpObjectTokenCategory =
        unsafe { CoCreateInstance(&CLSID_SP_OBJECT_TOKEN_CATEGORY, None, CLSCTX_ALL) }.ok()?;
    unsafe { category.SetId(SPCAT_RECOGNIZERS, false) }.ok()?;
    let tokens = unsafe { category.EnumTokens(PCWSTR::null(), PCWSTR::null()) }.ok()?;

    let mut total = 0u32;
    unsafe { tokens.GetCount(&mut total) }.ok()?;
    for index in 0..total {
        let Ok(token) = (unsafe { tokens.Item(index) }) else {
            continue;
        };
        if policy::lcid_tag(&language_of(&token)).as_deref() == Some(tag) {
            return Some(token);
        }
    }
    None
}

/// COM 回填的 `PWSTR` → `String`，顺手把 COM 分配的内存还回去。
///
/// 不还就是每读一个属性泄一小块：`EnumTokens` 的路径上会被调用很多次。
fn take(value: PWSTR) -> String {
    // SAFETY: `value` 是 COM 用 CoTaskMemAlloc 分配的、以 NUL 结尾的 UTF-16
    unsafe {
        let text = value.to_string().unwrap_or_default();
        CoTaskMemFree(Some(value.0 as *const _));
        text
    }
}

/// 一次听写会话的结果
pub(crate) enum Outcome {
    /// 听到的都并进 `LIVE.text` 了，按正常流程收尾
    Done,
    /// 起不来 / 半路出错：错误码 + 给用户看的那句话
    Failed(&'static str, String),
}

/// 开麦听到用户按停。**调用线程必须已经 `CoInitializeEx` 过**（`dictation::com()`）
pub(crate) fn listen(app: &AppHandle, target: Target, tag: &str) -> Outcome {
    let Some(token) = token_for(tag) else {
        return Outcome::Failed(
            "wrong_language",
            format!("这台机器的语音识别语言里找不到 \"{tag}\" 了，去设置里重新检测一次。"),
        );
    };

    // SAFETY: 下面每个调用都在同一个已初始化 COM 的线程上；COM 对象活到函数结束
    unsafe {
        let recognizer: ISpRecognizer =
            match CoCreateInstance(&CLSID_SP_INPROC_RECOGNIZER, None, CLSCTX_ALL) {
                Ok(recognizer) => recognizer,
                Err(error) => {
                    return Outcome::Failed(
                        "wrong_language",
                        format!("起不了本地识别器：{error}"),
                    )
                }
            };
        if let Err(error) = recognizer.SetRecognizer(&token) {
            return Outcome::Failed(
                "wrong_language",
                format!("识别器不接受 \"{tag}\" 这个语言：{error}"),
            );
        }

        // 麦克风。这一步失败才是真的"没有麦克风"—— 后面所有 HRESULT 都可能是
        // 语言包的问题，只有这里失败说明设备不可用
        let audio: IUnknown = match CoCreateInstance(&CLSID_SP_MM_AUDIO_IN, None, CLSCTX_ALL) {
            Ok(audio) => audio,
            Err(error) => {
                return Outcome::Failed(
                    "no_microphone",
                    format!("打不开默认麦克风：{error}。去「设置 → 隐私 → 麦克风」允许桌面应用使用麦克风。"),
                )
            }
        };
        if let Err(error) = recognizer.SetInput(&audio, true) {
            return Outcome::Failed(
                "no_microphone",
                format!("麦克风交给识别器时被拒绝：{error}。去「设置 → 隐私 → 麦克风」允许桌面应用使用麦克风。"),
            );
        }

        let context: ISpRecoContext = match recognizer.CreateRecoContext() {
            Ok(context) => context,
            Err(error) => {
                return Outcome::Failed("wrong_language", format!("建不了识别上下文：{error}"))
            }
        };
        if let Err(error) = context.SetNotifyWin32Event() {
            return Outcome::Failed("wrong_language", format!("挂不上事件通知：{error}"));
        }
        let handle = context.GetNotifyEventHandle();

        let grammar: ISpRecoGrammar = match context.CreateGrammar(0) {
            Ok(grammar) => grammar,
            Err(error) => {
                return Outcome::Failed("wrong_language", format!("建不了语法对象：{error}"))
            }
        };
        // `SPLO_STATIC`，不是 `SPLO_DYNAMIC`：后者在这个接口上回 E_INVALIDARG
        if let Err(error) = grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC) {
            return Outcome::Failed(
                "wrong_language",
                format!("这个识别器不支持自由听写：{error}。换个语言包，或者用 Windows 自己的语音输入。"),
            );
        }
        if let Err(error) = grammar.SetDictationState(SPRS_ACTIVE) {
            return Outcome::Failed("wrong_language", format!("开不了听写状态：{error}"));
        }

        let outcome = pump(app, target, &recognizer, &context, handle);

        // 收尾一定要把听写状态关掉：不然上下文析构前它还在占麦克风，
        // 下一次 `dictation_start` 会拿到一个"已经在听"的设备
        let _ = grammar.SetDictationState(SPRS_INACTIVE);
        outcome
    }
}

/// 事件循环。等到事件 → 排空 → 把识别结果并进 `LIVE.text`
fn pump(
    app: &AppHandle,
    target: Target,
    recognizer: &ISpRecognizer,
    context: &ISpRecoContext,
    handle: windows::Win32::Foundation::HANDLE,
) -> Outcome {
    let started = Instant::now();
    let mut stats = Stats::default();
    let mut ticks = 0u32;

    let outcome = 'session: loop {
        if dictation::stopping() {
            break Outcome::Done;
        }
        if started.elapsed() >= MAX_SESSION {
            break Outcome::Done;
        }

        // SAFETY: `handle` 是 `context` 的事件句柄，`context` 活到本函数结束
        if unsafe { WaitForSingleObject(handle, WAIT_SLICE) } != WAIT_OBJECT_0 {
            ticks = ticks.wrapping_add(1);
            if ticks % LEVEL_EVERY == 0 {
                // 只记峰值，不拿它做判断（见 `MAX_SESSION` 的注释）
                let mut status = SPRECOGNIZERSTATUS::default();
                // SAFETY: `recognizer` 活到本函数结束
                if unsafe { recognizer.GetStatus(&mut status) }.is_ok() {
                    stats.peak_level = stats.peak_level.max(status.AudioStatus.dwAudioLevel);
                }
            }
            continue;
        }

        loop {
            // SAFETY: SPEVENT 是 POD，全零是合法的"空事件"；`GetEvents` 回填它
            let mut event: SPEVENT = unsafe { std::mem::zeroed() };
            let mut fetched = 0u32;
            match unsafe { context.GetEvents(1, &mut event, &mut fetched) } {
                Ok(()) if fetched > 0 => {}
                Ok(()) => break,
                Err(error) => {
                    break 'session Outcome::Failed("internal", format!("读识别事件失败：{error}"))
                }
            }

            // `SPEVENT` 的头 16 位是事件 id，接着 16 位是 lParam 的类型
            let event_id = (event._bitfield & 0xFFFF) as u16;
            if event_id == SPEI_SOUND_START.0 as u16 {
                stats.sound_events += 1;
            } else if event_id == SPEI_RECOGNITION.0 as u16 {
                stats.recognitions += 1;
                if let Some(text) = result_text(&event) {
                    if let Some(heard) = policy::heard(&text) {
                        let all = dictation::append_heard(&heard);
                        dictation::emit_partial(app, target, all);
                    }
                }
            } else if event_id == SPEI_HYPOTHESIS.0 as u16 {
                stats.hypotheses += 1;
                // 还在说的那半句：只喂预览，不并进 `LIVE.text`（没定下来的字不许
                // 被当成结果交出去，0027 §8）
                if let Some(text) = result_text(&event) {
                    let preview = format!("{}{}", dictation::current_text(), text.trim());
                    dictation::emit_partial(app, target, preview);
                }
            }
        }
    };

    // 一行日志：这个功能"没出字"的原因太多，而界面上全都只表现为「没听到」
    eprintln!(
        "[lattice] dictation session: {:.1}s, sound={}, recognition={}, hypothesis={}, peak_level={}",
        started.elapsed().as_secs_f32(),
        stats.sound_events,
        stats.recognitions,
        stats.hypotheses,
        stats.peak_level
    );
    outcome
}

/// `SPEI_RECOGNITION` / `SPEI_HYPOTHESIS` 的 `lParam` 是一个 `ISpRecoResult*`。
///
/// 这个引用是 SAPI 为调用方 AddRef 过的，**读完 drop 掉就是 Release** ——
/// 不 drop 的话每说一句泄一个结果对象。
fn result_text(event: &SPEVENT) -> Option<String> {
    let pointer = event.lParam.0 as *mut core::ffi::c_void;
    if pointer.is_null() {
        return None;
    }
    // SAFETY: `SPEI_RECOGNITION` / `SPEI_HYPOTHESIS` 的 lParam 就是 ISpRecoResult*，
    // 而且这个引用归调用方所有（见上面的注释）
    unsafe {
        let result: ISpRecoResult = Interface::from_raw(pointer);
        let mut raw = PWSTR::null();
        // `u32::MAX` 的 ulCount 等于"一直取到结尾"
        result.GetText(0, u32::MAX, true, &mut raw, None).ok()?;
        Some(take(raw))
    }
}
