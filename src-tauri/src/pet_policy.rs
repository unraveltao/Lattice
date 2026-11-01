//! 桌宠的皮肤判据 —— 纯逻辑，不引 crate，能 `rustc --test` 单跑。
//!
//! # 这个文件存在的唯一理由
//!
//! **让平台不知道它是鲸鱼。**
//!
//! 用户明说"后续我可能会换素材"。换素材能不能不痛，不取决于渲染器写得多好，取决于
//! 平台**假设**了多少东西。所以这里做的全是"把假设收窄"的活：
//!
//! - 部件叫什么、有几件、贴图怎么切 —— 平台一个字都不问，那是渲染器的事。
//! - 平台只认三样：**六个姿态**（`POSTURES`）、**六个动作**（`ACTIONS`）、**一个格式版本**。
//! - 平台只查一件事：**路径有没有跑出皮肤目录**。
//!
//! 判断的形状照 `capability_policy.rs`：`Problem` 是一个**封闭的原因集合**，
//! 每个都带 `code()`，前端翻成人话。没有"拒绝但不说为什么"这条路。
//!
//! # 为什么不在这里读 JSON
//!
//! `pet.json` 的解析在 `pet.rs`（那边能用 serde）。这个文件只接受一个已经解析好的
//! `RawSkin`，吐一个校验过的 `Skin`。拆开的理由和 `llm_policy` / `hands_policy` 一样：
//! 引了 `serde` 就 `rustc --test` 不了，而本机跑不了 `cargo test` —— 那些断言会
//! 悄悄退回成"只有 CI 跑"（见 AGENTS §11）。
//!
//! # 兼容性写在哪儿
//!
//! 三个方向，故意不对称（§5.3 / §5.4）：
//!
//! | 遇到 | 怎么办 | 为什么 |
//! | --- | --- | --- |
//! | 不认识的**字段** | 忽略 | 皮肤可以比平台新 |
//! | 不认识的**动作 id** | 忽略那一条 | 同上，皮肤声明了平台还没有的动作 |
//! | 不认识的**姿态** | 忽略那个键 | 同上 |
//! | 不认识的**渲染器** | **拒绝整个皮肤** | 拿错渲染器画出来的是一堆错位的图，比明确拒绝糟得多 |
//! | `format` 比平台新 | **拒绝** | 装错了，必须拦 |
//! | `format` 比平台旧 | 走迁移 | 现在只有 1，但闸的位置留着 |

use std::path::Path;

/// 平台当前的皮肤格式版本。**改语义才加一，加字段不加。**
pub const FORMAT: u32 = 1;

/// 平台认识的渲染器。加一个 = 支持一种新画法（精灵图逐帧、SVG、骨骼动画…）。
///
/// 加进来的时候要同时在 `pet.rs` 的 `renderer()` 里给出实现，否则皮肤会被
/// 接受然后画不出来 —— 那种"接受了但不动"比拒绝难查得多。
pub const RENDERERS: [&str; 1] = ["rig"];

/// 平台对外暴露的六种姿态。**这是平台契约，不是某只宠物的表情表。**
///
/// 顺序有意义：`postures` 的索引与这张表对齐，`expression_for` 靠它查。
/// 加一种姿态 = 改这张表 + 改前端那张中文表 + 报告方各补一处。
pub const POSTURES: [&str; 6] = ["idle", "working", "waiting", "done", "error", "asleep"];

/// 平台定义的动作。皮肤只能**挑**，不能造。
///
/// `none` 是故意给的：想关掉某个手势就得有办法说"这个手势什么都不做"，
/// 否则唯一的选择是不写 —— 而"不写"和"没实现"在皮肤作者眼里是两件事。
pub const ACTIONS: [&str; 6] = [
    "open-assistant",
    "toggle-sleep",
    "move-window",
    "roam",
    "bubble",
    "none",
];

/// 皮肤能绑的手势。加一个手势 = 前端要真的产生这个手势。
pub const GESTURES: [&str; 3] = ["click", "doubleClick", "drag"];

/// 瞬时姿态保留多久再回落到 `idle`。
///
/// `done` / `error` 是"刚才发生了一件事"，不是"现在处于这个状态"。4 秒够人看见
/// 一眼，又不至于让一只刚说完话的宠物一直挂着笑脸。回落由**平台**做 —— 让每个
/// 报告方自己记定时器，就是 N 个定时器抢同一个字段。
pub const TRANSIENT_MS: u64 = 4_000;

/// 窗口尺寸的下限 / 上限（逻辑像素）。
///
/// 下限不是"皮肤说多小就多小"：一张 40×40 的宠物不是"小一号的宠物"，是一张缩略图
/// （PET_REFERENCE §5 为这句话踩过一次）。上限是"别让它占掉半个屏"。
pub const MIN_SIDE: u32 = 120;
pub const MAX_SIDE: u32 = 1_200;

// ---------------------------------------------------------------------------
// 输入：从 pet.json 解析出来、还没校验的那一份
// ---------------------------------------------------------------------------

/// 皮肤声明的窗口尺寸。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawSize {
    pub w: u32,
    pub h: u32,
    pub min_w: u32,
    pub min_h: u32,
}

impl RawSize {
    /// 皮肤的缺省尺寸。和 `lattice.pet` 0.9.1 之后那一版一致（420×340 / 最小 340×280）。
    pub const DEFAULT: RawSize = RawSize {
        w: 420,
        h: 340,
        min_w: 340,
        min_h: 280,
    };
}

/// `pet.json` 的镜像。字段名和 JSON 一一对应，解析由 `pet.rs` 做。
#[derive(Debug, Clone, Default)]
pub struct RawSkin {
    pub format: u32,
    /// 目录名。平台拿它当 id，所以它有字符集限制（见 `valid_id`）。
    pub id: String,
    pub render: String,
    /// 渲染器数据文件的相对路径（rig 渲染器下是 `model.json`）。
    pub data: String,
    pub size: Option<RawSize>,
    /// 姿态 → 这只宠物自己的表情名。**保持插入顺序无所谓**，查的时候按 `POSTURES` 走。
    pub postures: Vec<(String, String)>,
    /// 手势 → 动作 id。
    pub actions: Vec<(String, String)>,
    pub portrait: Option<String>,
}

// ---------------------------------------------------------------------------
// 输出：校验过的那一份
// ---------------------------------------------------------------------------

/// 一份能用的皮肤。
///
/// 和 `capability_policy::Verdict` 一个路子：**校验过的东西才配叫 `Skin`**，
/// 所以下游拿到的值不存在"字段可能非法"这种状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skin {
    pub id: String,
    pub render: String,
    pub data: String,
    pub size: RawSize,
    /// 与 `POSTURES` 同长同序。`None` = 皮肤没声明这个姿态，渲染器用自己的默认。
    pub postures: [Option<String>; POSTURES.len()],
    /// 只留下平台认识的动作，顺序按 `ACTIONS`。
    pub actions: Vec<(&'static str, &'static str)>,
    pub portrait: Option<String>,
    /// 被忽略掉的东西，给人看。**不是错误** —— 皮肤比平台新的时候必然会有。
    ///
    /// 设置页会把这几条显示成一行灰字（"这份形象声明了 2 个本版本还不支持的动作"），
    /// 否则用户只会看到"我明明写了 click 却没反应"，而那件事没有任何地方会报。
    pub ignored: Vec<String>,
}

/// 拒绝的原因。封闭集合，每个都带一个 snake_case 码给前端翻。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// `format` 比平台新。**必须拦** —— 这是"装错了"，不是"尽力而为"。
    FormatTooNew { got: u32 },
    /// `format` 是 0 或负数。不是"旧"，是无效。
    FormatInvalid,
    /// 不认识的渲染器。拒绝时要把 `got` 带出去 —— "你的渲染器不支持"没有用，
    /// "你的 `sprite` 不支持，支持的是 `rig`" 才有用。
    UnknownRenderer { got: String },
    /// `data` 是空的，或者指向的文件不存在（存在性由 `pet.rs` 查，这里只查空）。
    MissingData,
    /// 路径跑出了皮肤目录。
    PathEscapes { field: &'static str },
    /// id 非法（空 / 带分隔符 / 带 `..`）。
    BadId,
}

impl Problem {
    /// 前端那张中文表的键。**新增变体必须同时加一句中文**，否则界面上是一串英文码。
    pub fn code(&self) -> &'static str {
        match self {
            Problem::FormatTooNew { .. } => "format_too_new",
            Problem::FormatInvalid => "format_invalid",
            Problem::UnknownRenderer { .. } => "unknown_renderer",
            Problem::MissingData => "missing_data",
            Problem::PathEscapes { .. } => "path_escapes",
            Problem::BadId => "bad_id",
        }
    }

    /// 给人看的那半句。带上具体值，不然用户不知道该改哪儿。
    pub fn detail(&self) -> String {
        match self {
            Problem::FormatTooNew { got } => {
                format!("format {got} > {FORMAT}")
            }
            Problem::FormatInvalid => "format must be >= 1".to_string(),
            Problem::UnknownRenderer { got } => {
                format!("render \"{got}\" not in [{}]", RENDERERS.join(", "))
            }
            Problem::MissingData => "data is empty".to_string(),
            Problem::PathEscapes { field } => format!("{field} points outside the skin folder"),
            Problem::BadId => "id must be a plain folder name".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/// 版本闸。**只拦一个方向**（§5.4）。
///
/// 比平台新 = 装错了，拒绝；比平台旧 = 走迁移。现在只有 1，所以 `1` 直接过。
/// 将来加 2 的时候，这里变成 `match got { 1 => migrate_v1(raw), 2 => raw, _ => ... }`。
pub fn check_format(got: u32) -> Result<(), Problem> {
    if got == 0 {
        return Err(Problem::FormatInvalid);
    }
    if got > FORMAT {
        return Err(Problem::FormatTooNew { got });
    }
    Ok(())
}

/// 渲染器名。大小写和首尾空白都不计较 —— 皮肤作者手写 JSON，`"Rig "` 不该炸。
pub fn normalize_render(got: &str) -> Result<String, Problem> {
    let name = got.trim().to_ascii_lowercase();
    if !RENDERERS.contains(&name.as_str()) {
        return Err(Problem::UnknownRenderer { got: name });
    }
    Ok(name)
}

/// 皮肤里的相对路径必须落在皮肤目录内。
///
/// 三道，缺一不可：
/// - 反斜杠和正斜杠都当分隔符（Windows 作者会写 `tex\a.png`）；
/// - 任何一段是 `..` 就拒（`tex/../../x` 也要拒，不能只看开头）；
/// - 盘符（`C:`）和根（`/`、`\`）直接拒 —— 那是绝对路径换了个写法。
///
/// 空路径不算逃逸，算缺字段，由调用方给 `MissingData`。
pub fn path_is_inside(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() {
        return true;
    }
    // 盘符：C: / d: / \\?\C: 之类
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    // 根
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    // 逐段看
    !path
        .split(['/', '\\'])
        .any(|seg| seg == ".." || seg == "~")
}

/// id 就是目录名，所以它不能带路径语义。
///
/// 允许字母数字、`-`、`_`、`.`（`lattice.whale` 这种带点的 id 是合法目录名），
/// 别的都拒。**空 id 拒**：它是"哪一只"的唯一键，空了就没法存选择。
pub fn valid_id(id: &str) -> bool {
    let id = id.trim();
    if id.is_empty() || id == "." || id == ".." {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// 尺寸夹取。**越界不拒绝** —— 用户的窗口比皮肤的假设更重要（§6）。
///
/// 三条都往"能用"那边倒：宽度不小于 `min_w`、`min_w` 不小于 `MIN_SIDE`、
/// 宽高不超过 `MAX_SIDE`。皮肤写了 `w: 0` 也只会得到一只 120 宽的宠物，不会得到
/// 一个不存在的窗口。
pub fn clamp_size(raw: Option<RawSize>) -> RawSize {
    let raw = raw.unwrap_or(RawSize::DEFAULT);
    let min_w = raw.min_w.clamp(MIN_SIDE, MAX_SIDE);
    let min_h = raw.min_h.clamp(MIN_SIDE, MAX_SIDE);
    RawSize {
        w: raw.w.clamp(min_w, MAX_SIDE),
        h: raw.h.clamp(min_h, MAX_SIDE),
        min_w,
        min_h,
    }
}

/// 姿态名 → `POSTURES` 里的下标。
pub fn posture_index(name: &str) -> Option<usize> {
    POSTURES.iter().position(|p| *p == name.trim())
}

/// 这个姿态是不是瞬时的（报完过 `TRANSIENT_MS` 要回落到 `idle`）。
pub fn is_transient(posture: &str) -> bool {
    matches!(posture.trim(), "done" | "error")
}

/// 校验一份皮肤。
///
/// 顺序是**故意的**：先格式、再 id、再渲染器、最后路径。因为错误提示的价值和
/// "用户能不能立刻改对"成正比 —— `format` 错的时候，`data` 写没写对根本不重要。
pub fn accept(raw: RawSkin) -> Result<Skin, Problem> {
    check_format(raw.format)?;

    let id = raw.id.trim().to_string();
    if !valid_id(&id) {
        return Err(Problem::BadId);
    }

    let render = normalize_render(&raw.render)?;

    let data = raw.data.trim().to_string();
    if data.is_empty() {
        return Err(Problem::MissingData);
    }
    if !path_is_inside(&data) {
        return Err(Problem::PathEscapes { field: "data" });
    }

    let mut ignored = Vec::new();

    // 头像：可选，坏了就当没写（不拒绝整只宠物 —— 少一张头像不该让她消失）
    let portrait = match raw.portrait.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() && path_is_inside(p) => Some(p.to_string()),
        Some(p) if !p.is_empty() => {
            ignored.push(format!("portrait: {p} points outside the skin folder"));
            None
        }
        _ => None,
    };

    // 姿态：按 POSTURES 的顺序落位，没声明的留 None
    let mut postures: [Option<String>; POSTURES.len()] = Default::default();
    for (name, expression) in &raw.postures {
        match posture_index(name) {
            Some(i) => {
                let expression = expression.trim();
                if !expression.is_empty() {
                    postures[i] = Some(expression.to_string());
                }
            }
            // 皮肤比平台新：它认识一种平台还没有的姿态。忽略那个键，记一笔。
            None => ignored.push(format!("posture \"{}\" is not supported yet", name.trim())),
        }
    }

    // 动作：只留白名单里的
    //
    // 同一个手势写两遍时**后者覆盖前者** —— 那是配置文件的老规矩，皮肤作者复制一份
    // 再改的时候指望的就是这个。但覆盖要留痕：悄悄丢掉前一条，用户只会看到
    // "我明明写了 click 却没反应"，而那件事没有任何地方会报。
    let mut actions: Vec<(&'static str, &'static str)> = Vec::new();
    for (gesture, action) in &raw.actions {
        let gesture = gesture.trim();
        let action = action.trim();
        let Some(known_gesture) = GESTURES.iter().find(|g| **g == gesture) else {
            ignored.push(format!("gesture \"{gesture}\" is not supported yet"));
            continue;
        };
        if actions.iter().any(|(g, _)| g == known_gesture) {
            ignored.push(format!(
                "gesture \"{gesture}\" was declared twice; the last one wins"
            ));
            actions.retain(|(g, _)| g != known_gesture);
        }
        if let Some(known) = ACTIONS.iter().find(|a| **a == action) {
            actions.push((known_gesture, known));
        } else {
            // 皮肤声明了平台还没有的动作。**不拒绝整个皮肤** —— 它可能只是比平台新。
            ignored.push(format!("action \"{action}\" is not supported yet"));
        }
    }

    Ok(Skin {
        id,
        render,
        data,
        size: clamp_size(raw.size),
        postures,
        actions,
        portrait,
        ignored,
    })
}

/// 这个姿态该画哪张脸。
///
/// 兜底链：**这个姿态声明的** → **`idle` 声明的** → `None`（渲染器用自己的默认）。
///
/// 为什么不落到一个平台写死的表情名：平台不认识表情名，那套词是渲染器的方言。
/// 平台硬写一个 `"neutral"`，换一只没有 `neutral` 的皮肤就画不出来 —— 而 `None`
/// 让渲染器决定，这是唯一不会跨皮肤出错的答案。
pub fn expression_for<'a>(skin: &'a Skin, posture: &str) -> Option<&'a str> {
    let slot = posture_index(posture).and_then(|i| skin.postures[i].as_deref());
    slot.or_else(|| skin.postures[0].as_deref())
}

/// 这个手势该做什么。
///
/// `None` 有两种情况，对调用方是同一件事：**这个手势什么都不做**。
/// 皮肤没声明，或者声明了一个平台不认识的动作（那条已经在 `ignored` 里了）。
pub fn action_for<'a>(skin: &'a Skin, gesture: &str) -> Option<&'a str> {
    let gesture = gesture.trim();
    skin.actions
        .iter()
        .find(|(g, _)| *g == gesture)
        .map(|(_, a)| *a)
}

/// 皮肤目录 + 相对路径 → 绝对路径。调用方已经过 `path_is_inside`，这里只负责拼。
///
/// 用 `Path::join` 而不是字符串拼：Windows 上 `join` 会按平台给分隔符，
/// 而且它不会把 `a//b` 拼成两个斜杠。
pub fn resolve(skin_dir: &Path, relative: &str) -> std::path::PathBuf {
    skin_dir.join(relative.trim())
}

// ---------------------------------------------------------------------------
// 位置
// ---------------------------------------------------------------------------

/// 左右两侧留的空隙。
pub const MARGIN: i32 = 28;

/// 底边留的空隙。
///
/// **比 `MARGIN` 小，是故意的**：她脚下有一圈径向渐变的影子（PET_REFERENCE §5），
/// 影子画在画布内但视觉上是"落地"的那一部分。底边留 28 像素的话，那圈影子下面
/// 还有一条空桌面，看着像她浮在离地两厘米的地方。留 12 是她**站着**的距离。
pub const GROUND: i32 = 12;

/// 出厂位置：工作区右下角。
///
/// 为什么不是居中：中间是用户干活的地方，一只宠物第一次出现就压在正中间，
/// 和"我打开了一个聊天窗口"是同一件事，而它应该像桌面上的一个物件。
pub fn default_position(size: RawSize, work: (i32, i32, i32, i32)) -> (i32, i32) {
    let (left, top, work_w, work_h) = work;
    clamp_position(
        left + work_w - size.w as i32 - MARGIN,
        top + work_h - size.h as i32 - GROUND,
        size,
        work,
    )
}

/// 把位置夹回工作区。
///
/// **读和写都要过这一道**：`pet-state.json` 可能是手改的、可能来自一块已经拔掉的
/// 副屏、可能是一个缩到 0 的旧版本 —— 任何一次都不该变成"宠物在屏幕外面"，
/// 那种 bug 的症状是"它没了"，而用户第一反应是重装。
///
/// 夹到"至少露出 `MIN_VISIBLE` 那么多"，不是"整个都在屏幕内"：用户把宠物停在
/// 屏幕边缘是正常用法（她可以半个身子探出去）。
pub const MIN_VISIBLE: i32 = 48;

pub fn clamp_position(
    x: i32,
    y: i32,
    size: RawSize,
    work: (i32, i32, i32, i32),
) -> (i32, i32) {
    let (left, top, work_w, work_h) = work;
    let (w, h) = (size.w as i32, size.h as i32);
    let keep_x = MIN_VISIBLE.min(w);
    let keep_y = MIN_VISIBLE.min(h);
    (
        x.clamp(left - w + keep_x, left + work_w - keep_x),
        y.clamp(top, top + work_h - keep_y),
    )
}

/// 一个矩形：`(x, y, 宽, 高)`。
pub type Box4 = (i32, i32, i32, i32);

/// 让位时贴着小窗留的空隙。比 `MARGIN` 小：她是"贴过去"，不是"退到另一个区"。
pub const AVOID_GAP: i32 = 12;

fn overlaps(a: Box4, b: Box4) -> bool {
    // 边贴边不算重叠 —— 她挨着窗口站着不挡任何东西。
    let (ax, ay, aw, ah) = a;
    let (bx, by, bw, bh) = b;
    ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah
}

/// 小窗挡住宠物时，她该站哪（LAT-0041 §4.5）。
///
/// # 为什么是改位置，不是改层级
///
/// 宠物的层级是**出生属性**：`runner.rs:561` 那条注释写着，事后调
/// `set_always_on_top` / `SetWindowPos(HWND_TOPMOST)` 对无边框透明窗口返回成功但
/// `WS_EX_TOPMOST` 永远不出现。而她又**必须**出生即 Top，否则会被浏览器压住、点不到。
///
/// 于是只剩两条路：把小窗也改成永远置顶（那会改变它和**所有别的程序**的关系，
/// 是另一个产品的选择），或者**让宠物走开**。这里选后者 —— 一条纯函数，能测，
/// 可逆，不动任何窗口的层级。
///
/// # 挑哪个方向
///
/// 候选是"贴着小窗的右 / 左 / 下 / 上"四个位置，各过一遍 `clamp_position`
/// （工作区放不下就先夹回来），然后取**挪得最少**的那个。这样她不会为了躲开
/// 一次挡路就从屏幕右下角横穿到左边 —— 大多数时候"往右挪 12 像素"就够了。
///
/// 四个方向都还重叠（小窗铺满工作区）就**原地不动**。那是"聊天窗最大化"的场景，
/// 她本来就该在后面。
pub fn avoid(pet: Box4, window: Box4, work: (i32, i32, i32, i32)) -> (i32, i32) {
    let (px, py, pw, ph) = pet;
    if !overlaps(pet, window) {
        return (px, py);
    }

    let (wx, wy, ww, wh) = window;
    let size = RawSize {
        w: pw.max(0) as u32,
        h: ph.max(0) as u32,
        min_w: MIN_SIDE,
        min_h: MIN_SIDE,
    };
    let candidates = [
        (wx + ww + AVOID_GAP, py),
        (wx - pw - AVOID_GAP, py),
        (px, wy + wh + AVOID_GAP),
        (px, wy - ph - AVOID_GAP),
    ];

    let mut best: Option<((i32, i32), i32)> = None;
    for (cx, cy) in candidates {
        let (x, y) = clamp_position(cx, cy, size, work);
        if overlaps((x, y, pw, ph), window) {
            continue;
        }
        let distance = (x - px).abs() + (y - py).abs();
        if best.is_none_or(|(_, best_distance)| distance < best_distance) {
            best = Some(((x, y), distance));
        }
    }

    best.map(|(position, _)| position).unwrap_or((px, py))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_raw() -> RawSkin {
        RawSkin {
            format: 1,
            id: "whale".into(),
            render: "rig".into(),
            data: "model.json".into(),
            size: Some(RawSize::DEFAULT),
            postures: vec![
                ("idle".into(), "neutral".into()),
                ("working".into(), "unhappy".into()),
                ("asleep".into(), "sleep".into()),
            ],
            actions: vec![
                ("click".into(), "open-assistant".into()),
                ("drag".into(), "move-window".into()),
            ],
            portrait: Some("portrait.png".into()),
        }
    }

    // --- 版本闸 ---

    #[test]
    fn format_one_is_the_current_one() {
        assert_eq!(check_format(1), Ok(()));
    }

    #[test]
    fn a_newer_format_is_rejected_not_best_efforted() {
        // 装错了必须拦。尽力而为的结果是一堆错位的图。
        let got = check_format(2);
        assert_eq!(got, Err(Problem::FormatTooNew { got: 2 }));
        let problem = got.unwrap_err();
        assert_eq!(problem.code(), "format_too_new");
        assert!(problem.detail().contains("2 > 1"));
    }

    #[test]
    fn format_zero_is_invalid_not_old() {
        // 0 不是"旧版本"，是无效。这两件事的提示语完全不同。
        assert_eq!(check_format(0), Err(Problem::FormatInvalid));
        assert_eq!(Problem::FormatInvalid.code(), "format_invalid");
    }

    // --- 渲染器 ---

    #[test]
    fn the_only_renderer_we_have_is_rig() {
        assert_eq!(normalize_render("rig"), Ok("rig".into()));
    }

    #[test]
    fn renderer_name_is_trimmed_and_lowercased() {
        // 皮肤作者手写 JSON，`"Rig "` 不该炸。
        assert_eq!(normalize_render("  RIG "), Ok("rig".into()));
    }

    #[test]
    fn an_unknown_renderer_names_what_we_do_support() {
        let got = normalize_render("sprite");
        assert_eq!(
            got,
            Err(Problem::UnknownRenderer {
                got: "sprite".into()
            })
        );
        let detail = got.unwrap_err().detail();
        assert!(detail.contains("sprite"), "{detail}");
        assert!(detail.contains("rig"), "{}", detail);
    }

    // --- 路径 ---

    #[test]
    fn a_plain_relative_path_is_inside() {
        assert!(path_is_inside("model.json"));
        assert!(path_is_inside("tex/body.png"));
        assert!(path_is_inside("outfits/cape/hood.png"));
    }

    #[test]
    fn a_backslash_separator_is_inside_too() {
        // Windows 作者会写 tex\a.png，不该因此被拒。
        assert!(path_is_inside("tex\\body.png"));
        assert!(path_is_inside("sub\\model.json"));
    }

    #[test]
    fn dotdot_anywhere_is_outside() {
        assert!(!path_is_inside("../model.json"));
        // 关键：不是只看开头。tex/../../x 中间就逃出去了。
        assert!(!path_is_inside("tex/../../x.png"));
        assert!(!path_is_inside("a/../b"));
    }

    #[test]
    fn drive_letters_and_roots_are_outside() {
        assert!(!path_is_inside("C:/Windows/x.png"));
        assert!(!path_is_inside("c:\\x.png"));
        assert!(!path_is_inside("/etc/passwd"));
        assert!(!path_is_inside("\\server\\share"));
    }

    #[test]
    fn tilde_is_outside() {
        assert!(!path_is_inside("~/x.png"));
    }

    #[test]
    fn empty_path_is_not_an_escape_it_is_a_missing_field() {
        // 空路径交给 MissingData 报，别让"没写"和"想跑出去"共用一句话。
        assert!(path_is_inside(""));
        assert!(path_is_inside("   "));
    }

    // --- id ---

    #[test]
    fn a_plain_folder_name_is_a_valid_id() {
        assert!(valid_id("whale"));
        assert!(valid_id("lattice.whale"));
        assert!(valid_id("my-pet_2"));
    }

    #[test]
    fn an_id_with_path_semantics_is_rejected() {
        assert!(!valid_id(""));
        assert!(!valid_id("  "));
        assert!(!valid_id("."));
        assert!(!valid_id(".."));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a\\b"));
        assert!(!valid_id("C:whale"));
    }

    // --- 尺寸 ---

    #[test]
    fn size_is_clamped_not_rejected() {
        // 用户的窗口比皮肤的假设更重要。
        let got = clamp_size(Some(RawSize {
            w: 10,
            h: 10,
            min_w: 10,
            min_h: 10,
        }));
        assert_eq!(got.w, MIN_SIDE);
        assert_eq!(got.h, MIN_SIDE);
        assert_eq!(got.min_w, MIN_SIDE);
    }

    #[test]
    fn a_giant_size_is_capped() {
        let got = clamp_size(Some(RawSize {
            w: 9_999,
            h: 9_999,
            min_w: 9_999,
            min_h: 9_999,
        }));
        assert_eq!(got.w, MAX_SIDE);
        assert_eq!(got.h, MAX_SIDE);
        assert_eq!(got.min_w, MAX_SIDE);
    }

    #[test]
    fn width_below_its_own_minimum_is_raised() {
        let got = clamp_size(Some(RawSize {
            w: 200,
            h: 200,
            min_w: 340,
            min_h: 280,
        }));
        assert_eq!(got.w, 340, "宽度不能小于皮肤自己声明的 min_w");
        assert_eq!(got.h, 280);
    }

    #[test]
    fn no_size_means_the_default() {
        assert_eq!(clamp_size(None), RawSize::DEFAULT);
    }

    // --- 姿态 ---

    #[test]
    fn the_six_postures_are_the_contract() {
        assert_eq!(POSTURES.len(), 6);
        assert_eq!(posture_index("waiting"), Some(2));
        assert_eq!(posture_index(" sleepy "), None);
    }

    #[test]
    fn done_and_error_are_transient() {
        assert!(is_transient("done"));
        assert!(is_transient("error"));
        for steady in ["idle", "working", "waiting", "asleep"] {
            assert!(!is_transient(steady), "{steady} 不该自己回落");
        }
    }

    #[test]
    fn a_declared_posture_wins() {
        let skin = accept(ok_raw()).unwrap();
        assert_eq!(expression_for(&skin, "working"), Some("unhappy"));
    }

    #[test]
    fn an_undeclared_posture_falls_back_to_idle() {
        // 皮肤只有 3 个姿态，问它 waiting 时不该没有脸。
        let skin = accept(ok_raw()).unwrap();
        assert_eq!(expression_for(&skin, "waiting"), Some("neutral"));
    }

    #[test]
    fn with_nothing_declared_the_renderer_decides() {
        // 平台不认识表情名，所以只能给 None，不能硬写一个 "neutral"。
        let mut raw = ok_raw();
        raw.postures.clear();
        let skin = accept(raw).unwrap();
        assert_eq!(expression_for(&skin, "idle"), None);
        assert_eq!(expression_for(&skin, "working"), None);
    }

    #[test]
    fn an_unknown_posture_key_is_ignored_and_recorded() {
        // 皮肤比平台新：它认识 sleepy，平台还不认识。忽略，但要留痕。
        let mut raw = ok_raw();
        raw.postures.push(("sleepy".into(), "slack".into()));
        let skin = accept(raw).unwrap();
        assert_eq!(skin.postures[0], Some("neutral".to_string()));
        assert!(skin.ignored.iter().any(|i| i.contains("sleepy")));
    }

    #[test]
    fn an_empty_expression_counts_as_not_declared() {
        let mut raw = ok_raw();
        raw.postures = vec![("idle".into(), "   ".into())];
        let skin = accept(raw).unwrap();
        assert_eq!(skin.postures[0], None);
    }

    // --- 动作 ---

    #[test]
    fn a_known_action_is_kept() {
        let skin = accept(ok_raw()).unwrap();
        assert_eq!(action_for(&skin, "click"), Some("open-assistant"));
        assert_eq!(action_for(&skin, "drag"), Some("move-window"));
    }

    #[test]
    fn an_undeclared_gesture_does_nothing() {
        let skin = accept(ok_raw()).unwrap();
        assert_eq!(action_for(&skin, "doubleClick"), None);
    }

    #[test]
    fn an_unknown_action_is_dropped_not_fatal() {
        // 皮肤声明了平台还没有的动作。整只宠物不该因此消失。
        let mut raw = ok_raw();
        raw.actions.push(("click".into(), "pet-head".into()));
        let skin = accept(raw).unwrap();
        // 同一手势后者覆盖前者（配置文件的老规矩），而后者平台还不认识 ——
        // 于是 click 变成"什么都不做"，而不是回退到前一条。
        assert_eq!(action_for(&skin, "click"), None);
        assert!(skin.ignored.iter().any(|i| i.contains("pet-head")));
        assert!(
            skin.ignored.iter().any(|i| i.contains("declared twice")),
            "覆盖必须留痕：{:?}",
            skin.ignored
        );
    }

    #[test]
    fn an_unknown_gesture_is_dropped_and_recorded() {
        let mut raw = ok_raw();
        raw.actions.push(("hover".into(), "bubble".into()));
        let skin = accept(raw).unwrap();
        assert!(skin.ignored.iter().any(|i| i.contains("hover")));
    }

    #[test]
    fn none_is_a_real_action_so_a_gesture_can_be_switched_off() {
        // "不写"和"明确什么都不做"是两件事，后者必须有办法表达。
        let mut raw = ok_raw();
        raw.actions = vec![("click".into(), "none".into())];
        let skin = accept(raw).unwrap();
        assert_eq!(action_for(&skin, "click"), Some("none"));
    }

    // --- 整份皮肤 ---

    #[test]
    fn a_good_skin_survives_intact() {
        let skin = accept(ok_raw()).unwrap();
        assert_eq!(skin.id, "whale");
        assert_eq!(skin.render, "rig");
        assert_eq!(skin.data, "model.json");
        assert_eq!(skin.portrait.as_deref(), Some("portrait.png"));
        assert!(skin.ignored.is_empty(), "{:?}", skin.ignored);
    }

    #[test]
    fn format_is_checked_before_everything_else() {
        // 顺序是有意义的：format 错的时候，data 写没写对根本不重要。
        let mut raw = ok_raw();
        raw.format = 9;
        raw.data = "../escape.json".into();
        assert_eq!(accept(raw), Err(Problem::FormatTooNew { got: 9 }));
    }

    #[test]
    fn an_escaping_data_path_is_rejected() {
        let mut raw = ok_raw();
        raw.data = "../../etc/passwd".into();
        assert_eq!(
            accept(raw),
            Err(Problem::PathEscapes { field: "data" })
        );
    }

    #[test]
    fn a_bad_id_is_rejected() {
        let mut raw = ok_raw();
        raw.id = "a/b".into();
        assert_eq!(accept(raw), Err(Problem::BadId));
    }

    #[test]
    fn a_bad_portrait_is_dropped_but_the_pet_survives() {
        // 少一张头像不该让整只宠物消失。
        let mut raw = ok_raw();
        raw.portrait = Some("../../x.png".into());
        let skin = accept(raw).unwrap();
        assert_eq!(skin.portrait, None);
        assert!(skin.ignored.iter().any(|i| i.contains("portrait")));
    }

    #[test]
    fn an_absent_portrait_is_not_an_error() {
        let mut raw = ok_raw();
        raw.portrait = None;
        assert_eq!(accept(raw).unwrap().portrait, None);
    }

    #[test]
    fn every_problem_has_a_distinct_code() {
        // 前端那张中文表按 code 查。两个原因共用一个码，界面上就会说错话。
        let all = [
            Problem::FormatTooNew { got: 2 },
            Problem::FormatInvalid,
            Problem::UnknownRenderer { got: "x".into() },
            Problem::MissingData,
            Problem::PathEscapes { field: "data" },
            Problem::BadId,
        ];
        let mut codes: Vec<&str> = all.iter().map(|p| p.code()).collect();
        codes.sort_unstable();
        let before = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), before, "原因码重复了：{codes:?}");
        for p in &all {
            assert!(!p.detail().is_empty(), "{} 没有 detail", p.code());
        }
    }

    #[test]
    fn resolve_stays_under_the_skin_dir() {
        let dir = Path::new("C:/pets/whale");
        assert_eq!(resolve(dir, "model.json"), dir.join("model.json"));
        assert_eq!(resolve(dir, " tex/a.png "), dir.join("tex/a.png"));
    }

    // --- 位置 ---

    const WORK: (i32, i32, i32, i32) = (0, 0, 1920, 1040);
    const SIZE: RawSize = RawSize {
        w: 420,
        h: 340,
        min_w: 340,
        min_h: 280,
    };

    #[test]
    fn the_default_corner_is_the_bottom_right() {
        let (x, y) = default_position(SIZE, WORK);
        assert_eq!(x, 1920 - 420 - MARGIN);
        assert_eq!(y, 1040 - 340 - GROUND);
    }

    #[test]
    fn the_ground_gap_is_smaller_than_the_side_gap() {
        // 脚下有影子，底边留 MARGIN 会让她看着浮起来。
        assert!(GROUND < MARGIN, "GROUND {GROUND} 该比 MARGIN {MARGIN} 小");
    }

    #[test]
    fn a_position_on_a_vanished_monitor_is_pulled_back() {
        // 拔掉副屏之后，存下来的 x=3000 不能让她永远消失。
        let (x, _) = clamp_position(3000, 0, SIZE, WORK);
        assert!(x <= 1920 - MIN_VISIBLE, "x = {x} 还在屏幕外");
        assert!(x >= -420, "x = {x} 被拉过头了");
    }

    #[test]
    fn hanging_off_the_left_edge_keeps_a_sliver_visible() {
        let (x, _) = clamp_position(-9_999, 0, SIZE, WORK);
        assert_eq!(x, -420 + MIN_VISIBLE, "至少要露出 {MIN_VISIBLE} 像素");
    }

    #[test]
    fn a_position_inside_the_work_area_is_left_alone() {
        assert_eq!(clamp_position(700, 400, SIZE, WORK), (700, 400));
    }

    #[test]
    fn the_top_edge_is_hard() {
        // 头顶不能出界：宠物没有"探出上边缘"这种用法。
        let (_, y) = clamp_position(0, -500, SIZE, WORK);
        assert_eq!(y, 0);
    }

    #[test]
    fn a_secondary_monitor_with_a_negative_origin_works() {
        // 副屏在主屏左边时原点是负的。夹取不能假设 left == 0。
        let work = (-1920, 0, 1920, 1040);
        let (x, y) = default_position(SIZE, work);
        assert_eq!(x, -420 - MARGIN);
        assert_eq!(y, 1040 - 340 - GROUND);
        // 这块屏的右边缘是 0，所以落在这块屏内的坐标原样保留
        assert_eq!(clamp_position(-1000, 400, SIZE, work), (-1000, 400));
        // 而主屏上的 700 在这块屏外（它只到 0），要被拉回右边缘
        assert_eq!(clamp_position(700, 400, SIZE, work), (-MIN_VISIBLE, 400));
    }

    // --- 让位 ---

    /// 工作区 1920×1040，小窗 800×600 居中，宠物 420×340 在右下角。
    const PET: Box4 = (1920 - 420 - MARGIN, 1040 - 340 - GROUND, 420, 340);
    const WINDOW: Box4 = (560, 220, 800, 600);

    #[test]
    fn a_pet_that_is_not_in_the_way_does_not_move() {
        // 右下角那只和居中的小窗不重叠 —— 大多数时候她根本不该动。
        let (x, y) = avoid(PET, WINDOW, WORK);
        assert_eq!((x, y), (PET.0, PET.1));
    }

    #[test]
    fn touching_edges_is_not_overlapping() {
        // 边贴边站着不挡任何东西，不该触发让位。
        let window = (PET.0 - 800, PET.1, 800, 340);
        let (x, y) = avoid(PET, window, WORK);
        assert_eq!((x, y), (PET.0, PET.1));
    }

    #[test]
    fn a_pet_behind_the_window_steps_aside_by_the_shortest_distance() {
        // 小窗正好压在右下角：往右挪 12 像素就够（工作区还有地方）。
        let window = (1000, 400, 800, 600);
        let (x, y) = avoid(PET, window, WORK);
        assert_eq!(x, window.0 + window.2 + AVOID_GAP);
        assert_eq!(y, PET.1, "只该横向挪，不该纵向也动");
        assert!(!overlaps((x, y, PET.2, PET.3), window));
    }

    #[test]
    fn a_pet_on_the_left_goes_left() {
        // 她压在小窗左边那一角（x 200..620 撞上 560..1360）时，
        // 往左挪比横穿到右边近得多。
        let pet = (200, 400, 420, 340);
        let (x, y) = avoid(pet, WINDOW, WORK);
        assert_eq!(x, WINDOW.0 - pet.2 - AVOID_GAP);
        assert_eq!(y, 400);
        assert!(!overlaps((x, y, pet.2, pet.3), WINDOW));
    }

    #[test]
    fn a_window_that_covers_the_work_area_leaves_the_pet_alone() {
        // 聊天窗最大化：四个方向都放不下，她本来就该在后面，原地不动。
        let window = (0, 0, 1920, 1040);
        assert_eq!(avoid(PET, window, WORK), (PET.0, PET.1));
    }

    #[test]
    fn a_candidate_that_clamps_back_into_the_window_is_rejected() {
        // 小窗贴着右边缘：往右挪会被夹回工作区，于是仍然重叠 —— 这条候选必须作废，
        // 否则她会"挪了但还是被挡住"，而用户看到的是她抖了一下。
        let window = (1400, 300, 520, 700);
        let (x, y) = avoid(PET, window, WORK);
        assert!(
            !overlaps((x, y, PET.2, PET.3), window),
            "({x},{y}) 仍然挡着"
        );
    }

    #[test]
    fn the_result_is_always_inside_the_work_area() {
        // 让位不能把她推出屏幕。
        for window_x in [0, 200, 700, 1200, 1500] {
            let window = (window_x, 200, 800, 600);
            let (x, y) = avoid(PET, window, WORK);
            assert!(x >= -PET.2 + MIN_VISIBLE, "x = {x} 太靠左");
            assert!(x <= WORK.2 - MIN_VISIBLE, "x = {x} 太靠右");
            assert!(y >= 0 && y <= WORK.3 - MIN_VISIBLE, "y = {y} 出界");
        }
    }
}
