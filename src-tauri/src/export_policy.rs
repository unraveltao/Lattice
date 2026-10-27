//! 导出（`file.save`）的纯逻辑：文件名、单文件还是 zip、以及 ZIP 的字节布局。
//!
//! # 为什么自己写 ZIP
//!
//! 和 `package.rs` 是同一条理由（那边是读，这边是写）：`zip` crate 会带进来一整套
//! 依赖图和它自己的 unsafe，而这里要的只是"本地头 + 中央目录 + EOCD"三段字节，
//! 外加一个 CRC32。压缩本身交给 `flate2`（`export.rs`），这个文件只摆布局 ——
//! 所以它一个 crate 都不引，能用 `rustc --test` 单独跑。
//!
//! # 名字是名字，不是路径
//!
//! 组件递上来的顶层 `name` 只当**文件名**：出现 `/` `\` `:` 就是坏参数。zip 里
//! 那些条目名（`images/1.webp`）是相对路径，另有一条规则（`entry_name_ok`）：
//! 相对、`/` 分隔、没有 `..`、没有盘符。两条都比 `fs_policy.rs` 松 —— 那个函数
//! 是给"用户指的路径"用的，它允许目录。混用会让组件拿到"能写整个磁盘"的形状。
//!
//! # 取消不是错误
//!
//! 用户点取消时回到前端的是 `{ok:false, cancelled:true}`，不是一条错误。这条在
//! `export.rs` 里，这里只提供"要 zip 吗"和"扩展名补哪个"两个判据。

/// 顶层文件名的长度上限（`runtime/save-file.ts` 里是同一个数）
pub(crate) const MAX_NAME_CHARS: usize = 120;
/// 一趟最多几个文件
pub(crate) const MAX_FILES: usize = 64;
/// 单个文件的字节上限
pub(crate) const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
/// 一整趟的字节上限
pub(crate) const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;

/// 要写出去的一个文件：要么是文本，要么是一段 base64 字节
#[derive(Debug, Clone)]
pub(crate) struct OutFile {
    /// zip 内的相对路径；单文件时只当提示
    pub name: String,
    pub text: Option<String>,
    pub base64: Option<String>,
}

/// ZIP 里的一条记录。`payload` 已经是"要写进去的那串字节"（deflate 过或原样）
#[derive(Debug, Clone)]
pub(crate) struct ZipPart {
    pub name: String,
    /// 0 = 存储，8 = deflate
    pub method: u16,
    pub payload: Vec<u8>,
    /// 原始（未压缩）大小
    pub size: usize,
    pub crc: u32,
    pub date: u16,
    pub time: u16,
}

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
/// bit 11 = 名字是 UTF-8。没有这一位，中文文件名在别人的解压工具里就是乱码
const FLAG_UTF8: u16 = 0x0800;

/// 能不能当文件名。`None` = 不能。
///
/// 只判"形状"：控制字符、Windows 不允许的九个头、`..`、长度。不替用户改写 ——
/// 悄悄换成一个别的名字，比回一句 `bad_params` 难查得多。
pub(crate) fn clean_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return None;
    }
    if name == "." || name == ".." {
        return None;
    }
    if name
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return None;
    }
    Some(name.to_string())
}

/// zip 内的条目名能不能用（相对、`/` 分隔、没有 `..`、没有盘符）
pub(crate) fn entry_name_ok(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS * 4 {
        return false;
    }
    if name.chars().any(|ch| ch.is_control() || ch == '\\' || ch == ':') {
        return false;
    }
    if name.starts_with('/') || name.ends_with('/') {
        return false;
    }
    name.split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// 这一组文件要不要打成 zip（和 `runtime/save-file.ts::saveNeedsZip` 同一条判据）
pub(crate) fn wants_zip(files: &[OutFile]) -> bool {
    files.len() > 1 || files.iter().any(|file| file.base64.is_some())
}

/// 内容决定扩展名：`zip` 补 `.zip`，否则补 `.md`。
///
/// 用户可能在对话框里把名字改掉：没有扩展名就补一个；写成一个别的"文本/压缩包"
/// 扩展名（`note.zip` 而内容是正文）就换成对的；其余（`图表.v2`）在后面接一个。
pub(crate) fn with_extension(name: &str, zip: bool) -> String {
    let want = if zip { ".zip" } else { ".md" };
    let lower = name.to_lowercase();
    if lower.ends_with(want) {
        return name.to_string();
    }
    if let Some(dot) = name.rfind('.') {
        if dot > 0 && [".md", ".markdown", ".zip", ".txt"].contains(&&lower[dot..]) {
            return format!("{}{}", &name[..dot], want);
        }
    }
    format!("{name}{want}")
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// 标准 base64 解码（容忍缺掉的尾部 `=`，不容忍中间的 `=` 或字母表外的字符）。
///
/// **必须先解码成功再写包**：一条坏 base64 写进去就是 0 字节的图片，而用户看到的
/// 是一个"导出成功"的 zip。所以 `export.rs` 把这一层放在弹对话框之前。
pub(crate) fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let mut body = trimmed;
    let mut pad = 0;
    while let Some(stripped) = body.strip_suffix('=') {
        body = stripped;
        pad += 1;
    }
    if pad > 2 {
        return Err("base64 has too much padding".to_string());
    }
    if body.contains('=') {
        return Err("base64 has padding in the middle".to_string());
    }
    let raw = body.as_bytes();
    if raw.len() % 4 == 1 {
        return Err("base64 length is wrong".to_string());
    }
    if pad > 0 && raw.len() % 4 + pad != 4 {
        return Err("base64 padding does not match its length".to_string());
    }

    let mut out = Vec::with_capacity(raw.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in raw {
        let value = base64_value(byte).ok_or_else(|| "base64 has a character outside the alphabet".to_string())?;
        acc = (acc << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// 标准 CRC32（ZIP 用的多项式 0xEDB88320）。
pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (index, slot) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 == 1 { 0xedb8_8320 ^ (value >> 1) } else { value >> 1 };
        }
        *slot = value;
    }
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc = table[((crc ^ byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

/// DOS 的日期 / 时间两格。秒按 2 秒一格。
pub(crate) fn dos_datetime(year: u16, month: u8, day: u8, hour: u8, minute: u8, second: u8) -> (u16, u16) {
    let year = year.clamp(1980, 2107);
    let month = month.clamp(1, 12) as u16;
    let day = day.clamp(1, 31) as u16;
    let date = ((year - 1980) << 9) | (month << 5) | day;
    let time = ((hour.min(23) as u16) << 11) | ((minute.min(59) as u16) << 5) | (second.min(59) as u16 / 2);
    (time, date)
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// 把几条记录摆成一个 ZIP：本地头 + 数据，然后中央目录，最后 EOCD。
///
/// 布局与 `scripts/pack-widget.mjs::buildZip` 逐字节同构（本地头 30 + 名字 + 数据，
/// 中央目录 46 + 名字，EOCD 22），所以 Node 打的包和这里打的包能被同一批解压器认。
pub(crate) fn zip_bytes(parts: &[ZipPart]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();

    for part in parts {
        let offset = out.len() as u32;
        let name = part.name.as_bytes();

        push_u32(&mut out, LOCAL_SIG);
        push_u16(&mut out, 20); // 需要的版本 2.0
        push_u16(&mut out, FLAG_UTF8);
        push_u16(&mut out, part.method);
        push_u16(&mut out, part.time);
        push_u16(&mut out, part.date);
        push_u32(&mut out, part.crc);
        push_u32(&mut out, part.payload.len() as u32);
        push_u32(&mut out, part.size as u32);
        push_u16(&mut out, name.len() as u16);
        push_u16(&mut out, 0); // extra
        out.extend_from_slice(name);
        out.extend_from_slice(&part.payload);

        push_u32(&mut central, CENTRAL_SIG);
        push_u16(&mut central, 20); // 打包工具版本
        push_u16(&mut central, 20); // 需要的版本
        push_u16(&mut central, FLAG_UTF8);
        push_u16(&mut central, part.method);
        push_u16(&mut central, part.time);
        push_u16(&mut central, part.date);
        push_u32(&mut central, part.crc);
        push_u32(&mut central, part.payload.len() as u32);
        push_u32(&mut central, part.size as u32);
        push_u16(&mut central, name.len() as u16);
        push_u16(&mut central, 0); // extra
        push_u16(&mut central, 0); // comment
        push_u16(&mut central, 0); // 起始磁盘
        push_u16(&mut central, 0); // 内部属性
        push_u32(&mut central, 0); // 外部属性
        push_u32(&mut central, offset);
        central.extend_from_slice(name);
    }

    let directory_offset = out.len() as u32;
    let directory_size = central.len() as u32;
    out.extend_from_slice(&central);

    push_u32(&mut out, EOCD_SIG);
    push_u16(&mut out, 0); // 这张盘
    push_u16(&mut out, 0); // 目录所在的盘
    push_u16(&mut out, parts.len() as u16);
    push_u16(&mut out, parts.len() as u16);
    push_u32(&mut out, directory_size);
    push_u32(&mut out, directory_offset);
    push_u16(&mut out, 0); // 注释长度
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u16_at(bytes: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([bytes[at], bytes[at + 1]])
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    #[test]
    fn clean_name_trims_and_keeps_chinese() {
        assert_eq!(clean_name("  图表 2026  "), Some("图表 2026".to_string()));
    }

    #[test]
    fn clean_name_rejects_path_separators() {
        assert_eq!(clean_name("a/b"), None);
        assert_eq!(clean_name("a\\b"), None);
        assert_eq!(clean_name("C:note"), None);
    }

    #[test]
    fn clean_name_rejects_control_chars_and_dotdot() {
        assert_eq!(clean_name("a\u{0}b"), None);
        assert_eq!(clean_name(".."), None);
        assert_eq!(clean_name("   "), None);
    }

    #[test]
    fn clean_name_has_a_length_limit() {
        assert!(clean_name(&"a".repeat(MAX_NAME_CHARS)).is_some());
        assert_eq!(clean_name(&"a".repeat(MAX_NAME_CHARS + 1)), None);
    }

    #[test]
    fn entry_names_are_relative_and_slash_separated() {
        assert!(entry_name_ok("note.md"));
        assert!(entry_name_ok("images/1.webp"));
        assert!(!entry_name_ok("../note.md"));
        assert!(!entry_name_ok("/note.md"));
        assert!(!entry_name_ok("images\\1.webp"));
        assert!(!entry_name_ok("images//1.webp"));
    }

    #[test]
    fn decode_base64_reads_padded_and_unpadded() {
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("aGk").unwrap(), b"hi");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_base64("5L2g5aW9").unwrap(), "你好".as_bytes());
    }

    #[test]
    fn decode_base64_rejects_bad_shapes() {
        assert!(decode_base64("a$").is_err());
        assert!(decode_base64("aG=k").is_err());
        assert!(decode_base64("a").is_err());
        assert!(decode_base64("aGk==").is_err());
    }

    #[test]
    fn crc32_matches_the_reference_vector() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn dos_datetime_packs_like_the_spec() {
        let (time, date) = dos_datetime(2026, 10, 27, 10, 44, 0);
        assert_eq!(date, ((2026 - 1980) << 9) | (10 << 5) | 27);
        assert_eq!(time, (10 << 11) | (44 << 5));
        // 秒按 2 秒一格，越界值被夹住
        assert_eq!(dos_datetime(2026, 10, 27, 10, 44, 59).0, (10 << 11) | (44 << 5) | 29);
        assert_eq!(dos_datetime(1900, 13, 40, 99, 99, 99).1, (12 << 5) | 31);
    }

    #[test]
    fn with_extension_follows_the_content() {
        assert_eq!(with_extension("标题", false), "标题.md");
        assert_eq!(with_extension("标题", true), "标题.zip");
        assert_eq!(with_extension("标题.md", false), "标题.md");
        assert_eq!(with_extension("标题.zip", false), "标题.md");
        assert_eq!(with_extension("标题.MD", true), "标题.zip");
        assert_eq!(with_extension("图表.v2", true), "图表.v2.zip");
    }

    #[test]
    fn wants_zip_is_decided_by_content() {
        let text = OutFile { name: "note.md".into(), text: Some("hi".into()), base64: None };
        assert!(!wants_zip(std::slice::from_ref(&text)));
        let image = OutFile { name: "images/1.webp".into(), text: None, base64: Some("aGk=".into()) };
        assert!(wants_zip(&[text.clone(), image.clone()]));
        assert!(wants_zip(&[OutFile { name: "1.webp".into(), text: None, base64: Some("aGk=".into()) }]));
    }

    fn part(name: &str, payload: &[u8], method: u16) -> ZipPart {
        ZipPart {
            name: name.to_string(),
            method,
            payload: payload.to_vec(),
            size: payload.len(),
            crc: crc32(payload),
            date: 0,
            time: 0,
        }
    }

    #[test]
    fn zip_bytes_writes_a_local_header_before_each_payload() {
        let bytes = zip_bytes(&[part("note.md", b"hi", 0)]);
        assert_eq!(u32_at(&bytes, 0), LOCAL_SIG);
        assert_eq!(u16_at(&bytes, 6), FLAG_UTF8);
        assert_eq!(u16_at(&bytes, 8), 0);
        assert_eq!(u32_at(&bytes, 14), crc32(b"hi"));
        assert_eq!(u32_at(&bytes, 18), 2);
        assert_eq!(u16_at(&bytes, 26), "note.md".len() as u16);
        let name_at = 30;
        assert_eq!(&bytes[name_at..name_at + 7], b"note.md");
        assert_eq!(&bytes[name_at + 7..name_at + 9], b"hi");
    }

    #[test]
    fn zip_bytes_ends_with_an_eocd_that_points_at_the_directory() {
        let bytes = zip_bytes(&[part("note.md", b"hi", 0), part("images/1.webp", b"abc", 8)]);
        let eocd = bytes.len() - 22;
        assert_eq!(u32_at(&bytes, eocd), EOCD_SIG);
        assert_eq!(u16_at(&bytes, eocd + 8), 2);
        assert_eq!(u16_at(&bytes, eocd + 10), 2);
        let directory_size = u32_at(&bytes, eocd + 12) as usize;
        let directory_offset = u32_at(&bytes, eocd + 16) as usize;
        assert_eq!(directory_offset + directory_size, eocd);
        assert_eq!(u32_at(&bytes, directory_offset), CENTRAL_SIG);
        // 第二条记录的名字就跟着它的中央目录项
        let first_central_size = 46 + "note.md".len();
        assert_eq!(&bytes[directory_offset + first_central_size + 46..directory_offset + first_central_size + 46 + 13], b"images/1.webp");
    }

    #[test]
    fn zip_bytes_offsets_are_absolute() {
        let bytes = zip_bytes(&[part("note.md", b"hi", 0), part("images/1.webp", b"abc", 8)]);
        let eocd = bytes.len() - 22;
        let directory_offset = u32_at(&bytes, eocd + 16) as usize;
        let first_central_size = 46 + "note.md".len();
        let second = directory_offset + first_central_size;
        assert_eq!(u32_at(&bytes, second + 42) as usize, 30 + 7 + 2);
    }
}
