//! 姿态的运行时 —— 一份状态、两条命令、一个广播事件。
//!
//! 判据在 `presence_policy.rs`（纯逻辑，能 `rustc --test` 单跑）。这里只做三件事：
//! 存住、报出去、到点回落。
//!
//! # 为什么是"一次性线程"而不是一个每 500ms 的定时器
//!
//! `done` / `error` 过期需要有人叫醒。最顺手的写法是一个常驻 ticker，每半秒看一眼
//! —— 那是一根永远在跑的针，而它 99.9% 的时间什么都不会做。
//!
//! 改成**报的时候排一次**：进入瞬时姿态就 spawn 一个线程睡 4 秒，醒来先比对
//! `since`，还是那一格才回落。代价是一次短暂的线程，收益是没有常驻定时器
//! ——（和 `capability_probe.rs` 拒绝定时器是同一条理由：一件事有"发生了"这个时刻，
//! 就不该用"每隔一会儿看一眼"来实现它）。
//!
//! # 为什么事件是广播
//!
//! `emit` 是广播（不变量 9）。桌宠窗、assistant 小窗、主窗口里的静态头像可能同时
//! 都在听同一个姿态 —— 一份状态喂三处，不用维护三套。

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::pet_policy::TRANSIENT_MS;
use crate::presence_policy::{self, Posture, Presence};

/// 广播事件名。前端 `listen("lattice:presence")`。
pub const EVENT: &str = "lattice:presence";

/// 进程启动那一刻。所有 `since_ms` 都是相对它的毫秒数 —— 用单调时钟，
/// 不用 `SystemTime`：用户改一下系统时间，`SystemTime` 会跳，而"这个姿态持续了多久"
/// 不该因为改了时钟就变成负数或者十年。
static START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn now_ms() -> u64 {
    START.elapsed().as_millis() as u64
}

/// 姿态 + 附言。附言是给气泡用的（"正在读 weather.js"），**没有就不冒气泡**。
#[derive(Debug, Clone, PartialEq, Eq)]
struct State {
    presence: Presence,
    detail: Option<String>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State {
        presence: Presence::boot(0),
        detail: None,
    })
});

/// 给前端看的那一份。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub posture: &'static str,
    pub since_ms: u64,
    pub detail: Option<String>,
}

impl Snapshot {
    fn of(state: &State) -> Snapshot {
        Snapshot {
            posture: state.presence.posture.as_str(),
            since_ms: state.presence.since_ms,
            detail: state.detail.clone(),
        }
    }
}

/// 报一次姿态。
///
/// **谁拥有这一轮谁说**：assistant 面板在开轮 / 收到工具调用 / 等审批 / 出错 / 收尾时
/// 各报一次。宠物窗自己报 `asleep`（它知道自己睡着了）。
///
/// 同值重复报告不会重置计时（`presence_policy::report` 的规则 1），但**附言会更新**
/// —— "正在读 weather.js" 换成 "正在读 clock.js" 是同一种姿态下的新事实。
#[tauri::command]
pub fn presence_report(
    app: AppHandle,
    posture: String,
    detail: Option<String>,
) -> Result<Snapshot, String> {
    let incoming = Posture::parse(&posture)
        .ok_or_else(|| format!("unknown posture: {posture}"))?;
    let now = now_ms();
    let detail = detail.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());

    let (snapshot, changed) = {
        let mut state = STATE.lock().map_err(|_| "presence lock poisoned")?;
        let next = presence_policy::report(state.presence, incoming, now);
        let changed = next != state.presence || detail != state.detail;
        state.presence = next;
        state.detail = detail;
        (Snapshot::of(&state), changed)
    };

    // 只有真变了才广播。流式出字时报告很密，同值还广播等于让三个窗口各重渲染一遍。
    if changed {
        let _ = app.emit(EVENT, &snapshot);
        if incoming.is_transient() {
            schedule_fallback(app, snapshot.since_ms);
        }
    }
    Ok(snapshot)
}

/// 后建的窗口先读这一份。
///
/// 没有它的话，宠物窗一重启就显示 `idle`，而 agent 可能正在干活 —— 一只刚重启的
/// 宠物和一只真的闲着的宠物长得一模一样，那种 bug 没人报得清。
#[tauri::command]
pub fn presence_get() -> Result<Snapshot, String> {
    let state = STATE.lock().map_err(|_| "presence lock poisoned")?;
    Ok(Snapshot::of(&state))
}

/// 排一次回落。醒来先比对 `since` —— 4 秒之内又发生了一次 `done`，
/// 那一次的 `since` 已经变了，这一次就该安静退出。
fn schedule_fallback(app: AppHandle, since: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(TRANSIENT_MS));
        let snapshot = {
            let Ok(mut state) = STATE.lock() else {
                return;
            };
            if state.presence.since_ms != since {
                return; // 期间换过姿态，这一次的回落作废
            }
            let next = presence_policy::tick(state.presence, now_ms());
            if next == state.presence {
                return;
            }
            state.presence = next;
            // 回落成 idle 时附言必须清掉：那句"正在读 weather.js"已经过期了。
            if next.posture == Posture::Idle {
                state.detail = None;
            }
            Snapshot::of(&state)
        };
        let _ = app.emit(EVENT, &snapshot);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这个模块的测试不碰全局 `STATE`（那是进程级的，测试并行跑会互相踩）。
    /// 判据在 `presence_policy.rs` 里已经逐条钉过，这里只验"接线"这件事。
    #[test]
    fn the_event_name_is_stable() {
        // 前端 `listen("lattice:presence")` 写死了这个名字。改名 = 桌宠再也不动。
        assert_eq!(EVENT, "lattice:presence");
    }

    #[test]
    fn a_snapshot_serializes_to_camel_case() {
        // 前端读的是 `sinceMs`，不是 `since_ms`。
        let snapshot = Snapshot {
            posture: "working",
            since_ms: 1_234,
            detail: Some("reading weather.js".into()),
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"sinceMs\":1234"), "{json}");
        assert!(json.contains("\"posture\":\"working\""), "{json}");
        assert!(json.contains("\"detail\":\"reading weather.js\""), "{json}");
    }

    #[test]
    fn an_absent_detail_serializes_to_null_not_a_missing_key() {
        // 前端用 `detail ?? null` 判断"要不要冒气泡"。键不在和值是 null 在前端是两回事。
        let snapshot = Snapshot {
            posture: "idle",
            since_ms: 0,
            detail: None,
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"detail\":null"), "{json}");
    }
}
