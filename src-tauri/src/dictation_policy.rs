//! 听写的判据 —— **纯逻辑**；WinRT 在 `dictation.rs`、浮钮在 `dictation_button.rs`。
//!
//! 抽出来的理由和 `guide_policy.rs` 一样：这台机器跑不了 `cargo test`（安全策略拦
//! `target/debug/deps` 下的 exe），而"哪个语言算中文""松手位移多少算点击""拔掉外接屏
//! 之后浮钮该落在哪"全是纯算术 —— 用 `rustc --test` 壳子单独编一遍就能钉住，
//! 断言不复制。
//!
//! # 五件容易写错的事，都在这里
//!
//! 1. **语言判据不是"列表里有没有 `zh-CN`"**。这一版 `windows` crate 的
//!    `SpeechRecognizer` 没有语言 setter，`new()` 一律用系统语音语言 —— 所以唯一
//!    有意义的问题是"当前那个 tag 是不是 `zh-*`"。
//! 2. **浮钮位置记相对偏移，不记绝对坐标**。换显示器、改分辨率之后绝对坐标会落到
//!    屏幕外；偏移不会，但读回来仍然要钳进当前工作区（拔掉外接屏那种情况）。
//! 3. **拖动和点击必须分开**。松手位移小于 4px 才算点击 —— 不然"想拖它"会触发一次
//!    听写，而用户根本没打算说话。
//! 4. **焦点判据是"两个时刻比"**，不是"结束时看前台窗口"（见 0027 §7③）。
//! 5. **热键要能拒绝**。格式不对时宁可存回默认，也不要拿一个注册不上的字符串去
//!    试 —— 那会把"被占用"和"写错了"混成同一句话。
//!
//! 不引 crate：这个文件要能在写不了 `target/debug/deps` 的机器上单独跑。

/// 一次最多注入多少字符。
///
/// **和 `input_policy::MAX_TYPE_CHARS` 是同一个数**：那边是 `type_plan` 的边界，
/// 这里是"还没走到 `type_plan` 就先判一次"的地方。两处分开写是因为这个文件不许
/// 引兄弟模块（`rustc --test` 只编它自己）；改了一处就要改另一处。
pub const MAX_TYPE_CHARS: usize = 4000;

/// 默认热键。用户记不住它也不要紧 —— 浮钮才是主入口，热键是"手在键盘上"时的第二条路。
pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Space";

/// 浮钮离工作区右下角的默认偏移（负数向左上）
pub const DEFAULT_DX: i32 = -120;
pub const DEFAULT_DY: i32 = -120;

/// 浮钮的边长（物理像素）。28px 是"看得见但不碍事"的最小值
pub const BUTTON_SIZE: i32 = 28;

/// 松手位移小于这个数（物理像素）就算点击
pub const CLICK_SLOP: i32 = 4;

/// 偏移的合理范围。比这更远的偏移没有意义，还会让钳制失去意义
const MAX_OFFSET: i32 = 4000;

/// 这台机器能不能听写。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// 系统语音语言是中文，可以开麦
    Ready,
    /// 系统语音语言不是中文 —— 不是"没装语音包"，是"没切过去"
    WrongLanguage,
    /// 麦克风被拒绝 / 不存在（`RecognizeAsync` 返回 `MicrophoneUnavailable`）
    NoMicrophone,
}

/// 当前 tag 算不算中文。
///
/// 认 `zh`、`zh-CN`、`zh-TW`、`zh-Hans`，大小写无所谓。**不认**以 `zh` 开头但后面
/// 没有 `-` 的东西（`zhx` 之类不是真语言标签）—— 那属于"看着像中文"，而把英文系统
/// 判成中文的后果是用户说了半天出来一串乱码。
pub fn is_chinese(tag: &str) -> bool {
    let lower = tag.trim().to_ascii_lowercase();
    if lower.len() < 2 || !lower.starts_with("zh") {
        return false;
    }
    match lower.as_bytes().get(2) {
        None => true,
        Some(b'-') => true,
        Some(_) => false,
    }
}

/// 语言 tag → 能不能用
pub fn availability_for(tag: &str) -> Availability {
    if is_chinese(tag) {
        Availability::Ready
    } else {
        Availability::WrongLanguage
    }
}

/// 从"系统语言 + 这台机器支持的语言"里挑一个能用的。
///
/// 系统那个是中文就直接用它（不折腾）；否则在支持列表里找一个 `zh-*` ——
/// `SpeechRecognizer::Create(language)` 允许指定语言，所以"系统是英文、但这台机器
/// 装了中文听写"是有救的，不该判死。**一个都没有**才是真的做不了。
pub fn pick_language(system: &str, supported: &[String]) -> Option<String> {
    if is_chinese(system) {
        return Some(system.trim().to_string());
    }
    supported
        .iter()
        .find(|tag| is_chinese(tag))
        .map(|tag| tag.trim().to_string())
}

/// SAPI 令牌的 `Language` 属性 → 语言 tag。
///
/// 经典 SAPI 把语言记成 **LCID 的十六进制字符串**（不带 `0x`：本机中文令牌是
/// `804`、英文令牌是 `409;9`），而且可以是一串分号分隔的备选值。主语言 ID 在低
/// 10 位，`0x04` 是中文；次语言 ID 在 10–15 位，决定是简体还是繁体。
///
/// **按十进制解析会静默错一位**：`804` 当十进制是 0x324（主语言 0x24，不是中文），
/// 于是"这台机器有中文"被读成"没有" —— 症状和真的没装语音包一模一样。
///
/// **只认中文**，别的语言返回 `None`：这个功能只关心中文，把英文也映射出来只会
/// 让调用方多写一个用不上的分支。
///
/// 这条判断以前不存在，是因为 WinRT 直接给 BCP-47 标签。换成 SAPI 之后语言只剩
/// 数字，而"804 算不算中文"这种判断写进 COM 那半就再也测不了了。
pub fn lcid_tag(raw: &str) -> Option<String> {
    raw.split(';')
        .filter_map(|part| u32::from_str_radix(part.trim(), 16).ok())
        .find_map(|lcid| {
            if lcid & 0x3ff != 0x04 {
                return None;
            }
            let sub = (lcid >> 10) & 0x3f;
            Some(
                match sub {
                    1 => "zh-TW",
                    2 => "zh-CN",
                    3 => "zh-HK",
                    4 => "zh-SG",
                    // 只知道是中文、不知道是哪一支：仍然能用，tag 交给上层显示
                    _ => "zh",
                }
                .to_string(),
            )
        })
}

/// LCID 字符串 → 主语言名，只给"为什么不能听写"那句话用。
///
/// `lcid_tag` 对非中文一律回 `None`（判断只需要中文），但错误文案里写
/// "系统语音语言是 (读不出来)" 是在撒谎 —— 我们明明读到了，只是不是中文。
/// 所以这里补一个**只用来显示**的名字表，覆盖本机可能出现的那几种。
pub fn lcid_language(raw: &str) -> Option<&'static str> {
    let first = raw
        .split(';')
        .find_map(|part| u32::from_str_radix(part.trim(), 16).ok())?;
    Some(match first & 0x3ff {
        0x04 => "Chinese",
        0x07 => "German",
        0x09 => "English",
        0x0a => "Spanish",
        0x0c => "French",
        0x11 => "Japanese",
        0x12 => "Korean",
        0x19 => "Russian",
        _ => return None,
    })
}

/// 识别结果 → 要不要往上交。
///
/// 只有空白的结果等于"没听到"：`RecognizeAsync` 在没人说话时也会成功返回一个空
/// 字符串，把它当一句话交上去，用户会看到一条空提示。
pub fn heard(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 太长了吗。超限**拒绝不截断** —— 截断会把半句话打进别人的窗口，而用户不知道
pub fn too_long(text: &str) -> bool {
    text.chars().count() > MAX_TYPE_CHARS
}

/// 开听时那个窗口 == 出字前的那个窗口（`0` 不算任何窗口）。
///
/// 用户可能切走又切回来（仍然是同一扇窗口，仍然该打字），也可能切到另一个同类窗口
/// （两个记事本，不该打字）。只有这一条同时处理了两种。
pub fn same_window(before: isize, now: isize) -> bool {
    before != 0 && before == now
}

/// 浮钮上能被说出来的一个键。
///
/// 只收这四类：空格、F1–F24、字母、数字。理由不是"省事"，而是每一个都要能在
/// `global-hotkey` 的 `Code` 里找到确定的对应 —— 映射错了的症状是"设了热键但按了
/// 没反应"，而这个名字菜单里看得见、代码里查不出来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyKey {
    Space,
    F(u8),
    Letter(char),
    Digit(u8),
}

impl HotkeyKey {
    /// 写回文件 / 显示在设置页里的那个名字
    pub fn label(self) -> String {
        match self {
            HotkeyKey::Space => "Space".to_string(),
            HotkeyKey::F(number) => format!("F{number}"),
            HotkeyKey::Letter(letter) => letter.to_ascii_uppercase().to_string(),
            HotkeyKey::Digit(digit) => digit.to_string(),
        }
    }
}

/// 一个全局热键。修饰键各占一位，主键是 `key`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hotkey {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
    pub key: HotkeyKey,
}

impl Hotkey {
    /// 规范写法：修饰键固定顺序 `Ctrl+Alt+Shift+Win`，最后是主键。
    ///
    /// 顺序固定不是为了好看：同一个热键写出两种字符串，`dictation.json` 里就会
    /// 前后不一致，而"用户改过没改过"要靠字符串比。
    pub fn label(&self) -> String {
        let mut out = String::new();
        for (set, name) in [
            (self.ctrl, "Ctrl"),
            (self.alt, "Alt"),
            (self.shift, "Shift"),
            (self.win, "Win"),
        ] {
            if set {
                if !out.is_empty() {
                    out.push('+');
                }
                out.push_str(name);
            }
        }
        if !out.is_empty() {
            out.push('+');
        }
        out.push_str(&self.key.label());
        out
    }
}

/// 字符串 → 热键。**必须恰好有一个主键，且至少有一个修饰键**。
///
/// 没有修饰键的全局热键（一个裸 `Space`）等于把这个键从所有程序手里抢走 ——
/// 用户打不了空格，而菜单里那一行还写着"听写的热键"。
pub fn parse_hotkey(raw: &str) -> Result<Hotkey, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("\"hotkey\" must not be empty".to_string());
    }
    if trimmed.chars().count() > 40 {
        return Err(format!("\"{trimmed}\" is too long to be a hotkey"));
    }

    let mut hotkey = Hotkey {
        ctrl: false,
        shift: false,
        alt: false,
        win: false,
        key: HotkeyKey::Space,
    };
    let mut key: Option<&str> = None;

    for segment in trimmed.split('+') {
        let segment = segment.trim();
        if segment.is_empty() {
            return Err(format!("\"{trimmed}\" has an empty part"));
        }
        match segment.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "ctl" => hotkey.ctrl = true,
            "shift" => hotkey.shift = true,
            "alt" | "option" => hotkey.alt = true,
            "win" | "meta" | "super" | "cmd" => hotkey.win = true,
            _ => {
                if key.is_some() {
                    return Err(format!("\"{trimmed}\" names more than one key"));
                }
                key = Some(segment);
            }
        }
    }

    let Some(key) = key else {
        return Err(format!("\"{trimmed}\" has modifiers but no key"));
    };
    if !(hotkey.ctrl || hotkey.alt || hotkey.shift || hotkey.win) {
        return Err(format!("\"{trimmed}\" needs at least one modifier"));
    }
    hotkey.key = parse_key(key)?;
    Ok(hotkey)
}

fn parse_key(raw: &str) -> Result<HotkeyKey, String> {
    let lower = raw.trim().to_ascii_lowercase();
    if lower == "space" || lower == "spacebar" {
        return Ok(HotkeyKey::Space);
    }
    if let Some(rest) = lower.strip_prefix('f') {
        if let Ok(number) = rest.parse::<u8>() {
            if (1..=24).contains(&number) {
                return Ok(HotkeyKey::F(number));
            }
        }
        return Err(format!("I do not know the key \"{raw}\""));
    }
    let mut chars = lower.chars();
    if let (Some(only), None) = (chars.next(), chars.next()) {
        if only.is_ascii_alphabetic() {
            return Ok(HotkeyKey::Letter(only));
        }
        if let Some(digit) = only.to_digit(10) {
            return Ok(HotkeyKey::Digit(digit as u8));
        }
    }
    Err(format!("I do not know the key \"{raw}\""))
}

/// `dictation.json` 读出来的东西。四个字段，一个都不许让文件决定"能不能用"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// 总开关。默认 `false`，和 agent 端点同一条规矩：关着就不建浮钮、不注册热键、
    /// 不碰麦克风
    pub enabled: bool,
    /// 规范写法的热键字符串
    pub hotkey: String,
    /// 浮钮相对工作区右下角的偏移
    pub dx: i32,
    pub dy: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            hotkey: DEFAULT_HOTKEY.to_string(),
            dx: DEFAULT_DX,
            dy: DEFAULT_DY,
        }
    }
}

/// 逐项归一化。`None`（缺字段 / 类型不对 / 文件读坏了）一律落默认值。
///
/// 取的是"调用方已经拆好的字段"，不是 JSON 字符串：这个文件不许引 `serde_json`，
/// 而把"这份文件只影响三件事"这条规矩放在这里，比放在读盘那半更该被钉住。
pub fn normalize(
    enabled: Option<bool>,
    hotkey: Option<&str>,
    dx: Option<i32>,
    dy: Option<i32>,
) -> Settings {
    let defaults = Settings::default();
    Settings {
        enabled: enabled.unwrap_or(defaults.enabled),
        hotkey: hotkey
            .and_then(|raw| parse_hotkey(raw).ok())
            .map_or(defaults.hotkey, |parsed| parsed.label()),
        dx: clamp_offset(dx.unwrap_or(defaults.dx)),
        dy: clamp_offset(dy.unwrap_or(defaults.dy)),
    }
}

/// "为什么不能听写"—— 三句话对应三个不同的动作（0032 §4）。
///
/// `supported` 是 `SupportedTopicLanguages()` 的条数，`usable` 是"挑出了一个 `zh-*`"。
/// 前者 0 表示这台机器**没有语音识别组件**（要去装），非 0 而后者假表示
/// **有组件但没有中文**（要去加语言）—— 0027 §7 量过这两件事，文案一直是分开的，
/// 这次把它变成状态的一部分，好让设置页和 tooltip 说同一句话。
pub fn unavailable_reason(supported: usize, usable: bool) -> Option<&'static str> {
    if usable {
        return None;
    }
    if supported == 0 {
        Some("no_engine")
    } else {
        Some("no_chinese")
    }
}

fn clamp_offset(value: i32) -> i32 {
    value.clamp(-MAX_OFFSET, MAX_OFFSET)
}

/// 浮钮的左上角：工作区右下角 + 偏移，再钳进工作区。
///
/// `work` 是当前显示器的工作区 `[x, y, w, h]`（物理像素）。钳制这一步防的是
/// "笔记本拔掉外接屏"：偏移是相对上一次那块屏记的，那块屏没了之后它就越界了。
pub fn button_origin(dx: i32, dy: i32, work: [i32; 4], size: i32) -> (i32, i32) {
    let [left, top, width, height] = work;
    let size = size.max(1);
    let x = left + width + clamp_offset(dx) - size;
    let y = top + height + clamp_offset(dy) - size;
    let max_x = (left + width - size).max(left);
    let max_y = (top + height - size).max(top);
    (x.clamp(left, max_x), y.clamp(top, max_y))
}

/// 拖动后的位置 → 存盘的偏移（`button_origin` 的逆运算）。
pub fn button_offset(origin: (i32, i32), work: [i32; 4], size: i32) -> (i32, i32) {
    let [left, top, width, height] = work;
    let size = size.max(1);
    (
        clamp_offset(origin.0 - (left + width - size)),
        clamp_offset(origin.1 - (top + height - size)),
    )
}

/// 松手时这一下算点击还是拖动。
///
/// 用平方距离：4px 的判定不需要开方，而"差一点点"的取舍在这里没有意义。
pub fn is_click(travel_x: i32, travel_y: i32) -> bool {
    let travel_x = travel_x as i64;
    let travel_y = travel_y as i64;
    travel_x * travel_x + travel_y * travel_y < (CLICK_SLOP as i64) * (CLICK_SLOP as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- 语言 -------------------------------------------------------------

    #[test]
    fn chinese_tags_are_ready() {
        for tag in ["zh-CN", "zh-TW", "zh-Hans", "zh", "ZH-cn", " zh-Hant "] {
            assert_eq!(availability_for(tag), Availability::Ready, "tag={tag}");
            assert!(is_chinese(tag), "tag={tag}");
        }
    }

    #[test]
    fn other_languages_are_wrong_language() {
        for tag in ["en-US", "ja-JP", "", "  ", "zhx", "z", "zh_CN"] {
            assert_eq!(
                availability_for(tag),
                Availability::WrongLanguage,
                "tag={tag}"
            );
            assert!(!is_chinese(tag), "tag={tag}");
        }
    }

    #[test]
    fn a_prefix_that_only_looks_chinese_is_not() {
        // `zh` 后面必须是 `-` 或者到头。少这一条，`zhx` / `zh_CN` 会被当成中文，
        // 用户说了中文出来一串乱码，而界面上没有一处提示
        assert!(!is_chinese("zhx"));
        assert!(!is_chinese("zh_CN"));
        assert!(is_chinese("zh-Hans"));
    }

    #[test]
    fn the_system_language_wins_when_it_is_chinese() {
        let supported = vec!["en-US".to_string(), "zh-TW".to_string()];
        assert_eq!(pick_language("zh-CN", &supported).as_deref(), Some("zh-CN"));
    }

    #[test]
    fn an_english_system_with_a_chinese_pack_still_works() {
        // 0027 §7① 的前提错了：`SpeechRecognizer::Create(language)` 在，所以
        // "系统是英文"不等于"不能听写中文"——只要这台机器装了中文听写
        let supported = vec!["en-US".to_string(), "zh-CN".to_string()];
        assert_eq!(pick_language("en-US", &supported).as_deref(), Some("zh-CN"));
    }

    #[test]
    fn no_chinese_anywhere_means_no_dictation() {
        let supported = vec!["en-US".to_string(), "ja-JP".to_string()];
        assert_eq!(pick_language("en-US", &supported), None);
        assert_eq!(pick_language("", &[]), None);
    }

    // --- SAPI 的 LCID -----------------------------------------------------

    #[test]
    fn the_chinese_lcids_map_to_their_branches() {
        // 本机 zh-CN 令牌的 Language 属性就是 "804"
        assert_eq!(lcid_tag("804").as_deref(), Some("zh-CN"));
        assert_eq!(lcid_tag("404").as_deref(), Some("zh-TW"));
        assert_eq!(lcid_tag("c04").as_deref(), Some("zh-HK"));
        assert_eq!(lcid_tag("1004").as_deref(), Some("zh-SG"));
        // 只有主语言、没有次语言：仍然是中文，只是说不清哪一支
        assert_eq!(lcid_tag("4").as_deref(), Some("zh"));
    }

    #[test]
    fn other_lcids_are_not_chinese() {
        // 409 = en-US，本机英文令牌的完整属性是 "409;9"（分号后面是备选值）
        assert_eq!(lcid_tag("409"), None);
        assert_eq!(lcid_tag("409;9"), None);
        assert_eq!(lcid_tag("411"), None); // ja-JP
        assert_eq!(lcid_tag(""), None);
        assert_eq!(lcid_tag("hmm"), None);
    }

    #[test]
    fn a_mixed_lcid_list_still_finds_the_chinese_one() {
        // 一个令牌可以同时声明几种语言。**列表里有中文就算有** —— 只看第一项会
        // 把"支持中英双语"的令牌判成英文，然后告诉用户"这台机器没有中文"
        assert_eq!(lcid_tag("409;804").as_deref(), Some("zh-CN"));
        assert_eq!(lcid_tag(" 804 ; 409 ").as_deref(), Some("zh-CN"));
    }

    #[test]
    fn the_lcid_tag_is_recognised_by_the_same_predicate_as_a_bcp47_tag() {
        // 两条路最后都要过 `is_chinese`：LCID 映射出来的 tag 不许在别处被否掉
        for raw in ["804", "404", "c04", "1004", "4"] {
            let tag = lcid_tag(raw).expect("must map");
            assert!(is_chinese(&tag), "lcid={raw} tag={tag}");
        }
    }

    #[test]
    fn the_language_name_is_only_for_the_error_message() {
        // 本机两种令牌：中文 "804"、英文 "409;9"
        assert_eq!(lcid_language("804"), Some("Chinese"));
        assert_eq!(lcid_language("409;9"), Some("English"));
        assert_eq!(lcid_language("411"), Some("Japanese"));
        // 表里没有的语言不许瞎猜
        assert_eq!(lcid_language("1234"), None);
        assert_eq!(lcid_language(""), None);
        assert_eq!(lcid_language("hmm"), None);
    }

    // --- 识别结果 ---------------------------------------------------------

    #[test]
    fn text_is_trimmed() {
        assert_eq!(heard("  你好  ").as_deref(), Some("你好"));
        assert_eq!(heard("帮我把这句话记下来。").as_deref(), Some("帮我把这句话记下来。"));
    }

    #[test]
    fn whitespace_only_is_nothing_heard() {
        assert_eq!(heard(""), None);
        assert_eq!(heard("   "), None);
        assert_eq!(heard("\r\n\t"), None);
    }

    #[test]
    fn inner_whitespace_is_kept() {
        // 中间的换行和缩进是用户说出来的结构（比如"第一行、第二行"），不许折叠
        assert_eq!(heard("  a\nb  ").as_deref(), Some("a\nb"));
    }

    // --- 注入上限 ---------------------------------------------------------

    #[test]
    fn exactly_the_limit_is_allowed() {
        let text = "字".repeat(MAX_TYPE_CHARS);
        assert!(!too_long(&text));
    }

    #[test]
    fn one_over_the_limit_is_refused() {
        let text = "字".repeat(MAX_TYPE_CHARS + 1);
        assert!(too_long(&text));
    }

    #[test]
    fn the_limit_counts_characters_not_bytes() {
        // 4000 个汉字是 12 000 字节。按字节判会把三句话就顶到上限
        let text = "中".repeat(MAX_TYPE_CHARS);
        assert_eq!(text.len(), MAX_TYPE_CHARS * 3);
        assert!(!too_long(&text));
    }

    // --- 焦点 -------------------------------------------------------------

    #[test]
    fn the_same_window_may_be_typed_into() {
        assert!(same_window(0x1234, 0x1234));
    }

    #[test]
    fn zero_is_never_a_window() {
        // `GetForegroundWindow()` 在某些时刻返回 0（桌面、锁屏）。0 == 0 不算同一扇窗
        assert!(!same_window(0, 0));
        assert!(!same_window(0, 0x1234));
        assert!(!same_window(0x1234, 0));
    }

    #[test]
    fn another_window_is_refused() {
        // 两个记事本也是两扇窗：切到另一个同类窗口仍然不该打字
        assert!(!same_window(0x1234, 0x5678));
    }

    // --- 热键 -------------------------------------------------------------

    #[test]
    fn the_default_hotkey_round_trips() {
        let hotkey = parse_hotkey(DEFAULT_HOTKEY).expect("the default hotkey must parse");
        assert_eq!(hotkey.label(), DEFAULT_HOTKEY);
        assert!(hotkey.ctrl && hotkey.alt && !hotkey.shift && !hotkey.win);
        assert_eq!(hotkey.key, HotkeyKey::Space);
    }

    #[test]
    fn modifier_order_does_not_matter_but_the_label_is_canonical() {
        let a = parse_hotkey("Alt+Ctrl+Space").unwrap();
        let b = parse_hotkey("Ctrl+Alt+Space").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.label(), "Ctrl+Alt+Space");
        assert_eq!(
            parse_hotkey("shift+win+ctrl+f5").unwrap().label(),
            "Ctrl+Shift+Win+F5"
        );
    }

    #[test]
    fn a_bare_key_is_refused() {
        // 裸 `Space` 会把空格从所有程序手里抢走
        assert!(parse_hotkey("Space").is_err());
        assert!(parse_hotkey("Ctrl+").is_err());
        assert!(parse_hotkey("Ctrl+Alt").is_err());
        assert!(parse_hotkey("   ").is_err());
    }

    #[test]
    fn two_keys_are_refused() {
        assert!(parse_hotkey("Ctrl+A+B").is_err());
    }

    #[test]
    fn unknown_keys_are_refused() {
        for raw in ["Ctrl+Alt+F25", "Ctrl+Alt+F0", "Ctrl+Alt+Hmm", "Ctrl+alt+"] {
            assert!(parse_hotkey(raw).is_err(), "raw={raw}");
        }
        assert_eq!(parse_hotkey("Ctrl+Alt+1").unwrap().key, HotkeyKey::Digit(1));
        assert_eq!(parse_hotkey("Ctrl+Alt+f12").unwrap().key, HotkeyKey::F(12));
    }

    // --- dictation.json ---------------------------------------------------

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let settings = normalize(None, None, None, None);
        assert_eq!(settings, Settings::default());
        assert!(!settings.enabled);
    }

    #[test]
    fn bad_values_fall_back_field_by_field() {
        // 只有坏的那一项退回默认，别的照旧 —— 一份读坏的文件不该把总开关也关掉
        let settings = normalize(Some(true), Some("人"), Some(123_456), Some(-7));
        assert!(settings.enabled);
        assert_eq!(settings.hotkey, DEFAULT_HOTKEY);
        assert_eq!(settings.dx, MAX_OFFSET);
        assert_eq!(settings.dy, -7);
    }

    #[test]
    fn a_good_hotkey_is_kept_in_canonical_form() {
        let settings = normalize(None, Some("alt+Ctrl+F5"), None, None);
        assert_eq!(settings.hotkey, "Ctrl+Alt+F5");
    }

    /// 0032 §4：三种原因对应三个不同动作，所以它是状态的一部分，不是文案细节
    #[test]
    fn the_reason_says_which_action_is_missing() {
        assert_eq!(unavailable_reason(0, false), Some("no_engine"));
        assert_eq!(unavailable_reason(3, false), Some("no_chinese"));
        assert_eq!(unavailable_reason(3, true), None);
        // 系统语言本来就是 zh-*、列表却回 0：能听，不许报原因
        assert_eq!(unavailable_reason(0, true), None);
    }

    // --- 浮钮几何 ---------------------------------------------------------

    /// 主屏工作区：0,0 1920×1040（底下 40px 是任务栏）
    const WORK: [i32; 4] = [0, 0, 1920, 1040];

    #[test]
    fn the_default_offset_is_the_bottom_right_corner() {
        let (x, y) = button_origin(DEFAULT_DX, DEFAULT_DY, WORK, BUTTON_SIZE);
        assert_eq!(x, 1920 - 120 - BUTTON_SIZE);
        assert_eq!(y, 1040 - 120 - BUTTON_SIZE);
        // 右下角内侧，且整个钮在工作区里
        assert!(x + BUTTON_SIZE <= 1920);
        assert!(y + BUTTON_SIZE <= 1040);
    }

    #[test]
    fn an_offset_from_another_screen_is_clamped_back() {
        // 上次记的是"在 3456 宽那块屏上、右上角"，这会儿只有 1920 —— 偏移算出来
        // 是 x = 1920 - 1400 - 28，落在屏幕里；dy 是 -2000，算出来是负数，要夹回 0
        let (x, y) = button_origin(-1400, -2000, WORK, BUTTON_SIZE);
        assert!(x >= 0 && x + BUTTON_SIZE <= 1920, "x={x}");
        assert!(y >= 0 && y + BUTTON_SIZE <= 1040, "y={y}");
        assert_eq!(y, 0);
    }

    #[test]
    fn a_positive_offset_is_clamped_too() {
        // 偏移写反了（正数 = 往右下）。不夹的话钮会飞出工作区，用户找不回来
        let (x, y) = button_origin(500, 500, WORK, BUTTON_SIZE);
        assert_eq!(x, 1920 - BUTTON_SIZE);
        assert_eq!(y, 1040 - BUTTON_SIZE);
    }

    #[test]
    fn dragging_then_reading_back_gives_the_same_place() {
        let origin = (700, 400);
        let (dx, dy) = button_offset(origin, WORK, BUTTON_SIZE);
        assert_eq!(button_origin(dx, dy, WORK, BUTTON_SIZE), origin);
    }

    // --- 点击判据 ---------------------------------------------------------

    #[test]
    fn a_three_pixel_trip_is_a_click_but_five_is_a_drag() {
        assert!(is_click(3, 0));
        assert!(is_click(0, 3));
        assert!(is_click(2, 2));
        assert!(!is_click(5, 0));
        assert!(!is_click(0, 5));
        assert!(!is_click(4, 1));
    }
}
