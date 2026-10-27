//! 桌面浮钮：28×28 的 GDI 分层窗。
//!
//! **不是 WebView、不是组件、前端一行都不碰**（0027 §4）。一个常驻 WebView2 空载
//! 几十 MB，而 `ROADMAP` 风险表第一条就是"WebView 数量是内存杀手"；这颗钮要
//! 在屏幕上待一整天。
//!
//! # 窗口样式四件套，缺一件这个需求就不成立
//!
//! - `WS_EX_NOACTIVATE`：**点了不激活**。前台窗口从头到尾还是那个要插字的窗口 ——
//!   这是整个需求的支点（手工验收第 6 步就是在验它）。
//! - `WS_EX_TOOLWINDOW`：不进任务栏、不进 Alt+Tab。
//! - `WS_EX_TOPMOST`：永远浮在上面。
//! - `WS_EX_LAYERED`：圆角、半透明靠 `UpdateLayeredWindow` 贴一张带 alpha 的位图。
//!   **不用 `SetWindowRgn`** —— 那个要补 `RedrawWindow`，是 `PITFALLS` 里躺着的一条。
//!
//! 注意它**不带** `WS_EX_TRANSPARENT`：那是参考线（`guides_overlay.rs`）要的"点透"，
//! 而这颗钮必须能点。抄错这一个样式，症状是"钮看得见、点上去没反应"（0027 §5）。
//!
//! # 位置：相对工作区右下角的偏移
//!
//! 记绝对坐标的话，换显示器 / 改分辨率 / 拔外接屏之后它就在屏幕外了，而用户
//! 没有任何办法把它找回来。记偏移不会，但读回来仍然要**钳进当前工作区**
//! （`dictation_policy::button_origin`）—— 偏移是相对上一次那块屏记的。
//!
//! # 拖动和点击必须分开
//!
//! `WM_LBUTTONDOWN` 起拖、`WM_LBUTTONUP` 判"松手位移 < 4px"
//! （`dictation_policy::is_click`）。不分的话，"想拖它"会触发一次听写，而用户
//! 根本没打算说话。
//!
//! **不用 `WM_NCHITTEST` 返回 `HTCAPTION`** —— 那会走系统拖动循环，而系统拖动
//! 要求激活（`WS_EX_NOACTIVATE` 当场破功）。
//!
//! # 四张图，不是四次绘制
//!
//! `assets/dictation/*.png`（56×56，逻辑边长 28 的 2 倍图）编进二进制，启动时
//! 解成预乘 BGRA 的位图像素；状态切换 = 换一张贴上去。`listening` 用两张相位图
//! 每 400ms 轮换 —— 这就是"正在听"的全部动画。
//!
//! # 线程
//!
//! 窗口归一个专用线程所有，消息循环一边泵消息一边等指令。跨线程 `SetWindowPos`
//! 会等窗口线程处理，而窗口线程不泵消息两边就互相等死 —— 和 `guides_overlay.rs`
//! 同一个理由。所有窗口操作都在那个线程里做，外面只往通道里丢一条消息。

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::AppHandle;

use crate::dictation_policy as policy;

/// 逻辑边长（物理像素，窗口尺寸）
const SIZE: i32 = policy::BUTTON_SIZE;

/// 位图边长。56 = 28 的 2 倍，`UpdateLayeredWindow` 贴的时候缩一半
const BITMAP: i32 = 56;

/// "正在听"两张相位图的轮换周期
const PHASE_MS: u32 = 400;

/// 出错态显示多久（之后回到 idle，别让一颗红钮永远红着）
const ERROR_MS: u32 = 2000;

const TIMER_PHASE: usize = 1;
const TIMER_ERROR: usize = 2;

/// 四张图（`listening` 两张相位）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Look {
    Idle,
    Hover,
    Listening,
    ListeningB,
    Error,
}

impl Look {
    fn bytes(self) -> &'static [u8] {
        match self {
            Look::Idle => include_bytes!("../assets/dictation/idle.png"),
            Look::Hover => include_bytes!("../assets/dictation/hover.png"),
            Look::Listening => include_bytes!("../assets/dictation/listening.png"),
            Look::ListeningB => include_bytes!("../assets/dictation/listening-b.png"),
            Look::Error => include_bytes!("../assets/dictation/error.png"),
        }
    }

    fn index(self) -> usize {
        match self {
            Look::Idle => 0,
            Look::Hover => 1,
            Look::Listening => 2,
            Look::ListeningB => 3,
            Look::Error => 4,
        }
    }
}

/// 浮钮线程收到的指令。窗口操作一律在**那个线程**里做
pub enum Message {
    Show { dx: i32, dy: i32 },
    Hide,
    Move { dx: i32, dy: i32 },
    Listening(bool),
    Error,
}

static CHANNEL: Mutex<Option<Sender<Message>>> = Mutex::new(None);

/// 起线程（只起一次），然后把指令丢进去
pub fn apply(app: &AppHandle, settings: &policy::Settings) {
    if let Some(sender) = sender(app) {
        if settings.enabled && settings.show {
            let _ = sender.send(Message::Show {
                dx: settings.dx,
                dy: settings.dy,
            });
        } else {
            let _ = sender.send(Message::Hide);
        }
    }
}

/// 听写开始 / 结束。**状态只有一份**（在 `dictation.rs`），这里只是画出来
pub fn set_listening(listening: bool) {
    if let Some(sender) = sender_quiet() {
        let _ = sender.send(Message::Listening(listening));
    }
}

/// 出错了：红一颗，两秒后回 idle
pub fn flash_error() {
    if let Some(sender) = sender_quiet() {
        let _ = sender.send(Message::Error);
    }
}

fn sender(app: &AppHandle) -> Option<Sender<Message>> {
    let mut slot = CHANNEL.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(sender) = slot.as_ref() {
        return Some(sender.clone());
    }
    match spawn(app.clone()) {
        Ok(sender) => {
            *slot = Some(sender.clone());
            Some(sender)
        }
        Err(error) => {
            crate::dictation::record_error(format!("the dictation button is unavailable: {error}"));
            None
        }
    }
}

fn sender_quiet() -> Option<Sender<Message>> {
    CHANNEL
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

/// 起线程，并等它把窗口建好再返回（第一次点开关时不能"看起来没反应"）
fn spawn(app: AppHandle) -> Result<Sender<Message>, String> {
    let (sender, receiver) = mpsc::channel();
    let (ready, started) = mpsc::sync_channel::<Result<(), String>>(1);

    std::thread::Builder::new()
        .name("lattice-dictation-button".to_string())
        .spawn(move || run_thread(app, receiver, ready))
        .map_err(|error| error.to_string())?;

    match started.recv_timeout(Duration::from_secs(3)) {
        Ok(result) => result.map(|()| sender),
        Err(_) => Err("the dictation button thread did not start in time".to_string()),
    }
}

/// 热键 → 插件要的 `Shortcut`。
///
/// 自己拼而不是把用户写的字符串丢给插件的解析器：`Code` 那套是**物理键位**
/// （`KeyA` / `Digit0` / `Space`），我们存的是显示用的名字，两边对不上时症状是
/// "设了热键但按了没反应"，而菜单里还写着它是好的。
pub fn shortcut_of(hotkey: policy::Hotkey) -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    let mut modifiers = Modifiers::empty();
    if hotkey.ctrl {
        modifiers |= Modifiers::CONTROL;
    }
    if hotkey.alt {
        modifiers |= Modifiers::ALT;
    }
    if hotkey.shift {
        modifiers |= Modifiers::SHIFT;
    }
    if hotkey.win {
        modifiers |= Modifiers::SUPER;
    }
    let code = match hotkey.key {
        policy::HotkeyKey::Space => Code::Space,
        policy::HotkeyKey::F(number) => match number {
            1 => Code::F1,
            2 => Code::F2,
            3 => Code::F3,
            4 => Code::F4,
            5 => Code::F5,
            6 => Code::F6,
            7 => Code::F7,
            8 => Code::F8,
            9 => Code::F9,
            10 => Code::F10,
            11 => Code::F11,
            12 => Code::F12,
            13 => Code::F13,
            14 => Code::F14,
            15 => Code::F15,
            16 => Code::F16,
            17 => Code::F17,
            18 => Code::F18,
            19 => Code::F19,
            20 => Code::F20,
            21 => Code::F21,
            22 => Code::F22,
            23 => Code::F23,
            _ => Code::F24,
        },
        policy::HotkeyKey::Letter(letter) => match letter.to_ascii_uppercase() {
            'A' => Code::KeyA,
            'B' => Code::KeyB,
            'C' => Code::KeyC,
            'D' => Code::KeyD,
            'E' => Code::KeyE,
            'F' => Code::KeyF,
            'G' => Code::KeyG,
            'H' => Code::KeyH,
            'I' => Code::KeyI,
            'J' => Code::KeyJ,
            'K' => Code::KeyK,
            'L' => Code::KeyL,
            'M' => Code::KeyM,
            'N' => Code::KeyN,
            'O' => Code::KeyO,
            'P' => Code::KeyP,
            'Q' => Code::KeyQ,
            'R' => Code::KeyR,
            'S' => Code::KeyS,
            'T' => Code::KeyT,
            'U' => Code::KeyU,
            'V' => Code::KeyV,
            'W' => Code::KeyW,
            'X' => Code::KeyX,
            'Y' => Code::KeyY,
            _ => Code::KeyZ,
        },
        policy::HotkeyKey::Digit(digit) => match digit {
            0 => Code::Digit0,
            1 => Code::Digit1,
            2 => Code::Digit2,
            3 => Code::Digit3,
            4 => Code::Digit4,
            5 => Code::Digit5,
            6 => Code::Digit6,
            7 => Code::Digit7,
            8 => Code::Digit8,
            _ => Code::Digit9,
        },
    };
    Shortcut::new(
        if modifiers.is_empty() {
            None
        } else {
            Some(modifiers)
        },
        code,
    )
}

fn run_thread(
    app: AppHandle,
    receiver: Receiver<Message>,
    ready: mpsc::SyncSender<Result<(), String>>,
) {
    #[cfg(windows)]
    {
        if let Err(error) = unsafe { imp::run(app, receiver, ready) } {
            crate::dictation::record_error(format!("the dictation button thread stopped: {error}"));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = ready.send(Err(
            "the dictation button is only implemented on Windows".to_string()
        ));
        let _ = (app, receiver);
    }
}

#[cfg(windows)]
mod imp {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
    use std::time::Duration;

    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{GetLastError, HWND, POINT, RECT, SIZE as PT};
    use windows_sys::Win32::Graphics::Gdi::{
        AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, BI_RGB,
        CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HDC,
        HGDIOBJ, ReleaseDC, SelectObject,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetCapture, ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetWindowRect,
        HWND_TOPMOST, KillTimer, MSG, PM_REMOVE, PeekMessageW, RegisterClassExW, SW_HIDE,
        SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_SHOWWINDOW, ShowWindow, TranslateMessage,
        ULW_ALPHA, UpdateLayeredWindow, WNDCLASSEXW, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
        WM_TIMER, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
        SetTimer, SetWindowPos,
    };

    use super::{Look, Message, BITMAP, ERROR_MS, PHASE_MS, SIZE, TIMER_ERROR, TIMER_PHASE};
    use crate::dictation_policy as policy;

    const CLASS_NAME: &str = "LatticeDictationButton";
    /// `windows-sys` 0.61 没导出这一条（0x02A3），自己写 —— 数值是 Win32 的公开 ABI。
    /// 少了它，鼠标移出去之后钮会一直是悬停色
    const WM_MOUSELEAVE: u32 = 0x02A3;
    /// 四张图在数组里的下标
    const ART_COUNT: usize = 5;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 一张 32 位 DIB + 它的像素指针。状态切换 = 把新像素抄进去再贴一次
    pub struct Layer {
        hdc: HDC,
        bitmap: HGDIOBJ,
        previous: HGDIOBJ,
        pixels: *mut u8,
    }

    impl Layer {
        fn create(width: i32, height: i32) -> Result<Self, String> {
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
                    // 负数 = 自上而下，像素下标直接就是 y
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
                let bitmap = CreateDIBSection(
                    hdc,
                    &info,
                    DIB_RGB_COLORS,
                    &mut bits,
                    std::ptr::null_mut(),
                    0,
                );
                if bitmap.is_null() || bits.is_null() {
                    DeleteDC(hdc);
                    return Err(format!("CreateDIBSection failed ({})", GetLastError()));
                }
                let previous = SelectObject(hdc, bitmap as HGDIOBJ);
                Ok(Self {
                    hdc,
                    bitmap: bitmap as HGDIOBJ,
                    previous,
                    pixels: bits as *mut u8,
                })
            }
        }

        /// 整张抄进去（预乘 alpha 已经在解码那一步做过了）
        fn upload(&self, pixels: &[u8]) {
            let bytes = (BITMAP as usize * BITMAP as usize * 4).min(pixels.len());
            unsafe {
                std::ptr::copy_nonoverlapping(pixels.as_ptr(), self.pixels, bytes);
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

    /// 一张图：预乘过的 BGRA
    struct Art {
        pixels: Vec<u8>,
    }

    impl Art {
        fn load(look: Look) -> Result<Self, String> {
            let decoder = png::Decoder::new(std::io::Cursor::new(look.bytes()));
            let mut reader = decoder
                .read_info()
                .map_err(|error| format!("{look:?}.png is not a PNG: {error}"))?;
            let mut buffer = vec![0; reader.output_buffer_size()];
            let info = reader
                .next_frame(&mut buffer)
                .map_err(|error| format!("{look:?}.png could not be decoded: {error}"))?;
            if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
                return Err(format!(
                    "{look:?}.png must be 8-bit RGBA (it is {:?} {:?})",
                    info.color_type, info.bit_depth
                ));
            }
            if info.width as i32 != BITMAP || info.height as i32 != BITMAP {
                return Err(format!(
                    "{look:?}.png must be {BITMAP}×{BITMAP} (it is {}×{})",
                    info.width, info.height
                ));
            }
            // RGBA → 预乘 alpha 的 BGRA。不预乘的话 DWM 会把半透明边当"已经很亮"，
            // 圆角外面会有一圈灰雾
            let mut pixels = Vec::with_capacity(buffer.len());
            for pixel in buffer.chunks_exact(4) {
                let a = pixel[3] as u32;
                pixels.push((pixel[2] as u32 * a / 255) as u8);
                pixels.push((pixel[1] as u32 * a / 255) as u8);
                pixels.push((pixel[0] as u32 * a / 255) as u8);
                pixels.push(a as u8);
            }
            Ok(Self { pixels })
        }
    }

    /// 线程本地的状态。窗口过程也要用它，所以走 `thread_local` —— 不用
    /// `SetWindowLongPtrW` 存一个裸指针，少一次 `unsafe` 和一次悬垂引用的机会。
    struct Ctx {
        app: AppHandle,
        hwnd: isize,
        layer: Layer,
        arts: [Art; ART_COUNT],
        look: Look,
        phase_b: bool,
        listening: bool,
        /// 按下时的光标位置
        pressed_at: Option<(i32, i32)>,
        dragging: bool,
    }

    thread_local! {
        static CTX: RefCell<Option<Ctx>> = const { RefCell::new(None) };
    }

    pub unsafe fn run(
        app: AppHandle,
        receiver: Receiver<Message>,
        ready: SyncSender<Result<(), String>>,
    ) -> Result<(), String> {
        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        let class = wide(CLASS_NAME);
        let mut definition: WNDCLASSEXW = unsafe { zeroed() };
        definition.cbSize = size_of::<WNDCLASSEXW>() as u32;
        definition.lpfnWndProc = Some(window_proc);
        definition.hInstance = instance;
        definition.lpszClassName = class.as_ptr();

        let atom = unsafe { RegisterClassExW(&definition) };
        if atom == 0 {
            let error = format!("RegisterClassExW failed ({})", unsafe { GetLastError() });
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }

        // 样式：分层 + 不可激活 + 工具窗 + 置顶。**没有** WS_EX_TRANSPARENT
        let hwnd = unsafe {
            CreateWindowExW(
                (WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as u32,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                0,
                0,
                SIZE,
                SIZE,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        if hwnd.is_null() {
            let error = format!("CreateWindowExW failed ({})", unsafe { GetLastError() });
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }

        // 四张图先解出来：解不出来就别建窗口了，给用户一颗点不动的钮更糟
        let arts = match (
            Art::load(Look::Idle),
            Art::load(Look::Hover),
            Art::load(Look::Listening),
            Art::load(Look::ListeningB),
            Art::load(Look::Error),
        ) {
            (Ok(idle), Ok(hover), Ok(listening), Ok(listening_b), Ok(error)) => {
                [idle, hover, listening, listening_b, error]
            }
            (Err(error), ..) | (_, Err(error), ..) | (_, _, Err(error), ..) | (_, _, _, Err(error), _) | (_, _, _, _, Err(error)) => {
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
        };

        let layer = match Layer::create(BITMAP, BITMAP) {
            Ok(layer) => layer,
            Err(error) => {
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
        };
        // 先贴 idle：窗口还没 Show，但位图得先有一张
        layer.upload(&arts[Look::Idle.index()].pixels);

        CTX.with(|slot| {
            *slot.borrow_mut() = Some(Ctx {
                app,
                hwnd: hwnd as isize,
                layer,
                arts,
                look: Look::Idle,
                phase_b: false,
                listening: false,
                pressed_at: None,
                dragging: false,
            });
        });
        let _ = ready.send(Ok(()));

        // 消息循环：16ms 一跳（拖动要跟手）。窗口藏起来时也照样泵消息 ——
        // 这颗钮一旦建出来就一直在，藏起来只是 ShowWindow(SW_HIDE)
        loop {
            unsafe { pump() };
            match receiver.recv_timeout(Duration::from_millis(16)) {
                Ok(message) => {
                    CTX.with(|slot| {
                        if let Some(ctx) = slot.borrow_mut().as_mut() {
                            apply(ctx, message);
                        }
                    });
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
    }

    fn apply(ctx: &mut Ctx, message: Message) {
        match message {
            Message::Show { dx, dy } => {
                let work = work_area(ctx.hwnd);
                let (x, y) = policy::button_origin(dx, dy, work, SIZE);
                unsafe {
                    SetWindowPos(
                        ctx.hwnd as HWND,
                        HWND_TOPMOST,
                        x,
                        y,
                        SIZE,
                        SIZE,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                    ShowWindow(ctx.hwnd as HWND, SW_SHOWNOACTIVATE);
                }
                set_look(ctx, Look::Idle);
                present(ctx, x, y);
            }
            Message::Hide => {
                unsafe {
                    ShowWindow(ctx.hwnd as HWND, SW_HIDE);
                }
            }
            Message::Move { dx, dy } => {
                let work = work_area(ctx.hwnd);
                let (x, y) = policy::button_origin(dx, dy, work, SIZE);
                unsafe {
                    SetWindowPos(
                        ctx.hwnd as HWND,
                        HWND_TOPMOST,
                        x,
                        y,
                        SIZE,
                        SIZE,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                }
                present(ctx, x, y);
            }
            Message::Listening(listening) => {
                ctx.listening = listening;
                if listening {
                    set_look(ctx, Look::Listening);
                    unsafe {
                        SetTimer(ctx.hwnd as HWND, TIMER_PHASE, PHASE_MS, None);
                    }
                } else {
                    unsafe {
                        KillTimer(ctx.hwnd as HWND, TIMER_PHASE);
                    }
                    set_look(ctx, Look::Idle);
                }
            }
            Message::Error => {
                set_look(ctx, Look::Error);
                unsafe {
                    SetTimer(ctx.hwnd as HWND, TIMER_ERROR, ERROR_MS, None);
                }
            }
        }
    }

    /// 换一张图并立刻贴上去（位置不变）
    fn set_look(ctx: &mut Ctx, look: Look) {
        if ctx.look == look {
            return;
        }
        ctx.layer.upload(&ctx.arts[look.index()].pixels);
        ctx.look = look;
        let mut rect: RECT = unsafe { zeroed() };
        unsafe {
            let _ = GetWindowRect(ctx.hwnd as HWND, &mut rect);
        }
        present(ctx, rect.left, rect.top);
    }

    /// `UpdateLayeredWindow` 一次给位置、尺寸和像素
    fn present(ctx: &Ctx, x: i32, y: i32) {
        let destination = POINT { x, y };
        let size = PT { cx: SIZE, cy: SIZE };
        let source = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        unsafe {
            let _ = UpdateLayeredWindow(
                ctx.hwnd as HWND,
                std::ptr::null_mut(),
                &destination,
                &size,
                ctx.layer.hdc,
                &source,
                0,
                &blend,
                ULW_ALPHA,
            );
        }
    }

    fn work_area(hwnd: isize) -> [i32; 4] {
        match crate::guides_overlay::work_area(hwnd) {
            Some(work) => work,
            None => crate::guides_overlay::screen_bounds(),
        }
    }

    extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: usize, lparam: isize) -> isize {
        CTX.with(|slot| {
            let mut borrowed = slot.borrow_mut();
            let Some(ctx) = borrowed.as_mut() else {
                return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
            };
            match message {
                WM_LBUTTONDOWN => {
                    let mut point = POINT { x: 0, y: 0 };
                    unsafe {
                        let _ = GetCursorPos(&mut point);
                        SetCapture(hwnd);
                    }
                    ctx.pressed_at = Some((point.x, point.y));
                    ctx.dragging = false;
                    0
                }
                WM_MOUSEMOVE => {
                    let mut point = POINT { x: 0, y: 0 };
                    unsafe {
                        let _ = GetCursorPos(&mut point);
                    }
                    match ctx.pressed_at {
                        Some((start_x, start_y)) => {
                            let travel_x = point.x - start_x;
                            let travel_y = point.y - start_y;
                            // 4px 之内还算"按着没动"：一毫米的手抖不该把钮挪走
                            if travel_x.abs() > 3 || travel_y.abs() > 3 {
                                ctx.dragging = true;
                            }
                            if ctx.dragging {
                                // 跟手：窗口左上角 = 光标 - 半颗钮
                                let x = point.x - SIZE / 2;
                                let y = point.y - SIZE / 2;
                                unsafe {
                                    SetWindowPos(
                                        hwnd,
                                        HWND_TOPMOST,
                                        x,
                                        y,
                                        SIZE,
                                        SIZE,
                                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                                    );
                                }
                                present(ctx, x, y);
                            }
                        }
                        None => {
                            // 悬停高亮。`TrackMouseEvent` 是为了拿到 WM_MOUSELEAVE
                            let mut track: TRACKMOUSEEVENT = unsafe { zeroed() };
                            track.cbSize = size_of::<TRACKMOUSEEVENT>() as u32;
                            track.dwFlags = TME_LEAVE;
                            track.hwndTrack = hwnd;
                            unsafe {
                                let _ = TrackMouseEvent(&mut track);
                            }
                            if !ctx.listening {
                                set_look(ctx, Look::Hover);
                            }
                        }
                    }
                    0
                }
                WM_LBUTTONUP => {
                    unsafe {
                        if GetCapture() == hwnd {
                            ReleaseCapture();
                        }
                    }
                    let mut point = POINT { x: 0, y: 0 };
                    unsafe {
                        let _ = GetCursorPos(&mut point);
                    }
                    let pressed = ctx.pressed_at.take();
                    let dragged = ctx.dragging;
                    ctx.dragging = false;

                    if let Some((start_x, start_y)) = pressed {
                        if !dragged && policy::is_click(point.x - start_x, point.y - start_y) {
                            // 点击 = 开/停一次听写。浮钮永远不主动要前台
                            crate::dictation::toggle(&ctx.app);
                        } else {
                            // 拖动：存相对偏移，下次启动还在这个位置
                            let mut rect: RECT = unsafe { zeroed() };
                            unsafe {
                                let _ = GetWindowRect(hwnd, &mut rect);
                            }
                            let work = work_area(ctx.hwnd);
                            let (dx, dy) =
                                policy::button_offset((rect.left, rect.top), work, SIZE);
                            crate::dictation::remember_button_offset(&ctx.app, dx, dy);
                        }
                    }
                    if !ctx.listening {
                        set_look(ctx, Look::Idle);
                    }
                    0
                }
                WM_MOUSELEAVE => {
                    if !ctx.listening && !ctx.dragging {
                        set_look(ctx, Look::Idle);
                    }
                    0
                }
                WM_TIMER => {
                    match wparam {
                        TIMER_PHASE => {
                            if ctx.listening {
                                ctx.phase_b = !ctx.phase_b;
                                set_look(
                                    ctx,
                                    if ctx.phase_b {
                                        Look::ListeningB
                                    } else {
                                        Look::Listening
                                    },
                                );
                            } else {
                                unsafe {
                                    KillTimer(hwnd, TIMER_PHASE);
                                }
                            }
                        }
                        TIMER_ERROR => {
                            unsafe {
                                KillTimer(hwnd, TIMER_ERROR);
                            }
                            if !ctx.listening {
                                set_look(ctx, Look::Idle);
                            }
                        }
                        _ => {}
                    }
                    0
                }
                _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
            }
        })
    }

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
