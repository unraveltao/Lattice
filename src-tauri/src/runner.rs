//! 运行态：把画布上的 Placement 变成真正的桌面窗口
//!
//! 设计上刻意不在窗口里直接加载组件页面，而是加载 `widget-host.html`，
//! 由它再套一层沙箱 iframe。这样桌面窗口和主窗口里的预览**跑的是同一套
//! 桥与权限校验**，不会出现"预览能用、桌面上不能用"的分叉。
//!
//! 窗口本身是透明、无边框、不进任务栏、不抢焦点的，
//! 层级与穿透交给 desktop 模块落到 Win32。
//!
//! # 为什么这里没有"窗口表"
//!
//! 最初版本用一个 `Mutex<HashMap<label, WebviewWindow>>` 记账，结果一创建
//! 窗口就死锁：命令线程持锁 → `build()` 等主线程建 webview → 主线程里
//! 宿主页发 IPC 调 `widget_host_config` → 它要抢同一把锁。三边一卡，
//! 界面直接冻住，组件一个也出不来。
//!
//! 现在窗口的存在性交给 Tauri 自己的窗口注册表（`app.get_webview_window`），
//! 我们只额外记一张**极轻的配置表**（label → 宿主页配置），
//! 且配置在 `build()` **之前**写入，宿主页随时来问都能立刻拿到，不会等锁。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::desktop::{self, RegionPart, WindowLayer, WindowShape};
use crate::egress;
use crate::usage;
use crate::visibility;

/// 所有组件窗口的 label 前缀，用来把平台窗口和组件窗口区分开
pub(crate) const LABEL_PREFIX: &str = "widget-";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetWindowSpec {
    pub instance_id: String,
    pub widget_id: String,
    /// 相对应用根的入口，例如 `widgets/lattice.clock/index.html`
    pub entry: String,
    /// 已授予的权限，宿主页据此放行桥调用
    pub permissions: Vec<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 清单里声明的最小尺寸，宿主页缩放时据此夹紧
    pub min_w: f64,
    pub min_h: f64,
    pub layer: WindowLayer,
    pub click_through: bool,
    /// 组件要不要键盘焦点。false 的窗口带 `WS_EX_NOACTIVATE`，点了不抢焦点；
    /// true 的窗口可以激活，便签/待办才打得进字
    pub interactive: bool,
    /// 窗口轮廓：`rect`（默认，平台圆角）或 `region`（组件用 `window.setRegion` 上报）。
    /// 桌宠这类"不是一张卡片"的组件用后者，见 `docs/WIDGET_SPEC.md`
    #[serde(default)]
    pub shape: WindowShape,
    /// 别针：锁住位置与大小，宿主页把拖拽/缩放手柄收掉
    pub pinned: bool,
    /// 平台当前解析出来的明暗，桌面窗口据此上色，
    /// 不跟随系统 —— 否则用户把平台切成深色，桌面卡片还是白的
    pub theme: String,
    /// 平台当前生效的界面语言（`"zh"` / `"en"`）。桌面窗口的窗饰提示
    /// 与"组件坏了"那张卡片用它 —— 那两个宿主页不加载 store，从这儿拿初值，
    /// 之后的变化走 `lattice:language` 广播（和 `theme` 同一套）
    #[serde(default)]
    pub lang: String,
    /// 底板外观。老前端不带这个字段时按默认值（跟随主题、不透明、不模糊）走
    #[serde(default)]
    pub appearance: Appearance,
    /// 这个实例的配置。前端已经按清单 schema 合并过出厂值，这里只透传 ——
    /// 合并规则只能有一份，散到两边就会"画布和桌面显示得不一样"
    #[serde(default = "empty_config")]
    pub config: serde_json::Value,
    /// 清单里声明的联网白名单（`network.hosts`）。
    /// 只在授予了 `network` 权限时才起作用，两者缺一不可
    #[serde(default)]
    pub network: Vec<String>,
}

/// 老前端不带 `config` 时给一个空对象，而不是 `null`：
/// 宿主页拿到的永远是可展开的对象，少一层 `?? {}` 的判断
fn empty_config() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// 底板外观。三个值一起决定卡片长什么样：
///
/// - `tint`：`"auto"` 表示跟随明暗主题，否则是 `#rrggbb`
/// - `alpha`：底色的浓度，0 = 只剩磨砂，1 = 纯色实心
/// - `blur`：磨砂半径（逻辑像素），0 = 不磨砂
///
/// 注意这里不是"窗口透明度"：窗口始终不透明，透出来的其实是宿主页自己画的
/// 那块模糊壁纸（见 wallpaper.rs）。所以 alpha 调到 0 看到的是"糊掉的桌面"，
/// 而不是"压在后面的窗口"。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub tint: String,
    pub alpha: f64,
    pub blur: f64,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            tint: "auto".to_string(),
            alpha: 1.0,
            blur: 0.0,
        }
    }
}

/*
 * 下面两条事件的载荷都带着 `instanceId`，不是为了给宿主页用，是为了**让别的
 * 窗口闭嘴**。
 *
 * `emit_to(label)` 并不只发给那个窗口：JS 侧 `listen()` 注册的监听器 target
 * 是 `Any`，而 Tauri 的匹配规则是 `target == Any || filter(target)` —— 任何
 * emit 都会送到每个窗口的 `Any` 监听器上（tauri/src/event/listener.rs 的
 * `match_any_or_filter`）。不比对的话：拖 A 的底板滑杆，桌面上所有组件一起变色；
 * 撤 A 的一项权限，所有组件一起重载（未落盘的草稿当场丢）。
 *
 * 窗口自己的 label 也能当身份，但这两件事是"某个组件实例的属性变了"，
 * 用 instanceId 更贴题 —— 窗口 label 是 instanceId 清洗出来的，反过来推不回去。
 */
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppearanceMessage<'a> {
    instance_id: &'a str,
    appearance: &'a Appearance,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionsMessage<'a> {
    instance_id: &'a str,
    permissions: &'a [String],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigMessage<'a> {
    instance_id: &'a str,
    config: &'a serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub instance_id: String,
    pub widget_id: String,
    pub entry: String,
    pub permissions: Vec<String>,
    pub theme: String,
    /// 平台当前生效的界面语言，宿主页拿它当提示语的初值
    pub lang: String,
    pub pinned: bool,
    pub min_w: f64,
    pub min_h: f64,
    pub layer: WindowLayer,
    pub click_through: bool,
    pub interactive: bool,
    /// 窗口轮廓来源。`region` 的窗口不画底板、不画窗饰，背景透明，
    /// 可见像素全部由组件上报的区域决定
    pub shape: WindowShape,
    /// 底板外观，宿主页拿它上色与糊背景
    pub appearance: Appearance,
    /// 实例配置（已合并出厂值），宿主页原样交给组件
    pub config: serde_json::Value,
    /// 清单里声明的联网白名单（`network.hosts`）。
    /// 只在授予了 `network` 权限时才起作用，两者缺一不可
    pub network: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RectPayload {
    instance_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinnedPayload {
    instance_id: String,
    pinned: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerPayload {
    instance_id: String,
    layer: WindowLayer,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstancePayload {
    instance_id: String,
}

/// 只存宿主页启动时要问的那点东西，按窗口 label 索引
#[derive(Default)]
pub struct Runner {
    configs: Mutex<HashMap<String, HostConfig>>,
    /// 上一次真正写进 Win32 的窗口状态。层级和裁剪每次都要 EnumWindows、
    /// 还要给 Progman 发同步消息，拖动时每秒重做十几次太浪费，
    /// 状态没变就跳过。
    applied: Mutex<HashMap<String, Applied>>,
    /// 自己关掉自己的实例（`window.close()` 那条路）。
    ///
    /// 只活在内存里，不落盘 —— 它表达的是"这次运行里它退出了"，不是"用户不要它了"。
    /// 重启之后自动清空，所以组件的 placement 一直好好躺在 state.json 里，
    /// 下次开应用照样回来。
    suppressed: Mutex<HashSet<String>>,
    /// 托盘上的"暂停全部组件"。
    ///
    /// 只活在内存里：暂停是"现在别动"，不是配置。重启之后该恢复 ——
    /// 用户开机的期待是"组件在那儿"，不是"上次点了暂停所以还是空的"。
    paused: AtomicBool,
    /// 最后一次由组件上报的轮廓，按窗口 label 索引。
    ///
    /// 为什么要在这里留一份：窗口改尺寸 / 切层级时会重新走一遍
    /// `apply_to`，那时必须把组件报过的区域**重新贴回去**，
    /// 否则宠物会变回一块圆角矩形，直到它下一次上报才恢复。
    regions: Mutex<HashMap<String, Vec<RegionPart>>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Applied {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    layer: WindowLayer,
    click_through: bool,
    interactive: bool,
    shape: WindowShape,
}

/// 这次同步相对上次真正写进 Win32 的状态，哪些维度变了
#[derive(Debug, Default, Clone, Copy)]
struct Change {
    pos: bool,
    size: bool,
    layer: bool,
}

impl Runner {
    fn put(&self, label: &str, config: HostConfig) {
        if let Ok(mut map) = self.configs.lock() {
            map.insert(label.to_string(), config);
        }
    }

    /// 托盘暂停开关的当前值
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub(crate) fn get(&self, label: &str) -> Option<HostConfig> {
        self.configs.lock().ok()?.get(label).cloned()
    }

    fn forget(&self, label: &str) {
        if let Ok(mut map) = self.configs.lock() {
            map.remove(label);
        }
        if let Ok(mut map) = self.applied.lock() {
            map.remove(label);
        }
        // 轮廓也跟着窗口走：窗口没了，那条区域记录再留着只会在下次同名 label
        // 建窗口时被当成"已知轮廓"贴回去（内容早换了）
        if let Ok(mut map) = self.regions.lock() {
            map.remove(label);
        }
    }

    /// 记住"这个实例自己退出了"，本次运行别再给它建窗口
    fn suppress(&self, instance_id: &str) {
        if let Ok(mut set) = self.suppressed.lock() {
            set.insert(instance_id.to_string());
        }
    }

    fn is_suppressed(&self, instance_id: &str) -> bool {
        self.suppressed.lock().map(|set| set.contains(instance_id)).unwrap_or(false)
    }

    /// 把已经不在画布上的实例从"已退出"名单里划掉。
    ///
    /// 不划掉的话，同一个 instanceId 被删掉又加回来（撤销、恢复备份）时会永远
    /// 建不出窗口，看起来像"加了个组件但桌面上没有"。
    fn retain_suppressed(&self, alive: &HashSet<String>) {
        if let Ok(mut set) = self.suppressed.lock() {
            set.retain(|id| alive.contains(id));
        }
    }

    /// 记住某个窗口刚被写进去的状态（新建窗口时用，避免第一次同步重复写）
    fn remember(&self, label: &str, applied: Applied) {
        if let Ok(mut map) = self.applied.lock() {
            map.insert(label.to_string(), applied);
        }
    }

    /// 记下组件最新上报的轮廓（并返回之前那份，调用方可以据此跳过重复的 Win32 写入）
    fn remember_region(&self, label: &str, parts: Vec<RegionPart>) -> Vec<RegionPart> {
        let mut map = match self.regions.lock() {
            Ok(map) => map,
            Err(_) => return Vec::new(),
        };
        let previous = map.get(label).cloned().unwrap_or_default();
        map.insert(label.to_string(), parts);
        previous
    }

    /// 这个窗口最后一次上报的轮廓（没报过就是空 = 什么都不显示）
    fn region_of(&self, label: &str) -> Vec<RegionPart> {
        self.regions
            .lock()
            .ok()
            .and_then(|map| map.get(label).cloned())
            .unwrap_or_default()
    }

    /// 只改层级那一格，位置和尺寸保持原样。
    ///
    /// 这里必须"就地改"，不能整条覆盖 —— 覆盖成 0 的话，下一次同步会以为
    /// 位置变了，把窗口 set_position 到左上角去。
    fn patch_layer(&self, label: &str, layer: WindowLayer, click_through: bool) {
        if let Ok(mut map) = self.applied.lock() {
            if let Some(entry) = map.get_mut(label) {
                entry.layer = layer;
                entry.click_through = click_through;
            }
        }
    }

    /// 换外观，返回 true 表示确实变了（没变就别再发一遍事件）
    fn set_appearance(&self, label: &str, appearance: Appearance) -> bool {
        if let Ok(mut map) = self.configs.lock() {
            if let Some(config) = map.get_mut(label) {
                if config.appearance == appearance {
                    return false;
                }
                config.appearance = appearance;
                return true;
            }
        }
        false
    }

    /// 换掉某个窗口的权限集合，返回"真的变了没有"。
    ///
    /// 权限和外观一样不进 `diff`：`Applied` 那一套只管 Win32 的 pos / size / layer，
    /// 而权限是"活的"—— 用户在属性面板里撤掉一项，已经开着的窗口必须当场失去它，
    /// 不能等下次重开窗口才生效。以前没有这一步，撤销授权只是改了一份 JSON。
    ///
    /// 传进来的必须是排好序的（`normalize_permissions`），否则前端 grants 数组
    /// 按点击顺序变化会被当成"权限变了"，每点一次就重载一次组件。
    fn set_permissions(&self, label: &str, permissions: Vec<String>) -> bool {
        if let Ok(mut map) = self.configs.lock() {
            if let Some(config) = map.get_mut(label) {
                if config.permissions == permissions {
                    return false;
                }
                config.permissions = permissions;
                return true;
            }
        }
        false
    }

    /// 换掉某个窗口的联网白名单，返回"真的变了没有"。
    ///
    /// **不广播给宿主页**：这份白名单只在 Rust 侧用（`network.rs` 拿它比对），
    /// 宿主页和组件都不需要知道。和权限不一样 —— 权限变了要重载组件让它重走
    /// 一遍初始化，白名单变了组件什么都不用做，下一次请求自然按新规则判。
    ///
    /// 少了这一句会有一个很难查的现象：作者在改 `network.hosts`，存盘、卡片
    /// 也重载了，但请求还是被拒 —— 因为 `HostConfig` 是建窗口那一刻拍下来的。
    fn set_network(&self, label: &str, network: Vec<String>) -> bool {
        if let Ok(mut map) = self.configs.lock() {
            if let Some(config) = map.get_mut(label) {
                if config.network == network {
                    return false;
                }
                config.network = network;
                return true;
            }
        }
        false
    }

    /// 换掉某个窗口的实例配置，返回"真的变了没有"。
    ///
    /// 和外观、权限一样不进 `diff`：那套结构只描述 Win32 的 pos / size / layer。
    /// 这里比的是整份 JSON —— 前端每次都会送来**合并过出厂值**的完整对象，
    /// 所以"用户改了一项"和"对象不一样"是同一件事，不会误报。
    fn set_config(&self, label: &str, config: &serde_json::Value) -> bool {
        if let Ok(mut map) = self.configs.lock() {
            if let Some(current) = map.get_mut(label) {
                if &current.config == config {
                    return false;
                }
                current.config = config.clone();
                return true;
            }
        }
        false
    }

    /// 换掉某个窗口的层级，返回"真的变了没有"。
    ///
    /// 层级有**两份读者**：Win32（`Applied`）和宿主页窗饰上那颗按钮
    /// （`HostConfig`）。平台这边改层级走的是 `sync_widget_windows`，它原本
    /// 只动前者 —— 宿主页那份副本就永远停在建窗口那一刻，按钮画着旧图标；
    /// 更糟的是点下去它**从旧状态算新状态**，送回来的值等于没变，那颗按钮
    /// 看起来就是死的。所以这里和 `set_appearance` 一样返回"变了没有"，
    /// 调用方据此决定要不要推一条 `lattice:widget-layer` 过去。
    ///
    /// `click_through` 顺手一起记：`widget_set_layer` 重落层级时要读它。
    fn set_layer(&self, label: &str, layer: WindowLayer, click_through: bool) -> bool {
        if let Ok(mut map) = self.configs.lock() {
            if let Some(config) = map.get_mut(label) {
                let changed = config.layer != layer;
                config.layer = layer;
                config.click_through = click_through;
                return changed;
            }
        }
        false
    }

    /// 别针同理。宿主页自己点的时候走 `widget_set_pinned`（那条会 `put`），
    /// 但 agent 的 `placement.pin` 改的是 store，落到窗口要经过这条同步 ——
    /// 不推回去的话，窗饰上那颗图钉会一直显示旧状态，而它的悬停提示正是
    /// "位置已锁定"，说的是一件已经不成立的事。
    fn set_pinned(&self, label: &str, pinned: bool) -> bool {
        if let Ok(mut map) = self.configs.lock() {
            if let Some(config) = map.get_mut(label) {
                if config.pinned == pinned {
                    return false;
                }
                config.pinned = pinned;
                return true;
            }
        }
        false
    }

    /// 比对并记录：返回 None 表示这一轮什么都不用做。
    ///
    /// 只写变化的部分不只是省开销 —— 用户在桌面上拖动组件时，
    /// 那条 120ms 防抖同步如果无条件 set_position，就会把窗口拽回去。
    /// 位置没变就一根手指都不碰窗口，拖动才不会被抢。
    fn diff(&self, label: &str, next: Applied) -> Option<Change> {
        let mut map = self.applied.lock().ok()?;
        match map.get(label) {
            Some(prev) if *prev == next => None,
            Some(prev) => {
                let change = Change {
                    pos: prev.x != next.x || prev.y != next.y,
                    size: prev.w != next.w || prev.h != next.h,
                    layer: prev.layer != next.layer
                        || prev.click_through != next.click_through
                        || prev.interactive != next.interactive
                        // 轮廓变了要重走一遍 `apply_to`：`rect` 的窗口得补回圆角，
                        // `region` 的窗口得把组件报过的区域重新贴上去
                        || prev.shape != next.shape,
                };
                map.insert(label.to_string(), next);
                Some(change)
            }
            None => {
                map.insert(label.to_string(), next);
                Some(Change {
                    pos: true,
                    size: true,
                    layer: true,
                })
            }
        }
    }
}

/// 窗口标签只允许字母数字和 `-` `_`，实例 id 里的 `#` 等要换掉
fn label_for(instance_id: &str) -> String {
    let safe: String = instance_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("{LABEL_PREFIX}{safe}")
}

/// 权限集合排好序再去重。
///
/// 前端那份 `grants[widgetId]` 是按点击顺序长出来的，撤一项再勾回来顺序就变了。
/// 直接比顺序的话，"顺序变了"会被当成"权限变了"，组件跟着重载一次 —— 用户只是
/// 点了一下开关，界面却闪了一下。所以比较、存储、下发统一用这个形态。
fn normalize_permissions(permissions: &[String]) -> Vec<String> {
    let mut sorted = permissions.to_vec();
    sorted.sort();
    sorted.dedup();
    sorted
}

fn create(app: &AppHandle, spec: &WidgetWindowSpec, runner: &Runner) -> Result<(), String> {
    let label = label_for(&spec.instance_id);

    // 先登记配置再建窗口：宿主页一加载完就会来问，此时表里必须已经有答案
    runner.put(
        &label,
        HostConfig {
            instance_id: spec.instance_id.clone(),
            widget_id: spec.widget_id.clone(),
            entry: spec.entry.clone(),
            permissions: normalize_permissions(&spec.permissions),
            theme: spec.theme.clone(),
            lang: spec.lang.clone(),
            pinned: spec.pinned,
            min_w: spec.min_w,
            min_h: spec.min_h,
            layer: spec.layer,
            click_through: spec.click_through,
            interactive: spec.interactive,
            shape: spec.shape,
            appearance: spec.appearance.clone(),
            config: spec.config.clone(),
            network: spec.network.clone(),
        },
    );

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("widget-host.html".into()))
        .title(&spec.widget_id)
        .inner_size(spec.w, spec.h)
        .position(spec.x, spec.y)
        .decorations(false)
        // 尺寸由宿主页自己算（它要知道最小尺寸、也要在拖边时同步移动窗口），
        // 所以窗口本身不开可调整，避免系统边框和自绘手柄打架
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        /*
         * 置顶要在**建窗口时**就定下来，不能建完再补。
         *
         * 事后调 `set_always_on_top(true)`（不管是我们自己的 `SetWindowPos`
         * 还是 tao 的 API）对这类无边框透明窗口不生效：调用返回成功，
         * `WS_EX_TOPMOST` 却始终不出现 —— 桌宠就这么沉在浏览器下面、点不到。
         * 建的时候指定，窗口一出生就在顶层那一档，之后再没机会掉出去。
         */
        .always_on_top(spec.layer == WindowLayer::Top);

    /*
     * `shape: region` 的窗口必须**真透明**。
     *
     * 区域裁的是"哪一块算她"，但区域内部没被画到的像素仍会被 WebView2 拿
     * 窗口底色填上 —— 那圈底色在浅色壁纸上就是她周围的一圈黑框（实测：
     * 亮背景上她身边的亮度 23，去掉窗口后是 234）。区域的矩形粒度救不了它，
     * 只有让窗口本身逐像素透明才行。
     *
     * 卡片（`rect`）不加这条：它们自己会画满一块不透明的卡面，透明只会让
     * DWM 多走一遍 alpha 合成，白费性能。
     */
    let builder = if spec.shape == WindowShape::Region {
        builder.transparent(true)
    } else {
        builder
    };

    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            runner.forget(&label);
            return Err(format!("failed to create widget window: {error}"));
        }
    };

    // 闸要在窗口开始加载之前挂上：组件拿到 iframe 的第一件事就可能是一次
    // 把自己送出去的导航（CSP 拦不住这条，见 egress.rs）
    egress::guard(app, &window);
    // 渲染进程整个挂掉时前端自己报不了（它就是那个进程），只能从这边看
    crate::crash::guard(app, &window, &spec.instance_id);

    /*
     * 窗口销毁 = 这个实例没了。
     *
     * 终端组件的常驻 shell 挂在这一条上：宿主页可能来不及发 `term_dispose`
     * （渲染进程崩、进程被杀），而窗口一定会被 Tauri 收掉。少了它，任务管理器里
     * 会留下一排 `powershell.exe`，而用户只是关了一张卡片。
     */
    {
        let instance = spec.instance_id.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                crate::term::kill_instance(&instance);
            }
        });
    }

    // 缩放时窗口尺寸变了，圆角裁剪区域得跟着重算。
    // 放在 Rust 里做，省掉"上报前端 → 存 store → 再同步回来"这一圈，拖动边缘才跟手。
    //
    // `shape: region` 的窗口例外：区域是组件按自己的身形算的，这里既不知道
    // 它长什么样，也不该替它重算 —— 宿主页会收到 resize，组件自己再报一次。
    if let Ok(handle) = window.window_handle() {
        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
            let hwnd = win32.hwnd.get();
            let radius = desktop::CORNER_RADIUS * window.scale_factor().unwrap_or(1.0);
            let shape = spec.shape;

            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(size) = event {
                    if shape == WindowShape::Rect {
                        let _ = desktop::clip_rounded(hwnd, size.width, size.height, radius);
                    }
                }
            });
        }
    }

    // 先显示再落到层级：ShowWindow 会把窗口提到最前，
    // 顺序反过来的话，刚压到 HWND_BOTTOM / WorkerW 的窗口又被顶上去了
    //
    // 暂停中例外：窗口照建（否则恢复时要等一整轮同步），但先不显示 ——
    // 否则"暂停"期间新增一个组件，它会自己冒出来
    if !runner.is_paused() {
        let _ = window.show();
    }
    // 组件窗口也会被藏起来（同步时删掉的那批、主窗口收回时），
    // 藏起来之后它自己的心跳就该停 —— 可见性由窗口自己报给它自己的页面
    visibility::watch(&window);
    // 桌面组件也有焦点事件：用它来判断"这一分钟用没用"（见 usage.rs）
    usage::watch(&window);
    if let Err(error) = desktop::apply_to(
        &window,
        spec.layer,
        spec.click_through,
        spec.interactive,
        spec.shape,
    ) {
        // 层级失败不该让整个同步失败：窗口已经建好了，至少先让人看见
        eprintln!("[lattice] failed to apply window layer ({label}): {error}");
    } else {
        // `shape: region` 的窗口在组件第一次上报之前必须是"不可见"的：
        // 窗口本身不透明，不裁就是一张实心卡片，加载那几百毫秒会先闪一块色块。
        // 空区域正好表达"什么都不显示"，而且不用等组件 —— 它上报了才出现。
        if spec.shape == WindowShape::Region {
            if let Ok(handle) = window.window_handle() {
                if let RawWindowHandle::Win32(win32) = handle.as_raw() {
                    let hwnd = win32.hwnd.get() as isize;
                    let parts = runner.region_of(&label);
                    if let Err(error) = desktop::set_region(hwnd, &parts) {
                        eprintln!("[lattice] failed to apply the initial region ({label}): {error}");
                    }
                }
            }
            // 区域是在 `apply_to` 之后才贴上的，那一步会动非客户区；窗口真正
            // "立起来"要等这一串走完，所以收尾再让 tao 确认一次置顶 —— 少了它，
            // 桌宠偶尔建出来是被浏览器压着的普通窗口。
            if spec.layer == WindowLayer::Top {
                if let Err(error) = window.set_always_on_top(true) {
                    eprintln!("[lattice] failed to keep {label} on top: {error}");
                }
            }
        }
        runner.remember(
            &label,
            Applied {
                x: spec.x,
                y: spec.y,
                w: spec.w,
                h: spec.h,
                layer: spec.layer,
                click_through: spec.click_through,
                interactive: spec.interactive,
                shape: spec.shape,
            },
        );
    }

    Ok(())
}

/// 增量同步：缺的创建、多的关闭、在的更新位置与层级。
/// 拖动时会被高频调用，所以只做必要的写入。
///
/// # 为什么是 async
///
/// Tauri 2 的同步命令跑在**主线程**上，而 `WebviewWindowBuilder::build()`
/// 需要把建窗口的活儿投递回主线程再等它做完 —— 命令自己占着主线程等自己，
/// 于是永久卡死（日志停在 `sync specs=3` 就没了，连报错都没有）。
/// 改成 async 之后命令落到运行时线程池，主线程空出来接这个投递，窗口才建得出来。
#[tauri::command]
pub async fn sync_widget_windows(
    app: AppHandle,
    runner: State<'_, Runner>,
    specs: Vec<WidgetWindowSpec>,
) -> Result<(), String> {
    let wanted: std::collections::HashSet<String> = specs
        .iter()
        .map(|spec| label_for(&spec.instance_id))
        .collect();

    // 已经不在画布上的实例，从"自己退出了"名单里划掉（见 retain_suppressed）
    let alive: HashSet<String> = specs.iter().map(|spec| spec.instance_id.clone()).collect();
    runner.retain_suppressed(&alive);

    // 关掉已经不在画布上的组件窗口
    for (label, window) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) && !wanted.contains(&label) {
            // 先藏再关：close() 要等 WebView2 把渲染进程拆完，窗口会定格几百毫秒
            let _ = window.hide();
            let _ = window.close();
            runner.forget(&label);
        }
    }

    let mut failures: Vec<String> = Vec::new();

    for spec in specs {
        // 组件自己关掉了自己：窗口别再建回来，但 placement 留着（见 widget_close）
        if runner.is_suppressed(&spec.instance_id) {
            continue;
        }

        let label = label_for(&spec.instance_id);
        // 外观不进 diff（那个结构只管 Win32 的 pos / size / layer）：
        // 单独记一份，变了才 emit —— 拖滑杆时每 120ms 一次全量同步，
        // 无条件推的话宿主页每 120ms 重算一遍壁纸层
        if runner.set_appearance(&label, spec.appearance.clone()) {
            let _ = app.emit_to(
                &label,
                "lattice:appearance",
                AppearanceMessage {
                    instance_id: &spec.instance_id,
                    appearance: &spec.appearance,
                },
            );
        }

        /*
         * 权限变更必须推到已经开着的窗口。
         *
         * 以前 `HostConfig.permissions` 只在 `create()` 里写一次，之后再也不更新：
         * 用户在属性面板撤掉 `storage`，桌面上那个组件照样能读写磁盘。这不是
         * "少刷了一下"，是授权界面在说谎 —— 撤销动作必须当场生效。
         *
         * 宿主页收到就换掉手里的 granted 集合并重走一遍初始化（见 widgetHost.ts）。
         */
        let permissions = normalize_permissions(&spec.permissions);
        if runner.set_permissions(&label, permissions.clone()) {
            let _ = app.emit_to(
                &label,
                "lattice:widget-permissions",
                PermissionsMessage {
                    instance_id: &spec.instance_id,
                    permissions: &permissions,
                },
            );
        }

        // 白名单只活在 Rust 侧，静默更新（不广播，见 set_network 的注释）。
        // 作者改 `network.hosts` 之后不必重开窗口 —— 文件监听会把改动送到这里
        runner.set_network(&label, spec.network.clone());

        /*
         * 配置变更同理，只是它不重载组件 —— 宿主页收到就换掉手里那份对象，
         * 推一条 `config-changed` 给 iframe，组件就地重画。
         *
         * 属性面板改一项要走这里，是因为它只改 store；真正落到窗口上靠的是
         * App 那条 120ms 防抖同步。延迟一帧的代价换来的是"不必再开一条命令"，
         * 而配置本来就是离散操作（拨开关、选日期），不差这 120ms。
         */
        if runner.set_config(&label, &spec.config) {
            let _ = app.emit_to(
                &label,
                "lattice:widget-config",
                ConfigMessage {
                    instance_id: &spec.instance_id,
                    config: &spec.config,
                },
            );
        }

        match app.get_webview_window(&label) {
            Some(window) => {
                /*
                 * 层级 / 别针：平台改的，宿主页也得知道。
                 *
                 * `diff` 只管 Win32 那一层（pos / size / layer），窗饰上那颗
                 * 按钮画什么由宿主页自己记着 —— 它只在建窗口时从 `HostConfig`
                 * 取过一次。属性面板、右键菜单、agent 改层级之后，窗口当场就
                 * 换了层，按钮却还画着旧图标，而且再点一下是从旧状态算新状态，
                 * 送回去的值等于没变（`docs/PITFALLS.md`「层级、焦点与 z 序」）。
                 *
                 * 只推**真的变了**的那一条：这条 120ms 防抖同步在拖滑杆时每帧
                 * 都跑，无条件 emit 会让桌面上所有组件跟着重画窗饰。
                 */
                if runner.set_layer(&label, spec.layer, spec.click_through) {
                    let _ = app.emit_to(
                        &label,
                        "lattice:widget-layer",
                        LayerPayload {
                            instance_id: spec.instance_id.clone(),
                            layer: spec.layer,
                        },
                    );
                }
                if runner.set_pinned(&label, spec.pinned) {
                    let _ = app.emit_to(
                        &label,
                        "lattice:widget-pinned",
                        PinnedPayload {
                            instance_id: spec.instance_id.clone(),
                            pinned: spec.pinned,
                        },
                    );
                }

                let next = Applied {
                    x: spec.x,
                    y: spec.y,
                    w: spec.w,
                    h: spec.h,
                    layer: spec.layer,
                    click_through: spec.click_through,
                    interactive: spec.interactive,
                    shape: spec.shape,
                };
                if let Some(change) = runner.diff(&label, next) {
                    if change.pos {
                        let _ = window.set_position(LogicalPosition::new(spec.x, spec.y));
                    }
                    if change.size {
                        let _ = window.set_size(LogicalSize::new(spec.w, spec.h));
                    }
                    if change.layer {
                        if let Err(error) = desktop::apply_to(
                            &window,
                            spec.layer,
                            spec.click_through,
                            spec.interactive,
                            spec.shape,
                        ) {
                            eprintln!("[lattice] failed to update window layer ({label}): {error}");
                        }
                        // 换了层级 / 轮廓方式之后，组件报过的区域要原样贴回去：
                        // `apply_to` 对 `region` 窗口不碰区域，但改尺寸可能让
                        // 上一次的区域失效，这里补一刀是幂等的
                        if spec.shape == WindowShape::Region {
                            if let Ok(handle) = window.window_handle() {
                                if let RawWindowHandle::Win32(win32) = handle.as_raw() {
                                    let parts = runner.region_of(&label);
                                    let _ = desktop::set_region(win32.hwnd.get() as isize, &parts);
                                }
                            }
                        }
                    }
                }
            }
            None => {
                if let Err(error) = create(&app, &spec, &runner) {
                    failures.push(format!("{}：{error}", spec.widget_id));
                }
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

/// 同样要走 async：`close()` 也是投递到主线程执行
#[tauri::command]
pub async fn close_widget_windows(
    app: AppHandle,
    runner: State<'_, Runner>,
) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) {
            let _ = window.hide();
            let _ = window.close();
            runner.forget(&label);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 暂停 / 恢复
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PausedPayload {
    paused: bool,
}

/// 暂停或恢复所有组件窗口，返回**执行之后**的状态。
///
/// 暂停是"把窗口藏起来"，不是只把画面抹掉：`hide()` 会让 WebView2 把
/// `document.visibilityState` 翻成 hidden，`visibility.rs` 再从尺寸变化推一条
/// `lattice:window-visible` 下去，调度器两者取"与"——所有 `schedule.every`
/// 当场停摆。恢复时反过来。所以这个开关省的是真 CPU。
///
/// 恢复时还要重上一次层级：`show()` 会把窗口顶到最前，贴桌面那批
/// （`HWND_BOTTOM` / WorkerW）得重新压回去。
pub fn apply_pause(app: &AppHandle, runner: &Runner, paused: bool) -> bool {
    runner.set_paused(paused);

    for (label, window) in app.webview_windows() {
        if !label.starts_with(LABEL_PREFIX) {
            continue;
        }
        if paused {
            let _ = window.hide();
        } else {
            let _ = window.show();
            if let Some(config) = runner.get(&label) {
                if let Err(error) = desktop::apply_to(
                    &window,
                    config.layer,
                    config.click_through,
                    config.interactive,
                    config.shape,
                ) {
                    eprintln!("[lattice] failed to re-apply the layer after resuming ({label}): {error}");
                }
                // 恢复之后 `apply_to` 对 `region` 窗口不碰区域，但窗口刚被 show() 过，
                // 把组件报过的轮廓贴回去是幂等的保险
                if config.shape == WindowShape::Region {
                    if let Ok(handle) = window.window_handle() {
                        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
                            let parts = runner.region_of(&label);
                            let _ = desktop::set_region(win32.hwnd.get() as isize, &parts);
                        }
                    }
                }
            }
        }
        // hide/show 不改尺寸、不触发 Resized：可见性得显式补一刀，
        // 否则调度器要等到下一次最小化才会知道状态变了
        visibility::sync(&window);
    }

    let _ = app.emit_to("main", "lattice:paused", PausedPayload { paused });
    paused
}

/// 托盘菜单用：翻转一次
pub fn toggle_paused(app: &AppHandle) -> bool {
    let runner = app.state::<Runner>();
    let next = !runner.is_paused();
    apply_pause(app, &runner, next)
}

#[tauri::command]
pub fn set_widgets_paused(app: AppHandle, runner: State<'_, Runner>, paused: bool) -> bool {
    apply_pause(&app, &runner, paused)
}

#[tauri::command]
pub fn widgets_paused(runner: State<'_, Runner>) -> bool {
    runner.is_paused()
}

/// 重载一个组件的窗口。
///
/// 崩溃自动重试放弃之后，主窗口那条提示上有"Try again"。它不重置 `crash.rs`
/// 里的计数 —— 如果重载起来立刻又崩，会直接落到"放弃"那一支。这是有意的：
/// 连着崩三次、手动再试还是崩，说明文件本身有问题，多给三次机会只是多闪
/// 几下白屏。
#[tauri::command]
pub fn widget_reload(app: AppHandle, instance_id: String) -> Result<(), String> {
    let label = label_for(&instance_id);
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window for {instance_id}"))?;
    window.reload().map_err(|error| error.to_string())
}

/// 宿主页启动时问自己该装哪个组件、拿到了哪些权限
#[tauri::command]
pub fn widget_host_config(
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
) -> Result<HostConfig, String> {
    runner
        .get(window.label())
        .ok_or_else(|| format!("no widget config registered for window {}", window.label()))
}

// ---------------------------------------------------------------------------
// 宿主页 → 主窗口的动作通道
//
// 组件窗口和主窗口是两个 webview，彼此看不见对方的状态。宿主页上用户拖了、
// 缩了、点了别针，都要经由 Rust 转一手：Rust 改自己那份配置、必要时直接落到
// Win32，然后 emit 给主窗口，让 store 记下来。
//
// 为什么不让宿主页直接改 store：它没有 store，也不该有 —— 组件窗口只是渲染层。
// ---------------------------------------------------------------------------

/// 用户在桌面上拖完/缩完之后上报真实矩形
#[tauri::command]
pub fn widget_report_rect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let config = runner
        .get(window.label())
        .ok_or_else(|| "this window is not a registered widget window".to_string())?;

    // 顺手把缓存更新掉：下一次同步就不会再拿旧坐标去 set_position
    runner.remember(
        window.label(),
        Applied {
            x,
            y,
            w,
            h,
            layer: config.layer,
            click_through: config.click_through,
            interactive: config.interactive,
            shape: config.shape,
        },
    );

    let _ = app.emit_to(
        "main",
        "lattice:widget-rect",
        RectPayload {
            instance_id: config.instance_id,
            x,
            y,
            w,
            h,
        },
    );
    Ok(())
}

/// 别针开关
#[tauri::command]
pub fn widget_set_pinned(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    pinned: bool,
) -> Result<(), String> {
    let mut config = runner
        .get(window.label())
        .ok_or_else(|| "this window is not a registered widget window".to_string())?;
    config.pinned = pinned;
    runner.put(window.label(), config.clone());

    let _ = app.emit_to(
        "main",
        "lattice:widget-pinned",
        PinnedPayload {
            instance_id: config.instance_id,
            pinned,
        },
    );
    Ok(())
}

/// 层级切换：贴桌面 / 置顶
#[tauri::command]
pub fn widget_set_layer(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    layer: WindowLayer,
) -> Result<(), String> {
    let mut config = runner
        .get(window.label())
        .ok_or_else(|| "this window is not a registered widget window".to_string())?;
    config.layer = layer;
    runner.put(window.label(), config.clone());

    // 立即落到 Win32，不等主窗口那一圈同步，点完马上就能看到效果
    desktop::apply_to(
        &window,
        layer,
        config.click_through,
        config.interactive,
        config.shape,
    )?;
    runner.patch_layer(window.label(), layer, config.click_through);

    let _ = app.emit_to(
        "main",
        "lattice:widget-layer",
        LayerPayload {
            instance_id: config.instance_id,
            layer,
        },
    );
    Ok(())
}

/// 组件上报自己的轮廓（桥方法 `window.setRegion`）。
///
/// 只有清单里写了 `"shape": "region"` 的窗口认这条：别的窗口轮廓是平台的
/// 圆角矩形，允许组件随便改会让"卡片"这个概念当场失效（而用户按 ✕ 的那个
/// 位置是画在卡片右上角的，形状没了就点不到）。
///
/// 坐标是物理像素、相对客户区左上角 —— 和 `clip_rounded` 同一个口径，
/// 所以组件那边要自己乘 `devicePixelRatio`（宿主页会把比例告诉它）。
#[tauri::command]
pub fn widget_set_region(
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    parts: Vec<RegionPart>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let config = runner
        .get(&label)
        .ok_or_else(|| "this window is not a registered widget window".to_string())?;
    if config.shape != WindowShape::Region {
        return Err(
            "this widget does not declare \"shape\": \"region\" in its manifest".to_string(),
        );
    }

    // 一块宠物撑死十来块，几百块说明组件算错了 —— 限流而不是照单全收：
    // 每块都要 CreateXxxRgn + CombineRgn，几千块会明显卡住消息循环
    if parts.len() > MAX_REGION_PARTS {
        return Err(format!(
            "too many region parts ({} > {MAX_REGION_PARTS})",
            parts.len()
        ));
    }

    let handle = window.window_handle().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
            desktop::set_region(win32.hwnd.get() as isize, &parts)?;
            runner.remember_region(&label, parts);
            return Ok(());
        }
        Err("could not obtain the Win32 window handle".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (handle, parts);
        Err("window regions are only implemented on Windows".to_string())
    }
}

/// 一次上报最多认多少块。桌宠是十来块，留足余量
const MAX_REGION_PARTS: usize = 256;

/// 那一下点击的来路，由宿主页在调用时一并送来。
///
/// # 为什么值得单开一个参数
///
/// "组件自己从画布上消失"查了整整两轮，卡在同一个地方：日志只有
/// `reason: user`，而 `user` 只可能来自 ✕ 的 click 处理器 —— 也就是说
/// 处理器**确实跑了**，但没人知道那一下是谁派的。宿主页那边写
/// `console.info` 没用：vite dev 不转发组件窗口的 console，终端里一个字都看不到。
///
/// 把点击本身的特征塞进 IPC 参数，就能和 `widget_close` 打在同一行日志上。
/// 判读方式：
///
/// - `trusted` + 真实坐标 + `detail: 1` —— 真鼠标事件（可能被重放）
/// - `synthetic` —— 脚本 `dispatchEvent` 出来的
/// - `detail: 0` 且坐标 `0,0` —— 键盘激活（Enter / 空格）而非指针
/// - `pointer: touch` / `pen` —— 触摸屏或笔，Windows 上可能被误判
/// - `why: ok` —— 宿主页那条 `decideClose` 判据放行的原因（`runtime/close-guard.ts`）。
///   现在是 `ok` / `keyboard` 两种之一；其余分支（`no-press`、`stale-position` …）
///   根本不会走到这里，只留在宿主页的 console 里。**下次再撞到"组件自己消失"，
///   先看这一栏**：`ok` 说明那确实是一段按下 + 松开的完整序列，`keyboard` 说明
///   是键盘激活，两者指向的方向完全不同。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseOrigin {
    trusted: Option<bool>,
    detail: Option<u32>,
    pointer: Option<String>,
    /// `clientX,clientY` 拼好的字符串 —— Rust 这边不拆，只为了能对上下文
    at: Option<String>,
    /// 宿主页放行这次关闭的理由（见上）
    why: Option<String>,
}

impl CloseOrigin {
    fn describe(&self) -> String {
        let trusted = match self.trusted {
            Some(true) => "trusted",
            Some(false) => "synthetic",
            None => "trust?",
        };
        let detail = match self.detail {
            Some(value) => value.to_string(),
            None => "?".to_string(),
        };
        format!(
            "{trusted} detail={detail} pointer={} at={} why={}",
            self.pointer.as_deref().filter(|text| !text.is_empty()).unwrap_or("?"),
            self.at.as_deref().unwrap_or("?"),
            self.why.as_deref().unwrap_or("?"),
        )
    }
}

/// 关掉这个组件窗口。**只有用户按了 ✕ 才连 placement 一起删**。
///
/// # 为什么非得分个 `reason`
///
/// 这条命令有两个调用方，语义完全不同：
///
/// - 宿主页上的 ✕ —— 用户说"把这个组件从我的桌面上拿掉"，删 placement 是对的
/// - 组件自己调 `window.close()` —— 它只是要退出，用户摆好的布局不该陪葬
///
/// 以前两者共用一条路，"窗口关了"就直接等于"placement 删了"。后果是只要有任何
/// 一次意外的 `widget_close`（来路至今没查清，见 docs/ROADMAP.md 的坑表），
/// 用户的组件就静默消失，连日志都没有。关窗口是可撤销的小事，删用户数据不是。
///
/// 所以现在：`reason == "user"` 才发 `lattice:widget-close` 让主窗口删；
/// 别的来路一律只关窗口，并把实例记进 `suppressed`，本次运行不再重建
/// （不然下一次同步又会把它变出来，用户会觉得"关不掉"）。
#[tauri::command]
pub async fn widget_close(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    reason: Option<String>,
    click: Option<CloseOrigin>,
) -> Result<(), String> {
    let reason = reason.unwrap_or_else(|| "unknown".to_string());
    // 一定要留痕：这条路径会动用户的布局，出问题时得能查出是谁干的。
    // 点击特征打在同一行 —— 分两行写，出事后对时间戳能对到眼花
    let origin = click
        .as_ref()
        .map(|origin| format!(", {}", origin.describe()))
        .unwrap_or_default();
    /*
     * 带上毫秒时间戳。
     *
     * 日志文件里 stdout（cargo / tauri dev 的输出）是块缓冲的、stderr 不是，
     * 两者混在同一个文件里，**行序完全不可信** —— 上一轮就是靠行序去判"这次
     * 关闭发生在启动前还是重建后"，判错了方向。时间戳是唯一可靠的坐标。
     */
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    eprintln!(
        "[lattice] widget_close {} (reason: {reason}{origin}, t={stamp})",
        window.label()
    );

    if let Some(config) = runner.get(window.label()) {
        if reason == "user" {
            let _ = app.emit_to(
                "main",
                "lattice:widget-close",
                InstancePayload {
                    instance_id: config.instance_id,
                },
            );
        } else {
            runner.suppress(&config.instance_id);
            /*
             * 告诉主窗口"这一份没窗口了"。
             *
             * 桌面模式下画布那张卡只画静态卡（"它在自己那个窗口里跑"），窗口
             * 不在的时候那句话就是假的，组件在屏幕上会一个像素都不剩。主窗口
             * 拿这条事件把那一份退回画布上活的那份（`canvasNeedsLiveFrame`）。
             *
             * 和上一条**故意分开**：那条的语义是"删掉这个摆放"（用户点了 ✕），
             * 这条是"摆放留着、只是窗口没了"。合成一条的后果正是当初那三次
             * 静默删用户数据的老路。
             */
            let _ = app.emit_to(
                "main",
                "lattice:widget-suppressed",
                InstancePayload {
                    instance_id: config.instance_id,
                },
            );
        }
    }
    runner.forget(window.label());
    // 先藏再关：close() 要等 WebView2 把渲染进程拆完，窗口会定格几百毫秒
    let _ = window.hide();
    let _ = window.close();
    Ok(())
}

/// 平台换了明暗，把已经在桌面上的组件一起改过来。
///
/// 组件的明暗是在建窗口时定下的，之后平台再切主题就跟它没关系了。
/// 广播一条事件，各宿主页自己重上色。
#[tauri::command]
pub fn widget_set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let _ = app.emit("lattice:theme", theme);
    Ok(())
}

/// 平台换了界面语言，把已经在桌面上的组件窗口一起改过来。
///
/// 和主题同一套：`lang` 在建窗口时随 `HostConfig` 下去当初值，之后的切换走
/// 这条广播（宿主页不加载 store，读不到设置里那档偏好）。宿主页做两件事：
/// 用 `t()` 重画**平台自己写的**字（窗饰提示、错误卡片），再把新语言转发给组件
/// 的 iframe（`{ type: "language" }`）—— 作者写的中英文只有组件自己挑得出来。
#[tauri::command]
pub fn widget_set_language(app: AppHandle, lang: String) -> Result<(), String> {
    let _ = app.emit("lattice:language", lang);
    Ok(())
}

/// 属性面板拖滑杆时走的轻量通道：只推一个外观对象，不重建窗口、不动位置。
///
/// 组件可能只在画布上、没有桌面窗口，这时候 emit 会失败，忽略即可 ——
/// 面板改的是 store，下次投放时 `sync_widget_windows` 会把它带上。
#[tauri::command]
pub async fn widget_set_appearance(
    app: AppHandle,
    runner: State<'_, Runner>,
    instance_id: String,
    appearance: Appearance,
) -> Result<(), String> {
    let label = label_for(&instance_id);
    runner.set_appearance(&label, appearance.clone());
    // 载荷带 instanceId：这条事件会送到每个窗口，见 AppearanceMessage 的注释
    let _ = app.emit_to(
        &label,
        "lattice:appearance",
        AppearanceMessage {
            instance_id: &instance_id,
            appearance: &appearance,
        },
    );
    Ok(())
}
