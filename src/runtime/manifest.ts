/**
 * 棂 / Lattice —— 小组件清单（manifest）类型与校验
 *
 * 一个小组件就是一个目录：manifest.json + entry 指向的 HTML 入口。
 * 清单是平台与第三方之间唯一的契约，所有默认值都在这里收敛，
 * 避免各处的兜底逻辑互相漂移。
 */

import { normalizeAppearance, type Appearance } from "./appearance";
import { normalizeConfig, type ConfigField } from "./config";
import { normalizeChangelog, normalizeHelp, type ChangelogEntry, type WidgetHelp } from "./help";
import { t } from "./i18n";
import { normalizeText, type LocalizedText } from "./widget-text";
import { normalizeAgentTools, type AgentToolSpec } from "./widget-tools";

/** 组件在桌面上的层级 */
export type WidgetLayer = "desktop" | "top";

/**
 * 窗口轮廓从哪儿来。
 *
 * `rect`（默认）是平台画的圆角卡片。`region` 表示"这不是一张卡片"：
 * 可见像素和点击命中都由组件通过 `window.setRegion` 上报，平台不画底板、
 * 不画窗饰、不裁圆角 —— 桌宠、悬浮挂件走这条。代价是组件必须自己算
 * 轮廓，而且硬边缘（区域外的像素根本不存在，投影和半透明羽化都会被切掉）。
 */
export type WidgetShape = "rect" | "region";

/**
 * 组件可申请的权限。
 * 平台默认全拒，用户在组件详情里逐项授予；未授予时桥调用直接返回错误。
 */
export type Permission =
  | "clock" // 读取系统时间 / 时区
  | "storage" // 读写组件私有键值存储
  | "clipboard:write" // 写入剪贴板
  | "network" // 发起网络请求
  | "system:monitor" // 读取 CPU / 内存 / 磁盘等指标
  | "media:control" // 控制正在播放的媒体
  | "audio:level" // 读扬声器现在的响度（回环采集，只出一个 0..1）
  | "shell:open" // 把 http/https 链接交给系统默认浏览器
  | "agent:activity" // 读 agent 在本机做过的操作（审计日志）
  | "llm:chat" // 用用户配的模型说话（花的是用户自己的额度）
  | "agent:tools" // 让 agent / assistant 调用这个组件自己声明的工具（数据平面）
  | "terminal:exec" // 在这个终端卡片里跑命令（每个实例一条常驻 PowerShell）
  | "secret" // 在平台的密封库里存/取这个组件自己的 token（按组件 id 隔离）
  | "file:save" // 把内容存成文件或 zip（每次弹保存对话框，用户自己选位置）
  | "desktop:control"; // 让平台替你动桌面（借的是那八个白名单动作）

export interface WidgetSize {
  w: number;
  h: number;
  minW: number;
  minH: number;
}

/**
 * 联网白名单。
 *
 * 光有 `network` 权限不够 —— 那只是"用户允许这个组件联网"。**能连哪儿**
 * 写在清单里，由作者声明、用户在授权界面看到：一个天气组件没理由能连
 * 银行的域名。
 *
 * 两种写法：`example.com`（只匹配 80/443）、`example.com:8080`（钉住端口）。
 * 不支持通配符 —— `*.example.com` 的边界问题（`evil.example.com.attacker.net`）
 * 靠人一遍遍想不划算，多列一行的成本几乎为零。
 */
export interface WidgetNetwork {
  hosts: string[];
}

export interface WidgetManifest {
  /** 反向域名风格，全局唯一，例如 lattice.clock */
  id: string;
  /**
   * 显示名与一句话说明。
   *
   * 类型是 `LocalizedText`：只写一门（字符串）一直是合法的；写成
   * `{ "zh": …, "en": … }` 时平台按界面语言挑一份。作者文案不进 `i18n/*`，
   * 那是平台自己的字 —— 规则见 `runtime/widget-text.ts`。
   */
  name: LocalizedText;
  version: string;
  description: LocalizedText;
  author: string;
  /** 相对组件目录的入口 HTML，默认 index.html */
  entry: string;
  /**
   * 相对组件目录的图标（SVG 优先），空字符串 = 没声明。
   *
   * 只当**形状**用：平台把它当遮罩上色，所以 SVG 里 fill 写什么颜色都无所谓，
   * 彩色图标也会被压成单色剪影 —— 在 30px 的色块里，单色永远比彩色整齐，
   * 而且明暗主题切换不用组件操心。
   */
  icon: string;
  size: WidgetSize;
  layer: WidgetLayer;
  /**
   * 组件要不要键盘焦点。
   *
   * 桌面窗口默认带 `WS_EX_NOACTIVATE`（点了不抢焦点），这对时钟、倒计时这类
   * 只看不摸的组件是对的。但便签、待办这种要打字的不行：窗口拿不到焦点，
   * 光标会闪，按键却全进了后面那个窗口。
   *
   * 所以默认 `true`（能输入），纯展示组件在清单里写 `"interactive": false`
   * 换回"点了不打扰你"的行为。
   */
  interactive: boolean;
  /**
   * 窗口轮廓由谁决定：`rect`（平台圆角，默认）或 `region`（组件上报）。
   *
   * 写 `region` 等于同时声明三件事：不画底板、不画窗饰、背景透明。
   * 三者是同一个决定 —— 一块被裁成宠物形状的窗口没有"卡片"可画。
   */
  shape: WidgetShape;
  permissions: Permission[];
  /**
   * 联网白名单，只有授予 `network` 时才起作用。
   *
   * 空列表 = 哪儿都连不上。这看着苛刻，但方向是对的：漏写一行白名单，
   * 症状是"组件拿不到数据"，一眼就能看出来；反过来（默认放开）漏写一行，
   * 症状是"没人发现"。
   */
  network: WidgetNetwork;
  /** 声明所依赖的 SDK 版本区间，便于将来做兼容性拦截 */
  sdk: string;
  /**
   * 底板的出厂外观（颜色 / 浓度 / 磨砂）。属性面板里可以按实例覆盖，
   * 组件本身不参与 —— 底板是平台画的。
   */
  appearance: Appearance;
  /**
   * 这个组件可以被配置哪些项。
   *
   * 平台据此在属性面板里渲染表单，值按**实例**存（不是按组件），组件用
   * `config.get` 读一份归一化好的完整对象。写坏的字段会被单独丢弃，
   * 不会让整包加载失败 —— 规则见 runtime/config.ts。
   */
  config: ConfigField[];
  /**
   * 怎么用：几节短句，显示在属性面板和组件卡片上。
   *
   * 放在清单里而不是单独一份 README，是为了让它**跟着包走**：同一目录、
   * 同一次提交、同一个签名，想和代码脱节都难。写坏的条目单独丢弃，
   * 不影响组件加载 —— 规则见 runtime/help.ts。
   */
  help: WidgetHelp;
  /**
   * 改了什么：按版本记，新的在前。
   *
   * 这份是**给用户看的**（"更新之后多了什么"），开发决策留在 ROADMAP 和
   * commit 里。和目录里的 `notes` 分工：`changelog` 跟着包走、离线可读，
   * `notes` 是目录侧摘要、只在联网更新时看得到。
   */
  changelog: ChangelogEntry[];
  /**
   * 数据平面：这个组件把自己会做的事**声明成工具**，agent / assistant 经平台调它。
   *
   * 只有清单里同时申请了 `agent:tools` 权限、并且用户授予了，这些工具才会出现在
   * 模型那一侧 —— "允许天气组件联网"不等于"允许 agent 往里塞数据"，两个轴分开。
   * 上限与逐条丢弃的规则见 `runtime/widget-tools.ts`；协议（`agent-call` /
   * `agent-result`）见 WIDGET_SPEC §3.6。
   */
  agent: { tools: AgentToolSpec[] };
}

export const DEFAULT_SIZE: WidgetSize = { w: 240, h: 140, minW: 120, minH: 80 };
export const SUPPORTED_SDK = "^0.1";

export const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/**
 * 图标路径只允许"包内相对路径"。
 *
 * 这个字符串会被拼进 CSS 的 `url("...")` 当遮罩用，所以既不能带引号，
 * 也不能是绝对地址 —— 后者等于让组件清单远程拉图，而清单是第三方内容。
 */
const ICON_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

export class ManifestError extends Error {}

/**
 * 把磁盘上的原始 JSON 归一化成可信的 WidgetManifest。
 * 任何不合法都抛 ManifestError，由注册表决定是跳过还是展示错误卡片。
 */
export function normalizeManifest(raw: unknown, dirName: string): WidgetManifest {
  if (!raw || typeof raw !== "object") {
    throw new ManifestError(t("manifest.json is not an object"));
  }
  const input = raw as Record<string, unknown>;

  const id = requireString(input.id, "id");
  if (!ID_RE.test(id)) {
    throw new ManifestError(t('id "{id}" is not a reverse-domain id, e.g. lattice.clock', { id }));
  }

  const version = requireString(input.version, "version");
  if (!VERSION_RE.test(version)) {
    throw new ManifestError(t('version "{version}" is not a valid semver string', { version }));
  }

  const rawSize = (input.size ?? {}) as Partial<WidgetSize>;
  const size: WidgetSize = {
    w: positive(rawSize.w, DEFAULT_SIZE.w),
    h: positive(rawSize.h, DEFAULT_SIZE.h),
    minW: positive(rawSize.minW, DEFAULT_SIZE.minW),
    minH: positive(rawSize.minH, DEFAULT_SIZE.minH),
  };
  // 初始尺寸不得小于最小尺寸，否则拖拽逻辑会立刻反弹
  size.w = Math.max(size.w, size.minW);
  size.h = Math.max(size.h, size.minH);

  const layer: WidgetLayer = input.layer === "top" ? "top" : "desktop";
  // 只有显式写 false 才关掉：第三方组件忘了声明时，宁可抢一次焦点，
  // 也不要让人对着输入框敲半天没反应
  const interactive = input.interactive !== false;
  // 只有显式写 "region" 才换轮廓：默认必须是卡片，
  // 否则一个笔误就让组件变成一块看不见的剪影（组件没上报区域时窗口是空的）
  const shape: WidgetShape = input.shape === "region" ? "region" : "rect";

  return {
    id,
    name: normalizeText(input.name) || dirName,
    version,
    description: normalizeText(input.description),
    author: optionalString(input.author) || t("Unknown author"),
    entry: optionalString(input.entry) || "index.html",
    icon: normalizeIconPath(input.icon),
    size,
    layer,
    interactive,
    shape,
    permissions: normalizePermissions(input.permissions),
    network: normalizeNetwork(input.network),
    sdk: optionalString(input.sdk) || SUPPORTED_SDK,
    appearance: normalizeAppearance(input.appearance),
    config: normalizeConfig(input.config),
    help: normalizeHelp(input.help),
    changelog: normalizeChangelog(input.changelog),
    agent: { tools: normalizeAgentTools(input.agent) },
  };
}

function normalizePermissions(raw: unknown): Permission[] {
  if (!Array.isArray(raw)) return [];
  const out: Permission[] = [];
  for (const item of raw) {
    // 判据只留一份（`PERMISSION_READY`）。这里以前另抄了一份一模一样的七项名单，
    // 加权限时漏抄一处，表现是"清单里写了、界面上没有"，而且不报错。
    if (typeof item === "string" && PERMISSION_READY.has(item as Permission) && !out.includes(item as Permission)) {
      out.push(item as Permission);
    }
  }
  return out;
}

/**
 * 白名单条目：`host` 或 `host:port`，小写、精确匹配。
 *
 * 写坏一条就丢一条，不整包失败 —— 和图标同一个理由。丢掉的后果是那个主机
 * 连不上（明确的拒绝），而不是悄悄放宽（那才是真问题）。
 */
const NETWORK_HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;

function normalizeNetwork(raw: unknown): WidgetNetwork {
  if (!raw || typeof raw !== "object") return { hosts: [] };
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.hosts)) return { hosts: [] };

  const hosts: string[] = [];
  for (const item of input.hosts) {
    if (typeof item !== "string") continue;
    const host = item.trim().toLowerCase();
    // `*` 会在这里被 NETWORK_HOST_RE 挡掉：不支持通配符
    if (!host || !NETWORK_HOST_RE.test(host) || hosts.includes(host)) continue;
    hosts.push(host);
  }
  return { hosts };
}

/**
 * 图标路径：只接受包内相对路径，其余一律当没声明。
 * 不抛错是刻意的 —— 图标是锦上添花，不该因为写错一个路径就整包加载失败。
 */function normalizeIconPath(value: unknown): string {
  const raw = optionalString(value).replace(/^\.\//, "").replace(/^\/+/, "");
  if (!raw || raw.includes("..") || !ICON_PATH_RE.test(raw)) return "";
  return raw;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ManifestError(t('missing required field "{field}"', { field }));
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/** 权限的显示名，UI 与文档共用一份，避免文案漂移 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  clock: "System time",
  storage: "Widget storage",
  "clipboard:write": "Write clipboard",
  network: "Network access",
  "system:monitor": "System metrics",
  "media:control": "Media control",
  "audio:level": "Sound level",
  "shell:open": "Open links",
  "agent:activity": "Agent activity",
  "llm:chat": "Use my AI model",
  "agent:tools": "Agent tool calls",
  "terminal:exec": "Run commands",
  secret: "Store a secret for me",
  "file:save": "Save files",
  "desktop:control": "Rearrange my desktop",
};

/**
 * 权限名给界面看的那一份（按当前界面语言）。
 *
 * 表和函数分开：`PERMISSION_LABELS` 是**英文原文**，也是中文表的 key ——
 * 上面那句话已经在 `i18n/*` 里有一行对应。所以加一项权限还是"四处一起改"，
 * 只是第四处从"改标签"变成"表里加一行中文"，函数本身不用动。
 */
export function permissionLabel(permission: Permission): string {
  return t(PERMISSION_LABELS[permission] ?? permission);
}

/**
 * 已知权限，也是"能不能声明 / 能不能勾"的唯一判据。
 *
 * `normalizePermissions` 也读这一份 —— 以前那里另抄了一份同样的名单，两处
 * 各改各的，漏一处的表现是"清单里写了、界面上没有"，不报错。
 *
 * 十五项现在全齐了（`media:control` 在 v0.4、`agent:activity` 在 v0.8、
 * `audio:level` / `shell:open` 在 v0.9 补上、`desktop:control` 在 v0.10 末尾补上、
 * `agent:tools` 在数据平面那一版补上、`terminal:exec` 跟着终端组件补上、
 * `secret` 跟着 DPAPI 密封库补上、`file:save` 跟着便签贴图补上）。
 * 加一项权限要**四处一起改**：
 *
 * 1. `Permission` 联合类型
 * 2. 这个集合
 * 3. `PERMISSION_LABELS` 补文案（漏了界面上就是个空标签）
 * 4. `bridge.ts` 里 `defineMethod` 注册方法（漏了组件调不通）
 *
 * 还有第五处：`runtime/catalogue.ts` 的 `KNOWN_PERMISSIONS` —— 那是给商店卡片
 * 认"这个包要什么权限"用的，漏了不会崩，只是卡片上少一行。
 *
 * 界面上那套 `soon`（`isPermissionReady` 为假时禁用开关）现在不会触发了：
 * 集合和联合类型一样长，所以任何能被解析出来的权限都是"已就绪"。留着它是
 * 给"先声明、后实现"留的位子 —— 真要那么干，得先让 `normalizePermissions`
 * 放行集合外的名字，否则声明会在归一化那一步就被丢掉，`soon` 永远没机会出现。
 */
export const PERMISSION_READY: ReadonlySet<Permission> = new Set<Permission>([
  "clock",
  "storage",
  "clipboard:write",
  "system:monitor",
  "network",
  "media:control",
  "audio:level",
  "shell:open",
  "agent:activity",
  "llm:chat",
  "agent:tools",
  "terminal:exec",
  "secret",
  "file:save",
  "desktop:control",
]);

/** 这个权限是不是已经有桥方法了 */
export function isPermissionReady(permission: Permission): boolean {
  return PERMISSION_READY.has(permission);
}

