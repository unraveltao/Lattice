//! 桌面上的对齐参考线：两个 1px 的叠层窗口（Win32）
//!
//! 画布上的线是 DOM 画的（`Canvas.tsx` 里的 `.lattice-guide`）。桌面上没有
//! "画布"这一层：每个组件是一个独立窗口，谁也画不到自己窗口外面去。所以这条
//! 线只能由平台自己在 Win32 层画。
//!
//! # 线是局部的，不是贯穿屏幕的
//!
//! 一条从屏幕顶画到底的线会把整块桌面切成两半 —— 用户看到的第一个反应是
//! "这线太大"，而不是"对上了"。真正要说清的只有一件事："我这条边和它那条边
//! 在同一个坐标"。所以线以被拖的那扇窗口为中心、两端各伸出「半个窗口 + 48px」
//! （长度由
//! `runtime/align-guides.ts::guideLines` 算，画布和桌面共用一份规则）。
//!
//! 代价是窗口的位置和**尺寸**每帧都可能变：还是 `UpdateLayeredWindow` 一次调用
//! 的事（它同时给位置和大小），位图按"最长可能需要"建一张就够了。
//!
//! # 为什么不是 Tauri 的透明窗口
//!
//! 逐像素透明的 WebView2 窗口要求 DirectComposition，在软件渲染 / 某些显卡上
//! 直接建不出来（`HRESULT 0x8007139F`，见 desktop.rs 的模块注释）。而且为了一条
//! 1px 的线去开一个全屏 WebView2，失败时的症状是"屏幕上多了一个黑框"，
//! 比"没有线"严重得多。
//!
//! 这里只用 GDI：两个 `WS_EX_LAYERED | WS_EX_TRANSPARENT` 的窗口，一个 1px 宽、
//! 另一个 1px 高，内容用 `UpdateLayeredWindow` 逐像素给 alpha。建不出来 /
//! 画不出来最多是"没有参考线"，桌面照旧。
//!
//! # 为什么是两个窗口而不是一个全屏窗口
//!
//! `UpdateLayeredWindow` 每帧要交一张 32 位位图。全屏那张在 3456×1080 上是
//! 15 MB；两条 1px 的分别是 1080×4 和 3456×4 字节。而且位图只跟屏幕尺寸、颜色
//! 有关，拖动时只换位置和长度 —— 一帧的代价是两次 `UpdateLayeredWindow`。
//!
//! # 线程
//!
//! 窗口归一个专用线程所有，它的消息循环一边抽空队列一边等指令。
//! 原因是跨线程 `SetWindowPos` / `UpdateLayeredWindow` 会等窗口线程处理，而
//! 窗口线程如果不泵消息，两边就互相等死。所有窗口操作都在那个线程里做，
//! 外面只往通道里丢一条消息。
//!
//! 空闲时线程阻塞在 `recv()` 上，不轮询 —— 参考线只在拖动那几百毫秒存在。

use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Mutex, Once};
use std::time::Duration;

/// 参考线的粗细（物理像素）
const THICKNESS: i32 = 1;

/// 多久没收到新坐标就把线收掉。
///
/// 正常收线靠前端的 `Hide`（松手那一刻）。这条是兜底：宿主页崩了、拖动中窗口
/// 被关掉，都不会再有人发 `Hide`，而一条留在屏幕上的线没有任何办法能关掉它。
/// 前端拖动期间每秒有一发心跳，所以这个超时不会被"指针停住不动"误触发。
const IDLE_TIMEOUT: Duration = Duration::from_secs(4);

/// 一段参考线，全是绝对物理像素。
///
/// `at` 是它钉住的坐标（竖线是 x、横线是 y），`from` / `len` 是它自己那一截
/// 有多长 —— 线是局部的，不再铺满屏幕。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub at: i32,
    pub from: i32,
    pub len: i32,
}

impl Segment {
    /// 退化 / 非法的线段（长度为 0、坐标不是数）当作"没有线"
    pub fn sane(self) -> Option<Self> {
        if self.len <= 0 || self.at.unsigned_abs() > 100_000 || self.from.unsigned_abs() > 100_000 {
            return None;
        }
        Some(self)
    }
}

/// 叠层线程收到的指令
pub enum Message {
    /// 画（或移动）参考线，`None` 表示这个方向没有线
    Show {
        vertical: Option<Segment>,
        horizontal: Option<Segment>,
        color: [u8; 3],
    },
    Hide,
}

static START: Once = Once::new();
static CHANNEL: Mutex<Option<Sender<Message>>> = Mutex::new(None);

/// 显示（或移动）参考线。线会立刻出现在下一次叠层线程醒来时。
pub fn show(vertical: Option<Segment>, horizontal: Option<Segment>, color: [u8; 3]) {
    send(Message::Show {
        vertical: vertical.and_then(Segment::sane),
        horizontal: horizontal.and_then(Segment::sane),
        color,
    });
}

/// 收线
pub fn hide() {
    send(Message::Hide);
}

/// 某个窗口所在显示器的工作区（物理像素，`[x, y, w, h]`）。
///
/// 拖动时把"屏幕的左/中/右"也当候选线，是为了让"把卡片挪到屏幕正中"这种
/// 动作也有反馈 —— 画布那边候选的是画布边界，桌面这边就是工作区。
/// 用工作区而不是整个屏幕：贴着任务栏对齐没有意义。
#[cfg(windows)]
pub fn work_area(hwnd: isize) -> Option<[i32; 4]> {
    imp::work_area(hwnd)
}

/// 整块虚拟桌面（物理像素，`[x, y, w, h]`）。工作区读不到时的兜底
#[cfg(windows)]
pub fn screen_bounds() -> [i32; 4] {
    let screen = imp::virtual_screen();
    [
        screen.left,
        screen.top,
        screen.right - screen.left,
        screen.bottom - screen.top,
    ]
}

fn send(message: Message) {
    if let Some(sender) = channel_sender() {
        let _ = sender.send(message);
    }
}

fn channel_sender() -> Option<Sender<Message>> {
    START.call_once(|| match spawn() {
        Ok(sender) => {
            if let Ok(mut slot) = CHANNEL.lock() {
                *slot = Some(sender);
            }
        }
        Err(error) => eprintln!("[lattice] guide overlay unavailable: {error}"),
    });
    CHANNEL.lock().ok().and_then(|slot| slot.clone())
}

/// 起叠层线程，并等它把两个窗口建好再返回。
///
/// 第一次拖动会因此多花几毫秒（建窗口 + 两张 DIB，不涉及 WebView2）。
/// 值得等：不然第一帧的线会丢，而"拖动刚起手时对不齐"正是这个功能要解决的事。
fn spawn() -> Result<Sender<Message>, String> {
    let (sender, receiver) = mpsc::channel();
    let (ready, started) = mpsc::sync_channel::<Result<(), String>>(1);

    std::thread::Builder::new()
        .name("lattice-guides".to_string())
        .spawn(move || run_thread(receiver, ready))
        .map_err(|error| error.to_string())?;

    match started.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result.map(|()| sender),
        Err(_) => Err("the guide overlay thread did not start in time".to_string()),
    }
}

fn run_thread(receiver: Receiver<Message>, ready: SyncSender<Result<(), String>>) {
    #[cfg(windows)]
    {
        match unsafe { imp::Overlay::create() } {
            Ok(mut overlay) => {
                let _ = ready.send(Ok(()));
                overlay.run(receiver);
            }
            Err(error) => {
                let _ = ready.send(Err(error));
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = ready.send(Err("the guide overlay is only implemented on Windows".to_string()));
        let _ = receiver;
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr::null;
    use std::sync::mpsc::{Receiver, RecvTimeoutError};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{GetLastError, HINSTANCE, HWND, POINT, RECT, SIZE};
    use windows_sys::Win32::Graphics::Gdi::{
        AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, BI_RGB,
        CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC,
        GetMonitorInfoW, HDC, HGDIOBJ, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
        ReleaseDC, SelectObject,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetSystemMetrics, HWND_TOPMOST, MSG,
        PM_REMOVE, PeekMessageW, RegisterClassExW, SW_HIDE, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, SetWindowPos, ShowWindow, TranslateMessage, ULW_ALPHA,
        UpdateLayeredWindow, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT, WS_POPUP,
    };

    use super::{Message, Segment, IDLE_TIMEOUT, THICKNESS};
    use crate::guide_policy::line_alpha;

    const CLASS_NAME: &str = "LatticeGuideOverlay";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 整块虚拟桌面（物理像素）。参考线要跨屏连续，所以取的不是单块显示器
    pub fn virtual_screen() -> RECT {
        let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
        let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
        RECT {
            left: x,
            top: y,
            right: x + width,
            bottom: y + height,
        }
    }

    pub fn work_area(hwnd: isize) -> Option<[i32; 4]> {
        if hwnd == 0 {
            return None;
        }
        unsafe {
            let monitor = MonitorFromWindow(hwnd as HWND, MONITOR_DEFAULTTONEAREST);
            if monitor.is_null() {
                return None;
            }
            let mut info: MONITORINFO = zeroed();
            info.cbSize = size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return None;
            }
            let work = info.rcWork;
            Some([work.left, work.top, work.right - work.left, work.bottom - work.top])
        }
    }

    /// 一张画好就不再变的 32 位位图 + 它在内存里的像素指针
    struct Layer {
        hwnd: HWND,
        hdc: HDC,
        bitmap: HGDIOBJ,
        previous: HGDIOBJ,
        pixels: *mut u8,
    }

    impl Layer {
        fn create(hwnd: HWND, width: i32, height: i32) -> Result<Self, String> {
            if width <= 0 || height <= 0 {
                return Err(format!("refusing to create a {width}×{height} guide bitmap"));
            }
            unsafe {
                let screen = GetDC(std::ptr::null_mut());
                if screen.is_null() {
                    return Err("GetDC returned null".to_string());
                }
                let hdc = CreateCompatibleDC(screen);
                ReleaseDC(std::ptr::null_mut(), screen);
                if hdc.is_null() {
                    return Err("CreateCompatibleDC returned null".to_string());
                }

                let mut info: BITMAPINFO = zeroed();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    // 负数 = 自上而下。像素下标直接就是 y，省掉一次翻转
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                };

                let mut bits: *mut c_void = std::ptr::null_mut();
                let bitmap = CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
                if bitmap.is_null() || bits.is_null() {
                    DeleteDC(hdc);
                    return Err(format!("CreateDIBSection failed ({})", GetLastError()));
                }
                let previous = SelectObject(hdc, bitmap as HGDIOBJ);

                Ok(Self {
                    hwnd,
                    hdc,
                    bitmap: bitmap as HGDIOBJ,
                    previous,
                    pixels: bits as *mut u8,
                })
            }
        }

        /// 把一个像素写成预乘 alpha 的 BGRA
        fn put(&mut self, index: usize, color: [u8; 3], alpha: f64) {
            let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
            // 预乘：颜色先乘 alpha。不预乘的话 DWM 会把颜色当"已经很亮"，
            // 淡淡的一段会变成一层雾，线看起来比设定粗一圈
            unsafe {
                let at = self.pixels.add(index * 4);
                *at = (color[2] as u32 * a / 255) as u8;
                *at.add(1) = (color[1] as u32 * a / 255) as u8;
                *at.add(2) = (color[0] as u32 * a / 255) as u8;
                *at.add(3) = a as u8;
            }
        }
    }

    impl Drop for Layer {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.hdc, self.previous);
                DeleteObject(self.bitmap);
                DeleteDC(self.hdc);
            }
        }
    }

    pub struct Overlay {
        vertical: Layer,
        horizontal: Layer,
        screen: RECT,
        color: [u8; 3],
        painted: bool,
    }

    impl Overlay {
        pub unsafe fn create() -> Result<Self, String> {
            let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
            let class = wide(CLASS_NAME);
            let mut definition: WNDCLASSEXW = unsafe { zeroed() };
            definition.cbSize = size_of::<WNDCLASSEXW>() as u32;
            definition.lpfnWndProc = Some(DefWindowProcW);
            definition.hInstance = instance;
            definition.lpszClassName = class.as_ptr();

            let atom = unsafe { RegisterClassExW(&definition) };
            if atom == 0 {
                return Err(format!("RegisterClassExW failed ({})", unsafe { GetLastError() }));
            }

            let screen = virtual_screen();
            let width = screen.right - screen.left;
            let height = screen.bottom - screen.top;

            let vertical = unsafe { create_window(&class, instance) }?;
            let horizontal = match unsafe { create_window(&class, instance) } {
                Ok(hwnd) => hwnd,
                Err(error) => {
                    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(vertical) };
                    return Err(error);
                }
            };

            let vertical = Layer::create(vertical, THICKNESS, height)?;
            let horizontal = Layer::create(horizontal, width, THICKNESS)?;

            Ok(Self {
                vertical,
                horizontal,
                screen,
                color: [0x5d, 0xca, 0xa5],
                painted: false,
            })
        }

        /// 消息循环。可见时每 16ms 泵一次消息并检查超时；不可见时阻塞在通道上
        pub fn run(&mut self, receiver: Receiver<Message>) {
            let mut last = Instant::now();
            let mut visible = false;
            loop {
                if visible {
                    if last.elapsed() > IDLE_TIMEOUT {
                        self.hide();
                        visible = false;
                        continue;
                    }
                    unsafe { pump() };
                    match receiver.recv_timeout(Duration::from_millis(16)) {
                        Ok(message) => {
                            last = Instant::now();
                            visible = self.apply(message);
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                } else {
                    match receiver.recv() {
                        Ok(message) => {
                            last = Instant::now();
                            visible = self.apply(message);
                        }
                        Err(_) => break,
                    }
                }
            }
            self.hide();
        }

        fn apply(&mut self, message: Message) -> bool {
            match message {
                Message::Hide => {
                    self.hide();
                    false
                }
                Message::Show {
                    vertical,
                    horizontal,
                    color,
                } => {
                    if !self.painted || color != self.color {
                        self.color = color;
                        self.paint();
                    }
                    self.present(vertical, horizontal);
                    vertical.is_some() || horizontal.is_some()
                }
            }
        }

        /// 按像素规则填两张位图。只有颜色变了才需要重来一次。
        ///
        /// 位图按"最长可能需要"（整块虚拟桌面）建一张，段落比它短时只取前面的
        /// 那一段 —— 所以长度变了不用重画，跟着 `UpdateLayeredWindow` 的 size 走。
        fn paint(&mut self) {
            let height = (self.screen.bottom - self.screen.top) as usize;
            let width = (self.screen.right - self.screen.left) as usize;
            let color = self.color;

            for index in 0..height {
                let alpha = line_alpha(index);
                self.vertical.put(index, color, alpha);
            }
            for index in 0..width {
                let alpha = line_alpha(index);
                self.horizontal.put(index, color, alpha);
            }
            self.painted = true;
        }

        fn present(&self, vertical: Option<Segment>, horizontal: Option<Segment>) {
            let screen = self.screen;
            let height = (screen.bottom - screen.top).max(1);
            let width = (screen.right - screen.left).max(1);
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };

            match vertical {
                Some(segment) => {
                    // 位图只有 `height` 高，超过它就取到缓冲区外面去了
                    let len = segment.len.clamp(1, height);
                    let destination = POINT {
                        x: segment.at,
                        y: segment.from,
                    };
                    let size = SIZE {
                        cx: THICKNESS,
                        cy: len,
                    };
                    let source = POINT { x: 0, y: 0 };
                    unsafe {
                        let _ = UpdateLayeredWindow(
                            self.vertical.hwnd,
                            std::ptr::null_mut(),
                            &destination,
                            &size,
                            self.vertical.hdc,
                            &source,
                            0,
                            &blend,
                            ULW_ALPHA,
                        );
                        // 置顶的组件也在拖：每帧把线提到置顶组的最上面，
                        // 否则线会被正在拖的那扇窗口盖住 —— 而那扇窗口通常
                        // 正好压在线上。不激活、不改位置和尺寸
                        let _ = SetWindowPos(
                            self.vertical.hwnd,
                            HWND_TOPMOST,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                        );
                    }
                }
                None => {
                    unsafe {
                        let _ = ShowWindow(self.vertical.hwnd, SW_HIDE);
                    }
                }
            }

            match horizontal {
                Some(segment) => {
                    let len = segment.len.clamp(1, width);
                    let destination = POINT {
                        x: segment.from,
                        y: segment.at,
                    };
                    let size = SIZE {
                        cx: len,
                        cy: THICKNESS,
                    };
                    let source = POINT { x: 0, y: 0 };
                    unsafe {
                        let _ = UpdateLayeredWindow(
                            self.horizontal.hwnd,
                            std::ptr::null_mut(),
                            &destination,
                            &size,
                            self.horizontal.hdc,
                            &source,
                            0,
                            &blend,
                            ULW_ALPHA,
                        );
                        let _ = SetWindowPos(
                            self.horizontal.hwnd,
                            HWND_TOPMOST,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                        );
                    }
                }
                None => {
                    unsafe {
                        let _ = ShowWindow(self.horizontal.hwnd, SW_HIDE);
                    }
                }
            }
        }

        fn hide(&self) {
            unsafe {
                let _ = ShowWindow(self.vertical.hwnd, SW_HIDE);
                let _ = ShowWindow(self.horizontal.hwnd, SW_HIDE);
            }
        }
    }

    unsafe fn create_window(class: &[u16], instance: HINSTANCE) -> Result<HWND, String> {
        let hwnd = unsafe {
            CreateWindowExW(
                (WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) as u32,
                class.as_ptr(),
                null(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                null(),
            )
        };
        if hwnd.is_null() {
            Err(format!("CreateWindowExW failed ({})", unsafe { GetLastError() }))
        } else {
            Ok(hwnd)
        }
    }

    /// 把窗口线程的消息队列抽干。
    ///
    /// 这两个窗口不处理任何输入（点透 + 不可激活），但系统广播（显示设置变化、
    /// 主题切换）还是会投进来。不泵的话，别的进程 `SendMessage` 到这些广播上
    /// 会一直等。
    unsafe fn pump() {
        let mut message: MSG = unsafe { zeroed() };
        while unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
}
