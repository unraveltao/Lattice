/**
 * 棂 / Lattice —— 能力体检（设置 → 诊断）
 *
 * # 这块面板回答一个问题
 *
 * "我点了，为什么没反应。"
 *
 * 以前这个问题只有一个答案：去看 `state.json`、去看 WebView2 的远程调试端口、
 * 或者干脆重装。因为平台自己也不知道 —— 六组手和那些桥方法的能力，全是"调用
 * 失败才知道"。而失败的时候用户看到的是 `internal`，或者干脆什么都没有。
 *
 * 现在：启动时把机器上能看见的事实探一遍，摆成一张表。**红的那一行写着缺什么**，
 * 绿的那一行说明平台这边没问题（问题在别处）。
 *
 * # 为什么不是实时的
 *
 * 探针要拷一次屏幕、枚举一次音频设备、读几份配置。每秒做一遍，换来的信息量是零，
 * 而代价是它会自己变红 —— 用户锁一下屏，"屏幕"那一行就红了，那条红字说的不是
 * "你不能用"，是"我刚才看了一眼，那一瞬间不行"。
 *
 * 所以：**启动探一次，之后只在这个按钮被按下时重探**。表头上写着"最后检查：
 * 09:41"，用户自己决定要不要再查。这比一个会闪的灯诚实，也比它省电。
 *
 * # 为什么不做"自动修复"
 *
 * 每一行的原因都对应一个动作，而那些动作一半在系统里（装语言包、插一块声卡、
 * 把 npx 装到 PATH 上），一半在别的设置页（打开某一组手）。这块面板只负责
 * **说清楚**，不替用户动手 —— 一个会自己改系统设置的诊断面板，比一个红字可怕
 * 得多。
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  capabilityLabel,
  capabilityReasonText,
  groupRows,
  stampOf,
  tally,
  type CapabilityReport,
  type CapabilityRow,
} from "../runtime/capabilities";
import { isTauri } from "../runtime/registry";
import { useT } from "../runtime/i18n";

/** 一条。绿点 + 名字 + 右边那句"为什么" */
function Row({ row }: { row: CapabilityRow }) {
  const t = useT();
  const reason = capabilityReasonText(row);
  return (
    <li className="lattice-diag-row" data-ok={row.available ? "1" : "0"}>
      {/* 点只是给眼睛一个落点，说的是旁边那句话 —— 所以它不进无障碍树 */}
      <span className="lattice-diag-dot" aria-hidden="true" />
      <span className="lattice-diag-name">{capabilityLabel(row.id)}</span>
      <span className={`lattice-diag-note${row.available ? "" : " is-bad"}`}>
        {reason ?? t("Ready")}
      </span>
    </li>
  );
}

export function DiagnosticsPanel() {
  const t = useT();
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * `refresh` 为假时后端给的是启动时那一份（不重探）。
   *
   * 打开这一页就走这条：用户点进来看一眼，不该触发一次 BitBlt + 一次 COM 枚举。
   * 真要看现在的，按旁边那颗按钮。
   */
  const load = useCallback(async (refresh: boolean) => {
    if (!isTauri()) {
      setError("The capability probe needs the desktop app.");
      return;
    }
    setBusy(true);
    try {
      setReport(await invoke<CapabilityReport>("capability_probe", { refresh }));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const groups = report ? groupRows(report.rows) : null;
  const counts = report ? tally(report.rows) : null;

  return (
    <div className="lattice-settings-form">
      <div className="lattice-diag-head">
        <span className="lattice-diag-stamp">
          {report
            ? t("Last checked {time}", { time: stampOf(report.probedAt) })
            : t("Not checked yet")}
          {counts && counts.bad > 0 ? (
            <b className="is-bad">
              {" · "}
              {t("{count} need attention", { count: counts.bad })}
            </b>
          ) : null}
        </span>
        <button
          type="button"
          className="lattice-btn is-small"
          onClick={() => void load(true)}
          disabled={busy}
          title={t("Probe again now. This is the only way the list changes — there is no timer.")}
        >
          {busy ? t("Checking…") : t("Check again")}
        </button>
      </div>

      <p className="lattice-settings-hint">
        {t(
          "A snapshot, taken at launch and whenever you press the button. Nothing here is polled — a row that turns red stays red until you look again.",
        )}
      </p>

      {error ? <p className="lattice-modal-error">{error}</p> : null}

      {groups ? (
        <>
          {groups.hands.length > 0 ? (
            <section className="lattice-diag-group">
              <h3>{t("Assistant hands")}</h3>
              <ul>
                {groups.hands.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </ul>
            </section>
          ) : null}

          {groups.servers.length > 0 ? (
            <section className="lattice-diag-group">
              <h3>{t("MCP servers")}</h3>
              <ul>
                {groups.servers.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </ul>
            </section>
          ) : null}

          {groups.platform.length > 0 ? (
            <section className="lattice-diag-group">
              <h3>{t("Platform")}</h3>
              <ul>
                {groups.platform.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      <p className="lattice-settings-hint">
        {t(
          "A green row means this side is fine: if it still does nothing, the cause is outside Lattice (a window running as administrator, a site refusing the request, a path outside the widget's folder).",
        )}
      </p>
    </div>
  );
}
