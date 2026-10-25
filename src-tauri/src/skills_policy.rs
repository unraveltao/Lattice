//! 技能包的纯逻辑（0005 §4）。**不引 crate** —— 要能单独 `rustc --test` 跑。
//!
//! 技能是"怎么做"的说明书：一个目录 `skills/<id>/SKILL.md`，三个 front matter
//! 字段加一段正文。四条规矩：
//!
//! 1. **坏条目逐条丢**：一个拼错的键、一行没有冒号的废话，丢掉那一行，技能照常读。
//!    只有"读不成一份技能"（没有 front matter、没有 `name`）才算 `damaged`。
//! 2. **`id` 走字母表**：它要当目录名用，也是工具名式的东西（`skills/<id>/`）。
//!    所以只认 `[a-z0-9_-]`，不许 `..`、不许盘符、不许反斜杠 —— "规范化之后再判"
//!    在这里是错的，`..` 一旦进了路径就晚了。
//! 3. **上限按码点数**：4 000 字的中文是 12 KB 的 UTF-8。按字节算，中文技能会在
//!    1 300 字时被判超限，而它其实还没写完。
//! 4. **超限拒绝，不截断**：截断过的步骤等于半份说明书，模型会照半份做。

/// 最多同时启用几份
pub const MAX_SKILLS: usize = 4;
/// 单份正文的字数上限
pub const MAX_BODY_CHARS: usize = 4_000;
/// 启用的几份加起来的字数上限
pub const MAX_TOTAL_CHARS: usize = 8_000;
/// 导入时单个文件的体积上限（一份说明书不该有 200 KB）
pub const MAX_IMPORT_BYTES: usize = 200 * 1024;
/// 导入一个目录时的总量上限
pub const MAX_IMPORT_TOTAL: u64 = 2 * 1024 * 1024;
/// 导入一个目录时的文件数上限
pub const MAX_IMPORT_FILES: usize = 200;
/// 递归深度上限（技能目录里不该套娃）
pub const MAX_IMPORT_DEPTH: usize = 4;

/// `name` / `description` 的字数上限。它们只用来在面板上显示一行，超了截断 ——
/// 这两个字段是**展示**，不是说明书正文，截断不会让谁照着做半件事
pub const MAX_NAME_CHARS: usize = 60;
pub const MAX_DESCRIPTION_CHARS: usize = 160;

/// `name` / `description` / `tools` 三个键，别的一个都不认
pub const KEYS: [&str; 3] = ["name", "description", "tools"];

/// 一份读成了的技能。`damaged` 的那份不进这里，它只带着 id 出现在列表里
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// front matter 里声明的组名，原样小写。**不校验是不是六组之一** ——
    /// 认不出来的组名只影响面板上那句"缺 Files"，不值得让整份技能打不开
    pub tools: Vec<String>,
    pub body: String,
}

/// 码点数，不是字节数
pub fn chars(text: &str) -> usize {
    text.chars().count()
}

/// 按码点截断（不切在多字节字符中间）
pub fn take_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// 能不能当目录名用。**字母表比"合法文件名"窄得多**：`..` 与盘符在这一步就出局，
/// 不留到"拼出路径之后再检查"
pub fn id_ok(id: &str) -> bool {
    let text = id.trim();
    if text.is_empty() || chars(text) > 48 {
        return false;
    }
    if text.starts_with('-') || text.ends_with('-') {
        return false;
    }
    text.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// 把任意名字（目录名 / 文件名 / 技能标题）压成 id 字母表的样子。
///
/// 中文名压出来是空串（ASCII 之外一律丢），那就退回 `skill` —— 用户导进来的
/// 目录叫「周报」，id 是 `skill`，面板上显示的是 front matter 里的 `name`（周报），
/// 所以压不出来不是问题，认不出来才是
pub fn slug(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        let lower = c.to_ascii_lowercase();
        if lower.is_ascii_lowercase() || lower.is_ascii_digit() || lower == '_' {
            out.push(lower);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.chars().count() >= 40 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed
    }
}

/// 撞名不覆盖：`weekly` → `weekly-2` → `weekly-3`（0005 §5 的最后一行）
pub fn unique_id(base: &str, taken: &[String]) -> String {
    if !taken.iter().any(|id| id == base) {
        return base.to_string();
    }
    let mut index = 2;
    loop {
        let candidate = format!("{base}-{index}");
        if !taken.iter().any(|id| id == &candidate) {
            return candidate;
        }
        index += 1;
        // 48 是 id 的长度上限：`base` 太长时从左边留着，别让后缀把它顶出字母表
        if index > 999 {
            return format!("{}-{}", take_chars(base, 40), index);
        }
    }
}

/// 把文本切成 (front matter, 正文)。
///
/// 认三种写法：`---\n` 开头、CRLF、以及带 BOM 的文件（Windows 上用记事本存过一遍
/// 就会带 BOM，而它会让第一行不等于 `---`，于是一份好好的技能变成"读不成"）
pub fn split_front_matter(text: &str) -> Option<(&str, &str)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let first = text.lines().next()?;
    if first.trim() != "---" {
        return None;
    }
    let rest = &text[first.len()..];
    let rest = rest.strip_prefix('\r').unwrap_or(rest);
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    // 逐行找收尾的 `---`，同时记住它的字节偏移
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim() == "---" {
            let meta = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return Some((meta, body));
        }
        offset += line.len();
    }
    None
}

/// 读一份技能。`None` = 读不成（没有 front matter、或者没有 `name`）——
/// 调用方把它标成 `damaged`，**不拦列表**
pub fn parse(text: &str) -> Option<Skill> {
    let (meta, body) = split_front_matter(text)?;
    let mut name = String::new();
    let mut description = String::new();
    let mut tools: Vec<String> = Vec::new();
    for line in meta.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            // 没有冒号的一行：丢掉这一行，别让整份技能打不开
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        match key.as_str() {
            "name" if !value.is_empty() => name = take_chars(value, MAX_NAME_CHARS),
            "description" => description = take_chars(value, MAX_DESCRIPTION_CHARS),
            "tools" => {
                for raw in value.split([',', ' ', '\t']).map(str::trim) {
                    let group = raw.to_ascii_lowercase();
                    if group.is_empty() || tools.contains(&group) {
                        continue;
                    }
                    tools.push(group);
                }
            }
            // 别的键（包括作者自己加的 `version:`）忽略
            _ => {}
        }
    }
    if name.is_empty() {
        return None;
    }
    Some(Skill {
        name,
        description,
        tools,
        body: body.trim().to_string(),
    })
}

/// 超上限的原因。`reason` 是给界面用的三种字面量，`total` / `limit` 让界面
/// 说清"超了多少"（0005 §5 的第二行）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Budget {
    pub reason: &'static str,
    pub total: usize,
    pub limit: usize,
}

/// 这几份正文有没有超上限（0005 §3：**在启用时判**，不在渲染时判）
pub fn budget(bodies: &[&str]) -> Result<usize, Budget> {
    if bodies.len() > MAX_SKILLS {
        return Err(Budget {
            reason: "count",
            total: bodies.len(),
            limit: MAX_SKILLS,
        });
    }
    let mut total = 0usize;
    for body in bodies {
        let size = chars(body);
        if size > MAX_BODY_CHARS {
            return Err(Budget {
                reason: "body",
                total: size,
                limit: MAX_BODY_CHARS,
            });
        }
        total += size;
    }
    if total > MAX_TOTAL_CHARS {
        return Err(Budget {
            reason: "total",
            total,
            limit: MAX_TOTAL_CHARS,
        });
    }
    Ok(total)
}

/// 启用清单的归一化：只留形状合法的 id、去重、保持顺序。
/// **不改条数** —— 超过 4 条不是"洗掉几条"，是用户要看到一句"太多了"
pub fn normalize_enabled(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in list {
        let id = raw.trim().to_string();
        if !id_ok(&id) || out.contains(&id) {
            continue;
        }
        out.push(id);
    }
    out
}

/// 一份技能的文件名。**只有这一个合法形态**：`<id>/SKILL.md`
pub fn skill_file(id: &str) -> Option<String> {
    if !id_ok(id) {
        return None;
    }
    Some(format!("{id}/SKILL.md"))
}

/// 文件名是不是 `SKILL.md`（大小写不敏感：Windows 上 `skill.md` 也是同一个文件）
pub fn is_skill_file(name: &str) -> bool {
    name.eq_ignore_ascii_case("SKILL.md")
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "---\nname: 周报\ndescription: 把这几天的改动整理成一份周报\ntools: files, shell\n---\n\n什么时候用：每周五。\n第一步：读 CHANGELOG。\n";

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn parses_a_whole_skill() {
        let skill = parse(GOOD).expect("good skill");
        assert_eq!(skill.name, "周报");
        assert_eq!(skill.description, "把这几天的改动整理成一份周报");
        assert_eq!(skill.tools, vec!["files".to_string(), "shell".to_string()]);
        assert!(skill.body.starts_with("什么时候用"));
        assert!(!skill.body.contains("name:"));
    }

    #[test]
    fn crlf_and_bom_still_parse() {
        let text = "\u{feff}---\r\nname: Weekly\r\n---\r\nbody\r\n";
        let skill = parse(text).expect("crlf");
        assert_eq!(skill.name, "Weekly");
        assert_eq!(skill.body, "body");
    }

    #[test]
    fn no_front_matter_is_damaged() {
        assert!(parse("# 周报\n\n步骤").is_none());
        assert!(parse("---\nname: x\n").is_none(), "没有收尾的 ---");
    }

    #[test]
    fn missing_name_is_damaged_but_unknown_keys_are_not() {
        assert!(parse("---\ndescription: 只有描述\n---\nbody").is_none());
        let skill = parse("---\nversion: 2\nname: A\n---\nbody").expect("unknown key ignored");
        assert_eq!(skill.name, "A");
    }

    #[test]
    fn bad_lines_are_dropped_one_by_one() {
        let text = "---\njust text\nname: A\ntools: files,, shell files\n: empty key\n---\nb";
        let skill = parse(text).expect("still parses");
        assert_eq!(skill.name, "A");
        assert_eq!(skill.tools, vec!["files".to_string(), "shell".to_string()]);
    }

    #[test]
    fn quotes_are_stripped_from_values() {
        let skill = parse("---\nname: \"A\"\ndescription: 'B'\n---\nb").expect("quoted");
        assert_eq!(skill.name, "A");
        assert_eq!(skill.description, "B");
    }

    #[test]
    fn names_and_descriptions_are_capped_by_chars() {
        let long_name: String = "字".repeat(MAX_NAME_CHARS + 10);
        let long_desc: String = "字".repeat(MAX_DESCRIPTION_CHARS + 10);
        let text = format!("---\nname: {long_name}\ndescription: {long_desc}\n---\nb");
        let skill = parse(&text).expect("capped");
        assert_eq!(chars(&skill.name), MAX_NAME_CHARS);
        assert_eq!(chars(&skill.description), MAX_DESCRIPTION_CHARS);
    }

    #[test]
    fn id_alphabet_rejects_traversal_and_drives() {
        assert!(id_ok("weekly-report"));
        assert!(id_ok("a_1"));
        assert!(!id_ok("../etc"));
        assert!(!id_ok(".."));
        assert!(!id_ok("C:x"));
        assert!(!id_ok("a\\b"));
        assert!(!id_ok(""));
        assert!(!id_ok(&"a".repeat(49)));
        assert!(!id_ok("-lead"));
        assert!(!id_ok("Name"), "大写也不行：目录名要能跨文件系统");
    }

    #[test]
    fn skill_file_only_accepts_plain_ids() {
        assert_eq!(skill_file("weekly").as_deref(), Some("weekly/SKILL.md"));
        assert!(skill_file("../x").is_none());
    }

    #[test]
    fn slug_squeezes_names_into_the_alphabet() {
        assert_eq!(slug("Weekly Report"), "weekly-report");
        assert_eq!(slug("my_skill"), "my_skill");
        assert_eq!(slug("---"), "skill");
        assert_eq!(slug("周报"), "skill");
        assert_eq!(slug("a  b"), "a-b");
    }

    #[test]
    fn collisions_get_a_suffix() {
        assert_eq!(unique_id("weekly", &[]), "weekly");
        assert_eq!(unique_id("weekly", &ids(&["weekly"])), "weekly-2");
        assert_eq!(unique_id("weekly", &ids(&["weekly", "weekly-2"])), "weekly-3");
    }

    #[test]
    fn budget_counts_chars_not_bytes() {
        // 3 000 个汉字 = 9 KB UTF-8，但只有 3 000 字 —— 算得进去
        let body = "字".repeat(3_000);
        assert_eq!(budget(&[&body]).unwrap(), 3_000);
    }

    #[test]
    fn budget_reports_count_first() {
        let body = "a";
        let too_many = vec![body; MAX_SKILLS + 1];
        let error = budget(&too_many).unwrap_err();
        assert_eq!(error.reason, "count");
        assert_eq!(error.total, MAX_SKILLS + 1);
        assert_eq!(error.limit, MAX_SKILLS);
    }

    #[test]
    fn budget_rejects_a_single_long_body() {
        let body = "字".repeat(MAX_BODY_CHARS + 1);
        let error = budget(&[&body]).unwrap_err();
        assert_eq!(error.reason, "body");
        assert_eq!(error.total, MAX_BODY_CHARS + 1);
    }

    #[test]
    fn budget_rejects_a_long_total() {
        let body = "字".repeat(MAX_BODY_CHARS);
        let error = budget(&[&body, &body, &body]).unwrap_err();
        assert_eq!(error.reason, "total");
        assert_eq!(error.total, MAX_BODY_CHARS * 3);
        assert_eq!(error.limit, MAX_TOTAL_CHARS);
    }

    #[test]
    fn enabled_list_is_cleaned_not_truncated() {
        let list = ids(&["a", " a ", "b", "../x", "", "a"]);
        assert_eq!(normalize_enabled(&list), ids(&["a", "b"]));
        let many: Vec<String> = (0..6).map(|index| format!("s{index}")).collect();
        assert_eq!(normalize_enabled(&many).len(), 6, "条数由上一步的 budget 判");
    }

    #[test]
    fn skill_file_name_is_case_insensitive() {
        assert!(is_skill_file("SKILL.md"));
        assert!(is_skill_file("skill.md"));
        assert!(!is_skill_file("README.md"));
    }

    #[test]
    fn empty_body_is_allowed() {
        let skill = parse("---\nname: A\n---\n").expect("empty body");
        assert_eq!(skill.body, "");
    }

    #[test]
    fn char_count_is_codepoints() {
        assert_eq!(chars("周报"), 2);
        assert_eq!(chars("😀"), 1);
        assert_eq!(take_chars("周报abc", 2), "周报");
    }
}
