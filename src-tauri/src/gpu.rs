//! GPU 占用与显存：一条常驻的 PDH 查询 + 一次 DXGI 枚举。
//!
//! # 为什么是 PDH
//!
//! Windows 上没有统一的 GPU API：NVIDIA 有 NVML、AMD 有 ADL、Intel 什么都没公开。
//! 唯一厂商中立、且**任务管理器自己也读**的那份数据是性能计数器
//! （`GPU Engine` / `GPU Adapter Memory`）。PDH 是读计数器的官方途径，`pdh.dll`
//! 是系统自带的，不引依赖。
//!
//! 但 `system.metrics` 里逐核 CPU 特意绕开了 PDH（`metrics.rs` 里那条注释）——
//! 那不是标准不一：逐核 CPU 有 `NtQuerySystemInformation` 这条更轻的路，
//! 而 GPU 只有这一条。
//!
//! # 三个必须踩准的地方
//!
//! 1. **计数器路径要用英文名去加。** 中文系统上 `GPU 引擎` 才是对象名，
//!    拿英文路径直接 `PdhAddCounterW` 会 `PDH_CSTATUS_NO_OBJECT`。所以先试
//!    `PdhAddEnglishCounterW`（它按英文名反查本地化名），失败了再退回原名 ——
//!    反过来的顺序在中文机器上永远失败。
//!
//! 2. **一条查询常驻，不是每次开一条。** `Utilization Percentage` 是速率型
//!    计数器，值来自"两次 collect 之间"，句柄活着一秒收一次才有意义。每次
//!    重建查询等于每次都是第一拍，读出来永远是 0。
//!
//! 3. **实例名要拆，不能直接取最大值。** 一块卡有 3D / Copy / VideoDecode
//!    好几条引擎、几十个进程实例；怎么合成一个数在 `gpu_policy.rs` 里，
//!    带断言。这里只负责把字符串搬过去。
//!
//! # 读不到的时候
//!
//! PDH 分不清"这台机器没有 GPU"和"GPU 计数器被关掉了"—— 两者都是加计数器
//! 失败。所以这里只回 `None`，组件把整行收起来；**不显示 0%**：0% 是"显卡闲着"，
//! 和"读不到"是两件事。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows_sys::Win32::System::Performance::{
    PdhAddCounterW, PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
    PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
    PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};

use crate::gpu_policy;

/// 加不上计数器之后多久再试一次。显卡不会热插拔，但驱动更新 / TDR 会换掉
/// 计数器实例 —— 试得太勤是每秒一次系统调用，太懒则是"插上 eGPU 也不认"
const RETRY_AFTER: Duration = Duration::from_secs(30);

/// 连续几拍读不出来就重建查询。实例集合被驱动更新清空过之后，
/// 老的句柄会一直回空数组，重建一次就恢复
const REBUILD_AFTER: u32 = 3;

/// 一条 GPU 读数。`usage` 的口径和 `cpu.usage` 一样是 0–1
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    /// 适配器名（DXGI 给的，例如 `NVIDIA GeForce RTX 3060`）。读不到就是空串
    pub name: String,
    /// 0–1，最忙那条引擎的占用
    pub usage: f64,
    /// 已用显存（字节）。和 `total` 一起才好看 —— 单给一个数没有参照
    pub used: u64,
    /// 显存总量（字节）。DXGI 的 `DedicatedVideoMemory`；0 表示读不到
    pub total: u64,
}

/// PDH 句柄是裸指针，`Mutex` 里的东西要 `Send` 才能进 `static`。
///
/// 安全前提：这些句柄只在这个模块的锁里用，PDH 自己线程安全
/// （同一条查询不跨线程并发调用即可，而这里每次都持锁）
struct Query {
    query: PDH_HQUERY,
    engine: PDH_HCOUNTER,
    memory: PDH_HCOUNTER,
}

unsafe impl Send for Query {}

impl Query {
    fn close(&self) {
        // SAFETY: 句柄来自 `PdhOpenQueryW`，且只关一次（`Query` 不实现 Clone）
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}

impl Drop for Query {
    fn drop(&mut self) {
        self.close();
    }
}

/// DXGI 那边一次性拿到的东西：名字和显存总量。它们不随时间变
struct Adapter {
    card: u64,
    name: String,
    total: u64,
}

struct Sampler {
    query: Option<Query>,
    adapters: Vec<Adapter>,
    /// 上一次尝试建立查询的时刻（失败后用来退避）
    tried: Option<Instant>,
    failures: u32,
}

impl Default for Sampler {
    fn default() -> Self {
        Self {
            query: None,
            adapters: Vec::new(),
            tried: None,
            failures: 0,
        }
    }
}

static SAMPLER: OnceLock<Mutex<Sampler>> = OnceLock::new();

/// 取一份 GPU 读数。`None` = 这台机器上没有可读的 GPU 计数器
pub fn snapshot() -> Option<Gpu> {
    let lock = SAMPLER.get_or_init(|| Mutex::new(Sampler::default()));
    let mut sampler = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if sampler.query.is_none() {
        // 退避：刚试过就别再试，否则没显卡的机器每秒白开一条查询
        if let Some(at) = sampler.tried {
            if at.elapsed() < RETRY_AFTER {
                return None;
            }
        }
        sampler.tried = Some(Instant::now());
        // 第一拍只建基线：速率型计数器要两次 collect 才有值，所以这一拍返回 None
        sampler.query = open();
        return None;
    }

    // 句柄复制出来用，别借着 `sampler` 不放 —— 下面失败计数要改 `sampler`。
    // 裸指针是 `Copy`，而且这条查询在本次调用期间一定还活着（`sampler.query`
    // 只有下面"重建"那一处会动，且那一处不会在借用期间发生）
    let (query, engine, memory) = {
        let live = sampler.query.as_ref()?;
        (live.query, live.engine, live.memory)
    };

    // SAFETY: 句柄活着且本次调用持锁
    if unsafe { PdhCollectQueryData(query) } != 0 {
        sampler.failures += 1;
        if sampler.failures >= REBUILD_AFTER {
            // 丢下这条查询，下一拍重建。`Drop` 会关掉句柄
            sampler.query = None;
            sampler.tried = Some(Instant::now());
        }
        return None;
    }
    sampler.failures = 0;

    let engines = read_array(engine).unwrap_or_default();
    let memory_items = read_array(memory).unwrap_or_default();

    // 实例名每拍几百条，解析出来的引擎名要复制一份才借得动（`read_array`
    // 的缓冲下一行就没了）。每秒几百个小 String，比 PDH 自己那次 collect 便宜
    let parsed: Vec<(u64, String, f64)> = engines
        .iter()
        .filter_map(|(name, value)| {
            gpu_policy::parse_engine(name).map(|(card, engine)| (card, engine.to_string(), *value))
        })
        .collect();
    let samples: Vec<(u64, &str, f64)> = parsed
        .iter()
        .map(|(card, engine, value)| (*card, engine.as_str(), *value))
        .collect();
    let totals = gpu_policy::engine_totals(&samples);

    let vram: Vec<(u64, u64)> = memory_items
        .iter()
        .filter_map(|(name, value)| {
            gpu_policy::parse_adapter(name).map(|card| (card, value.max(0.0) as u64))
        })
        .collect();

    // 一块卡都没有 = 没有可读的 GPU。注意这里不能"回落到第一块适配器"：
    // 那会在混合显卡上画出核显的数，却挂着独显的名字
    let card = gpu_policy::pick(&totals, &vram)?;

    if sampler.adapters.is_empty() {
        sampler.adapters = adapters();
    }
    let adapter = sampler.adapters.iter().find(|item| item.card == card);
    let percent = totals
        .iter()
        .find(|(other, _)| *other == card)
        .map(|(_, value)| *value)
        .unwrap_or(0.0);

    Some(Gpu {
        name: adapter.map(|item| item.name.clone()).unwrap_or_default(),
        usage: (percent / 100.0).clamp(0.0, 1.0),
        used: vram
            .iter()
            .find(|(other, _)| *other == card)
            .map(|(_, used)| *used)
            .unwrap_or(0),
        total: adapter.map(|item| item.total).unwrap_or(0),
    })
}

/// 开一条查询，把两个计数器挂上去，先 collect 一次建基线
fn open() -> Option<Query> {
    let mut query: PDH_HQUERY = std::ptr::null_mut();
    // SAFETY: 数据源为 NULL = 读本机实时数据；句柄写进我们自己的变量
    if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) } != 0 {
        return None;
    }

    let engine = add_counter(query, "\\GPU Engine(*)\\Utilization Percentage");
    let memory = add_counter(query, "\\GPU Adapter Memory(*)\\Dedicated Usage");

    let (Some(engine), Some(memory)) = (engine, memory) else {
        // 两个计数器有一个加不上就当这台机器没有 GPU。句柄要还回去
        unsafe {
            PdhCloseQuery(query);
        }
        return None;
    };

    let built = Query {
        query,
        engine,
        memory,
    };
    // SAFETY: 刚建好的查询，第一次 collect 只是把基线取回来
    if unsafe { PdhCollectQueryData(built.query) } != 0 {
        return None;
    }
    Some(built)
}

/// 加一个计数器。先按英文名（能反查本地化名），失败再按原名试一次
fn add_counter(query: PDH_HQUERY, path: &str) -> Option<PDH_HCOUNTER> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut counter: PDH_HCOUNTER = std::ptr::null_mut();

    // SAFETY: `wide` 以 NUL 结尾且活到调用结束；counter 指向我们自己的变量
    let english = unsafe { PdhAddEnglishCounterW(query, wide.as_ptr(), 0, &mut counter) } == 0;
    if english {
        return Some(counter);
    }
    // SAFETY: 同上
    let plain = unsafe { PdhAddCounterW(query, wide.as_ptr(), 0, &mut counter) } == 0;
    if plain {
        return Some(counter);
    }
    None
}

/// 一个通配实例计数器的当前值：`[(实例名, 值)]`。
///
/// 两步调用是 PDH 的规矩：先问要多大缓冲（回 `PDH_MORE_DATA`），再按那个大小
/// 取一次。空数组是正常状态（这一拍没有实例），不是错误 —— 上层用 `unwrap_or_default`
/// 接住，画出来就是"这一拍没数"。
fn read_array(counter: PDH_HCOUNTER) -> Option<Vec<(String, f64)>> {
    let mut size = 0u32;
    let mut count = 0u32;
    // SAFETY: 空指针 + 0 长度 = 只问大小，PDH 不会往里写
    let probe = unsafe {
        PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            std::ptr::null_mut(),
        )
    };
    if probe != PDH_MORE_DATA || size == 0 || count == 0 {
        return Some(Vec::new());
    }

    // 缓冲区按 PDH 要的字节数开，再当成 `PDH_FMT_COUNTERVALUE_ITEM_W` 数组用。
    // 用 `u64` 对齐的 Vec<u8> 不够 —— 所以这里开 `Vec<u64>` 再转指针，
    // 保证 8 字节对齐（结构体里最大的成员是 f64 / 指针）
    let words = (size as usize).div_ceil(8);
    let mut buffer = vec![0u64; words];
    let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
    // SAFETY: buffer 至少 size 字节，且按 8 字节对齐
    let status = unsafe {
        PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, items)
    };
    if status != 0 {
        return Some(Vec::new());
    }

    let mut out = Vec::with_capacity(count as usize);
    for index in 0..count as usize {
        // SAFETY: PDH 说写了 `count` 条
        let item = unsafe { &*items.add(index) };
        // CStatus 0 = 有效，1 = 新数据；别的（比如刚重建查询那一拍）跳过这一条
        if item.FmtValue.CStatus > 1 {
            continue;
        }
        // SAFETY: szName 是 PDH 写进同一个缓冲区的 NUL 结尾宽字符串
        let name = unsafe { wide(item.szName) };
        // SAFETY: 请求的是 PDH_FMT_DOUBLE，联合体里那个就是 doubleValue
        let value = unsafe { item.FmtValue.Anonymous.doubleValue };
        out.push((name, value));
    }
    Some(out)
}

/// NUL 结尾的宽字符串 → String
unsafe fn wide(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut length = 0usize;
    // SAFETY: 调用方保证这是 PDH 写好的、以 NUL 结尾的字符串
    while unsafe { *ptr.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: 上面数出来的长度就是有效字符数
    let slice = unsafe { std::slice::from_raw_parts(ptr, length) };
    String::from_utf16_lossy(slice)
}

/// DXGI 枚举：适配器名 + 显存总量。
///
/// 显存**总量**只能从这儿拿：`GPU Adapter Memory` 那组计数器只有
/// `Dedicated Usage` / `Shared Usage` / `Total Committed`，没有上限。
/// 跳过软件适配器（`Microsoft Basic Render Driver`）—— 它不是一块卡
fn adapters() -> Vec<Adapter> {
    let mut out = Vec::new();
    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(factory) => factory,
        Err(_) => return out,
    };

    let mut index = 0;
    loop {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
            break;
        };
        index += 1;
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        // DXGI_ADAPTER_FLAG_SOFTWARE = 2
        if desc.Flags & 2 != 0 {
            continue;
        }
        out.push(Adapter {
            card: gpu_policy::luid(desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart),
            name: String::from_utf16_lossy(&desc.Description)
                .trim_end_matches('\0')
                .trim()
                .to_string(),
            total: desc.DedicatedVideoMemory as u64,
        });
    }
    out
}
