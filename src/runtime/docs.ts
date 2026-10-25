/**
 * 帮助页要读的那几份文档，以及"怎么从一份跳到另一份"。
 *
 * # 为什么直接读仓库里的 .md
 *
 * 另一条路是：另写一份给用户看的说明，放进应用里。那条路的结局是**两份说明
 * 各自漂**——改代码的人只改 `docs/`，用户读到的是半年前的版本，而没有任何
 * 东西会报错。这里改成把仓库里那份 Markdown 直接打进包里：文档改了、重新
 * 打包，应用里就是新的。**一份事实一个家**，这条规矩在界面上同样成立。
 *
 * 代价有三个，都认：
 *   1. 文档是中文写的。界面切英文时正文还是中文，所以列表页会说明一句。
 *   2. 文档里有相对链接和图片，得在这里改写（`rewriteImages` / `resolveDocLink`）。
 *   3. 打包体积。`import.meta.glob` **不 eager**，每份文档是独立 chunk，
 *      点开才读 —— 不点开就只是文件躺在安装目录里。
 *
 * # 为什么只列九份
 *
 * `docs/` 下还有 `AGENT_ACCESS.md` / `CODE_SIGNING.md` / `VELA-REUSE.md`
 * 这些专题，以及九份 design 文档。它们**能被链接跳到**（glob 覆盖整个目录），
 * 但不进首页清单：帮助页的第一屏要回答"我该读哪一份"，列二十条就等于没列。
 */

export interface DocEntry {
  id: string;
  /** 仓库里的路径，相对仓库根（`docs/PITFALLS.md`） */
  path: string;
  /** 分组标题，i18n key */
  group: string;
  /** 标题 / 一句话，都是 i18n key */
  title: string;
  summary: string;
}

export const DOCS: DocEntry[] = [
  {
    id: "map",
    path: "docs/README.md",
    group: "Start here",
    title: "Documentation map",
    summary: "Which page answers which question",
  },
  {
    id: "glossary",
    path: "GLOSSARY.md",
    group: "Start here",
    title: "Glossary",
    summary: "Directory, manifest, placement — the words this project reuses",
  },
  {
    id: "spec",
    path: "docs/WIDGET_SPEC.md",
    group: "Building",
    title: "Widget spec",
    summary: "Manifest, bridge, permissions, region art",
  },
  {
    id: "architecture",
    path: "docs/ARCHITECTURE.md",
    group: "Building",
    title: "Architecture",
    summary: "Three layers, sandbox, windows, data",
  },
  {
    id: "pitfalls",
    path: "docs/PITFALLS.md",
    group: "Building",
    title: "Pitfalls",
    summary: "Look up a symptom, not a version",
  },
  {
    id: "rules",
    path: "AGENTS.md",
    group: "Building",
    title: "Platform rules",
    summary: "What platform code must not break",
  },
  {
    id: "build",
    path: "docs/reference/build.md",
    group: "The project",
    title: "Build and release",
    summary: "Toolchain, packaging, the release checklist",
  },
  {
    id: "roadmap",
    path: "docs/ROADMAP.md",
    group: "The project",
    title: "Roadmap",
    summary: "Where it is, what was overturned, what comes next",
  },
  {
    id: "history",
    path: "docs/reference/history.md",
    group: "The project",
    title: "Version archive",
    summary: "The long-form log of every version",
  },
];

/**
 * 打包时把 Markdown 变成"点开才加载"的模块。
 *
 * 键是相对**本文件**的路径（`../../docs/README.md`），所以下面统一用 `key()`
 * 拼；写死字符串的地方只有这一处，搬文件不会散一地。
 */
const SOURCES = import.meta.glob(["../../docs/**/*.md", "../../GLOSSARY.md", "../../AGENTS.md"], {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

/** 文档里的图（架构图、截图）。它们是资源 URL，不是文本，所以 eager 拿地址 */
const ASSETS = import.meta.glob(["../../docs/*.svg", "../../docs/*.png"], {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function key(path: string): string {
  return `../../${path}`;
}

/** 这个仓库路径有没有对应的文档（`docs/design/0007-*.md` 也算） */
export function hasDoc(path: string): boolean {
  return key(path) in SOURCES;
}

/** 读一份文档。读不到返回 `null` —— 调用方显示一句人话，不要抛给用户一个堆栈 */
export async function loadDoc(path: string): Promise<string | null> {
  const loader = SOURCES[key(path)];
  if (!loader) return null;
  return await loader();
}

/** 文档里那张图在包里的地址 */
export function assetUrl(path: string): string | null {
  return ASSETS[key(path)] ?? null;
}

/**
 * 把 `docs/` 下的相对路径按"当前文档所在目录"解析成仓库路径。
 *
 * 只处理 `.` / `..` / 普通段 —— 不做 URL 编码、不认协议。解不出来返回 `null`，
 * 调用方别猜。
 */
export function resolvePath(currentPath: string, target: string): string | null {
  const segments = currentPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/") || null;
}

export type DocLink =
  | { kind: "doc"; path: string; anchor: string }
  | { kind: "anchor"; anchor: string }
  | { kind: "external"; href: string }
  | { kind: "missing"; href: string };

/** 正文里点到一条链接，该干什么 */
export function resolveDocLink(currentPath: string, href: string): DocLink {
  const raw = href.trim();
  if (raw.startsWith("#")) return { kind: "anchor", anchor: raw.slice(1) };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return /^https?:/i.test(raw) ? { kind: "external", href: raw } : { kind: "missing", href: raw };
  }

  const cut = raw.indexOf("#");
  const target = cut >= 0 ? raw.slice(0, cut) : raw;
  const anchor = cut >= 0 ? raw.slice(cut + 1) : "";
  const path = resolvePath(currentPath, target);
  if (path && hasDoc(path)) return { kind: "doc", path, anchor };
  return { kind: "missing", href: raw };
}

/**
 * 把正文里的图片地址换成包里的地址。
 *
 * 必须在**渲染之前**做：渲染器只认"能直接当 src 的字符串"，它不该知道仓库
 * 结构。跳过围栏代码 —— 那些示例里写着 `![alt](./x.png)`，改了就变成假代码。
 */
export function rewriteImages(currentPath: string, source: string): string {
  let inFence = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, src: string) => {
        // 远程图（徽章）原样留着，渲染器会把它降级成 alt 文字
        if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return match;
        const path = resolvePath(currentPath, src);
        const url = path ? assetUrl(path) : null;
        return url ? `![${alt}](${url})` : match;
      });
    })
    .join("\n");
}

/** 正文里第一条标题当名字（用于不在目录里的文档） */
export function docTitleFromMarkdown(source: string): string {
  const match = source.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

/** 路径的最后一段，兜底用（`docs/design/0007-x.md` → `0007-x.md`） */
export function docFileName(path: string): string {
  return path.split("/").pop() ?? path;
}
