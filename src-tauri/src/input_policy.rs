//! 键鼠那只手的形状 —— **纯逻辑**，`SendInput` 在 `hands.rs` 里。
//!
//! 三件事，全都能在不动鼠标键盘的前提下测：
//!
//! 1. `"Ctrl+S"` 这种说法怎么变成一串虚拟键码（`parse_chord`）。
//! 2. 一段文字怎么变成按键序列（`type_plan`）—— 中文不能按字符发键码，
//!    只能一个 UTF-16 单元一条 `KEYEVENTF_UNICODE`。
//! 3. 屏幕坐标怎么变成 `SendInput` 要的 `0..=65535`（`absolute`）。
//!
//! **坐标这条最容易错**：`SendInput` 的绝对坐标是按**虚拟桌面**归一化的，
//! 双屏时主屏的宽度不是分母 —— 用主屏宽度算，副屏上的点会全部落到主屏
//! 右侧那一小块里。分母必须是 `GetSystemMetrics` 的 `SM_CXVIRTUALSCREEN`。
//!
//! 不引 crate：这个文件要能在写不了 `target/debug/deps` 的机器上单独跑。

/// 一次最多敲多少字符。
///
/// 4000 字已经远超"帮我填个表单"，而 4000 条 `SendInput` 大约要 1~2 秒 ——
/// 用户按下 Allow 之后盯着屏幕的那两秒就是上限。再长就该用 `file.write`
/// 或者 `shell.run`，不该让键盘慢慢敲。
pub const MAX_TYPE_CHARS: usize = 4000;

/// `SendInput` 的绝对坐标是 16 位归一化的
const ABSOLUTE_MAX: i64 = 65535;

// 虚拟键码。只列这里用得到的那几个；`windows-sys` 里有全套常量，
// 但这个文件不许引 crate，所以自己写一遍（数值是 Win32 的公开 ABI）。
const VK_BACK: u16 = 0x08;
const VK_TAB: u16 = 0x09;
const VK_RETURN: u16 = 0x0D;
const VK_PAUSE: u16 = 0x13;
const VK_CAPITAL: u16 = 0x14;
const VK_ESCAPE: u16 = 0x1B;
const VK_PRIOR: u16 = 0x21;
const VK_NEXT: u16 = 0x22;
const VK_END: u16 = 0x23;
const VK_HOME: u16 = 0x24;
const VK_LEFT: u16 = 0x25;
const VK_UP: u16 = 0x26;
const VK_RIGHT: u16 = 0x27;
const VK_DOWN: u16 = 0x28;
const VK_SNAPSHOT: u16 = 0x2C;
const VK_INSERT: u16 = 0x2D;
const VK_DELETE: u16 = 0x2E;

/// 一个按键组合。`vk` 是主键，修饰键各占一位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chord {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
    pub vk: u16,
}

impl Chord {
    /// 按下去的顺序：修饰键先、主键后；松开反过来。
    /// 反了的话 `Ctrl+S` 会变成"先按 S 再按 Ctrl"——那是两个独立的输入。
    pub fn modifiers(&self) -> Vec<u16> {
        let mut out = Vec::new();
        if self.ctrl {
            out.push(0x11); // VK_CONTROL
        }
        if self.shift {
            out.push(0x10); // VK_SHIFT
        }
        if self.alt {
            out.push(0x12); // VK_MENU
        }
        if self.win {
            out.push(0x5B); // VK_LWIN
        }
        out
    }
}

/// 名字 → 虚拟键码。认不出来就是 `None`（由调用方变成一句人话）。
pub fn vk_of(name: &str) -> Option<u16> {
    let lower = name.trim().to_ascii_lowercase();
    let named = match lower.as_str() {
        "enter" | "return" => VK_RETURN,
        "esc" | "escape" => VK_ESCAPE,
        "tab" => VK_TAB,
        "space" | "spacebar" => 0x20,
        "backspace" | "back" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "insert" | "ins" => VK_INSERT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" | "pgup" => VK_PRIOR,
        "pagedown" | "pgdn" => VK_NEXT,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "printscreen" | "prtsc" => VK_SNAPSHOT,
        "pause" => VK_PAUSE,
        "capslock" | "caps" => VK_CAPITAL,
        "plus" => 0xBB, // 主键盘的 + 是 Shift 加 = 那个键
        _ => 0,
    };
    if named != 0 {
        return Some(named);
    }

    // F1..F24：0x70 起
    if let Some(rest) = lower.strip_prefix('f') {
        if let Ok(number) = rest.parse::<u8>() {
            if (1..=24).contains(&number) {
                return Some(0x6F + number as u16);
            }
        }
    }

    // 单个 ASCII 字符
    let mut chars = name.chars();
    let first = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    Some(match first {
        'a'..='z' => first.to_ascii_uppercase() as u16,
        'A'..='Z' => first as u16,
        '0'..='9' => first as u16,
        ';' => 0xBA,
        '=' => 0xBB,
        '+' => 0xBB,
        ',' => 0xBC,
        '-' => 0xBD,
        '.' => 0xBE,
        '/' => 0xBF,
        '`' => 0xC0,
        '[' => 0xDB,
        '\\' => 0xDC,
        ']' => 0xDD,
        '\'' => 0xDE,
        _ => return None,
    })
}

/// `"Ctrl+Shift+S"` / `"Enter"` / `"F5"` / `"Ctrl++"` → `Chord`。
///
/// 修饰键的位置不重要（`Shift+Ctrl+S` 一样），但**必须恰好有一个主键**。
/// 一个都没有（`"Ctrl"`）是写坏了；有两个（`"Ctrl+A+B"`）也是 ——
/// 那种情况下猜一个，用户看到的是"按了但没反应"。
pub fn parse_chord(raw: &str) -> Result<Chord, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("\"key\" must not be empty".to_string());
    }

    // `Ctrl++`：末尾那个 `++` 里的后一个加号是键，前一个是分隔符。
    // 先把它摘出去，剩下的部分才按 `+` 切 —— 否则会切出两个空段。
    let (body, forced_key) = match trimmed.strip_suffix("++") {
        Some(body) => (body, Some("+")),
        None => (trimmed, None),
    };

    let mut chord = Chord {
        ctrl: false,
        shift: false,
        alt: false,
        win: false,
        vk: 0,
    };
    let mut key: Option<&str> = forced_key;

    for segment in body.split('+') {
        let segment = segment.trim();
        if segment.is_empty() {
            // 只有 `++` 本身（body 为空）时切出来的是一个空段，那是合法的
            if body.is_empty() {
                continue;
            }
            return Err(format!("\"{raw}\" has an empty part"));
        }
        match segment.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "ctl" => chord.ctrl = true,
            "shift" => chord.shift = true,
            "alt" | "option" => chord.alt = true,
            "win" | "meta" | "super" | "cmd" => chord.win = true,
            _ => {
                if key.is_some() {
                    return Err(format!("\"{raw}\" names more than one key"));
                }
                key = Some(segment);
            }
        }
    }

    let Some(key) = key else {
        return Err(format!("\"{raw}\" has modifiers but no key"));
    };
    chord.vk = vk_of(key).ok_or_else(|| format!("I do not know the key \"{key}\""))?;
    Ok(chord)
}

/// 方向键 / 编辑键必须带 `KEYEVENTF_EXTENDEDKEY`。
///
/// 不带的话，小键盘 NumLock 开着时 `Home` 会被当成小键盘的 7，
/// 而这个错**只在某些机器上、某些输入法下**出现 —— 是那种"用户说点了没反应"
/// 而开发者本地永远复现不了的 bug。
pub fn needs_extended(vk: u16) -> bool {
    matches!(
        vk,
        VK_PRIOR | VK_NEXT | VK_END | VK_HOME | VK_LEFT | VK_UP | VK_RIGHT | VK_DOWN
            | VK_SNAPSHOT | VK_INSERT | VK_DELETE
    )
}

/// 一段文字里的一步。分开是因为它们走两条完全不同的路：
/// `Unit` 是"这个码点"，`Virtual` 是"这个键"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// 一个 UTF-16 单元，`KEYEVENTF_UNICODE` 发出去 — 中文、emoji 都走这条
    Unit(u16),
    /// 一个真实的键（Enter / Tab），按虚拟键码发
    Virtual(u16),
}

/// 文字 → 按键序列。
///
/// - 换行一律变成 `Enter`（`\r\n` 只算一次，模型经常给成对的）；
/// - 制表符变成 `Tab`；
/// - 其余控制字符**丢掉**：它们敲不出任何可见的东西，而发一个
///   `KEYEVENTF_UNICODE` 的 `\x00` 会被系统当成"没有输入"；
/// - 其余字符按 UTF-16 拆（emoji 是两个单元，必须两个都发）。
pub fn type_plan(text: &str) -> Result<Vec<Step>, String> {
    if text.is_empty() {
        return Err("\"text\" must not be empty".to_string());
    }
    let chars = text.chars().count();
    if chars > MAX_TYPE_CHARS {
        return Err(format!(
            "that is {chars} characters; I can type at most {MAX_TYPE_CHARS} at a time"
        ));
    }

    let mut steps = Vec::new();
    let mut iter = text.chars().peekable();
    while let Some(ch) = iter.next() {
        match ch {
            '\r' => {
                if iter.peek() == Some(&'\n') {
                    iter.next();
                }
                steps.push(Step::Virtual(VK_RETURN));
            }
            '\n' => steps.push(Step::Virtual(VK_RETURN)),
            '\t' => steps.push(Step::Virtual(VK_TAB)),
            ch if (ch as u32) < 0x20 || ch == '\u{7f}' => {}
            ch => {
                let mut buffer = [0u16; 2];
                for unit in ch.encode_utf16(&mut buffer) {
                    steps.push(Step::Unit(*unit));
                }
            }
        }
    }

    if steps.is_empty() {
        return Err("there is nothing in \"text\" that can be typed".to_string());
    }
    Ok(steps)
}

/// 屏幕坐标 → `SendInput` 的绝对坐标（0..=65535）。
///
/// `left/top/width/height` 是**虚拟桌面**的矩形（所有显示器合起来那一块）。
/// 落在矩形外面就返回 `None` —— 不是为了省事，而是"点一个不存在的坐标"
/// 和"点错地方"是同一件事，而后者会动用户的真实鼠标。
pub fn absolute(x: i32, y: i32, left: i32, top: i32, width: i32, height: i32) -> Option<(i32, i32)> {
    if width <= 1 || height <= 1 {
        return None;
    }
    if x < left || y < top || x >= left + width || y >= top + height {
        return None;
    }
    let ax = ((x - left) as i64 * ABSOLUTE_MAX / (width as i64 - 1)) as i32;
    let ay = ((y - top) as i64 * ABSOLUTE_MAX / (height as i64 - 1)) as i32;
    Some((ax, ay))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_letter_key_is_its_own_virtual_code() {
        assert_eq!(vk_of("s"), Some(0x53));
        assert_eq!(vk_of("S"), Some(0x53));
        assert_eq!(vk_of("1"), Some(0x31));
    }

    #[test]
    fn named_keys_cover_the_ones_a_model_actually_says() {
        assert_eq!(vk_of("Enter"), Some(VK_RETURN));
        assert_eq!(vk_of("esc"), Some(VK_ESCAPE));
        assert_eq!(vk_of("PageDown"), Some(VK_NEXT));
        assert_eq!(vk_of("F5"), Some(0x74));
        assert_eq!(vk_of("f24"), Some(0x87));
    }

    #[test]
    fn an_unknown_key_is_none_not_a_guess() {
        assert_eq!(vk_of("hyper"), None);
        assert_eq!(vk_of(""), None);
        assert_eq!(vk_of("f25"), None);
        // 多字符但不是键名
        assert_eq!(vk_of("ab"), None);
    }

    #[test]
    fn punctuation_maps_to_the_oem_keys() {
        assert_eq!(vk_of(";"), Some(0xBA));
        assert_eq!(vk_of("/"), Some(0xBF));
        assert_eq!(vk_of("+"), Some(0xBB));
    }

    #[test]
    fn a_chord_picks_up_its_modifiers() {
        let chord = parse_chord("Ctrl+S").unwrap();
        assert!(chord.ctrl);
        assert!(!chord.shift);
        assert_eq!(chord.vk, 0x53);
        assert_eq!(chord.modifiers(), vec![0x11]);
    }

    #[test]
    fn modifiers_may_come_in_any_order() {
        let chord = parse_chord("shift + ctrl + s").unwrap();
        assert!(chord.ctrl && chord.shift);
        assert_eq!(chord.vk, 0x53);
    }

    #[test]
    fn a_bare_key_is_a_chord_without_modifiers() {
        let chord = parse_chord("Enter").unwrap();
        assert!(chord.modifiers().is_empty());
        assert_eq!(chord.vk, VK_RETURN);
    }

    #[test]
    fn the_plus_key_itself_parses() {
        let chord = parse_chord("Ctrl++").unwrap();
        assert!(chord.ctrl);
        assert_eq!(chord.vk, 0xBB);
    }

    #[test]
    fn a_chord_with_no_key_is_rejected() {
        assert!(parse_chord("Ctrl").is_err());
        assert!(parse_chord("").is_err());
        assert!(parse_chord("Ctrl+Shift").is_err());
    }

    #[test]
    fn a_chord_with_two_keys_is_rejected() {
        // 猜一个的后果是"按了但没反应"，比报错难查得多
        assert!(parse_chord("Ctrl+A+B").is_err());
    }

    #[test]
    fn an_unknown_key_in_a_chord_is_rejected() {
        assert!(parse_chord("Ctrl+Hyper").is_err());
    }

    #[test]
    fn navigation_keys_need_the_extended_flag() {
        assert!(needs_extended(VK_HOME));
        assert!(needs_extended(VK_DELETE));
        assert!(!needs_extended(0x53)); // S
        assert!(!needs_extended(0x70)); // F1
    }

    #[test]
    fn plain_text_becomes_one_unit_per_character() {
        let plan = type_plan("ab").unwrap();
        assert_eq!(plan, vec![Step::Unit(b'a' as u16), Step::Unit(b'b' as u16)]);
    }

    #[test]
    fn chinese_is_sent_as_utf16_units() {
        let plan = type_plan("你好").unwrap();
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0], Step::Unit('你' as u16));
    }

    #[test]
    fn an_emoji_is_two_units_and_both_are_sent() {
        // KEYEVENTF_UNICODE 按 UTF-16 工作：漏掉低代理项会打出一个乱码方块
        let plan = type_plan("😀").unwrap();
        assert_eq!(plan.len(), 2);
        assert!(matches!(plan[0], Step::Unit(u) if (0xD800..0xDC00).contains(&u)));
        assert!(matches!(plan[1], Step::Unit(u) if (0xDC00..0xE000).contains(&u)));
    }

    #[test]
    fn newlines_become_enter_and_crlf_counts_once() {
        assert_eq!(type_plan("a\r\nb").unwrap(), vec![
            Step::Unit(b'a' as u16),
            Step::Virtual(VK_RETURN),
            Step::Unit(b'b' as u16),
        ]);
        assert_eq!(type_plan("\n").unwrap(), vec![Step::Virtual(VK_RETURN)]);
    }

    #[test]
    fn a_tab_is_a_real_tab_key() {
        assert_eq!(type_plan("a\tb").unwrap()[1], Step::Virtual(VK_TAB));
    }

    #[test]
    fn control_characters_are_dropped() {
        // 发一个 \x00 的 KEYEVENTF_UNICODE 什么都不会发生，只是白花一次调用
        assert_eq!(type_plan("a\u{0}b\u{7f}c").unwrap().len(), 3);
    }

    #[test]
    fn empty_or_untypeable_text_is_rejected() {
        assert!(type_plan("").is_err());
        // 空白本身是能敲的（换了别的实现会把它当"没内容"拒掉，那就没法填空格了）
        assert_eq!(type_plan("   ").unwrap().len(), 3);
        assert!(type_plan("\u{0}\u{1}").is_err());
    }

    #[test]
    fn text_past_the_budget_is_rejected_before_anything_is_typed() {
        let long = "a".repeat(MAX_TYPE_CHARS + 1);
        assert!(type_plan(&long).is_err());
        assert!(type_plan(&"a".repeat(MAX_TYPE_CHARS)).is_ok());
    }

    #[test]
    fn a_point_maps_to_the_full_absolute_range() {
        assert_eq!(absolute(0, 0, 0, 0, 1920, 1080), Some((0, 0)));
        assert_eq!(
            absolute(1919, 1079, 0, 0, 1920, 1080),
            Some((65535, 65535))
        );
        // 正中间大约是一半（归一化空间里 960px 不是精确的 32767.5，
        // 差几十是乘除取整，不是错）
        let (ax, ay) = absolute(960, 540, 0, 0, 1920, 1080).unwrap();
        assert!((ax - 32768).abs() <= 40, "ax = {ax}");
        assert!((ay - 32768).abs() <= 40, "ay = {ay}");
    }

    #[test]
    fn a_secondary_monitor_maps_through_the_virtual_desktop() {
        // 副屏在主屏左边时 left 是负数；分母必须是两边合起来的宽度
        let (ax, _) = absolute(-1920, 0, -1920, 0, 3840, 1080).unwrap();
        assert_eq!(ax, 0);
        // 主屏左上角在整块虚拟桌面的正中间
        let (ax, _) = absolute(0, 0, -1920, 0, 3840, 1080).unwrap();
        assert!((ax - 32768).abs() <= 40, "ax = {ax}");
    }

    #[test]
    fn a_point_off_every_screen_has_no_absolute_form() {
        assert_eq!(absolute(-1, 0, 0, 0, 1920, 1080), None);
        assert_eq!(absolute(0, 1080, 0, 0, 1920, 1080), None);
        // 分辨率读失败（0 宽）时不能除零
        assert_eq!(absolute(0, 0, 0, 0, 0, 0), None);
        assert_eq!(absolute(0, 0, 0, 0, 1, 1), None);
    }
}
