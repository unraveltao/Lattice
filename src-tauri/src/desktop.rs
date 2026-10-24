//! 桌面层控制（Windows）
//!
//! 小组件"贴桌面"和"置顶"是两套完全不同的窗口行为：
//!
//! - `desktop`：把窗口挂到 WorkerW 下（Wallpaper Engine 那套做法），
//!   窗口就沉到桌面图标之上、普通窗口之下，切窗口不会被挡住。
//!   拿不到 WorkerW 时降级为 `HWND_BOTTOM`，至少不会浮在最上层。
//! - `top`：还原父子关系后设为 `HWND_TOPMOST`。
//!
//! 两种层级都会加 `WS_EX_TOOLWINDOW`（不进任务栏、不进 Alt+Tab）。
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
//! # 关于圆角
//!
//! 组件窗口是**不透明**的，圆角靠 `SetWindowRgn` 把窗口本身裁成圆角矩形，
//! 而不是靠 `border-radius` + 透明窗口。原因是逐像素透明要求
//! WebView2 走 DirectComposition 合成，在混合显卡 / 虚拟显示适配器环境下
//! 直接建不出 webview（`HRESULT(0x8007139F)`）；就算建出来了，
//! 一旦软件渲染，透明背景也会退回成白底。
//!
//! 裁剪方案没有这些前提：窗口照常渲染，形状由系统负责，
//! 代价是圆角边缘没有抗锯齿。对一个贴桌面的小组件来说这笔交易很划算。

use serde::{Deserialize, Serialize};

/// 组件窗口的圆角半径（逻辑像素），与画布里 `.lattice-widget` 的 12px 对齐
pub const CORNER_RADIUS: f64 = 12.0;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowLayer {
    Desktop,
    Top,
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

            // 轮廓归组件管的时候一根手指都别碰区域：`clip_rounded` 会把
            // 宠物身上那块非矩形区域换成圆角矩形，动物当场变成一张卡片。
            // 空区域留到窗口真正建完之后由 `runner::create` 补（那里才知道
            // 实例是 shape: region），这里只管"不覆盖"。
            if shape == WindowShape::Rect {
                imp::clip_rounded(hwnd, size.width, size.height, CORNER_RADIUS * scale)?;
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
    use windows_sys::Win32::Foundation::{HANDLE, HWND, LPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateEllipticRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject,
        RedrawWindow, SetWindowRgn, RGN_OR, RDW_ALLCHILDREN, RDW_ERASE, RDW_INVALIDATE,
        RDW_UPDATENOW,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GWL_EXSTYLE, GetParent, GetPropW,
        GetWindowLongPtrW, HWND_BOTTOM, HWND_TOPMOST, RemovePropW, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOZORDER, SendMessageTimeoutW, SetParent, SetPropW, SetWindowLongPtrW,
        SetWindowPos, WINDOWPOS, WM_WINDOWPOSCHANGING, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
    };

    /// Progman 收到这条未公开消息后会派生出承载壁纸的 WorkerW
    const SPAWN_WORKER_W: u32 = 0x052C;

    /// 把窗口裁成圆角矩形。区域坐标是物理像素，宽高要 +1：
    /// GDI 的区域是右开区间，少 1px 会吃掉最后一行/列。
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
                0,
                0,
                width as i32 + 1,
                height as i32 + 1,
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

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
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
