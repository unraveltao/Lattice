//! 屏幕与截图那只手的形状 —— **纯逻辑**，Win32 调用在 `hands.rs` 里。
//!
//! 两件事：
//!
//! 1. **哪些窗口算"看得见"**。`EnumWindows` 会把桌面上三百个看不见的东西
//!    （隐藏窗口、被系统 cloak 掉的 UWP、零尺寸的宿主窗口、没有标题的
//!    辅助窗口）全报一遍。全交给模型等于给它一张假的桌面地图 —— 它会照着
//!    一个在屏幕外 8000 像素处的窗口去算坐标，然后去点空气。
//! 2. **PNG 怎么拼**。截图存盘要么引一个图像库（这一仓不引），要么自己写。
//!    写 PNG 只需要四样东西：签名、IHDR、IDAT、IEND，其中只有 IDAT 需要
//!    deflate（交给 `flate2`，它已经在依赖里）；**分块与 CRC 是纯字节运算**，
//!    所以放在这里、能被 `rustc --test` 钉住。
//!
//! 不引 crate：这个文件要能在写不了 `target/debug/deps` 的机器上单独跑。

use std::path::PathBuf;

/// 一次最多报几个窗口。40 条已经覆盖"用户在干活的那几屏"，
/// 再多的边际收益是把 20k 字的工具结果预算喂给一堆后台进程。
pub const MAX_WINDOWS: usize = 40;

/// 单个窗口标题的字符上限。浏览器标题能长到几百字，而模型只需要
/// "这是哪个窗口"，不需要整条 URL。
pub const MAX_TITLE_CHARS: usize = 120;

/// 类名上限（`Chrome_WidgetWin_1` 这种）。
pub const MAX_CLASS_CHARS: usize = 64;

/// 截图的像素上限：4 亿字节 ≈ 100 MP。8K 双屏（7680×2160×2）也才 33 MP。
/// 超过就拒绝 —— 那不是"再多等一会儿"，是一次 400MB 的分配。
pub const MAX_PIXELS: u64 = 100_000_000;

/// 1×1 的透明 PNG 长度下限，用来挡"拼出来的东西根本不像 PNG"这种回归。
pub const PNG_MIN_BYTES: usize = 67;

// ---------------------------------------------------------------------------
// 窗口列表
// ---------------------------------------------------------------------------

/// 一个候选窗口要不要进列表。
///
/// 五个条件缺一不可，每条都对应一种实际撞见过的幽灵：
/// `IsWindowVisible` 为假的（后台宿主）、被 DWM cloak 掉的（切到别的虚拟桌面
/// 之后 `IsWindowVisible` 仍然是 true，但屏幕上没有）、没有标题的（辅助窗口）、
/// 零宽或零高的（最小化之后 `GetWindowRect` 给的是 -32000 加零尺寸）。
pub fn keep_window(visible: bool, cloaked: bool, title: &str, width: i32, height: i32) -> bool {
    visible && !cloaked && !title.trim().is_empty() && width > 0 && height > 0
}

/// 标题进列表之前先压平：换行会把一行 JSON 拆成两行（模型看到的是
/// 两个残缺的窗口），首尾空白是纯噪音。
pub fn clip_title(title: &str) -> String {
    let flat = title.split_whitespace().collect::<Vec<_>>().join(" ");
    take_chars(&flat, MAX_TITLE_CHARS)
}

/// 类名同理，只是上限更小、不压空白（类名里本来就没有空白）。
pub fn clip_class(class: &str) -> String {
    take_chars(class.trim(), MAX_CLASS_CHARS)
}

/// 按字符（不是字节）截断，切点上补一个省略号。
///
/// **按字节切会把一个汉字劈成两半**，那一半是无效 UTF-8 —— `String` 那边
/// 会 panic 或者变成替换符（`shell.run` 的输出截断在 `shell_policy` 里踩过）。
pub fn take_chars(text: &str, limit: usize) -> String {
    if limit == 0 {
        return String::new();
    }
    let mut out = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= limit {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

/// 排序键：焦点窗口排第一，其余保持 `EnumWindows` 的 z 序（从最上面往下）。
/// 模型读列表时"第一个就是用户正在看的那个"省掉一轮试探。
pub fn rank(focused: bool) -> u8 {
    if focused {
        0
    } else {
        1
    }
}

// ---------------------------------------------------------------------------
// 截图存哪
// ---------------------------------------------------------------------------

/// 截图的文件名。用毫秒时间戳：同一轮里连截两张不该互相覆盖。
pub fn screenshot_name(now_ms: u128) -> String {
    format!("screenshot-{now_ms}.png")
}

/// `path` 参数既可以是文件夹，也可以直接是一个 `.png` 文件。
///
/// 默认落在 `fallback`（工作目录；没配就是 `%TEMP%`）—— 落在进程的 cwd
/// 是个坑：GUI 进程的 cwd 可能是 `C:\Program Files\...`，写不进去。
pub fn screenshot_target(raw: Option<&str>, fallback: &str, name: &str) -> String {
    let given = raw.map(str::trim).filter(|text| !text.is_empty());
    match given {
        Some(given) if given.to_ascii_lowercase().ends_with(".png") => given.to_string(),
        Some(given) => PathBuf::from(given).join(name).display().to_string(),
        None => PathBuf::from(fallback).join(name).display().to_string(),
    }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/// `\x89PNG\r\n\x1a\n`：PNG 的签名，八个字节一个都不能差。
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// 标准 CRC-32（PNG 用的那个多项式 `0xEDB88320`，初值全 1，末尾取反）。
///
/// 不用查表：一张 8K 截图是 15MB，纯位运算的代价是几十毫秒，而查表要
/// 静态初始化一张 1KB 的表 —— 这里没有一处值得为它复杂。
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 两段字节当成一段算 CRC。分块头（4 字节）和数据要连起来算，
/// 但把它们先拼成一个 `Vec` 等于每次多拷 15MB。
fn crc32_of_two(first: &[u8], second: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in first.iter().chain(second.iter()) {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 一个 PNG 分块：`[长度 u32 大端][类型 4 字节][数据][CRC u32 大端]`。
///
/// CRC 覆盖的是**类型加数据**，不含长度 —— 漏了类型那一半，图片照样能显示
/// （浏览器宽容），但严格的解码器会拒。
pub fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32_of_two(kind, data).to_be_bytes());
    out
}

/// IHDR：8 位深、颜色类型 6（RGBA）、无压缩、无滤波、不隔行。
///
/// 颜色类型 6 意味着**每像素四字节**，和 `GetDIBits` 给的 BGRA 只差
/// 一个红蓝交换 —— 那一步在 `hands.rs` 里，不在这里（这里不认识像素）。
pub fn ihdr(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity(13);
    data.extend_from_slice(&width.to_be_bytes());
    data.extend_from_slice(&height.to_be_bytes());
    data.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(b"IHDR", &data)
}

pub fn iend() -> Vec<u8> {
    chunk(b"IEND", &[])
}

/// 每行前面加一个滤波字节 `0`（None）。PNG 的原始数据是
/// `[滤波][像素…]` 逐行重复 —— 少了这个字节，图片会整体斜切。
pub fn scanlines(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let stride = width as usize * 4;
    let mut out = Vec::with_capacity((stride + 1) * height as usize);
    for row in 0..height as usize {
        out.push(0);
        let start = row * stride;
        match rgba.get(start..start + stride) {
            Some(line) => out.extend_from_slice(line),
            // 像素短了就当黑的补齐：拼出一张坏图，好过拼出一个坏文件
            None => out.extend(std::iter::repeat_n(0u8, stride)),
        }
    }
    out
}

/// zlib 的 adler32（deflate 流的尾巴）。
pub fn adler32(data: &[u8]) -> u32 {
    let mut a = 1u32;
    let mut b = 0u32;
    for byte in data {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// **不压缩**的 zlib 流：`78 01` + 若干 stored 块 + adler32。
///
/// 只在测试和兜底里用（真的截图走 `flate2`）。它的价值是让"一个合法的
/// PNG 文件长什么样"能在这个文件里被单独钉住 —— 不用图像库也能验。
pub fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 16);
    out.extend_from_slice(&[0x78, 0x01]);
    if data.is_empty() {
        // 一个空的 stored 块：BFINAL=1 / BTYPE=00，长度 0
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xFF, 0xFF]);
    } else {
        let mut offset = 0usize;
        while offset < data.len() {
            let count = (data.len() - offset).min(65535);
            let last = offset + count == data.len();
            // 每个 stored 块从字节边界开始，所以这三字节里的
            // "BFINAL + BTYPE + 补齐" 正好就是一个字节
            out.push(if last { 0x01 } else { 0x00 });
            out.extend_from_slice(&(count as u16).to_le_bytes());
            out.extend_from_slice(&(!(count as u16)).to_le_bytes());
            out.extend_from_slice(&data[offset..offset + count]);
            offset += count;
        }
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

/// 拼一张完整的 PNG。`idat` 是已经 zlib 压过的扫描线。
pub fn png(width: u32, height: u32, idat: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(idat.len() + 64);
    out.extend_from_slice(&PNG_SIGNATURE);
    out.extend_from_slice(&ihdr(width, height));
    out.extend_from_slice(&chunk(b"IDAT", idat));
    out.extend_from_slice(&iend());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hidden_window_is_not_listed() {
        assert!(!keep_window(false, false, "Notepad", 800, 600));
    }

    #[test]
    fn a_cloaked_window_is_not_listed() {
        // 切到别的虚拟桌面之后 IsWindowVisible 仍然是 true —— 只信它就会
        // 列出一堆"屏幕上根本没有"的窗口
        assert!(!keep_window(true, true, "Settings", 800, 600));
    }

    #[test]
    fn a_window_without_a_title_is_not_listed() {
        assert!(!keep_window(true, false, "   ", 800, 600));
        assert!(!keep_window(true, false, "", 800, 600));
    }

    #[test]
    fn a_minimised_window_is_not_listed() {
        // 最小化时 GetWindowRect 给 -32000 加零尺寸
        assert!(!keep_window(true, false, "Notepad", 0, 0));
        assert!(!keep_window(true, false, "Notepad", 160, 0));
    }

    #[test]
    fn a_normal_window_is_listed() {
        assert!(keep_window(true, false, "main.rs - Visual Studio Code", 1200, 800));
    }

    #[test]
    fn a_title_is_flattened_and_capped() {
        assert_eq!(clip_title("  A\n\tB   C  "), "A B C");
        let long = "x".repeat(500);
        let clipped = clip_title(&long);
        assert_eq!(clipped.chars().count(), MAX_TITLE_CHARS + 1);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn a_class_name_is_capped_separately() {
        assert_eq!(clip_class("  Chrome_WidgetWin_1  "), "Chrome_WidgetWin_1");
        assert_eq!(clip_class(&"y".repeat(100)).chars().count(), MAX_CLASS_CHARS + 1);
    }

    #[test]
    fn cutting_by_characters_never_splits_a_chinese_one() {
        // 按字节切会把"你好"劈成两半，那一半不是合法 UTF-8
        assert_eq!(take_chars("你好世界", 2), "你好…");
        assert_eq!(take_chars("你好世界", 9), "你好世界");
        assert_eq!(take_chars("你好世界", 0), "");
    }

    #[test]
    fn the_focused_window_ranks_first() {
        assert!(rank(true) < rank(false));
    }

    #[test]
    fn a_screenshot_name_carries_the_millisecond() {
        assert_eq!(screenshot_name(1_700_000_000_123), "screenshot-1700000000123.png");
    }

    #[test]
    fn a_screenshot_lands_in_the_fallback_folder_by_default() {
        assert_eq!(
            screenshot_target(None, "C:\\work", "shot.png"),
            "C:\\work\\shot.png"
        );
        assert_eq!(
            screenshot_target(Some("   "), "C:\\Temp", "shot.png"),
            "C:\\Temp\\shot.png"
        );
    }

    #[test]
    fn a_screenshot_path_may_be_a_folder_or_a_file() {
        assert_eq!(
            screenshot_target(Some("C:\\shots"), "C:\\work", "shot.png"),
            "C:\\shots\\shot.png"
        );
        assert_eq!(
            screenshot_target(Some("C:\\shots\\named.PNG"), "C:\\work", "shot.png"),
            "C:\\shots\\named.PNG"
        );
    }

    #[test]
    fn crc32_matches_the_reference_value() {
        // "123456789" 是这个算法的标准测试向量
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn adler32_matches_the_reference_value() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        assert_eq!(adler32(b""), 1);
    }

    #[test]
    fn a_png_starts_with_its_signature_and_an_ihdr() {
        let body = png(2, 1, &zlib_stored(&scanlines(&[255, 0, 0, 255, 0, 255, 0, 255], 2, 1)));
        assert_eq!(&body[..8], &PNG_SIGNATURE);
        // 签名之后第一个块必须是 IHDR，长度 13
        assert_eq!(&body[8..12], &13u32.to_be_bytes());
        assert_eq!(&body[12..16], b"IHDR");
        assert_eq!(&body[16..20], &2u32.to_be_bytes());
        assert_eq!(&body[20..24], &1u32.to_be_bytes());
        // 8 位深 / RGBA / 不隔行
        assert_eq!(&body[24..29], &[8, 6, 0, 0, 0]);
        assert!(body.len() >= PNG_MIN_BYTES);
        assert_eq!(&body[body.len() - 12..], &iend()[..]);
    }

    #[test]
    fn every_chunk_carries_its_own_crc() {
        let one = chunk(b"tEXt", b"hello");
        assert_eq!(&one[..4], &5u32.to_be_bytes());
        assert_eq!(&one[4..8], b"tEXt");
        assert_eq!(&one[8..13], b"hello");
        let crc = u32::from_be_bytes(one[13..17].try_into().unwrap());
        assert_eq!(crc, crc32(b"tEXthello"));
    }

    #[test]
    fn the_iend_chunk_is_twelve_bytes_of_nothing() {
        assert_eq!(iend().len(), 12);
        assert_eq!(&iend()[4..8], b"IEND");
        assert_eq!(&iend()[8..], &crc32(b"IEND").to_be_bytes());
    }

    #[test]
    fn scanlines_put_a_filter_byte_before_every_row() {
        let pixels = vec![1u8; 4 * 3]; // 3 像素宽、1 行
        let lines = scanlines(&pixels, 3, 1);
        assert_eq!(lines.len(), (3 * 4 + 1) * 1);
        assert_eq!(lines[0], 0);
        assert_eq!(&lines[1..], &pixels[..]);
    }

    #[test]
    fn a_short_pixel_buffer_is_padded_rather_than_left_ragged() {
        // 少了一行的像素要补黑，不能少写那一个滤波字节 —— 那会让后面
        // 所有行的滤波字节错位，整张图斜掉
        let lines = scanlines(&[9u8; 4], 2, 2);
        assert_eq!(lines.len(), (2 * 4 + 1) * 2);
        assert_eq!(&lines[9..], &[0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn a_stored_zlib_stream_is_still_a_valid_stream() {
        let stream = zlib_stored(b"abc");
        assert_eq!(&stream[..2], &[0x78, 0x01]);
        // 一个 stored 块：BFINAL=1、长度 3、补码
        assert_eq!(stream[2], 0x01);
        assert_eq!(&stream[3..5], &3u16.to_le_bytes());
        assert_eq!(&stream[5..7], &(!3u16).to_le_bytes());
        assert_eq!(&stream[7..10], b"abc");
        assert_eq!(&stream[10..], &adler32(b"abc").to_be_bytes());
    }

    #[test]
    fn a_long_payload_becomes_several_stored_blocks() {
        let payload = vec![7u8; 70_000];
        let stream = zlib_stored(&payload);
        assert_eq!(stream[2], 0x00); // 第一块不是最后一块
        assert_eq!(&stream[3..5], &65535u16.to_le_bytes());
        // 头两块各 65535，第三块 65535+…：总共 70000 = 65535 + 4465
        let second = 2 + 5 + 65535;
        assert_eq!(stream[second], 0x01); // 第二块收尾
        assert_eq!(&stream[second + 1..second + 3], &4465u16.to_le_bytes());
    }
}
