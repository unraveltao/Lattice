//! 桌面层控制（Windows）
//!
//! 小组件有三个层级，是 Windows 自己的 z 序模型，组件只是选一站：
//!
//! - `desktop`：把窗口挂到 WorkerW 下（Wallpaper Engine 那套做法），
//!   窗口就沉到桌面图标之上、普通窗口之下，切窗口不会被挡住。
//!   拿不到 WorkerW 时降级为 `HWND_BOTTOM`，至少不会浮在最上层。
//! - `normal`：一个**普通窗口** —— 不置顶、不沉底，别人能盖住它，
//!   它也能盖住别人；位置和大小记得住，重启还在原地。
//! - `top`：还原父子关系后设为 `HWND_TOPMOST`。
//!
//! 为什么必须有中间那一层：只有"沉到最底"和"压在所有东西上面"两档时，
//! 日常最想要的状态（*浮在资源管理器上面，但不压全屏应用*）**根本选不出来**。
//! 用户把层级调来调去都觉得"没变化"，多半就是卡在这 —— 他想要的第三档不存在。
//!
//! 三种层级都会加 `WS_EX_TOOLWINDOW`（不进任务栏、不进 Alt+Tab）。
//!
//! # 一个容易踩的语义陷阱
//!
//! `desktop` 这一档在 Win32 里**是两种不同的东西**，取决于 `interactive`：
//! 纯展示组件真的挂进 WorkerW（壁纸那一层），可输入的组件只能退成
//! `HWND_BOTTOM` 的普通窗口。所以"贴在桌面上"这句文案对便签来说是假的 ——
//! 它其实只是"压在所有普通窗口下面"。界面上别把这两件事说成一件
//! （`InspectorPanel` 按 `interactive` 分开写文案）。
//!
//! # 关于焦点
//!
//! 纯展示的组件（时钟、倒计时）加 `WS_EX_NOACTIVATE`：点它不抢焦点，
//! 不打断你正在打的字。
//!
//! 但**要输入的组件不能这么干**。`WS_EX_NOACTIVATE` 的窗口永远不会成为前台
//! 窗口，WebView2 就拿不到键盘焦点 —— 光标会闪，敲的键却全进了后面那个窗口。
//! 更狠的是 `desktop` 层原本还要 `SetParent` 到 WorkerW：那是桌面的子窗口，
//! 连激活的资格都没有，等于把"能写字的便签"这条路彻底堵死。
//!
//! 所以清单里 `interactive: true` 的组件走另一条路：不挂 WorkerW，退成
//! `HWND_BOTTOM` 的普通窗口，可以点、可以激活、可以打字；失焦时 runner 会
//! 把它重新压回最底层，视觉上仍然是"贴在桌面上"。
//!
//! # 关于圆角与透明
//!
//! **卡片**（`shape: rect`）的窗口是**不透明**的，圆角靠 `SetWindowRgn` 把窗口
//! 本身裁成圆角矩形，而不是靠 `border-radius` + 透明窗口。原因是逐像素透明要求
//! WebView2 走 DirectComposition 合成，在混合显卡 / 虚拟显示适配器环境下
//! 直接建不出 webview（`HRESULT(0x8007139F)`）；就算建出来了，
//! 一旦软件渲染，透明背景也会退回成白底。
//!
//! 裁剪方案没有这些前提：窗口照常渲染，形状由系统负责，
//! 代价是圆角边缘没有抗锯齿。对一个贴桌面的小组件来说这笔交易很划算。
//!
//! **区域形状**（`shape: region`，桌宠那类）是唯一的例外，它**必须**逐像素透明：
//! 区域只回答"哪一块算她"，区域里面没被画到的像素仍然会被 WebView2 拿窗口
//! 底色填上 —— 实测在亮壁纸上一圈近黑的底（亮度 23，背景 246），就是"她周围
//! 那一圈黑框"。所以这类窗口在 `runner::create` 里开 `transparent(true)`，
//! 同时把窗口自带的边框位摘掉（`strip_frame`）：两条一起做才干净，只做一半
//! 会剩一层软影或者一圈硬边。
//!
//! 这台机器（有 GPU 合成）上真透明是能建的；万一哪天在没 GPU 的环境里
//! 建不出来，症状是窗口直接建失败（`0x8007139F`），不会静默变白底。

use serde::{Deserialize, Serialize};

/// 组件窗口的圆角半径（逻辑像素），与画布里 `.lattice-widget` 的 12px 对齐
pub const CORNER_RADIUS: f64 = 12.0;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowLayer {
    Desktop,
    /// 普通窗口：不置顶、不沉底。顺序就是 z 序从下到上，别重排 —— 前端
    /// 的 `nextLayer` 和检查器那排分段按钮都按这个顺序循环。
    Normal,
    Top,
}

impl Default for WindowLayer {
    fn default() -> Self {
        WindowLayer::Desktop
    }
}

/// 这个窗口在 Win32 眼里**实际**是什么层级。
///
/// 和 `WindowLayer`（用户要的那一档）不是一回事：`desktop` 有两种落法
/// （WorkerW 父窗口 / `HWND_BOTTOM`），`top` 有可能没置上（tao 的位和
/// Win32 的位打架时静默失败）。检查器把这一份直接显示出来，用户报
/// "点了没反应"时才有一个事实可查，而不是四次猜测。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerProbe {
    /// `workerw` / `bottom` / `normal` / `topmost` / `unknown`
    pub actual: String,
    /// 有父窗口（说明真的挂在 WorkerW 下）
    pub parented: bool,
    /// `WS_EX_TOPMOST` 这一位
    pub topmost: bool,
    /// "永远待在底层"的守卫开着没有
    pub sunk: bool,
    /// 窗口句柄取没取到（取不到时上面几个字段全是 false）
    pub found: bool,
}

/// 窗口轮廓从哪儿来。
///
/// `Rect` 是平台自己的圆角矩形（`clip_rounded`）；`Region` 表示轮廓由组件
/// 通过 `window.setRegion` 上报，平台不再碰区域，也不画底板 —— 桌宠、
/// 悬浮挂件这类"不是一张卡片"的东西走这条。
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowShape {
    #[default]
    Rect,
    Region,
}

/// 轮廓里的一块。坐标是**物理像素**、相对客户区左上角，和 `clip_rounded` 同一个口径。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegionPart {
    #[serde(default)]
    pub kind: RegionKind,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RegionKind {
    #[default]
    Rect,
    Ellipse,
}

/// 把窗口裁成若干块矩形 / 椭圆的并集。
///
/// 空切片表示"什么都不显示"：建窗口到组件第一次上报之间那几百毫秒用它兜底，
/// 否则会先闪一块不透明的矩形（窗口是不透明的，不裁就是一张实心卡片）。
///
/// 成功后区域归系统所有，不能再删 —— 和 `clip_rounded` 同一条规矩。
pub fn set_region(hwnd: isize, parts: &[RegionPart]) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::set_region(hwnd, parts)
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, parts);
        Err("window regions are only implemented on Windows".to_string())
    }
}

/// 把窗口裁成圆角矩形。区域坐标是物理像素
pub fn clip_rounded(hwnd: isize, width: u32, height: u32, radius: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::clip_rounded(hwnd, width, height, radius)
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, width, height, radius);
        Err("window clipping is only implemented on Windows".to_string())
    }
}

/// 按窗口**当前外框**裁圆角 —— 尺寸由 Win32 现量，调用方不用猜。
///
/// 为什么要有这一个：`SetWindowRgn` 的坐标是**窗口坐标（外框）**。拿客户区
/// 尺寸当宽度，会把右边和下面各裁掉一条非客户区（`decorations(false)` 的窗口
/// 也有 8px 的细边框），而那条正好压在页面自绘的缩放手柄上 ——
/// 症状不是报错，是"手柄画在那儿，按下去掉到下面的窗口里"。
pub fn clip_rounded_current(hwnd: isize, radius: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::clip_rounded_current(hwnd, radius)
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, radius);
        Err("window clipping is only implemented on Windows".to_string())
    }
}

/// 对给定窗口句柄应用层级、穿透与焦点设置
pub fn apply_layer(
    hwnd: isize,
    layer: WindowLayer,
    click_through: bool,
    interactive: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::apply(hwnd, layer, click_through, interactive)
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, layer, click_through, interactive);
        Err("window layering is only implemented on Windows".to_string())
    }
}

/// 翻转"永远待在底层"的开关。任意线程可调（只写一个窗口属性）。
pub fn set_sink(hwnd: isize, on: bool) {
    #[cfg(windows)]
    {
        if hwnd != 0 {
            imp::set_sink(hwnd as windows_sys::Win32::Foundation::HWND, on);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, on);
    }
}

/// 装底层守卫。只能在窗口自己的线程上调（见 `imp::install_guard`）。
pub fn install_guard(hwnd: isize) -> Result<(), String> {
    #[cfg(windows)]
    {
        if hwnd == 0 {
            return Err("window handle is null".to_string());
        }
        imp::install_guard(hwnd as windows_sys::Win32::Foundation::HWND)
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        Ok(())
    }
}

/// 读这个窗口**实际**在什么层级。纯读，不改任何东西。
///
/// 存在的理由只有一个：让"我点了没反应"从猜测变成事实。层级这条链路上
/// 的失败全是无声的 —— 找不到 WorkerW 就悄悄降级成 `HWND_BOTTOM`，
/// `set_always_on_top` 失败只 `eprintln` 一行，用户在界面上什么都看不到。
pub fn probe(hwnd: isize) -> LayerProbe {
    #[cfg(windows)]
    {
        imp::probe(hwnd)
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        LayerProbe {
            actual: "unknown".to_string(),
            parented: false,
            topmost: false,
            sunk: false,
            found: false,
        }
    }
}

/// 把层级与穿透设置应用到某个 Tauri 窗口
pub fn apply_to(
    window: &tauri::WebviewWindow,
    layer: WindowLayer,
    click_through: bool,
    interactive: bool,
    shape: WindowShape,
) -> Result<(), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle().map_err(|error| error.to_string())?;

    // 裁剪区域用的是物理像素，先把逻辑尺寸按 DPI 放缩
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?;

    #[cfg(windows)]
    {
        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
            let hwnd = win32.hwnd.get();
            let guard = layer == WindowLayer::Desktop && interactive;
            let target = hwnd as isize;

            // 先翻守卫开关，再落层级。反过来的话，切"置顶"那一下的
            // HWND_TOPMOST 会被还活着的守卫改写成 HWND_BOTTOM，组件就永远上不去了。
            set_sink(target, guard);

            apply_layer(hwnd, layer, click_through, interactive)?;

            /*
             * 区域形状的窗口不该带系统的边框位。
             *
             * 这里**和** `set_region` 各做一次，不是冗余：窗口刚建出来时
             * `apply_layer` 会按 tao 的默认样式重建一遍非客户区（边框跟着回来），
             * 而 `set_region` 要等组件上报轮廓才跑 —— 中间那几百毫秒里她周围
             * 有一圈黑框。两个点各摘一次，覆盖"建窗口"和"换轮廓"两条路。
             *
             * 必须在 `apply_layer` 之后：先摘了再落层级，`SetWindowPos` 会把
             * 非客户区按当时的样式重算一遍，边框就又回来了。
             */
            if shape == WindowShape::Region {
                imp::strip_frame(hwnd as _);
            }

            // 轮廓归组件管的时候一根手指都别碰区域：`clip_rounded` 会把
            // 宠物身上那块非矩形区域换成圆角矩形，动物当场变成一张卡片。
            // 空区域留到窗口真正建完之后由 `runner::create` 补（那里才知道
            // 实例是 shape: region），这里只管"不覆盖"。
            if shape == WindowShape::Rect {
                imp::clip_rounded(hwnd, size.width, size.height, CORNER_RADIUS * scale)?;
            }

            /*
             * 置顶这一位交给 tao 的 API，别自己调 `SetWindowPos(HWND_TOPMOST)`。
             *
             * 实测：桌宠窗口上用 Win32 直接置顶会静默失败 —— 返回 TRUE，
             * `WS_EX_TOPMOST` 却始终不出现（同一个进程里的主窗口反倒正常）。
             * 原因是 tao 自己也记着"这个窗口是不是置顶"，两边不一致时以它的
             * 记录为准，它下一次重排样式就把那一位按回去了。走 API 让它同时
             * 更新自己的记录，之后的重排不会再清掉。
             *
             * 必须在 `strip_frame` 之后：那一次 `SWP_FRAMECHANGED` 会把顶层的位
             * 抹掉（她周围那圈黑框就是同一次重排留下的），顺序反了就白置顶。
             */
            if let Err(error) = window.set_always_on_top(layer == WindowLayer::Top) {
                eprintln!("[lattice] failed to apply the always-on-top state: {error}");
            }

            // 子类化必须在窗口自己的线程上做：跨线程调 SetWindowSubclass
            // 不报错，只是返回 0（实测就是这样，守卫静默失效）。
            if guard {
                let _ = window.run_on_main_thread(move || {
                    if let Err(error) = install_guard(target) {
                        eprintln!("[lattice] failed to install the z-order guard: {error}");
                    }
                });
            }
            return Ok(());
        }
        Err("could not obtain the Win32 window handle".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (handle, scale, size);
        Err("window layering is only implemented on Windows".to_string())
    }
}

#[tauri::command]
pub fn apply_window_layer(
    window: tauri::WebviewWindow,
    layer: WindowLayer,
    click_through: bool,
    interactive: bool,
    // 老调用方不带这个字段：默认 `rect`，行为和加这个参数之前一模一样
    #[allow(unused_variables)] shape: Option<WindowShape>,
) -> Result<(), String> {
    apply_to(
        &window,
        layer,
        click_through,
        interactive,
        shape.unwrap_or_default(),
    )
}

#[cfg(windows)]
mod imp {
    use super::WindowLayer;
    use windows_sys::Win32::Foundation::{HANDLE, HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_NCRENDERING_POLICY};
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateEllipticRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject,
        RedrawWindow, SetWindowRgn, RGN_OR, RDW_ALLCHILDREN, RDW_ERASE, RDW_INVALIDATE,
        RDW_UPDATENOW,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GWL_EXSTYLE, GWL_STYLE, GetParent, GetPropW,
        GetWindowRect,
        GetWindowLongPtrW, HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST, RemovePropW,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        SendMessageTimeoutW, SetParent, SetPropW, SetWindowLongPtrW, SetWindowPos, WINDOWPOS,
        WM_WINDOWPOSCHANGING, WS_BORDER, WS_DLGFRAME, WS_EX_CLIENTEDGE, WS_EX_LAYERED,
        WS_EX_NOACTIVATE, WS_EX_STATICEDGE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
        WS_EX_WINDOWEDGE,
    };

    /// Progman 收到这条未公开消息后会派生出承载壁纸的 WorkerW
    const SPAWN_WORKER_W: u32 = 0x052C;

    /// 把窗口裁成圆角矩形。区域坐标是物理像素，**四条边都比窗口大 1px**。
    ///
    /// 为什么不正好是 `(0, 0, w + 1, h + 1)`：区域边界压在窗口最外面那一像素上时，
    /// 合成出来的那一圈**不属于窗口的可见内容** —— 不透明的窗口看不出来（窗口自己
    /// 的底色盖住了），`transparent(true)` 的窗口就露馅：深色面板外面浮一条 1px 的边，
    /// 内容是桌面（0036 的现场，小窗四边各 1px）。把边界推到窗口外面，最外那一像素
    /// 就成了"完整的内部"。多给的部分被窗口自身裁掉，不会画到别的地方。
    ///
    /// 实测：拿一个**不透明**的普通窗口试，`(0, 0, w + 1, h + 1)` 直边是满的 ——
    /// 这条只在透明窗口上看得到（小窗、桌面卡片都是透明的）。
    pub fn clip_rounded(hwnd: isize, width: u32, height: u32, radius: f64) -> Result<(), String> {
        if hwnd == 0 {
            return Err("window handle is null".to_string());
        }
        if width == 0 || height == 0 {
            return Ok(());
        }
        let diameter = (radius * 2.0).round().max(2.0) as i32;
        let region = unsafe {
            CreateRoundRectRgn(
                -1,
                -1,
                width as i32 + 2,
                height as i32 + 2,
                diameter,
                diameter,
            )
        };
        if region.is_null() {
            return Err("failed to create the rounded window region".to_string());
        }
        // 成功后区域归系统所有，不能再删；失败才需要自己释放
        let ok = unsafe { SetWindowRgn(hwnd as HWND, region, 1) };
        if ok == 0 {
            unsafe {
                DeleteObject(region);
            }
            return Err("failed to apply the window region".to_string());
        }
        Ok(())
    }

    /// 现量外框再裁（见 `desktop::clip_rounded_current`）
    pub fn clip_rounded_current(hwnd: isize, radius: f64) -> Result<(), String> {
        if hwnd == 0 {
            return Err("window handle is null".to_string());
        }
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        let measured = unsafe { GetWindowRect(hwnd as HWND, &mut rect) };
        if measured == 0 {
            return Err("could not measure the window".to_string());
        }
        let width = (rect.right - rect.left).max(0) as u32;
        let height = (rect.bottom - rect.top).max(0) as u32;
        clip_rounded(hwnd, width, height, radius)
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 把窗口自己的边框 / 投影剥掉（区域形状的窗口用）。
    ///
    /// 桌宠的轮廓就是她的形状，而 `WS_BORDER` / `WS_DLGFRAME` / `WS_EX_WINDOWEDGE`
    /// 会让系统沿着这圈轮廓画一条深色描边，再叠一层 DWM 投影 —— 看上去就是
    /// "她周围有一圈黑框"。那圈不是组件画的：它在区域边界上、由 DWM 合成，
    /// CSS 盖不住，只能在窗口这一层摘掉。
    ///
    /// 三条：
    /// - **先改样式，再 `SWP_FRAMECHANGED`**。只改样式不重算非客户区的话，旧边框
    ///   的像素要等窗口下一次改尺寸才会掉 —— 表现是"改了没用，拖一下才没"。
    /// - **顺手关掉 DWM 的非客户区渲染**（`DWMNCRP_DISABLED`）。边框没了、投影
    ///   还在，是最难查的那种"剩一半"。
    /// - **只对区域窗口做**。圆角卡片那圈 1px 描边是 CSS 画的（`body::after`），
    ///   动它会让所有组件的长相一起变。
    pub fn strip_frame(hwnd: HWND) {
        const DWMNCRP_DISABLED: i32 = 1;
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            let next = style & !((WS_BORDER | WS_DLGFRAME) as isize);
            if next != style {
                SetWindowLongPtrW(hwnd, GWL_STYLE, next);
            }
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let next_ex =
                ex & !((WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE) as isize);
            if next_ex != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next_ex);
            }
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            let disabled: i32 = DWMNCRP_DISABLED;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY as u32,
                &disabled as *const i32 as *const core::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }

    /// 若干块矩形 / 椭圆的并集 → 窗口区域。
    ///
    /// 逐块 `CombineRgn(RGN_OR)`：一块桌宠通常由"头 + 两只耳朵 + 身体 + 尾巴"
    /// 五六块拼出来，`SetWindowRgn` 只吃一个区域，所以并集这一步躲不掉。
    pub fn set_region(hwnd: isize, parts: &[super::RegionPart]) -> Result<(), String> {
        if hwnd == 0 {
            return Err("window handle is null".to_string());
        }

        // 先建一个空区域：没有任何一块时它就是"什么都不显示"，
        // 比 SetWindowRgn(hwnd, 0) 强 —— 后者会**清掉**区域，窗口变回整块矩形
        let region = unsafe { CreateRectRgn(0, 0, 0, 0) };
        if region.is_null() {
            return Err("failed to create the window region".to_string());
        }

        for part in parts {
            if part.w <= 0 || part.h <= 0 {
                continue;
            }
            let right = part.x.saturating_add(part.w);
            let bottom = part.y.saturating_add(part.h);
            let one = unsafe {
                match part.kind {
                    super::RegionKind::Ellipse => CreateEllipticRgn(part.x, part.y, right, bottom),
                    super::RegionKind::Rect => CreateRectRgn(part.x, part.y, right, bottom),
                }
            };
            if one.is_null() {
                continue;
            }
            // dest 与 src1 同一个句柄是允许的（区域是就地并集）
            unsafe {
                CombineRgn(region, region, one, RGN_OR);
                DeleteObject(one);
            }
        }

        let ok = unsafe { SetWindowRgn(hwnd as HWND, region, 1) };
        if ok == 0 {
            unsafe {
                DeleteObject(region);
            }
            return Err("failed to apply the window region".to_string());
        }

        // 区域形状的窗口不该有边框：那圈描边和投影正是"她周围的黑框"
        strip_frame(hwnd as HWND);

        /*
         * 区域变了以后必须**强制重绘一次**。
         *
         * `SetWindowRgn` 第三个参数虽然叫 redraw，但它只让系统重画"区域"这件事
         * 本身；WebView2 的合成层是 DirectComposition 挂在窗口上的，它不知道
         * 区域改了，于是新区域里没被重绘到的横条会留着上一帧 —— 表现就是
         * 宠物被切成一条一条。实测从"整块矩形"切到"按轮廓的 36 块"就会这样。
         *
         * RDW_ALLCHILDREN 是重点：WebView2 的渲染窗口是子窗口。
         */
        unsafe {
            RedrawWindow(
                hwnd as HWND,
                std::ptr::null(),
                std::ptr::null_mut(),
                RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW | RDW_ERASE,
            );
        }

        Ok(())
    }

    struct Search {
        found: HWND,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let shell_class = wide("SHELLDLL_DefView");
        let worker_class = wide("WorkerW");

        // 桌面图标挂在带 SHELLDLL_DefView 子窗口的那个窗口下，
        // 我们要找的是它的兄弟 WorkerW —— 壁纸层
        let shell = unsafe {
            FindWindowExW(hwnd, std::ptr::null_mut(), shell_class.as_ptr(), std::ptr::null())
        };
        if !shell.is_null() {
            let worker = unsafe {
                FindWindowExW(
                    std::ptr::null_mut(),
                    hwnd,
                    worker_class.as_ptr(),
                    std::ptr::null(),
                )
            };
            if !worker.is_null() {
                let search = unsafe { &mut *(lparam as *mut Search) };
                search.found = worker;
                return 0; // 找到即停止枚举
            }
        }
        1 // 继续
    }

    fn find_worker_w() -> Option<HWND> {
        let progman_class = wide("Progman");
        let progman = unsafe { FindWindowW(progman_class.as_ptr(), std::ptr::null()) };
        if !progman.is_null() {
            let mut result: usize = 0;
            unsafe {
                SendMessageTimeoutW(progman, SPAWN_WORKER_W, 0, 0, 0, 1000, &mut result);
            }
        }

        let mut search = Search {
            found: std::ptr::null_mut(),
        };
        unsafe {
            EnumWindows(Some(enum_proc), &mut search as *mut Search as LPARAM);
        }
        if search.found.is_null() {
            None
        } else {
            Some(search.found)
        }
    }

    pub fn apply(
        hwnd: isize,
        layer: WindowLayer,
        click_through: bool,
        interactive: bool,
    ) -> Result<(), String> {
        if hwnd == 0 {
            return Err("window handle is null".to_string());
        }
        let hwnd = hwnd as HWND;

        unsafe {
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let mut style = current;
            style |= WS_EX_TOOLWINDOW as isize;
            // 要输入就必须能激活，否则键盘事件根本进不来
            if interactive {
                style &= !(WS_EX_NOACTIVATE as isize);
            } else {
                style |= WS_EX_NOACTIVATE as isize;
            }
            if click_through {
                style |= (WS_EX_LAYERED | WS_EX_TRANSPARENT) as isize;
            } else {
                style &= !(WS_EX_TRANSPARENT as isize);
            }

            // 样式没变就别写。SetWindowLongPtr 会发 WM_STYLECHANGED，
            // WebView2 收到之后会重建合成目标 —— 表现就是卡片白闪一下。
            // 焦点每变一次就闪一次，用户看到的就是"闪来闪去"。
            if style != current {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
            }

            // 能输入的窗口要"能激活但不许窜到前面"：守卫在 apply_to 里挂
            match layer {
                WindowLayer::Desktop if !interactive => match find_worker_w() {
                    Some(worker) => {
                        reparent(hwnd, worker);
                    }
                    None => {
                        // 降级：不挂 WorkerW，但至少压到最底层
                        reparent(hwnd, std::ptr::null_mut());
                        sink(hwnd);
                    }
                },
                // 能输入的组件：留在顶层窗口这一层，压到最底。
                // 挂进 WorkerW 会变成桌面的子窗口，永远拿不到键盘焦点。
                WindowLayer::Desktop => {
                    reparent(hwnd, std::ptr::null_mut());
                    sink(hwnd);
                }
                /*
                 * 普通窗口：从 WorkerW 里摘出来、摘掉 topmost，剩下的交给系统。
                 *
                 * `HWND_NOTOPMOST` 会把窗口放在"所有非置顶窗口之上"—— 也就是
                 * 用户刚点了这一档，它当场浮到普通窗口的最前面，这正是预期：
                 * 他刚刚才把注意力放在这个组件上。之后它就是一个普通窗口，
                 * 谁激活谁在上面。
                 */
                WindowLayer::Normal => {
                    reparent(hwnd, std::ptr::null_mut());
                    SetWindowPos(
                        hwnd,
                        HWND_NOTOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                WindowLayer::Top => {
                    // 之前可能挂在 WorkerW 下，先脱离再置顶
                    reparent(hwnd, std::ptr::null_mut());
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
        }

        Ok(())
    }

    /// 只把窗口压到最底层，不碰样式、不碰父窗口。
    ///
    /// 失焦时用它而不是整个 `apply`：那条路会写扩展样式，每次都会让
    /// WebView2 重画一遍。只改 z 序既轻，也不会闪。
    pub fn sink(hwnd: HWND) {
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    /// 让窗口"永远待在底层"：拦下 `WM_WINDOWPOSCHANGING`，把任何"提到前面"的
    /// 请求改写成 `HWND_BOTTOM`。
    ///
    /// 为什么需要这个：可输入的组件必须能激活（不能带 `WS_EX_NOACTIVATE`），
    /// 而 Windows 激活一个窗口时会顺手把它提到 z 序最前 —— 点一下便签，
    /// 它就从桌面窜到浏览器上面；切走再沉回去。一进一出就是"闪来闪去"。
    /// 激活和 z 序本来就是两件事，这里只拦 z 序，键盘焦点照样给。
    ///
    /// 分两步是因为线程限制：子类化只能在窗口自己的线程装（`install_guard`），
    /// 但"要不要拦"必须能随时、同步地翻（`set_sink`）—— 否则切到"置顶"时，
    /// 守卫还没来得及摘，`HWND_TOPMOST` 就被改写成 `HWND_BOTTOM` 了。
    pub fn set_sink(hwnd: HWND, on: bool) {
        unsafe {
            let name = wide(SINK_PROP);
            if on {
                SetPropW(hwnd, name.as_ptr(), 1 as HANDLE);
            } else {
                RemovePropW(hwnd, name.as_ptr());
            }
        }
    }

    /// 装守卫。跨线程调用会静默失败（返回 0），必须回到窗口线程
    pub fn install_guard(hwnd: HWND) -> Result<(), String> {
        let ok = unsafe { SetWindowSubclass(hwnd, Some(bottom_proc), SUBCLASS_ID, 0) };
        if ok == 0 {
            Err("SetWindowSubclass returned 0 (happens when called off the window thread)".to_string())
        } else {
            Ok(())
        }
    }

    /// 读实际层级。三样东西各查一次：父窗口、`WS_EX_TOPMOST`、守卫属性。
    ///
    /// 判据顺序不能换：挂在 WorkerW 下的窗口一定没有 topmost 位，
    /// 但一个 `HWND_BOTTOM` 的窗口同时可能带着守卫属性 —— 先看父窗口，
    /// 再看待守卫，最后才轮到"普通"，否则会把贴桌面的报成沉底。
    pub fn probe(hwnd: isize) -> super::LayerProbe {
        if hwnd == 0 {
            return super::LayerProbe {
                actual: "unknown".to_string(),
                parented: false,
                topmost: false,
                sunk: false,
                found: false,
            };
        }
        unsafe {
            let target = hwnd as HWND;
            let parented = !GetParent(target).is_null();
            let style = GetWindowLongPtrW(target, GWL_EXSTYLE) as isize;
            let topmost = (style & WS_EX_TOPMOST as isize) != 0;
            let name = wide(SINK_PROP);
            let sunk = !GetPropW(target, name.as_ptr()).is_null();

            let actual = if parented {
                "workerw"
            } else if topmost {
                "topmost"
            } else if sunk {
                "bottom"
            } else {
                "normal"
            };

            super::LayerProbe {
                actual: actual.to_string(),
                parented,
                topmost,
                sunk,
                found: true,
            }
        }
    }

    const SUBCLASS_ID: usize = 0x1a77_7e11;

    /// 窗口属性名：非空表示"这个窗口要一直待在底层"
    const SINK_PROP: &str = "LatticeSinkToBottom";

    unsafe extern "system" fn bottom_proc(
        hwnd: HWND,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _id: usize,
        _data: usize,
    ) -> isize {
        unsafe {
            if msg == WM_WINDOWPOSCHANGING && lparam != 0 {
                let name = wide(SINK_PROP);
                if !GetPropW(hwnd, name.as_ptr()).is_null() {
                    let pos = lparam as *mut WINDOWPOS;
                    // 只拦"往上提"的请求，原地不动。写成 HWND_BOTTOM 也能挡住，
                    // 但那会让被点中的窗口沉到同类组件的最下面 —— 两个组件叠着的时候，
                    // 点上面那个，它反而钻到下面去，一样是"闪"。
                    if ((*pos).flags & SWP_NOZORDER) == 0 && (*pos).hwndInsertAfter != HWND_BOTTOM {
                        (*pos).flags |= SWP_NOZORDER;
                    }
                }
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
    }

    /// 父窗口没变就不重设。SetParent 即使"设成同一个"也会让窗口重画一次。
    unsafe fn reparent(hwnd: HWND, parent: HWND) {
        unsafe {
            if GetParent(hwnd) != parent {
                SetParent(hwnd, parent);
            }
        }
    }
}
