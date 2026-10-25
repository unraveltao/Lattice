/**
 * 棂 / Lattice —— 属性检查器
 *
 * 选中一个组件实例后，这里管它的层级、穿透、尺寸和权限授予。
 * 权限是按 widgetId 记的（同一组件的多个实例共享授权），
 * 因为权限是"你信不信任这个组件的代码"，跟摆了几份无关。
 *
 * 一列 320px 放不下十一项控件平铺，所以分成四段折叠：
 * 怎么用 / 层级与尺寸 / 外观 / 权限与选项。只有"层级与尺寸"默认展开 ——
 * 那是选中一个组件之后最常做的事；开合状态只活在会话里，不落盘。
 *
 * 最底下单独一格 `.lattice-danger-zone` 放 `Remove`。它**不许**回到标题行：
 * 那颗按钮旁边的邻居是"收起来"，而移除会拿走用户摆好的一个实例
 * （`removePlacement` 留了 8 秒撤销，那是兜底，不是设计）。
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
  MAX_BLUR,
  hexFromRgb,
  isPlainAppearance,
  normalizeAppearance,
  themeSurfaceRgb,
  tintRgb,
  type Appearance,
} from "../runtime/appearance";
import { isPermissionReady, permissionLabel, type Permission } from "../runtime/manifest";
import {
  hasConfigOverrides,
  resolveConfig,
  type ConfigField,
  type ConfigValue,
  type NumberField,
} from "../runtime/config";
import { isTauri, type WidgetRecord } from "../runtime/registry";
import { hasHelp } from "../runtime/help";
import { useT } from "../runtime/i18n";
import { useText } from "../runtime/widget-text";
import { HelpContent } from "./HelpContent";
import { LibSection } from "./LibSection";
import { PanelGlyph, WidgetIconMark } from "./icons";
import { useLattice } from "./store";

interface InspectorPanelProps {
  records: Map<string, WidgetRecord>;
  /** 面板是否展开；收起后退成一条竖条，只留开合按钮 */
  open: boolean;
  onToggle: () => void;
}

/** 输入框的尺寸上限。再大就不是"小组件"了，也没必要让它盖满屏 */
const MAX_SIZE = 2400;

/** 把输入框里的字符串夹成合法尺寸；非法值退回当前值，不要静默改成最小值 */
function clampSize(raw: string, min: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, Math.min(MAX_SIZE, Math.round(value)));
}

interface SliderRowProps {
  /** 左侧那一列，越短越好，面板只有两百多像素宽 */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** 数值框显示几位小数，0 表示取整 */
  decimals?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}

/**
 * 一条滑杆 + 一个数字框。
 *
 * 数字框跟尺寸框一样是"草稿 + 提交"：拖滑杆求手感，输数字求准确，
 * 但边打字边提交的话，输入 "0." 的那一瞬间值就被夹成 0 了。
 */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  decimals = 0,
  onChange,
  ariaLabel,
}: SliderRowProps) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };

  return (
    <div className="lattice-slider-row">
      <span className="lattice-slider-key">{label}</span>
      <input
        type="range"
        className="lattice-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={ariaLabel}
      />
      <input
        type="number"
        className="lattice-slider-num"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft ?? shown}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        aria-label={t("{label} value", { label: ariaLabel })}
      />
    </div>
  );
}

interface ConfigControlProps {
  field: ConfigField;
  value: ConfigValue;
  onChange: (value: ConfigValue) => void;
}

/**
 * 一条配置项。
 *
 * 这五类控件都由**平台**画，组件一行代码都不参与 —— 跟底板、窗饰一样。
 * 组件自己画设置 UI 有两个躲不开的毛病：卡片只有 240×140，塞一条设置就把
 * 内容挤没了；而且组件自己的存储是按 `widgetId` 的，桌面上两个时钟会共享
 * 同一份偏好。属性面板按**实例**渲染，正好是用户期望的粒度。
 */
function ConfigControl({ field, value, onChange }: ConfigControlProps) {
  // 标签 / 说明 / 选项名 / 灰字都是**作者写的**，按当前语言取一份（见 widget-text.ts）
  const text = useText();
  if (field.type === "toggle") {
    return (
      <div className="lattice-config">
        <label className="lattice-switch is-row">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{text(field.label)}</span>
        </label>
        {field.help ? <p className="lattice-hint">{text(field.help)}</p> : null}
      </div>
    );
  }

  return (
    <div className="lattice-config">
      <span className="lattice-config-label">{text(field.label)}</span>
      {field.type === "select" ? (
        <select
          className="lattice-input"
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          aria-label={text(field.label)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {text(option.label)}
            </option>
          ))}
        </select>
      ) : field.type === "number" ? (
        <ConfigNumber field={field} value={Number(value)} onChange={onChange} />
      ) : field.type === "date" ? (
        /*
         * 原生日期控件在这里是**对的**：属性面板在平台窗口里，`color-scheme`
         * 跟着主题走，不会像组件的沙箱那样在深色卡片上变成一块黑药丸。
         * 倒计时原来为了这件事在组件里写了一段按亮度猜明暗的补丁。
         */
        <input
          type="date"
          className="lattice-input"
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          aria-label={text(field.label)}
        />
      ) : (
        <input
          type="text"
          className="lattice-input"
          value={String(value)}
          placeholder={text(field.placeholder)}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
          aria-label={text(field.label)}
        />
      )}
      {field.help ? <p className="lattice-hint">{text(field.help)}</p> : null}
    </div>
  );
}

/**
 * 数字配置项：草稿 + 提交，和尺寸框同一套规矩。
 *
 * 边打字边提交的话，输入 `0.` 的那一瞬间会被夹成 `0`，光标跟着跳；
 * 而每一项改动都会推到桌面窗口，值一路跳就更明显。
 */
function ConfigNumber({
  field,
  value,
  onChange,
}: {
  field: NumberField;
  value: number;
  onChange: (value: ConfigValue) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = useText();

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(field.max, Math.max(field.min, parsed)));
  };

  return (
    <label className="lattice-size-input">
      <input
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.step}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        aria-label={text(field.label)}
      />
      {field.unit ? <span>{field.unit}</span> : null}
    </label>
  );
}

export function InspectorPanel({ records, open, onToggle }: InspectorPanelProps) {
  const t = useT();
  /** 组件名 / 描述 / 配置项文案都是作者写的，按当前语言取一份 */
  const text = useText();
  const selectedId = useLattice((state) => state.selectedInstanceId);
  const placements = useLattice((state) => state.placements);
  const grants = useLattice((state) => state.grants);
  const desktopRects = useLattice((state) => state.desktopRects);
  const setDesktopRect = useLattice((state) => state.setDesktopRect);
  const update = useLattice((state) => state.updatePlacement);
  const remove = useLattice((state) => state.removePlacement);
  const grant = useLattice((state) => state.grant);
  const revoke = useLattice((state) => state.revoke);
  const configs = useLattice((state) => state.configs);
  const setConfig = useLattice((state) => state.setConfig);
  const resetConfig = useLattice((state) => state.resetConfig);
  const theme = useLattice((state) => state.theme);

  const placement = placements.find((item) => item.instanceId === selectedId);
  const record = placement ? records.get(placement.widgetId) : undefined;

  /*
   * 尺寸输入是"草稿 + 提交"的：边打字边写 store 的话，输入 "2" 的那一瞬间
   * 组件就会被缩成 2px，画布跟着跳。所以只在失焦 / 回车时提交。
   */
  const [draft, setDraft] = useState({ w: "", h: "" });
  const editingRef = useRef(false);

  useEffect(() => {
    if (editingRef.current || !placement) return;
    setDraft({ w: String(placement.w), h: String(placement.h) });
  }, [placement?.instanceId, placement?.w, placement?.h]);

  /*
   * "跟随主题"时滑杆也要有个数字，所以要读一次主题底色。等一帧再读，
   * 见 themeSurfaceRgb 的注释。
   */
  const [surfaceRgb, setSurfaceRgb] = useState<[number, number, number]>([255, 255, 255]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSurfaceRgb(themeSurfaceRgb()));
    return () => cancelAnimationFrame(raf);
  }, [theme]);

  /**
   * 改尺寸要同时写两处：画布上的 placement，和桌面窗口记下的矩形。
   *
   * 只写 placement 的话，已经投放到桌面的组件不会变 —— buildSpecs 优先用
   * desktopRects 里的尺寸（那是用户拖边缘改过的真实值）。反过来只写
   * desktopRects，画布上的框又不动。两边一起写，才是一份尺寸。
   */
  const applySize = (w: number, h: number) => {
    if (!placement) return;
    update(placement.instanceId, { w, h });
    const rect = desktopRects[placement.instanceId];
    if (rect) setDesktopRect(placement.instanceId, { ...rect, w, h });
    setDraft({ w: String(w), h: String(h) });
  };

  const commitSize = () => {
    editingRef.current = false;
    if (!placement || !record) return;
    const { minW, minH } = record.manifest.size;
    applySize(clampSize(draft.w, minW, placement.w), clampSize(draft.h, minH, placement.h));
  };

  if (!open) {
    return (
      <aside className="lattice-panel lattice-panel-right is-collapsed">
        <button
          type="button"
          className="lattice-icon-btn is-large"
          onClick={onToggle}
          title={t("Show the inspector")}
          aria-label={t("Show the inspector")}
          aria-expanded={false}
        >
          <PanelGlyph side="right" />
        </button>
        <span className="lattice-panel-rail-label">{t("Inspector")}</span>
      </aside>
    );
  }

  if (!placement || !record) {
    return (
      <aside className="lattice-panel lattice-panel-right">
        <header className="lattice-panel-head">
          <h2 className="lattice-panel-title">{t("Inspector")}</h2>
          <div className="lattice-panel-actions">
            <button
              type="button"
              className="lattice-icon-btn"
              onClick={onToggle}
              title={t("Collapse the inspector")}
              aria-label={t("Collapse the inspector")}
              aria-expanded
            >
              <PanelGlyph side="right" />
            </button>
          </div>
        </header>
        <div className="lattice-panel-body is-empty">
          <div className="lattice-panel-empty">
            <span className="lattice-panel-empty-art" aria-hidden />
            <p className="lattice-hint">
              {t("Select a widget on the canvas to see its layer, size and permissions.")}
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const manifest = record.manifest;
  const granted = grants[manifest.id] ?? [];
  // 实例覆盖优先，缺的键用清单的出厂值补 —— 和 buildSpecs / WidgetFrame 同一套规则
  const configOverrides = configs[placement.instanceId];
  const resolvedConfig = resolveConfig(manifest.config, configOverrides);

  // 实例覆盖优先，没有就退回清单的出厂值 —— 跟 buildSpecs 用的是同一套规则
  const appearance = normalizeAppearance(placement.appearance ?? manifest.appearance);
  const tintHex = appearance.tint === "auto" ? hexFromRgb(...surfaceRgb) : appearance.tint;
  const tint = tintRgb(tintHex) ?? surfaceRgb;
  const isAuto = appearance.tint === "auto";

  /** 只改底板，别动 placement 上的其它字段 */
  const patchAppearance = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    update(placement.instanceId, { appearance: next });
    /*
     * 滑杆要跟手，所以这里直接推一份给桌面窗口。
     *
     * 光靠 store 不够：App 那条同步是 120ms 防抖的，而且每次改动都会把计时器
     * 重新起算 —— 一路拖下去，桌面窗口要等到松手才动，滑杆看起来就是死的。
     *
     * 推失败不要紧（组件还在画布上、没有桌面窗口），下次同步照样会带上它。
     */
    if (isTauri()) {
      void invoke("widget_set_appearance", {
        instanceId: placement.instanceId,
        appearance: next,
      }).catch(() => {});
    }
  };

  /** 拖动任一 R/G/B 滑杆 = 从"跟随主题"变成"就用这个颜色"，起点是当前看起来的颜色 */
  const setChannel = (index: 0 | 1 | 2, raw: number) => {
    const next: [number, number, number] = [...tint];
    next[index] = Math.round(Math.min(255, Math.max(0, raw)));
    patchAppearance({ tint: hexFromRgb(...next) });
  };

  return (
    <aside className="lattice-panel lattice-panel-right">
      <header className="lattice-panel-head">
        <h2 className="lattice-panel-title">
          {record.iconUrl && <WidgetIconMark url={record.iconUrl} size={13} />}
          <span className="lattice-panel-title-text">{text(manifest.name)}</span>
        </h2>
        <div className="lattice-panel-actions">
          {/*
            标题行只剩"收起来"这一件事。

            上一版这颗"移除"就长在收起按钮左边，中间隔 8px —— 想收面板、
            结果删掉了一个组件（好在 `removePlacement` 留了 8 秒撤销）。
            规矩：危险动作永远沉到面板最下面、离开合按钮最远，
            见下面 `.lattice-danger-zone`。别挪回来。
          */}
          <button
            type="button"
            className="lattice-icon-btn"
            onClick={onToggle}
            title={t("Collapse the inspector")}
            aria-label={t("Collapse the inspector")}
            aria-expanded
          >
            <PanelGlyph side="right" />
          </button>
        </div>
      </header>

      <div className="lattice-panel-body">
        <p className="lattice-card-desc">{text(manifest.description) || t("No description")}</p>

        {/*
          "怎么用"放在最上面、默认收起：它是选中共一个组件时最先想知道的事，
          但不该把下面的层级 / 穿透 / 权限挤下去 —— 那些才是要动手的。
          说明来自清单（`runtime/help.ts`），没写就不画这一段。
        */}
        {hasHelp(manifest.help) && (
          <LibSection title={t("How to use")} count={manifest.help.sections.length}>
            <HelpContent help={manifest.help} changelog={manifest.changelog} />
          </LibSection>
        )}

        {/*
          面板拆成三段折叠：位置与层级 / 外观 / 权限与设置。

          上一版是十一项控件平铺在一列里，滚三屏才看得全，而且"底板的浓度"
          和"这个组件能不能联网"看起来同等要紧 —— 它们不是。折叠之后，
          第一屏只回答"它在哪儿、多大"，想调外观或权限再各点一下。

          只有第一段默认展开：改层级和尺寸是选中一个组件之后最常做的事。
          开合状态**只活在这次会话里**（LibSection 的 useState），不落 state.json ——
          用户下次打开面板想要的仍然是"最常做的那段展开"，记住上次摊开了哪几段
          只会让每次打开面板看到的都不一样。
        */}
        <LibSection title={t("Layer & size")} count={null} defaultOpen>
          <section className="lattice-field">
            <span className="lattice-label">{t("Layer")}</span>
            <div className="lattice-segmented">
              {(["desktop", "top"] as const).map((layer) => (
                <button
                  key={layer}
                  type="button"
                  className={`lattice-segment${placement.layer === layer ? " is-active" : ""}`}
                  onClick={() => update(placement.instanceId, { layer })}
                >
                  {layer === "desktop" ? t("Desktop") : t("On top")}
                </button>
              ))}
            </div>
            <p className="lattice-hint">
              {placement.layer === "desktop"
                ? t("Sits above desktop icons and below normal windows, so switching apps never covers it.")
                : t("Floats above every window — good for monitors and readouts.")}
            </p>
          </section>

          <section className="lattice-field">
            <label className="lattice-switch">
              <input
                type="checkbox"
                checked={placement.clickThrough}
                onChange={(event) =>
                  update(placement.instanceId, { clickThrough: event.target.checked })
                }
              />
              <span>{t("Click-through")}</span>
            </label>
            <p className="lattice-hint">
              {t("Mouse events pass straight through — useful for purely decorative widgets.")}
            </p>
          </section>

          <section className="lattice-field">
            <div className="lattice-field-head">
              <span className="lattice-label">{t("Size")}</span>
              <button
                type="button"
                className="lattice-link-btn"
                onClick={() => applySize(manifest.size.w, manifest.size.h)}
              >
                {t("Reset to {w} × {h}", { w: manifest.size.w, h: manifest.size.h })}
              </button>
            </div>
            <div className="lattice-size-grid">
              <label className="lattice-size-input">
                <span>{t("W")}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={manifest.size.minW}
                  max={MAX_SIZE}
                  value={draft.w}
                  onChange={(event) => {
                    editingRef.current = true;
                    setDraft((prev) => ({ ...prev, w: event.target.value }));
                  }}
                  onBlur={commitSize}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      editingRef.current = false;
                      setDraft({ w: String(placement.w), h: String(placement.h) });
                      event.currentTarget.blur();
                    }
                  }}
                  aria-label={t("Widget width")}
                />
              </label>
              <label className="lattice-size-input">
                <span>{t("H")}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={manifest.size.minH}
                  max={MAX_SIZE}
                  value={draft.h}
                  onChange={(event) => {
                    editingRef.current = true;
                    setDraft((prev) => ({ ...prev, h: event.target.value }));
                  }}
                  onBlur={commitSize}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      editingRef.current = false;
                      setDraft({ w: String(placement.w), h: String(placement.h) });
                      event.currentTarget.blur();
                    }
                  }}
                  aria-label={t("Widget height")}
                />
              </label>
            </div>
            <p className="lattice-hint">
              {t("Minimum {w} × {h}. Drag the edges on the canvas, or type an exact value here.", {
                w: manifest.size.minW,
                h: manifest.size.minH,
              })}
            </p>
          </section>
        </LibSection>

        <LibSection title={t("Appearance")} count={null}>
          <section className="lattice-field">
            <div className="lattice-field-head">
              <span className="lattice-label">{t("Backplate")}</span>
            <button
              type="button"
              className="lattice-link-btn"
              onClick={() => update(placement.instanceId, { appearance: undefined })}
              disabled={isPlainAppearance(appearance)}
            >
              {t("Reset to theme")}
            </button>
          </div>

            <div className="lattice-tint-row">
              <label
                className="lattice-swatch"
                style={{ background: tintHex }}
                title={t("Pick a colour")}
              >
                <input
                  type="color"
                  value={tintHex}
                  onChange={(event) => patchAppearance({ tint: event.target.value })}
                  aria-label={t("Backplate colour")}
                />
              </label>
              <code className="lattice-mono lattice-tint-code">{isAuto ? "auto" : tintHex}</code>
              <button
                type="button"
                className="lattice-chip"
                onClick={() => patchAppearance({ tint: "auto" })}
                aria-pressed={isAuto}
                title={t("Follow the light / dark theme")}
              >
                {t("Auto")}
              </button>
            </div>

            {(["R", "G", "B"] as const).map((channel, index) => (
              <SliderRow
                key={channel}
                label={channel}
                value={tint[index]}
                min={0}
                max={255}
                step={1}
                onChange={(value) => setChannel(index as 0 | 1 | 2, value)}
                ariaLabel={t(
                  channel === "R" ? "Backplate red" : channel === "G" ? "Backplate green" : "Backplate blue",
                )}
              />
            ))}

            <SliderRow
              label={t("Fill")}
              value={appearance.alpha}
              min={0}
              max={1}
              step={0.01}
              decimals={2}
              onChange={(value) => patchAppearance({ alpha: value })}
              ariaLabel={t("Backplate fill")}
            />
            <SliderRow
              label={t("Blur")}
              value={appearance.blur}
              min={0}
              max={MAX_BLUR}
              step={0.5}
              decimals={1}
              onChange={(value) => patchAppearance({ blur: value })}
              ariaLabel={t("Backplate blur")}
            />

            <p className="lattice-hint">
              {appearance.alpha === 1 && appearance.blur > 0
                ? t("Fill is at 100%, so nothing shows through — lower Fill to see the frosted wallpaper.")
                : appearance.blur === 0 && appearance.alpha < 1
                  ? t("The wallpaper shows through but is still sharp — raise Blur to frost it.")
                  : t("Fill is how much of the colour covers the backplate, not window transparency. At 0 you get only the frosted wallpaper.")}
            </p>
          </section>
        </LibSection>

        {/*
          最后一段：这台机器上的设置与信任 —— 这一份的选项、这个组件的权限、
          它从哪个目录来。散在三段里都太细，但都回答"它被允许做什么"，
          所以合成一段，默认收起。
        */}
        <LibSection title={t("Permissions & options")} count={null}>
          {manifest.config.length > 0 && (
            <section className="lattice-field">
              <div className="lattice-field-head">
                <span className="lattice-label">{t("Options")}</span>
                <button
                  type="button"
                  className="lattice-link-btn"
                  onClick={() => resetConfig(placement.instanceId)}
                  disabled={!hasConfigOverrides(configOverrides)}
                  title={t("Back to the defaults this widget ships with")}
                >
                  {t("Reset")}
                </button>
              </div>

              {manifest.config.map((field) => (
                <ConfigControl
                  key={field.key}
                  field={field}
                  value={resolvedConfig[field.key]}
                  onChange={(value) => setConfig(placement.instanceId, field.key, value)}
                />
              ))}

              <p className="lattice-hint">
                {t("Options belong to this copy only — two widgets of the same kind can be set up differently.")}
              </p>
            </section>
          )}

          <section className="lattice-field">
            <span className="lattice-label">{t("Permissions")}</span>
            {manifest.permissions.length === 0 ? (
              <p className="lattice-hint">{t("This widget needs no platform permissions.")}</p>
            ) : (
              manifest.permissions.map((permission: Permission) => {
                const enabled = granted.includes(permission);
                const ready = isPermissionReady(permission);
                return (
                  <label
                    key={permission}
                    className={`lattice-switch is-row${ready ? "" : " is-pending"}`}
                    title={ready ? undefined : t("No bridge method backs this permission yet")}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={!ready}
                      onChange={(event) =>
                        event.target.checked
                          ? grant(manifest.id, permission)
                          : revoke(manifest.id, permission)
                      }
                    />
                    <span className="lattice-perm-name">{permissionLabel(permission)}</span>
                    <code className="lattice-mono lattice-perm-code">{permission}</code>
                    {!ready && <span className="lattice-perm-soon">{t("soon")}</span>}
                  </label>
                );
              })
            )}
            <p className="lattice-hint">
              {t("Calls without a granted permission are rejected by the bridge; widgets must degrade gracefully.")}
            </p>
            {manifest.permissions.some((permission) => !isPermissionReady(permission)) && (
              <p className="lattice-hint">
                {t("Permissions marked")} <code className="lattice-mono">{t("soon")}</code>{" "}
                {t("are declared by the widget but the platform has no bridge method behind them yet — granting them would change nothing.")}
              </p>
            )}
          </section>

          <section className="lattice-field">
            <span className="lattice-label">{t("Source")}</span>
            <code className="lattice-mono lattice-path">{record.dir}</code>
          </section>
        </LibSection>

        {/*
          面板最底下那一件"会真的动用户东西"的事：把这一份从画布和桌面上拿走。

          三条规矩：
            · 它不在标题行里（上一版在那儿，紧挨着"收起来"）；
            · 它和上面的设置隔一条线，位置最低、离标题最远；
            · 旁边写清它**不是**卸载 —— 包还在组件库里，再拖出来又是一份。
              用户把"移除一个实例"当成"删掉这个组件"是这个面板最容易误读的一句话。
        */}
        <div className="lattice-danger-zone">
          <p className="lattice-hint">
            {t("Takes this copy off the canvas and the desktop. The widget itself stays in your library.")}
          </p>
          <button
            type="button"
            className="lattice-btn is-danger"
            onClick={() => remove(placement.instanceId)}
          >
            {t("Remove")}
          </button>
        </div>
      </div>
    </aside>
  );
}
