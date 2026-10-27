/**
 * 层级那行"真话读数"。
 *
 * # 它为什么存在
 *
 * 层级这条链路上的失败**全是无声的**：找不到 WorkerW 就悄悄降级成
 * `HWND_BOTTOM`；`set_always_on_top` 失败只往 stderr 写一行；可输入的组件
 * 选"桌面层"时，它其实只是"压在最底下"而不是真的贴桌面。用户在界面上
 * 什么都看不出来，于是只能说"我点了没效果"—— 而这句话对我们是**四次猜测**
 * 的起点。
 *
 * 所以这里直接问 Win32：这个窗口现在实际在哪儿？要的和实际的对不上就
 * 红字写出来。下一次再有人说"没效果"，他截图里就带着答案。
 *
 * # 为什么要等 400ms
 *
 * 层级是**意图**先到、`sync_widget_windows` 120ms 防抖之后才真的落到 Win32 上
 * （见 `runner.rs::widget_set_layer`）。挂载那一刻就问，读到的必然是旧值，
 * 于是这行字会在每次改层级之后先骗人半秒。两个点各问一次：现在问一次
 * （窗口刚建好时是对的），400ms 后再问一次（等落盘）。
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useT } from "../runtime/i18n";
import {
  asProbeState,
  expectedProbe,
  probeLabelKey,
  type ProbeState,
  type WindowLayer,
} from "../runtime/layer";
import { isTauri } from "../runtime/registry";

/** `desktop::LayerProbe` 的线上形状 */
interface ProbePayload {
  actual: string;
  parented: boolean;
  topmost: boolean;
  sunk: boolean;
  found: boolean;
}

/** 落盘那一跳的余量：`sync_widget_windows` 自己 120ms，再留三倍 */
const SETTLE_MS = 400;

interface LayerProbeLineProps {
  instanceId: string;
  /** 用户要的那一档 */
  layer: WindowLayer;
  /** 组件要不要键盘焦点。同一个"桌面层"对这两种是两种 Win32 落法 */
  interactive: boolean;
}

export function LayerProbeLine({ instanceId, layer, interactive }: LayerProbeLineProps) {
  const t = useT();
  /** `null` = 还没有窗口可问（画布上摆着、桌面上没开） */
  const [actual, setActual] = useState<ProbeState | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setActual(null);
      return;
    }

    let alive = true;
    const ask = () => {
      void invoke<ProbePayload>("widget_layer_probe", { instanceId })
        .then((probe) => {
          if (alive) setActual(probe.found ? asProbeState(probe.actual) : null);
        })
        // 问不到就是"没开窗"：这个组件可能只摆在画布上，桌面上没有窗口。
        // 这不是错误，别把它画成错误。
        .catch(() => {
          if (alive) setActual(null);
        });
    };

    ask();
    const timer = window.setTimeout(ask, SETTLE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [instanceId, layer, interactive]);

  if (actual === null) {
    return <p className="lattice-hint lattice-probe">{t("No window open")}</p>;
  }

  const want = expectedProbe(layer, interactive);
  const agree = actual === want;

  return (
    <>
      <p className={`lattice-hint lattice-probe${agree ? "" : " is-off"}`}>
        {t("Window right now")}：{t(probeLabelKey(actual))}
        {agree ? " ✓" : ""}
      </p>
      {agree ? null : (
        <p className="lattice-hint lattice-probe is-off">
          {t("Asked for {want}, Windows actually reports {got}.", {
            want: t(probeLabelKey(want)),
            got: t(probeLabelKey(actual)),
          })}
        </p>
      )}
    </>
  );
}
