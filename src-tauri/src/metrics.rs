//! 系统指标采样（CPU / 内存 / 磁盘 / 网络 / 整机概况）
//!
//! 为什么要有缓存：指标是"一次采样、多处复用"的。五个组件各自每秒拉一次，
//! 如果每次调用都真去问一遍系统，同一秒里会有五次完全相同的采样，CPU 那点
//! 占用还会被算进它自己头上（`GetSystemTimes` 读的是全局计数，采样本身也在
//! 消耗 CPU）。所以这里留一个 1 秒的缓存窗口：窗口内第一个调用者采样，其余
//! 直接拿结果。
//!
//! 为什么不用 `sysinfo` 之类的 crate：这个项目只跑 Windows，需要的几个数
//! 各自对应一个 Win32 调用（`GetSystemTimes` / `NtQuerySystemInformation` /
//! `GlobalMemoryStatusEx` / `GetPerformanceInfo` / `GetDiskFreeSpaceExW` /
//! `GetIfTable2`），加起来不到 400 行。多一个依赖就要多一份供应链风险，而
//! 组件跑的是任意代码 —— 平台自身的依赖越少越好。
//!
//! 速率类指标（CPU 占用、网络吞吐）必须靠两次采样做差，所以缓存里同时存着
//! "上一次的原始计数"。第一次调用没有前值，占用返回 0 —— 这是刻意的：
//! 与其编一个看起来合理的假数字，不如老实说"还没测出来"。逐核数组同理，
//! 第一拍是空数组，组件据此把那一行收起来。
//!
//! 差分那点算术单独放在 `metrics_policy.rs` 里（纯函数、可 `rustc --test`），
//! 这个文件只负责把 Win32 的计数搬到内存里。

use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use windows_sys::Wdk::System::SystemInformation::{
    NtQuerySystemInformation, SystemProcessorPerformanceInformation,
};
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, IF_TYPE_SOFTWARE_LOOPBACK, MIB_IF_TABLE2,
};
use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows_sys::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
use windows_sys::Win32::System::SystemInformation::{
    GlobalMemoryStatusEx, GetTickCount64, MEMORYSTATUSEX,
};
use windows_sys::Win32::System::Threading::GetSystemTimes;
use windows_sys::Win32::System::WindowsProgramming::SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION;

use crate::metrics_policy::{self, CpuTimes};

/// 缓存窗口。1 秒对应"组件最细的心跳就是 1 秒"，再密也没有意义
const CACHE_WINDOW: Duration = Duration::from_millis(1000);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub cpu: Cpu,
    pub memory: Memory,
    pub disk: Disk,
    pub network: Network,
    /// 整机概况：开机时长、进程 / 线程 / 句柄计数
    pub system: SystemInfo,
    /// GPU 占用与显存。**`None` = 这台机器上没有可读的 GPU 计数器**
    /// （没有独显、显卡驱动没装、或者计数器被关掉）—— 不是 0%，两者要分清：
    /// 0% 是"显卡闲着"，`None` 是"读不到"，组件对这两件事的反应不一样
    pub gpu: Option<crate::gpu::Gpu>,
    /// 采样时刻（Unix 毫秒）。组件可以据此判断这份数据有多旧
    pub sampled_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    /// 0–1。第一次采样没有前值，返回 0
    pub usage: f64,
    /// 逻辑核数
    pub cores: u32,
    /// 每个逻辑核的占用，0–1，长度等于 `cores`。
    ///
    /// 第一拍、或者核数刚变过（休眠唤醒 / 热插拔）时是**空数组**：按索引硬对
    /// 会把 A 核的计数减到 B 核头上，画出来的曲线看着合理其实全错。
    pub per_core: Vec<f64>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub used: u64,
    pub total: u64,
    pub usage: f64,
    /// 已提交（commit charge）：进程"承诺要付"的内存量，含页面文件
    pub commit_used: u64,
    /// 提交上限。接近它系统就会开始拒绝分配，比物理内存满了更早出事
    pub commit_limit: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    /// 系统盘盘符，例如 `C:`
    pub mount: String,
    pub used: u64,
    pub total: u64,
    pub usage: f64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    /// 每秒字节数。第一次采样没有前值，返回 0
    pub rx_per_sec: f64,
    pub tx_per_sec: f64,
    /// 开机以来的累计字节数
    pub rx_total: u64,
    pub tx_total: u64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// 开机至今的秒数
    pub uptime_sec: u64,
    pub processes: u32,
    pub threads: u32,
    pub handles: u32,
}

#[derive(Clone, Copy, Default)]
struct NetTotals {
    rx: u64,
    tx: u64,
}

/// 上一次的原始计数。速率类指标全靠它做差
#[derive(Default)]
struct Previous {
    at: Option<Instant>,
    cpu: CpuTimes,
    per_core: Vec<CpuTimes>,
    net: NetTotals,
}

#[derive(Default)]
struct Sampler {
    previous: Previous,
    cached: Option<(Instant, Metrics)>,
}

static SAMPLER: OnceLock<Mutex<Sampler>> = OnceLock::new();

/// 取一份指标。缓存窗口内重复调用不会再问系统
pub fn snapshot() -> Metrics {
    let lock = SAMPLER.get_or_init(|| Mutex::new(Sampler::default()));
    // 采样过程不会 panic，但真被毒化了也不该让组件拿不到数据
    let mut sampler = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some((at, metrics)) = &sampler.cached {
        if at.elapsed() < CACHE_WINDOW {
            return metrics.clone();
        }
    }

    let now = Instant::now();
    let cpu_now = cpu_times();
    let per_core_now = per_core_times();
    let net_now = net_totals();
    // 一次 GetPerformanceInfo 供内存（提交量）和整机（进程 / 线程 / 句柄）共用
    let perf = performance();

    // 有前值才谈得上"速率"，没有就报 0
    let (cpu_usage, per_core_usage, rx_per_sec, tx_per_sec) = match sampler.previous.at {
        Some(previous_at) => {
            let seconds = now.duration_since(previous_at).as_secs_f64().max(0.001);
            let rx = net_now.rx.saturating_sub(sampler.previous.net.rx) as f64 / seconds;
            let tx = net_now.tx.saturating_sub(sampler.previous.net.tx) as f64 / seconds;
            (
                metrics_policy::usage(sampler.previous.cpu, cpu_now),
                metrics_policy::per_core(&sampler.previous.per_core, &per_core_now),
                rx,
                tx,
            )
        }
        None => (0.0, Vec::new(), 0.0, 0.0),
    };

    let cores = if per_core_now.is_empty() {
        std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(0)
    } else {
        per_core_now.len() as u32
    };

    sampler.previous = Previous {
        at: Some(now),
        cpu: cpu_now,
        per_core: per_core_now,
        net: net_now,
    };

    let metrics = Metrics {
        cpu: Cpu {
            usage: cpu_usage,
            cores,
            per_core: per_core_usage,
        },
        memory: memory(perf.as_ref()),
        disk: disk(),
        network: Network {
            rx_per_sec,
            tx_per_sec,
            rx_total: net_now.rx,
            tx_total: net_now.tx,
        },
        system: system_info(perf.as_ref()),
        // GPU 有自己的句柄（一条常驻的 PDH 查询），但节拍跟着这份缓存走：
        // 一秒最多 collect 一次，和"组件最细的心跳"对齐
        gpu: crate::gpu::snapshot(),
        sampled_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };

    sampler.cached = Some((now, metrics.clone()));
    metrics
}

/// `GetSystemTimes` 给的是开机以来的累计值，单位 100ns。
/// `kernel` 里已经包含了 `idle`，所以总量是 `kernel + user`。
fn cpu_times() -> CpuTimes {
    let mut idle = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = idle;
    let mut user = idle;
    let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    if ok == 0 {
        return CpuTimes::default();
    }
    CpuTimes {
        idle: filetime(idle),
        total: filetime(kernel) + filetime(user),
    }
}

fn filetime(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

/// 逐核累计计数。`NtQuerySystemInformation` 是唯一给逐核数据的轻量接口
/// （PDH 要走计数器路径，WMI 更重），口径和 `GetSystemTimes` 一样：
/// `KernelTime` 里含 `IdleTime`。
fn per_core_times() -> Vec<CpuTimes> {
    let size = std::mem::size_of::<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION>();
    // 多要一个位置：查的瞬间核数涨了也不会 SIZE_MISMATCH
    let capacity = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        + 1;
    let mut buffer: Vec<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION> =
        vec![SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION::default(); capacity];
    let mut returned = 0u32;

    let status = unsafe {
        NtQuerySystemInformation(
            SystemProcessorPerformanceInformation,
            buffer.as_mut_ptr() as *mut c_void,
            (capacity * size) as u32,
            &mut returned,
        )
    };
    // NTSTATUS >= 0 才是成功。长度不够时返回 STATUS_INFO_LENGTH_MISMATCH，
    // 这一拍就当没测到 —— 空数组让组件把逐核那行收起来，下一拍自然恢复
    if status < 0 {
        return Vec::new();
    }

    let filled = (returned as usize / size).min(capacity);
    buffer
        .into_iter()
        .take(filled)
        .map(|core| CpuTimes {
            idle: core.IdleTime.max(0) as u64,
            // 同样的口径：kernel 含 idle，忙 = kernel + user - idle
            total: core.KernelTime.saturating_add(core.UserTime).max(0) as u64,
        })
        .collect()
}

fn memory(info: Option<&PERFORMANCE_INFORMATION>) -> Memory {
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return Memory {
            used: 0,
            total: 0,
            usage: 0.0,
            commit_used: 0,
            commit_limit: 0,
        };
    }
    let total = status.ullTotalPhys;
    let used = total.saturating_sub(status.ullAvailPhys);
    // 提交量的单位是**页**，不是字节，要乘 PageSize 才是用户看得懂的量
    let (commit_used, commit_limit) = match info {
        Some(info) => {
            let page = info.PageSize as u64;
            (
                (info.CommitTotal as u64).saturating_mul(page),
                (info.CommitLimit as u64).saturating_mul(page),
            )
        }
        None => (0, 0),
    };
    Memory {
        used,
        total,
        usage: if total == 0 { 0.0 } else { used as f64 / total as f64 },
        commit_used,
        commit_limit,
    }
}

/// `GetPerformanceInfo` 一次给齐提交量和进程 / 线程 / 句柄计数。
/// 一拍只问一次，两个结构体共用这一份结果。
fn performance() -> Option<PERFORMANCE_INFORMATION> {
    let mut info: PERFORMANCE_INFORMATION = unsafe { std::mem::zeroed() };
    info.cb = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;
    if unsafe { GetPerformanceInfo(&mut info, info.cb) } == 0 {
        return None;
    }
    Some(info)
}

fn system_info(info: Option<&PERFORMANCE_INFORMATION>) -> SystemInfo {
    SystemInfo {
        // GetTickCount64 是毫秒，且不会像 32 位那版一样 49 天回绕
        uptime_sec: unsafe { GetTickCount64() } / 1000,
        processes: info.map(|info| info.ProcessCount).unwrap_or(0),
        threads: info.map(|info| info.ThreadCount).unwrap_or(0),
        handles: info.map(|info| info.HandleCount).unwrap_or(0),
    }
}

fn disk() -> Disk {
    // 系统盘而不是应用数据盘：用户看"磁盘满了没有"看的是 C:
    let mount = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let root = format!("{mount}\\");
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();

    let mut available = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    if ok == 0 {
        return Disk {
            mount,
            used: 0,
            total: 0,
            usage: 0.0,
        };
    }
    let used = total.saturating_sub(free);
    Disk {
        mount,
        used,
        total,
        usage: if total == 0 { 0.0 } else { used as f64 / total as f64 },
    }
}

/// 所有"已连接且在工作"的物理网卡字节数之和。
///
/// 跳过回环（`IF_TYPE_SOFTWARE_LOOPBACK`）和没连上的网卡：虚拟网卡、断开的
/// VPN 适配器都会留在表里，把它们算进去，用户会看到一个和实际流量对不上的数。
/// 更细的口径（按网卡分别列出）留给以后 —— 现在这张卡上只放一个总数。
fn net_totals() -> NetTotals {
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    if unsafe { GetIfTable2(&mut table) } != 0 || table.is_null() {
        return NetTotals::default();
    }

    let mut totals = NetTotals::default();
    unsafe {
        let count = (*table).NumEntries as usize;
        // Table 声明成 [MIB_IF_ROW2; 1]，实际是变长数组，按首地址加偏移取
        let rows = (*table).Table.as_ptr();
        for index in 0..count {
            let row = &*rows.add(index);
            if row.OperStatus != IfOperStatusUp || row.Type == IF_TYPE_SOFTWARE_LOOPBACK {
                continue;
            }
            totals.rx = totals.rx.saturating_add(row.InOctets);
            totals.tx = totals.tx.saturating_add(row.OutOctets);
        }
        FreeMibTable(table as *const core::ffi::c_void);
    }
    totals
}

#[tauri::command]
pub fn system_metrics() -> Metrics {
    snapshot()
}
