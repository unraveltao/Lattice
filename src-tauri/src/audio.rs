//! 声音高低：默认输出设备的**回环采集**，给组件那条"心电图"用。
//!
//! # 为什么不是问 SMTC
//!
//! `media.rs` 那套（系统媒体传输控件）只有标题、歌手、进度 —— **没有音量**。
//! 想看"现在有多响"，唯一的办法是自己去听输出设备在放什么：WASAPI 的
//! 回环模式（`AUDCLNT_STREAMFLAGS_LOOPBACK`）就是干这个的，它把"本机正在
//! 播给扬声器的那一路"复制一份出来。
//!
//! # 为什么只算一个数，不留波形
//!
//! 我们每块只算 RMS，然后立刻把指针还回去（`ReleaseBuffer`）—— **不缓存、
//! 不落盘、不出进程**。组件拿到的是 0..1 的一个数，跟"录下来了"是两件事。
//! 这也让它不需要任何系统级授权：回环采集的是本进程自己的输出混音，
//! 不会弹"要不要允许录音"，也拿不到别的进程的单独音轨。
//!
//! # 为什么要有后台线程
//!
//! 一次 `Initialize` + `Start` 大约十几毫秒，而且每次都要重新协商缓冲。要是
//! 每个 `audio.level` 调用现开现关，组件那边 80ms 一问，一半时间花在初始化上，
//! 声音还一顿一顿的。所以：**一个线程从头采到尾**，把结果写进一个 `f32`，
//! 命令只负责读那个数（一次锁，纳秒级）。
//!
//! 线程出错（拔耳机、切默认设备、独占模式被别的程序抢走）不是致命错误：
//! 睡两秒重来。重试期间 `running` 是 `false`，组件画一条平线 —— 那本来就是
//! "现在没有声音"的诚实画法，不该红字报警。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

use crate::audio_policy::{decay, next_level, rms_f32, rms_i16};

/// 每次读出来的东西。
///
/// `running` 是"采集线程还活着"，不是"有声音"：没有设备、设备被独占、正在
/// 重连的时候它是 `false`，此时 `level` 恒为 0。组件据此画平线，而不是提示错误。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevel {
    /// 0..1，已经做过分贝映射和释放曲线
    pub level: f32,
    pub running: bool,
}

/// 采集线程多久看一次缓冲。
///
/// 40ms 比组件的采样间隔（80ms）密一倍：短促的重音不会正好落在两次读取之间
/// 被漏掉。再密就没意义了 —— 回环缓冲本身是引擎按周期填的。
const POLL_MS: u64 = 40;

/// 出错之后等多久再试
const RETRY_MS: u64 = 2000;

/// 共享模式的回环流，缓冲时长给 0 表示"用引擎的默认周期"
const BUFFER_HNS: i64 = 0;

struct Meter {
    /// 当前包络值 + 它最后一次更新的时刻
    shared: Mutex<Shared>,
    running: AtomicBool,
}

struct Shared {
    level: f32,
    at: Option<Instant>,
}

impl Meter {
    const fn new() -> Self {
        Self {
            shared: Mutex::new(Shared {
                level: 0.0,
                at: None,
            }),
            running: AtomicBool::new(false),
        }
    }

    /// 锁中毒不当回事：里面只有一个 f32，没有"半个状态"可言
    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// 采集线程推一块进来
    fn push(&self, rms: f32) {
        let mut shared = self.lock();
        let elapsed = shared
            .at
            .map(|at| at.elapsed().as_secs_f32() * 1000.0)
            .unwrap_or(0.0);
        shared.level = next_level(shared.level, rms, elapsed);
        shared.at = Some(Instant::now());
    }

    /// 组件读一次。
    ///
    /// 读的时候也顺手释放一下：采集线程挂了（设备拔掉、正在重试）之后没人推新值，
    /// 不释放的话指针会永远停在最后一次的峰值上，看着像卡死。
    fn read(&self) -> f32 {
        let mut shared = self.lock();
        let elapsed = shared
            .at
            .map(|at| at.elapsed().as_secs_f32() * 1000.0)
            .unwrap_or(0.0);
        let value = decay(shared.level, elapsed);
        shared.level = value;
        shared.at = Some(Instant::now());
        value
    }
}

static METER: Meter = Meter::new();
static STARTED: Once = Once::new();

fn ensure_started() {
    STARTED.call_once(|| {
        // 起不来（线程被系统拒了）不是致命错误：命令照常返回 running: false
        let _ = std::thread::Builder::new()
            .name("lattice-audio".to_string())
            .spawn(capture_loop);
    });
}

fn capture_loop() {
    loop {
        // 正常返回 = 设备失效，异常返回 = 初始化失败。两种都重来
        let _ = capture_until_failure();
        METER.running.store(false, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(RETRY_MS));
    }
}

/// 开一路回环，一直读到出错为止。
///
/// 返回 `Ok(())` 表示流结束了（设备切走 / 被别的程序独占），`Err` 表示这一路
/// 根本没开起来。两种都交给上面那个循环重试 —— 这里不区分，因为对组件来说
/// 它们的表现一样：`running: false`。
fn capture_until_failure() -> windows::core::Result<()> {
    // SAFETY: 这一段全是 COM 调用。每个指针的生命周期都在本函数里管住：
    // 混音格式由系统 `CoTaskMemAlloc` 出来，`Initialize` 用完立刻 `CoTaskMemFree`；
    // 采样块由 `GetBuffer` 借出，`ReleaseBuffer` 归还（每个分支都必须还，
    // 所以下面用 `?` 之前先还 —— 见 `read_packets`）。
    unsafe {
        // 采集线程是全新线程，没初始化过 COM。同一模式重复初始化返回 S_FALSE，无害
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;

        let format = client.GetMixFormat()?;
        // 这两项**必须在 free 之前抄下来**：`format` 是系统分配的内存，
        // `Initialize` 之后就没用了，再解引用是 use-after-free
        let bits = (*format).wBitsPerSample;
        let channels = (*format).nChannels.max(1) as usize;

        let initialized = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            BUFFER_HNS,
            0,
            format,
            None,
        );
        CoTaskMemFree(Some(format as *const _ as *const core::ffi::c_void));
        initialized?;

        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        METER.running.store(true, Ordering::Relaxed);

        loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));

            let mut packet = capture.GetNextPacketSize()?;
            while packet > 0 {
                let mut data: *mut u8 = core::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;

                // 静音块（系统明确说"这一段是空的"）不用去读内存：
                // 指针可能指向一片没写过的地方
                let rms = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                    0.0
                } else {
                    packet_rms(data, frames, bits, channels)
                };

                // 无论读没读，都必须还
                capture.ReleaseBuffer(frames)?;
                METER.push(rms);

                packet = capture.GetNextPacketSize()?;
            }
        }
    }
}

/// 一块采样有多响。只认 32 位浮点和 16 位整数 —— 共享模式的混音格式是前者，
/// 后者留给老设备；其余格式（24 位打包、8 位）直接当静音，别猜。
///
/// `frames` 是**帧**数，一帧有 `channels` 个采样。少乘这个声道数不会崩，
/// 但会把立体声当单声道读一半，右声道的声音就永远看不见 —— 而多乘就会越界。
///
/// # Safety
///
/// `data` 必须指向至少 `frames * channels * bits/8` 字节的可读内存，且这块内存在
/// 调用期间有效 —— 由 WASAPI 的 `GetBuffer` / `ReleaseBuffer` 保证。
unsafe fn packet_rms(data: *mut u8, frames: u32, bits_per_sample: u16, channels: usize) -> f32 {
    let count = frames as usize * channels;
    // SAFETY: 见函数注释 —— 这块内存由 WASAPI 借给我们，长度是 frames × channels × 位深
    unsafe {
        match bits_per_sample {
            32 => rms_f32(std::slice::from_raw_parts(data as *const f32, count)),
            16 => rms_i16(std::slice::from_raw_parts(data as *const i16, count)),
            _ => 0.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 现在有多响。
///
/// **同步命令**（不是 `async fn`）：它只锁一个 f32、读一个原子，没有任何阻塞。
/// 丢进 `spawn_blocking` 反而要多一次线程切换，而组件 80ms 就问一次。
#[tauri::command]
pub fn audio_level() -> AudioLevel {
    ensure_started();
    AudioLevel {
        level: METER.read(),
        running: METER.running.load(Ordering::Relaxed),
    }
}
