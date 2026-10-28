/**
 * 每实例配置：清单声明 schema，属性面板渲染表单，组件读值。
 *
 * # 为什么配置该归平台管
 *
 * 组件自己画设置 UI 有两个毛病，都在官方组件里现过身：
 *
 * 1. **空间不够**。卡片只有 240×140，塞进一条设置项就把内容挤没了 —— 倒计时
 *    原来在卡片底部放了一个原生 `<input type="date">`，还得自己算 `color-scheme`
 *    才能让它别在深色卡片上变成一块黑药丸（见它原来的 `syncInputScheme`）。
 * 2. **粒度不对**。组件自己存的偏好是按 `widgetId` 的，所以桌面上放两个时钟，
 *    切一个 24 小时制，另一个跟着变。而"字号 / 显示秒 / 目标日期"这种东西
 *    天然是**每个实例**一份 —— 这正是 `Placement` 的粒度，不是组件存储的粒度。
 *
 * 所以：清单里声明 `config`，属性面板按 schema 渲染，值按 `instanceId` 存在
 * `state.json` 里，组件通过 `config.get` 拿一份**已经归一化好**的完整对象。
 *
 * # 为什么 `date` 单独一个类型
 *
 * 日期是配置里最常见的一项（倒计时、纪念日、截止日），而 `<input type="date">`
 * 在不同语言/主题下的长相差别很大。平台窗口的 `color-scheme` 是对的，原生控件
 * 在属性面板里不别扭；搬进组件的沙箱就又要自己算一遍亮度。多一个类型，
 * 换掉的是一整段组件里的补丁代码。
 *
 * # 边界
 *
 * - 未知键、类型不对、越界的值一律退回出厂值。schema 是第三方声明的，
 *   宿主不能因为一个字段写坏就把整个组件打死，也不能把 `NaN` 递给组件。
 * - 最多 12 个字段。属性面板只有 320px 宽，再多就不是"配置"了，
 *   那种组件该自己画一个设置页。
 */

import { normalizeLine, normalizeText, type LocalizedText } from "./widget-text";

/** 配置值只有这三种。对象和数组一律不支持 —— 属性面板没法通用地渲染它们 */
export type ConfigValue = string | number | boolean;

/** 一个实例的配置：只存"改过的键"，没改过的由 schema 的 default 补 */
export type ConfigValues = Record<string, ConfigValue>;

/**
 * 标签类的文案都是 `LocalizedText`：作者可以写一门字符串，也可以写
 * `{ zh, en }` 让平台按界面语言挑（见 `runtime/widget-text.ts`）。`unit`
 * 例外 —— 它是 `px` / `s` / `%` 这种语言无关的符号，写成两门反而奇怪。
 */
export interface ConfigOption {
  value: string;
  label: LocalizedText;
}

interface BaseField {
  key: string;
  label: LocalizedText;
  /** 一句话说明，显示在控件下面。空串表示不显示 */
  help: LocalizedText;
}

export interface ToggleField extends BaseField {
  type: "toggle";
  default: boolean;
}

export interface NumberField extends BaseField {
  type: "number";
  default: number;
  min: number;
  max: number;
  step: number;
  /** 后缀单位，例如 `px` / `s`。空串表示不显示 */
  unit: string;
}

export interface TextField extends BaseField {
  type: "text";
  default: string;
  /** 输入框里的灰字，也是用户能看到的字，所以同样可以写成两门 */
  placeholder: LocalizedText;
  maxLength: number;
}

export interface SelectField extends BaseField {
  type: "select";
  default: string;
  options: ConfigOption[];
}

export interface DateField extends BaseField {
  type: "date";
  /** `YYYY-MM-DD`；空串表示"没设过"，由组件自己决定退到什么 */
  default: string;
}

export type ConfigField = ToggleField | NumberField | TextField | SelectField | DateField;

/** 属性面板能塞下的上限。超过这个数就该组件自己画设置页了 */
export const MAX_CONFIG_FIELDS = 12;
/** 文本字段的硬上限，防止有人把一整篇文章塞进 state.json */
const MAX_TEXT_LENGTH = 2000;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 归一化清单里的 `config`。
 *
 * 写坏的字段**单独丢弃**，不让整包加载失败 —— 配置是锦上添花，跟 `icon` 一样：
 * 一个字段名写错，不该让用户看不见这个组件。丢掉的字段在属性面板里不会出现，
 * 组件 `config.get` 也拿不到它，行为等同于"没声明"。
 */
export function normalizeConfig(raw: unknown): ConfigField[] {
  if (!Array.isArray(raw)) return [];

  const fields: ConfigField[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (fields.length >= MAX_CONFIG_FIELDS) break;
    if (!item || typeof item !== "object") continue;
    const input = item as Record<string, unknown>;

    const key = typeof input.key === "string" ? input.key.trim() : "";
    // 键会变成组件里 `config.get()` 返回对象的属性名，必须能安全地写进 JSON
    if (!KEY_RE.test(key) || seen.has(key)) continue;

    const field = buildField(key, input);
    if (!field) continue;

    seen.add(key);
    fields.push(field);
  }

  return fields;
}

function buildField(key: string, input: Record<string, unknown>): ConfigField | null {
  // 标签没写就用键名：键名是英文，总比空着强
  const label = normalizeText(input.label) || key;
  const help = normalizeText(input.help);

  switch (input.type) {
    case "toggle":
      return { key, label, help, type: "toggle", default: input.default === true };

    case "number": {
      const min = finite(input.min, 0);
      const max = finite(input.max, 100);
      // min > max 是写错了，交换而不是丢弃：两个数都在，只是顺序反了
      const [low, high] = min <= max ? [min, max] : [max, min];
      const step = Math.abs(finite(input.step, 1)) || 1;
      const fallback = finite(input.default, low);
      return {
        key,
        label,
        help,
        type: "number",
        min: low,
        max: high,
        step,
        unit: normalizeLine(input.unit, 6),
        default: clamp(fallback, low, high),
      };
    }

    case "text":
      return {
        key,
        label,
        help,
        type: "text",
        default: typeof input.default === "string" ? input.default.slice(0, MAX_TEXT_LENGTH) : "",
        placeholder: normalizeText(input.placeholder, 80),
        maxLength: Math.min(MAX_TEXT_LENGTH, Math.max(1, Math.round(finite(input.maxLength, 120)))),
      };

    case "select": {
      const options = normalizeOptions(input.options);
      // 没有可选项的 select 是坏的：渲染出来是一个永远空的框
      if (options.length === 0) return null;
      const wanted = typeof input.default === "string" ? input.default : "";
      const known = options.some((option) => option.value === wanted);
      return {
        key,
        label,
        help,
        type: "select",
        options,
        default: known ? wanted : options[0].value,
      };
    }

    case "date": {
      const wanted = typeof input.default === "string" ? input.default.trim() : "";
      return {
        key,
        label,
        help,
        type: "date",
        default: isDate(wanted) ? wanted : "",
      };
    }

    default:
      // 不认识的类型：宁可少一个开关，也不要渲染一个不会生效的控件
      return null;
  }
}

function normalizeOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ConfigOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (options.length >= 12) break;
    // 允许写 `"a"` 这种简写，label 就用 value 本身
    const value = typeof item === "string" ? item : null;
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const resolved = value ?? (typeof record?.value === "string" ? record.value : "");
    if (!resolved || seen.has(resolved)) continue;
    // 没写 label（或者两门都不可用）就用 value 本身当显示名
    const label = normalizeText(record?.label, 40) || resolved;
    seen.add(resolved);
    options.push({ value: resolved.slice(0, 40), label });
  }
  return options;
}

/**
 * 把"用户改过的键"套到 schema 上，得到组件该看到的那份完整对象。
 *
 * 三条规则：
 * - 没改过的键用 `default` 补上，所以组件永远不用自己处理 `undefined`
 * - 改过但非法的值（类型错、越界、选项不存在）退回 `default`，不是退回
 *   "上一次的值" —— 宿主不记历史，记了就会出现"两个窗口看到的不一样"
 * - 只返回 schema 里有的键。用户从旧版本升上来、清单删掉了某个字段时，
 *   那份残留的 override 会被安静地忽略，不会漏给组件
 */
export function resolveConfig(
  fields: ConfigField[],
  overrides?: Record<string, unknown> | null,
): ConfigValues {
  const out: ConfigValues = {};
  for (const field of fields) {
    const raw = overrides ? overrides[field.key] : undefined;
    switch (field.type) {
      case "toggle":
        out[field.key] = typeof raw === "boolean" ? raw : field.default;
        break;
      case "number": {
        const value = typeof raw === "number" && Number.isFinite(raw) ? raw : field.default;
        out[field.key] = clamp(value, field.min, field.max);
        break;
      }
      case "text":
        out[field.key] =
          typeof raw === "string" ? raw.slice(0, field.maxLength) : field.default;
        break;
      case "select":
        out[field.key] =
          typeof raw === "string" && field.options.some((option) => option.value === raw)
            ? raw
            : field.default;
        break;
      case "date":
        out[field.key] = typeof raw === "string" && isDate(raw) ? raw : field.default;
        break;
    }
  }
  return out;
}

/**
 * 一份 patch 能不能写进去。`null` = 可以，否则返回一句**能直接给模型看**的话。
 *
 * 为什么不在写完再靠 `resolveConfig` 兜：那个函数对非法值是**安静地退回出厂值**
 * （它服务的是"读"，读的人不该因为一个坏字段拿到 `NaN`）。放到写这条路上就变成
 * "写成功了，但值没变" —— 模型没有任何办法从结果里看出自己写错了，只会重试或
 * 者宣布做到了。写之前判，判不过就拒绝。
 *
 * 也不做"部分接受"：三条里错一条就整份拒。半个 patch 落盘之后，用户看到的是
 * 一个既不是旧值也不是新值的配置。
 */
export function configPatchError(
  fields: ConfigField[],
  patch: Record<string, unknown>,
): string | null {
  const keys = Object.keys(patch);
  if (keys.length === 0) return "patch is empty";
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of keys) {
    const field = byKey.get(key);
    if (!field) return `this widget has no config field named ${JSON.stringify(key)}`;
    const value = patch[key];
    switch (field.type) {
      case "toggle":
        if (typeof value !== "boolean") return `${key} must be true or false`;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return `${key} must be a number`;
        if (value < field.min || value > field.max) {
          return `${key} must be between ${field.min} and ${field.max}`;
        }
        break;
      case "text":
        if (typeof value !== "string") return `${key} must be a string`;
        if (value.length > field.maxLength) {
          return `${key} is longer than ${field.maxLength} characters`;
        }
        break;
      case "select":
        if (typeof value !== "string" || !field.options.some((option) => option.value === value)) {
          return `${key} must be one of ${field.options.map((option) => option.value).join(", ")}`;
        }
        break;
      case "date":
        if (typeof value !== "string" || !isDate(value)) return `${key} must be a YYYY-MM-DD date`;
        break;
    }
  }
  return null;
}

/** 这个实例有没有改过任何一项（属性面板据此决定 Reset 按钮可不可点） */export function hasConfigOverrides(overrides?: Record<string, unknown> | null): boolean {
  return !!overrides && Object.keys(overrides).length > 0;
}

/** `YYYY-MM-DD`，而且必须是真实存在的日期（挡掉 2027-02-31） */
export function isDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  // 用 UTC 构造：本地时区的 Date 在夏令时切换那天会把日期挪一天
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
