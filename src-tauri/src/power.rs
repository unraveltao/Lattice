//! 电源状态：一次 `GetSystemPowerStatus`，解释全在 `power_policy.rs`。
//!
//! # 为什么是独立一条命令，而不是并进 `system_metrics`
//!
//! `system_metrics` 的返回形状是"每秒采样一次、几个组件复用"，它带一秒的缓存、
//! 还要把逐核 CPU 一起搬过来；而电量几十秒才变一次，一张 240×140 的卡片只要这
//! 几个字段。并进去的代价是每个电池卡片每 30 秒收一遍逐核数据，换来的只是少一条
//! 命令 —— 不值。
//!
//! 缓存也不在这里：读一次 `GetSystemPowerStatus` 就是一次廉价的系统调用，
//! 真正的节流在组件那一侧（`schedule.every`，窗口不可见时整条停摆）。
//!
//! # 0.3.0：组件并了，命令没并
//!
//! `lattice.battery` 那个组件下架，电池成了 `lattice.sysmon` 上的一行。但**这两条
//! 命令仍然是两条**：系统卡片挂两条 `schedule.every`（1000ms 拉指标、30000ms 拉
//! 电源），各拿各的那一份。理由和上面那段一字不差 —— 合的是"用户看见的东西"，
//! 不是"每次要搬多少字节"。真并进 `system_metrics` 的话，那张卡每秒都会多收一份
//! 半分钟才变一次的电量。

use serde::Serialize;
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

use crate::power_policy;

/// 一次电源读数。字段全是**已经解释好的事实** —— 前端不再认位掩码，
/// 也不做"255 是什么"这种判断（那份判据在 `power_policy.rs`，带断言）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Power {
    /// `true` = 接着交流电，`false` = 正在用电瓶，`null` = 这一项读不出来
    pub ac: Option<bool>,
    /// 0–100；读不出来就是 `null`。**别夹到 100**：那会把"读坏了"画成"满电"
    pub percent: Option<u8>,
    pub charging: bool,
    /// 这台机器有没有电池。台式机上组件该说"没有电池"，而不是画一个 0%
    pub no_battery: bool,
    /// 剩下不到几分钟时系统会置这一位；组件据此把告警画得更急
    pub critical: bool,
    /// 节电模式开着没有
    pub saver: bool,
    /// 还能用多少分钟 —— 只在**用电瓶**且系统估得出来时才有值
    pub minutes_left: Option<u32>,
}

impl Power {
    /// 读不到时的形状：全"未知"，而不是全 0
    fn unknown() -> Self {
        Self {
            ac: None,
            percent: None,
            charging: false,
            no_battery: false,
            critical: false,
            saver: false,
            minutes_left: None,
        }
    }
}

#[tauri::command]
pub fn system_power() -> Power {
    // SAFETY: SYSTEM_POWER_STATUS 全是标量字段，零值就是合法的"未知"
    let mut raw: SYSTEM_POWER_STATUS = unsafe { core::mem::zeroed() };
    // SAFETY: 结构体由我们持有一整个生命周期，指针有效且对齐
    if unsafe { GetSystemPowerStatus(&mut raw) } == 0 {
        return Power::unknown();
    }
    let ac = power_policy::ac(raw.ACLineStatus);
    let flags = power_policy::flags(raw.BatteryFlag);
    Power {
        ac,
        percent: power_policy::percent(raw.BatteryLifePercent),
        charging: flags.charging,
        no_battery: flags.no_battery,
        critical: flags.critical,
        saver: power_policy::saver(raw.SystemStatusFlag),
        minutes_left: power_policy::minutes_left(raw.BatteryLifeTime, ac, flags.no_battery),
    }
}
