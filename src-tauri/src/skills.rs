//! 技能包 —— **目录这一半**（0005 §4）。
//!
//! 为什么技能目录归 Rust、前端一条文件也读不到：`skills/` 是**平台自己的配置**。
//! 一份能被模型（或渲染进程里任何一个 XSS）改写的技能目录，等于"它说自己有
//! 这条流程就有"，和 `assistant.json` 是同一条理由。所以：前端只能问列表、
//! 挑启用、导入、删；正文由 Rust 递过去，前端只负责拼进提示词。
//!
//! 四条不变的：
//! - **导入不启用**：导进来只是"有了"，勾上才算"这轮照它做"（和不变量 15
//!   "新权限不自动授予"是同一个形状）。
//! - **撞名不覆盖**：第二份叫 `<id>-2`。覆盖等于静默换掉用户正在用的流程。
//! - **超限拒绝**：上限在 `skills_policy` 里判，这里只把原因搬给界面。
//! - **技能不新增执行通道**：这里没有任何"跑一下技能"的命令。技能正文里要做
//!   的事仍然走那六只手、仍然要审批、仍然进审计（0005 §3）。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::skills_policy;

/// 一份技能的现状。`body` 也在里面 —— 渲染进程没有文件系统，Rust 不递，
/// 这一轮的提示词就只能"知道有这么个技能"却读不到它写的步骤。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub body: String,
    /// 磁盘上的体积（面板上显示给人看）
    pub bytes: u64,
    pub enabled: bool,
    /// 目录里有 `SKILL.md`，但读不成一份技能（没有 front matter / 没有 name）
    pub damaged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsView {
    /// `skills/` 的绝对路径。面板要显示它，否则用户不知道"导入"从哪儿拿、
    /// 删掉的目录去了哪儿
    pub folder: String,
    pub skills: Vec<SkillView>,
}

fn skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::llm::config_dir(app)?.join("skills");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create the skills folder: {error}"))?;
    Ok(dir)
}

/// 目录名 → 一份技能。读不成也**不拦列表**：`damaged` 让用户看见"这个目录里
/// 有东西，但读不成技能"，比它悄悄不出现好
fn read_one(dir: &Path, id: &str, enabled: bool) -> Option<SkillView> {
    let file = dir.join("SKILL.md");
    let bytes = std::fs::metadata(&file).ok().map(|meta| meta.len()).unwrap_or(0);
    let text = std::fs::read_to_string(&file).ok();
    match text.as_deref().and_then(skills_policy::parse) {
        Some(skill) => Some(SkillView {
            id: id.to_string(),
            name: skill.name,
            description: skill.description,
            tools: skill.tools,
            body: skill.body,
            bytes,
            enabled,
            damaged: false,
        }),
        // 读得成文件、但读不成技能：名字先拿 id 顶上，至少点得动删
        None => Some(SkillView {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            tools: Vec::new(),
            body: String::new(),
            bytes,
            enabled,
            damaged: true,
        }),
    }
}

/// 扫一遍 `skills/`。**只认一层目录**：`skills/<id>/SKILL.md`，id 走字母表
fn scan(app: &AppHandle) -> Result<SkillsView, String> {
    let dir = skills_dir(app)?;
    let enabled = crate::llm::skills_enabled(app);
    let mut skills: Vec<SkillView> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(SkillsView {
            folder: dir.display().to_string(),
            skills,
        });
    };
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().to_string();
        if !skills_policy::id_ok(&id) {
            continue;
        }
        if !entry.path().is_dir() {
            continue;
        }
        if !entry.path().join("SKILL.md").is_file() {
            continue;
        }
        if let Some(view) = read_one(&entry.path(), &id, enabled.iter().any(|one| one == &id)) {
            skills.push(view);
        }
    }
    // 按 id 排序：同一组技能每轮拼出来的提示词是同一段字（上下文缓存才有意义）
    skills.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(SkillsView {
        folder: dir.display().to_string(),
        skills,
    })
}

/// 列表。面板每次挂载都问一次，**不信自己的缓存**（用户在资源管理器里删了一个
/// 目录，面板不该还画着它）
#[tauri::command]
pub fn assistant_skills(app: AppHandle) -> Result<SkillsView, String> {
    scan(&app)
}

/// 存启用清单。
///
/// 三道校验，任何一道不过都**不写盘、不截断**：
/// 1. id 形状（`normalize_enabled`，顺带把读坏的剔掉）；
/// 2. 每一份都真的在磁盘上、且没坏 —— 启用一份不存在的技能，提示词里就会出现
///    一节空标题，模型会以为"这条流程只有名字"；
/// 3. 上限（4 份 / 每份 4 000 字 / 合计 8 000 字）。
#[tauri::command]
pub fn assistant_skills_save(app: AppHandle, enabled: Vec<String>) -> Result<SkillsView, String> {
    let wanted = skills_policy::normalize_enabled(&enabled);
    let view = scan(&app)?;
    let mut bodies: Vec<&str> = Vec::new();
    for id in &wanted {
        let skill = view
            .skills
            .iter()
            .find(|one| &one.id == id)
            .ok_or_else(|| format!("there is no skill called {id}"))?;
        if skill.damaged {
            return Err(format!(
                "{id} cannot be read as a skill — fix its SKILL.md or remove the folder"
            ));
        }
        bodies.push(skill.body.as_str());
    }
    if let Err(error) = skills_policy::budget(&bodies) {
        // 话由界面说，但这一句必须到得了用户眼前：不写清"超了多少"，用户只会
        // 看到一个点不动的开关
        return Err(format!(
            "skills are capped at {} — this would be {} ({})",
            error.limit, error.total, error.reason
        ));
    }
    crate::llm::set_skills_enabled(&app, &wanted)?;
    scan(&app)
}

/// 把一个目录或一个 `.md` 拷进 `skills/<id>`。**不启用**。
#[tauri::command]
pub fn assistant_skill_import(app: AppHandle, path: String) -> Result<SkillsView, String> {
    let source = PathBuf::from(path.trim());
    if !source.exists() {
        return Err("that path does not exist".to_string());
    }
    let dir = skills_dir(&app)?;
    let taken: Vec<String> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|id| skills_policy::id_ok(id))
                .collect()
        })
        .unwrap_or_default();

    if source.is_file() {
        if !source
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        {
            return Err("import a folder with a SKILL.md in it, or a single .md file".to_string());
        }
        let stem = source
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let base = if skills_policy::is_skill_file(&source.file_name().unwrap_or_default().to_string_lossy()) {
            // 一个恰好叫 `SKILL.md` 的单独文件：id 只能从它所在的目录名来
            source
                .parent()
                .and_then(|parent| parent.file_name())
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or(stem)
        } else {
            stem
        };
        let id = skills_policy::unique_id(&skills_policy::slug(&base), &taken);
        let target = dir.join(&id);
        std::fs::create_dir_all(&target)
            .map_err(|error| format!("failed to create the skill folder: {error}"))?;
        copy_file(&source, &target.join("SKILL.md"))?;
        check_parses(&target)?;
        return scan(&app);
    }

    // 目录：先确认它真的是一个技能，再拷 —— 拷完才发现读不成，用户手上就多一个
    // 删起来很困惑的目录
    if find_skill_file(&source).is_none() {
        return Err("that folder has no SKILL.md in it".to_string());
    }
    let base = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let id = skills_policy::unique_id(&skills_policy::slug(&base), &taken);
    let target = dir.join(&id);
    let mut budget = CopyBudget::default();
    copy_tree(&source, &target, 0, &mut budget)?;
    if find_skill_file(&target).is_none() {
        let _ = std::fs::remove_dir_all(&target);
        return Err("that folder has no SKILL.md in it".to_string());
    }
    check_parses(&target)?;
    scan(&app)
}

/// 删一个技能目录，并从启用清单里剔掉。
///
/// 先剔清单再删目录：反过来的话，删到一半失败就留下一条"启用了、但文件没了"的
/// 悬空记录，而提示词那一节会变成空标题
#[tauri::command]
pub fn assistant_skill_remove(app: AppHandle, id: String) -> Result<SkillsView, String> {
    if !skills_policy::id_ok(&id) {
        return Err("that is not a skill id".to_string());
    }
    let mut enabled = crate::llm::skills_enabled(&app);
    enabled.retain(|one| one != &id);
    crate::llm::set_skills_enabled(&app, &enabled)?;
    let dir = skills_dir(&app)?.join(&id);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)
            .map_err(|error| format!("failed to remove the skill folder: {error}"))?;
    }
    scan(&app)
}

/* ------------------------------------------------------------------ 内部 */

/// 拷一个目录时的三道额度。**不是防谁**：技能里放一段 500 MB 的语料，
/// 面板上就会一直转，而它本来也进不了提示词
#[derive(Default)]
struct CopyBudget {
    files: usize,
    bytes: u64,
}

fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    let size = std::fs::metadata(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?
        .len();
    if size as usize > skills_policy::MAX_IMPORT_BYTES {
        return Err(format!(
            "{} is larger than the {} KB a skill file may be",
            source.display(),
            skills_policy::MAX_IMPORT_BYTES / 1024
        ));
    }
    std::fs::copy(source, target)
        .map_err(|error| format!("failed to copy {}: {error}", source.display()))?;
    Ok(())
}

fn find_skill_file(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if skills_policy::is_skill_file(&name) && entry.path().is_file() {
            return Some(entry.path());
        }
    }
    None
}

fn copy_tree(
    source: &Path,
    target: &Path,
    depth: usize,
    budget: &mut CopyBudget,
) -> Result<(), String> {
    if depth > skills_policy::MAX_IMPORT_DEPTH {
        return Err("that skill folder is nested too deeply".to_string());
    }
    std::fs::create_dir_all(target)
        .map_err(|error| format!("failed to create {}: {error}", target.display()))?;
    let entries = std::fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏文件与符号链接一概不拷：`.git`、`.DS_Store`、一个指到 C:\ 的链接
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            copy_tree(&path, &target.join(&name), depth + 1, budget)?;
            continue;
        }
        budget.files += 1;
        budget.bytes += meta.len();
        if budget.files > skills_policy::MAX_IMPORT_FILES {
            return Err(format!(
                "that folder has more than {} files",
                skills_policy::MAX_IMPORT_FILES
            ));
        }
        if budget.bytes > skills_policy::MAX_IMPORT_TOTAL {
            return Err(format!(
                "that folder is larger than {} MB",
                skills_policy::MAX_IMPORT_TOTAL / (1024 * 1024)
            ));
        }
        copy_file(&path, &target.join(&name))?;
    }
    Ok(())
}

/// 拷完了要读得成一份技能。读不成就把刚建的目录删掉 —— 留下的那一个用户
/// 只能靠"删掉重来"，而他并不知道里面缺什么
fn check_parses(target: &Path) -> Result<(), String> {
    let file = find_skill_file(target)
        .ok_or_else(|| "that skill has no SKILL.md in it".to_string())?;
    let text = std::fs::read_to_string(&file)
        .map_err(|error| format!("failed to read {}: {error}", file.display()))?;
    if skills_policy::parse(&text).is_none() {
        let _ = std::fs::remove_dir_all(target);
        return Err(
            "that file has no skill front matter — it needs name / description between two --- lines"
                .to_string(),
        );
    }
    Ok(())
}
