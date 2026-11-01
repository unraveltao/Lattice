//! 桌宠 —— **平台自己的一个窗口，不是组件**。
//!
//! # 为什么它不该是组件（LAT-0041 §2.1）
//!
//! 组件是用户摆上去的东西：可以摆，也可以不摆。而"agent 长什么样"不该取决于用户
//! 有没有把某个组件拖到桌面上。更硬的一条是**界面里的头像**：组件跑在沙箱 iframe 里，
//! 它画不到 assistant 小窗的标题栏里去 —— 那道墙是设计出来的，不该为了一个头像开洞。
//!
//! 所以这里的东西和 `runner.rs` 那条管线**一点关系都没有**：
//! 不走 placement、不查桥权限、不进 `sync_widget_windows`、不读 manifest。
//! 平台自带窗口在这个仓库早有先例：assistant 小窗、听写浮钮、对齐参考线，这是第四个。
//!
//! # 它和 `lattice.pet` 那个组件的关系
//!
//! 没关系了。那只鲸鱼从"官方组件"降成"只有你自己装的本地组件"：它继续能用、能加功能，
//! 但平台不再分发它（那 84 张贴图的授权问题见 LAT-0041 §1.1）。桌宠读的是
//! `pets/<id>/pet.json` 这套**新格式**，不是组件清单。
//!
//! # 这一片做到哪
//!
//! 皮肤发现 / 校验 / 状态文件 / 命令面。**窗口和资源协议不在这个文件里** ——
//! 它们要一起落地才有意义（窗口要 `lattice-pet://` 才加载得到贴图），所以单独一片。
//! 在那之前 `pet_boot` 已经把窗口需要的东西全给出来了，接线只是搬过去。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::desktop::{self, WindowLayer, WindowShape};
use crate::pet_policy::{self, Problem, RawSize, RawSkin, Skin};

/// 状态文件名。**故意不叫 `pet.json`** —— 那是皮肤描述符的名字，两者混起来之后的
/// 症状是"换了个形象，我的窗口位置没了"（LAT-0041 §4.7）。
const STATE_FILE: &str = "pet-state.json";

/// 皮肤放在 `app_data_dir/pets/`，和 `widgets/` 平级。
const SKINS_DIR: &str = "pets";

const STATE_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// pet.json 的线上形状
// ---------------------------------------------------------------------------

/// 名字可以写成 `{ "zh": "大肥鱼", "en": "Whale" }`，也可以写成一句 `"大肥鱼"`。
///
/// 两种都收：单语言的小皮肤没理由被迫写一个空 `en`，而双语是平台界面的现状
/// （英文原句当 key、缺翻译退化成英文）。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum NameField {
    Both { zh: Option<String>, en: Option<String> },
    One(String),
}

impl NameField {
    fn into_pair(self) -> (Option<String>, Option<String>) {
        match self {
            NameField::One(text) => (Some(text.clone()), Some(text)),
            NameField::Both { zh, en } => (zh, en),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SizeFile {
    w: u32,
    h: u32,
    #[serde(default = "default_min_w")]
    min_w: u32,
    #[serde(default = "default_min_h")]
    min_h: u32,
}

fn default_min_w() -> u32 {
    pet_policy::MIN_SIDE
}

fn default_min_h() -> u32 {
    pet_policy::MIN_SIDE
}

/// `pet.json` 的磁盘形状。**字段和 `pet_policy::RawSkin` 一一对应**，多出来的忽略
/// （serde 默认行为）—— 那正是"皮肤可以比平台新"的实现。
#[derive(Debug, Clone, Deserialize)]
struct SkinFile {
    format: u32,
    id: Option<String>,
    name: Option<NameField>,
    render: String,
    data: String,
    size: Option<SizeFile>,
    #[serde(default)]
    postures: BTreeMap<String, String>,
    #[serde(default)]
    actions: BTreeMap<String, String>,
    portrait: Option<String>,
}

// ---------------------------------------------------------------------------
// 给前端看的形状
// ---------------------------------------------------------------------------

/// 一份皮肤在列表里的样子。`problem` 非空 = 这份皮肤用不了，但**仍然列出来**
/// —— 用户要知道"我放进去的那只为什么不出现"，而不是对着一个空列表发呆。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinSummary {
    pub id: String,
    pub name_zh: Option<String>,
    pub name_en: Option<String>,
    pub render: Option<String>,
    pub portrait: Option<String>,
    pub problem: Option<ProblemView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemView {
    /// snake_case 码，前端那张中文表的键。
    pub code: String,
    /// 带上具体值的那半句（`render "sprite" not in [rig]`）。
    pub detail: String,
}

impl From<&Problem> for ProblemView {
    fn from(problem: &Problem) -> ProblemView {
        ProblemView {
            code: problem.code().to_string(),
            detail: problem.detail(),
        }
    }
}

/// 平台存的那一份。和 `assistant-window.json` 一个路数：读和写都过一遍夹取。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetState {
    pub version: u32,
    /// 选中的皮肤 id。`None` = 还没选过（第一次启动）。
    pub skin_id: Option<String>,
    /// **唯一**一个"我不想看见它"的开关。托盘菜单和设置页写的是同一个字段。
    pub hidden: bool,
    pub rect: Rect,
    pub scale: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// 窗口要的那一份。`pet_boot` 返回它，`pet.html` 照着建渲染器。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetBoot {
    pub state: PetState,
    pub skin: SkinView,
}

/// 校验过的皮肤 + 它声明的那些东西，前端不用再解一遍 `pet.json`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinView {
    pub id: String,
    pub render: String,
    /// 渲染器数据文件的相对路径（rig 渲染器下是 `model.json`）。
    pub data: String,
    pub w: u32,
    pub h: u32,
    pub portrait: Option<String>,
    /// 与 `pet_policy::POSTURES` 同长同序。`null` = 皮肤没声明，渲染器用自己的默认。
    pub postures: Vec<Option<String>>,
    pub actions: Vec<ActionView>,
    /// 被忽略的东西（皮肤比平台新的那些）。设置页把它显示成一行灰字。
    pub ignored: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionView {
    pub gesture: &'static str,
    pub action: &'static str,
}

impl SkinView {
    fn of(skin: &Skin) -> SkinView {
        SkinView {
            id: skin.id.clone(),
            render: skin.render.clone(),
            data: skin.data.clone(),
            w: skin.size.w,
            h: skin.size.h,
            portrait: skin.portrait.clone(),
            postures: skin.postures.iter().cloned().collect(),
            actions: skin
                .actions
                .iter()
                .map(|(gesture, action)| ActionView { gesture, action })
                .collect(),
            ignored: skin.ignored.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// 目录与状态
// ---------------------------------------------------------------------------

/// `app_data_dir/pets/`，不存在就建。
///
/// 泛型在 `Runtime` 上，因为资源协议（`protocol.rs`）要按协议名复用同一个处理函数，
/// 而那边拿到的 `AppHandle` 是泛型的。
pub(crate) fn skins_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let dir = base.join(SKINS_DIR);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("failed to create the pets directory: {error}"))?;
    }
    Ok(dir)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    Ok(dir.join(STATE_FILE))
}

/// 当前屏的工作区（逻辑像素）。和 `assistant_window.rs` 同一个取法：
/// 有窗口就问窗口所在那块屏，没有就问主屏。
fn work_area(app: &AppHandle) -> (i32, i32, i32, i32) {
    let monitor = app
        .get_webview_window(LABEL)
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return (0, 0, 1280, 800);
    };
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    (
        origin.x.round() as i32,
        origin.y.round() as i32,
        size.width.round() as i32,
        size.height.round() as i32,
    )
}

/// 窗口标签。和 assistant 的 `LABEL` 一样是固定的 —— 桌宠只有一只。
pub const LABEL: &str = "pet";

fn fresh_state(app: &AppHandle) -> PetState {
    let size = RawSize::DEFAULT;
    let (x, y) = pet_policy::default_position(size, work_area(app));
    PetState {
        version: STATE_VERSION,
        skin_id: None,
        hidden: false,
        rect: Rect {
            x,
            y,
            w: size.w,
            h: size.h,
        },
        scale: 1.0,
    }
}

/// 把一份状态夹进现在的屏幕与上下限。
///
/// **读和写都要过这一道**：文件可能是手改的、可能来自一块已经拔掉的副屏、
/// 可能是一个缩到 0 的旧版本 —— 任何一次都不该变成"宠物在屏幕外面"。
fn normalize_state(app: &AppHandle, state: &mut PetState) {
    state.version = STATE_VERSION;
    state.scale = if state.scale.is_finite() {
        state.scale.clamp(0.5, 2.0)
    } else {
        1.0
    };
    let size = RawSize {
        w: state.rect.w,
        h: state.rect.h,
        min_w: pet_policy::MIN_SIDE,
        min_h: pet_policy::MIN_SIDE,
    };
    let clamped = pet_policy::clamp_size(Some(size));
    state.rect.w = clamped.w;
    state.rect.h = clamped.h;
    let (x, y) = pet_policy::clamp_position(state.rect.x, state.rect.y, clamped, work_area(app));
    state.rect.x = x;
    state.rect.y = y;
}

fn load_state(app: &AppHandle) -> PetState {
    let mut state = state_path(app)
        .ok()
        .filter(|path| path.exists())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<PetState>(&text).ok())
        .unwrap_or_else(|| fresh_state(app));
    normalize_state(app, &mut state);
    state
}

fn save_state(app: &AppHandle, state: &PetState) -> Result<(), String> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| format!("failed to save pet state: {error}"))
}

// ---------------------------------------------------------------------------
// 皮肤发现
// ---------------------------------------------------------------------------

/// 扫一遍 `pets/`。
///
/// 排序按 id，**不是按目录遍历顺序** —— 那个顺序在 Windows 上是文件系统的实现细节，
/// 换台机器就变，而设置页里那排形象不该每次打开都换个次序。
fn discover(app: &AppHandle) -> Vec<(SkinSummary, Option<Skin>)> {
    match skins_dir(app) {
        Ok(root) => scan(&root),
        Err(_) => Vec::new(),
    }
}

/// 扫一个皮肤根目录。
///
/// **和 `AppHandle` 无关**，所以测试能直接喂它一个临时目录 —— 而这一层恰恰是
/// 最需要测的："我放进去的那只为什么不出现"的答案全在这里，而它出错时
/// 没有任何一处会报错，只是桌面上空着。
pub(crate) fn scan(root: &std::path::Path) -> Vec<(SkinSummary, Option<Skin>)> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut found: Vec<(SkinSummary, Option<Skin>)> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        found.push(load_skin(&dir, &dir_name));
    }
    found.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    found
}

/// 读一份皮肤。**永远返回一个 `SkinSummary`** —— 读失败也要有一条记录，
/// 否则用户只会看到"我放进去的那只不见了"，而没有任何地方说得出为什么。
fn load_skin(dir: &std::path::Path, dir_name: &str) -> (SkinSummary, Option<Skin>) {
    let empty = |problem: Problem| {
        (
            SkinSummary {
                id: dir_name.to_string(),
                name_zh: None,
                name_en: None,
                render: None,
                portrait: None,
                problem: Some(ProblemView::from(&problem)),
            },
            None,
        )
    };

    let path = dir.join("pet.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        // 目录里没有 pet.json：不是"坏皮肤"，是"这里没有皮肤"。跳过它，
        // 别在列表里留一条看不懂的红字 —— `pets/` 里可能有用户的备份目录。
        return (
            SkinSummary {
                id: dir_name.to_string(),
                name_zh: None,
                name_en: None,
                render: None,
                portrait: None,
                problem: None,
            },
            None,
        );
    };

    let Ok(file) = serde_json::from_str::<SkinFile>(&text) else {
        // JSON 本身坏了。这和"字段不对"是两件事，但给用户看的话是同一句：
        // 这份皮肤读不了。用 `bad_json` 而不是 `bad_id`，别让人去查 id。
        return empty(Problem::MissingData);
    };

    let (name_zh, name_en) = file
        .name
        .clone()
        .map(NameField::into_pair)
        .unwrap_or((None, None));

    let raw = RawSkin {
        format: file.format,
        id: file.id.clone().unwrap_or_else(|| dir_name.to_string()),
        render: file.render.clone(),
        data: file.data.clone(),
        size: file.size.as_ref().map(|size| RawSize {
            w: size.w,
            h: size.h,
            min_w: size.min_w,
            min_h: size.min_h,
        }),
        postures: file
            .postures
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        actions: file.actions.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        portrait: file.portrait.clone(),
    };

    match pet_policy::accept(raw) {
        Ok(skin) => {
            // 数据文件必须真的在。`pet_policy` 只查路径形状，查不了磁盘 ——
            // 而"校验通过但文件不存在"的症状是宠物窗一片空白，比拒绝难查得多。
            if !pet_policy::resolve(dir, &skin.data).is_file() {
                return empty(Problem::MissingData);
            }
            let summary = SkinSummary {
                id: skin.id.clone(),
                name_zh,
                name_en,
                render: Some(skin.render.clone()),
                portrait: skin.portrait.clone(),
                problem: None,
            };
            (summary, Some(skin))
        }
        Err(problem) => {
            let mut entry = empty(problem);
            entry.0.name_zh = name_zh;
            entry.0.name_en = name_en;
            entry.0.render = Some(file.render);
            entry
        }
    }
}

/// 找一份能用的皮肤：优先选中的那只，否则第一只可用的。
fn pick(app: &AppHandle, wanted: Option<&str>) -> Option<(SkinSummary, Skin)> {
    let all = discover(app);
    let usable: Vec<(SkinSummary, Skin)> = all
        .into_iter()
        .filter_map(|(summary, skin)| skin.map(|skin| (summary, skin)))
        .collect();

    if let Some(id) = wanted {
        if let Some(hit) = usable.iter().find(|(summary, _)| summary.id == id) {
            return Some(hit.clone());
        }
    }
    usable.into_iter().next()
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 设置页那一排形象。**读不了的也在里面**，带 `problem`。
#[tauri::command]
pub fn pet_skins(app: AppHandle) -> Result<Vec<SkinSummary>, String> {
    Ok(discover(&app).into_iter().map(|(summary, _)| summary).collect())
}

#[tauri::command]
pub fn pet_state(app: AppHandle) -> PetState {
    load_state(&app)
}

/// 选一只。选的那只如果读不了，**不改状态** —— 让设置页显示原因，
/// 而不是把用户的选择悄悄换成一个能用的。
#[tauri::command]
pub fn pet_choose(app: AppHandle, skin_id: String) -> Result<PetState, String> {
    let Some((summary, _)) = pick(&app, Some(&skin_id)) else {
        return Err(format!("no usable skin with id \"{skin_id}\""));
    };
    if summary.id != skin_id {
        return Err(format!("skin \"{skin_id}\" is not usable"));
    }
    let mut state = load_state(&app);
    state.skin_id = Some(summary.id);
    normalize_state(&app, &mut state);
    save_state(&app, &state)?;

    // 换形象 = 重建窗口。不只是换渲染器数据：**尺寸也可能不同**（`pet.json` 的
    // `size` 是皮肤声明的），而且新皮肤可能换了渲染器。让窗口就地换一身衣服
    // 要比销毁重建省，但省下来的是 200 毫秒，换来的是两条不同的加载路径
    // —— 一条"开机第一次"、一条"换皮肤"，后者只有在用户换皮肤时才会跑到。
    destroy(&app);
    create(&app)?;
    avoid_assistant(&app);
    Ok(state)
}

/// 藏起来 / 放出来。托盘菜单和设置页共用这一条。
#[tauri::command]
pub fn pet_set_hidden(app: AppHandle, hidden: bool) -> Result<PetState, String> {
    let mut state = load_state(&app);
    state.hidden = hidden;
    save_state(&app, &state)?;
    set_visible(&app, !hidden)?;
    Ok(state)
}

/// 拖动结束后写回位置。窗口那边在 `Moved` 上攒着调，不每帧写盘。
#[tauri::command]
pub fn pet_save_rect(app: AppHandle, x: i32, y: i32, w: u32, h: u32) -> Result<PetState, String> {
    let mut state = load_state(&app);
    state.rect = Rect { x, y, w, h };
    normalize_state(&app, &mut state);
    save_state(&app, &state)?;
    Ok(state)
}

/// 宠物窗启动时问这一句：**我是谁、画哪只、多大、在哪**。
///
/// 一次问全，不让窗口自己再拼三四个命令 —— 窗口是平台自己的，没有理由让它
/// 走一遍"先拿列表再拿状态再拿描述符"的舞。
#[tauri::command]
pub fn pet_boot(app: AppHandle) -> Result<Option<PetBoot>, String> {
    let state = load_state(&app);
    let Some((_, skin)) = pick(&app, state.skin_id.as_deref()) else {
        return Ok(None);
    };
    Ok(Some(PetBoot {
        state,
        skin: SkinView::of(&skin),
    }))
}

/// 手势触发的动作。
///
/// **动作名来自皮肤数据，而皮肤是用户从外面放进来的** —— 所以这里是白名单，
/// 不是"皮肤能调任意平台能力"。不在表里的一律安静返回成功：皮肤可能比平台新，
/// 它声明的动作平台还不认识，那是"这个动作暂时没效果"，不是错误。
///
/// 皮肤在 `pet.json` 里把 `click` 映射到 `open-assistant`，渲染器照着查表再调
/// 这一条。**映射在数据里、实现在代码里**：换一只形象改它的 `pet.json` 就够了，
/// 不用碰这一行。
#[tauri::command]
pub fn pet_act(app: AppHandle, action: String) -> Result<(), String> {
    match action.as_str() {
        "open-assistant" => {
            crate::assistant_window::toggle(&app)?;
            Ok(())
        }
        "toggle-sleep" => {
            let now = crate::presence::presence_get()?;
            let next = if now.posture == "asleep" { "idle" } else { "asleep" };
            crate::presence::presence_report(app, next.to_string(), None)?;
            Ok(())
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

fn hwnd_of(window: &tauri::WebviewWindow) -> Option<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(win32) => Some(win32.hwnd.get() as isize),
        _ => None,
    }
}

/// 建窗口。**没有可用皮肤就不建** —— 一个空窗口不是"桌宠在加载"，是"一块吃点击的透明区域"。
///
/// 参数照抄 `runner.rs:540-586` 那一组（区域窗的三条硬要求都在那儿的注释里）：
/// - `transparent(true)`：区域之内没被画到的像素否则会被 WebView2 拿窗口底色填上，
///   浅色壁纸上就是她周围一圈黑框。
/// - `always_on_top(true)` **在 `build()` 之前**：事后调 `set_always_on_top` 对无边框
///   透明窗口返回成功但 `WS_EX_TOPMOST` 永远不出现。
/// - `focused(false)` + `apply_to(.., interactive: false, ..)`：那一位给窗口挂上
///   `WS_EX_NOACTIVATE`，点她不抢焦点 —— 一只宠物把光标从你的编辑器里抢走是不能接受的。
fn create(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let state = load_state(app);
    if state.hidden {
        return Ok(());
    }
    if pick(app, state.skin_id.as_deref()).is_none() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pet.html".into()))
        .title("Lattice Companion")
        .inner_size(state.rect.w as f64, state.rect.h as f64)
        .position(state.rect.x as f64, state.rect.y as f64)
        .decorations(false)
        // 阴影要系统画，而系统画的是**矩形**的阴影 —— 一只区域窗带一圈矩形阴影
        // 就是"她周围有一个看不见的框"。
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .transparent(true)
        .always_on_top(true)
        .build()
        .map_err(|error| format!("could not create the companion window: {error}"))?;

    // **先显示再落层级**：`ShowWindow` 会把窗口提到最前，顺序反过来刚压到顶层的
    // 窗口又被顶下去（`runner.rs:642` 同一个理由）。
    let _ = window.show();

    desktop::apply_to(&window, WindowLayer::Top, false, false, WindowShape::Region)?;

    // 空区域 = 渲染器上报轮廓之前她"不存在"。窗口本身是透明的，但不裁的话
    // 整块 420×340 会吃掉点击 —— 用户会以为应用卡了。
    if let Some(hwnd) = hwnd_of(&window) {
        desktop::set_region(hwnd, &[])?;
    }

    // 区域是在 `apply_to` 之后才贴上的，那一步会动非客户区；收尾再确认一次置顶。
    // 少了它，桌宠偶尔建出来是被浏览器压着的普通窗口（`runner.rs:678` 同一个坑）。
    let _ = window.set_always_on_top(true);

    // 这一扇窗只该显示本地内容。挂上出网闸门当保险：哪天有人往 pet.html 里塞一个
    // 远程 `<img>`，它不会悄悄变成一条出网通道。
    crate::egress::guard(app, &window);

    Ok(())
}

fn destroy(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

/// 藏起来 / 放出来。`hidden` 是唯一那个开关，托盘和设置页都走它。
pub fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    if visible {
        create(app)
    } else {
        destroy(app);
        Ok(())
    }
}

/// 启动时建一次。失败不 panic：一只宠物建不出来不该让整个应用起不来。
pub fn boot(app: &AppHandle) {
    if let Err(error) = create(app) {
        eprintln!("[lattice] failed to create the companion window: {error}");
    }
}

/// 渲染器算好的轮廓（物理像素，相对客户区）。空数组 = 整窗点透。
#[tauri::command]
pub fn pet_set_region(
    app: AppHandle,
    parts: Vec<crate::desktop::RegionPart>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    let Some(hwnd) = hwnd_of(&window) else {
        return Ok(());
    };
    desktop::set_region(hwnd, &parts)
}

/// 小窗出现 / 消失 / 被挪动时，宠物让开或者回去（LAT-0041 §4.5）。
///
/// **层级改不了就改位置**：她必须出生即 Top，而小窗是故意不置顶的普通窗口，
/// 所以她会压在聊天框上。这条函数把她的窗口挪到不重叠的地方；小窗藏起来之后
/// 再挪回 `pet-state.json` 里那个位置。
///
/// **挪动不写盘**：让位是临时的，用户选的位置才是权威。写进去的话，
/// 聊天窗开一次、关一次，她的"家"就被改成了被挤到角落的那个坐标。
pub fn avoid_assistant(app: &AppHandle) {
    let Some(pet) = app.get_webview_window(LABEL) else {
        return;
    };
    let state = load_state(app);
    let home = (state.rect.x, state.rect.y);

    let target = match app.get_webview_window(crate::assistant_window::LABEL) {
        Some(assistant) if assistant.is_visible().unwrap_or(false) => {
            let scale = pet.scale_factor().unwrap_or(1.0);
            match (assistant.outer_position(), assistant.outer_size()) {
                (Ok(position), Ok(size)) => {
                    let window = position.to_logical::<i32>(scale);
                    let extent = size.to_logical::<i32>(scale);
                    pet_policy::avoid(
                        (home.0, home.1, state.rect.w as i32, state.rect.h as i32),
                        (window.x, window.y, extent.width, extent.height),
                        work_area(app),
                    )
                }
                // 问不到小窗的矩形（它刚销毁、或 DPI 正在变）：保持原样，
                // 别拿一个猜出来的值把她甩到屏幕另一头
                _ => home,
            }
        }
        _ => home,
    };

    if target != home {
        let _ = pet.set_position(tauri::LogicalPosition::new(target.0, target.1));
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 一个用完就删的临时目录。
    ///
    /// 不引 `tempfile`：这里只需要"唯一 + 能删"两件事，而这一片和 `pet_policy`
    /// 一样守着"能少一个依赖就少一个"。名字里带 pid 和时间戳 —— 测试并行跑，
    /// 撞名字的症状是两条测试互相删对方的文件，报错还指向另一个测试。
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Scratch {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let name = format!("lattice-pet-{}-{tag}-{stamp}", std::process::id());
            let path = std::env::temp_dir().join(name);
            std::fs::create_dir_all(&path).expect("could not create the scratch directory");
            Scratch(path)
        }

        fn dir(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::create_dir_all(&path).expect("could not create a skin directory");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("could not create the parent directory");
        }
        std::fs::write(path, text).expect("could not write the fixture");
    }

    /// 一份最小的合法描述符。**和真装在那台机器上的 `pets/whale/pet.json` 同形**
    /// —— 换素材时最容易写错的就是这里，所以测试钉的是这个形状，不是抽象形状。
    const GOOD: &str = r#"{
        "format": 1,
        "id": "whale",
        "name": { "zh": "大肥鱼", "en": "Big Fishy" },
        "render": "rig",
        "data": "model.json",
        "size": { "w": 420, "h": 340, "minW": 340, "minH": 280 },
        "postures": { "idle": "neutral", "asleep": "sleep" },
        "actions": { "click": "open-assistant" }
    }"#;

    #[test]
    fn a_folder_without_a_descriptor_is_not_an_error() {
        // `pets/` 里可能有用户自己的备份目录。那不是坏皮肤，是"这里没有皮肤"。
        let scratch = Scratch::new("empty");
        scratch.dir("backup-of-mine");
        let found = scan(&scratch.0);
        assert_eq!(found.len(), 1);
        assert!(found[0].0.problem.is_none(), "没有 pet.json 不算坏皮肤");
        assert!(found[0].1.is_none(), "但也没有能用的皮肤");
    }

    #[test]
    fn a_usable_skin_is_discovered() {
        let scratch = Scratch::new("usable");
        let dir = scratch.dir("whale");
        write(&dir.join("pet.json"), GOOD);
        write(&dir.join("model.json"), "{}");

        let found = scan(&scratch.0);
        assert_eq!(found.len(), 1);
        assert!(found[0].0.problem.is_none());
        let skin = found[0].1.as_ref().expect("这份皮肤应该可用");
        assert_eq!(skin.id, "whale");
        assert_eq!(skin.size.w, 420);
        assert_eq!(skin.actions, vec![("click", "open-assistant")]);
        // 名字是双语对象时两个都要留 —— 界面按当前语言挑
        assert_eq!(found[0].0.name_zh.as_deref(), Some("大肥鱼"));
        assert_eq!(found[0].0.name_en.as_deref(), Some("Big Fishy"));
    }

    #[test]
    fn a_descriptor_pointing_at_a_missing_data_file_is_rejected() {
        // `pet_policy` 只查路径形状，查不了磁盘。而"校验通过但文件不存在"的症状
        // 是宠物窗一片空白 —— 比明确拒绝难查得多，所以这一道必须在这一层补。
        let scratch = Scratch::new("nodata");
        let dir = scratch.dir("whale");
        write(&dir.join("pet.json"), GOOD);

        let found = scan(&scratch.0);
        assert!(found[0].1.is_none(), "数据文件不在就不能用");
        let problem = found[0].0.problem.as_ref().expect("要带一个能读的原因");
        assert_eq!(problem.code, "missing_data");
    }

    #[test]
    fn broken_json_is_reported_not_dropped() {
        // 症状是"我放进去的那只不见了"。留在列表里、带一句原因，才查得下去。
        let scratch = Scratch::new("badjson");
        let dir = scratch.dir("oops");
        write(&dir.join("pet.json"), "{ this is not json");

        let found = scan(&scratch.0);
        assert_eq!(found.len(), 1, "坏皮肤也要留在列表里");
        assert!(found[0].1.is_none());
        assert!(found[0].0.problem.is_some());
    }

    #[test]
    fn an_unknown_renderer_is_rejected_but_an_unknown_posture_is_not() {
        // 那两条不对称是"换素材"能成立的唯一原因：平台画不出来的东西必须拒绝
        // （否则窗口一片空白），平台还没见过的姿态必须忽略（否则皮肤比平台新
        // 就整只消失）。
        let scratch = Scratch::new("renderer");
        let dir = scratch.dir("sprite");
        write(&dir.join("pet.json"), &GOOD.replace("\"rig\"", "\"sprite\""));
        write(&dir.join("model.json"), "{}");

        let found = scan(&scratch.0);
        assert!(found[0].1.is_none(), "不认识的渲染器必须拒绝");
        assert_eq!(
            found[0].0.problem.as_ref().expect("要带原因").code,
            "unknown_renderer"
        );

        let scratch2 = Scratch::new("posture");
        let dir2 = scratch2.dir("future");
        write(
            &dir2.join("pet.json"),
            &GOOD.replace(
                "\"idle\": \"neutral\"",
                "\"idle\": \"neutral\", \"dancing\": \"happy\"",
            ),
        );
        write(&dir2.join("model.json"), "{}");

        let found2 = scan(&scratch2.0);
        let skin = found2[0].1.as_ref().expect("皮肤比平台新不该让整只消失");
        assert!(
            skin.ignored.iter().any(|line| line.contains("dancing")),
            "被忽略的键要留痕，否则用户不知道为什么那个姿态没反应"
        );
    }

    #[test]
    fn the_list_is_sorted_by_id_not_by_directory_order() {
        // 目录遍历顺序是文件系统的实现细节，换台机器就变；设置页里那排形象
        // 不该每次打开都换个次序。
        let scratch = Scratch::new("order");
        for name in ["zebra", "apple", "mango"] {
            let dir = scratch.dir(name);
            write(
                &dir.join("pet.json"),
                &GOOD.replace("\"whale\"", &format!("\"{name}\"")),
            );
            write(&dir.join("model.json"), "{}");
        }

        let ids: Vec<String> = scan(&scratch.0).into_iter().map(|(s, _)| s.id).collect();
        assert_eq!(ids, vec!["apple", "mango", "zebra"]);
    }

    #[test]
    fn a_single_language_name_is_accepted() {
        // 单语言的小皮肤没理由被迫写一个空 `en`。
        let scratch = Scratch::new("onename");
        let dir = scratch.dir("plain");
        write(
            &dir.join("pet.json"),
            &GOOD.replace(
                "{ \"zh\": \"大肥鱼\", \"en\": \"Big Fishy\" }",
                "\"大肥鱼\"",
            ),
        );
        write(&dir.join("model.json"), "{}");

        let found = scan(&scratch.0);
        assert!(found[0].1.is_some(), "一句名字也是合法的");
        assert_eq!(found[0].0.name_zh.as_deref(), Some("大肥鱼"));
        assert_eq!(found[0].0.name_en.as_deref(), Some("大肥鱼"));
    }
}
