/**
 * `file.save` 的参数规则：这名字能不能当文件名、这一趟是写一个文件还是打一个 zip、
 * 扩展名该补哪个。
 *
 * # 为什么不叫 `file.write`
 *
 * `file.write` 在 `hands.rs` 里已经是"助手直接写盘"：带审批、能覆盖任意路径。
 * 组件这条路完全相反 —— **每次弹保存对话框、用户自己选位置**。一个词两个意思，
 * 后面所有人都会搞混，所以名字必须分开（见 design/0028）。
 *
 * # 三条规矩
 *
 * - **`name` 只当文件名，不当路径**。组件递上来的名字里出现 `/` `\` `:` 就是坏参
 *   数（那是"想写到别处去"的形状）。真正落盘之前 `export_policy.rs` 还会再判一遍：
 *   这一份挡的是"组件写错了"，那一份挡的是"有人绕过了这一份"。
 * - **取消不是错误**。Rust 回 `{ok:false, cancelled:true}` 时界面一个字都不要说 ——
 *   把"我不想存了"报成红字是这个仓库反复踩过的坑。
 * - **单文件还是 zip 由内容决定，不由用户决定**。一个文件、而且给的是 `text`，
 *   就写那个文件；只要多一个文件、或者任意一个给了 `base64`，就打成一个 zip。
 *   `base64` 在 zip 里是字节（图片），单文件路径只认文本 —— Markdown 是文本格式。
 *
 * 纯函数，没有 Tauri、没有 DOM：`tests/export.html` 直接跑。
 */

/** 保存框里那个名字的长度上限。Windows 的路径总长比它宽松得多，这里防的是"一整段话当名字" */
export const MAX_SAVE_NAME_CHARS = 120;
/** 一趟最多几个文件。便签导出是 1（正文）+ 8（图），64 已经够任何正常用法 */
export const MAX_SAVE_FILES = 64;
/** 单个文件的字节上限（解 base64 之后的估算值） */
export const MAX_SAVE_FILE_BYTES = 8 * 1024 * 1024;
/** 一整趟的字节上限 */
export const MAX_SAVE_TOTAL_BYTES = 16 * 1024 * 1024;

const FORBIDDEN_IN_NAME = /[\\/:*?"<>|]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 一个要写出去的文件：要么是文本，要么是一段 base64 字节 */
export interface SaveFile {
  /** zip 内的相对路径（`note.md` / `images/1.webp`）；单文件时只当提示 */
  name: string;
  text?: string;
  base64?: string;
}

/**
 * 单文件文档的形状（design/0031）。
 *
 * **它不决定要不要打 zip** —— 那是内容的事（多文件或带 base64 一律 zip）。它只
 * 决定两件跟"单个文本文件"有关的事：补哪个扩展名、保存框里挂哪个过滤器。
 *
 * 为什么要有它、而不是让组件把 `.html` 写进 `name` 里：用户在保存框里会把名字
 * 改掉（`周报.md`）。改完就再也看不出"这份东西本来是网页"，于是 HTML 会被写进
 * 一个 `.md` 文件 —— 而那正是"别信用户在对话框里敲的名字"要挡的事。
 */
export type SaveDocument = "md" | "html";

export interface SaveRequest {
  /** 用户会看到、也能改的那个名字（不含扩展名也一样能过，扩展名由 `withSaveExtension` 补） */
  name: string;
  /** 单文件时那份文档是什么。缺省 `md` */
  document: SaveDocument;
  files: SaveFile[];
}

export type SavePlan =
  | { ok: true; request: SaveRequest; zip: boolean }
  | { ok: false; error: string };

/**
 * 清一遍名字。返回 `null` = 这个名字不能当文件名。
 *
 * 只做"形状"判断：控制字符、路径分隔符、Windows 不允许的九个头、`..`、长度。
 * 不去猜用户的意图（不加前缀、不替换成下划线）—— 出错就回 `bad_params`，让组件
 * 自己改一个名字，比平台悄悄改成另一个文件更好查。
 */
export function cleanSaveName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name) return null;
  if (name.length > MAX_SAVE_NAME_CHARS) return null;
  if (FORBIDDEN_IN_NAME.test(name)) return null;
  if (CONTROL_CHARS.test(name)) return null;
  if (name === "." || name === "..") return null;
  return name;
}

/** zip 内路径的形状：相对、`/` 分隔、没有 `..`、没有盘符 */
export function cleanEntryName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_SAVE_NAME_CHARS * 4) return null;
  if (CONTROL_CHARS.test(name)) return null;
  if (name.includes("\\") || name.includes(":")) return null;
  if (name.startsWith("/") || name.endsWith("/")) return null;
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return name;
}

/**
 * base64 解码之后大概多少字节。
 *
 * 不真的解码：这一层只判额度，解码是 Rust 的活（那边失败就整包失败）。估算按
 * `len * 3 / 4` 再去掉 padding 算 —— 和真实值最多差 2 字节，对上限判断没有影响。
 */
export function base64Bytes(text: string): number {
  if (!text) return 0;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

/** 这一组文件要不要打成 zip */
export function saveNeedsZip(files: readonly SaveFile[]): boolean {
  return files.length > 1 || files.some((file) => typeof file.base64 === "string");
}

/**
 * 把 `file.save` 的原始参数收成一份干净的请求。
 *
 * 任何一处不合格都是 `{ok:false}`，由桥翻成 `bad_params` —— 不要"尽量修好再写"：
 * 名字被悄悄改掉、图片被悄悄丢掉，用户在保存框里看到的和实际写出去的不是一回事。
 */
export function planSave(params: unknown): SavePlan {
  if (!params || typeof params !== "object") return { ok: false, error: "file.save takes an object" };
  const raw = params as { name?: unknown; files?: unknown; document?: unknown };
  const name = cleanSaveName(raw.name);
  if (!name) return { ok: false, error: `"name" must be a plain file name of at most ${MAX_SAVE_NAME_CHARS} characters` };
  // 不认的值直接拒：猜一个的下场是用户拿到一个后缀不对的文件，而他不会去看日志
  const document: SaveDocument = raw.document === undefined ? "md" : (raw.document as SaveDocument);
  if (document !== "md" && document !== "html") {
    return { ok: false, error: '"document" is either "md" or "html"' };
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    return { ok: false, error: "file.save needs at least one file" };
  }
  if (raw.files.length > MAX_SAVE_FILES) {
    return { ok: false, error: `at most ${MAX_SAVE_FILES} files at a time` };
  }

  const files: SaveFile[] = [];
  let total = 0;
  for (const item of raw.files) {
    if (!item || typeof item !== "object") return { ok: false, error: "every file needs a name and text or base64" };
    const entry = item as { name?: unknown; text?: unknown; base64?: unknown };
    const entryName = cleanEntryName(entry.name);
    if (!entryName) return { ok: false, error: "every file needs a safe relative name" };
    const hasText = typeof entry.text === "string";
    const hasBase64 = typeof entry.base64 === "string";
    if (hasText === hasBase64) {
      return { ok: false, error: `"${entryName}" needs exactly one of "text" or "base64"` };
    }
    const bytes = hasText ? (entry.text as string).length : base64Bytes(entry.base64 as string);
    if (bytes > MAX_SAVE_FILE_BYTES) {
      return { ok: false, error: `"${entryName}" is larger than ${MAX_SAVE_FILE_BYTES} bytes` };
    }
    total += bytes;
    if (total > MAX_SAVE_TOTAL_BYTES) {
      return { ok: false, error: `all files together may hold at most ${MAX_SAVE_TOTAL_BYTES} bytes` };
    }
    files.push(hasText ? { name: entryName, text: entry.text as string } : { name: entryName, base64: entry.base64 as string });
  }

  return { ok: true, request: { name, document, files }, zip: saveNeedsZip(files) };
}

/** 内容和扩展名对不上时，把名字里的那个换掉 */
const SWAPPABLE = [".md", ".markdown", ".zip", ".txt", ".html", ".htm"];

/**
 * 按内容补扩展名（`zip` 决定 `.zip`，否则按 `document` 补 `.md` / `.html`）。
 *
 * 用户可能在对话框里把名字改成一个没有扩展名的词，也可能改成一个别的扩展名。
 * 规则只有三条：已经是想要的那个就留着；是这几个"文本 / 压缩包"的另一个就换成想要
 * 的那个（`note.zip` 但内容是正文 → `note.md`，`周报.md` 但内容是网页 → `周报.html`）；
 * 其余（`图表.v2`）在后面接一个。
 */
export function withSaveExtension(name: string, zip: boolean, document: SaveDocument = "md"): string {
  const want = zip ? ".zip" : document === "html" ? ".html" : ".md";
  const lower = name.toLowerCase();
  if (lower.endsWith(want)) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot) : "";
  if (SWAPPABLE.includes(ext)) return name.slice(0, dot) + want;
  return name + want;
}

/** 桥回给组件的形状：写成功 */
export function savedResult(path: string): { ok: true; path: string } {
  return { ok: true, path };
}

/**
 * 桥回给组件的形状：用户取消了。
 *
 * 没有 `error`、没有 `code` —— 界面上不该出现任何红字。`cancelled` 这个字段本身
 * 就是给组件判断用的，所以组件可以据此"什么都不做"。
 */
export function cancelledResult(): { ok: false; cancelled: true } {
  return { ok: false, cancelled: true };
}
