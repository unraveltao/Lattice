//! `lattice-widget://` —— 用户组件的静态文件服务
//!
//! 内置组件的文件在 `public/widgets` 里，跟着前端资源一起打包，
//! `/widgets/<id>/index.html` 这条路径就够用了。
//! 用户装的组件不在那儿：它们在 `%APPDATA%\<identifier>\widgets\<id>\`，
//! 是运行期才出现的文件，前端资源里根本没有。所以开一个自定义协议，
//! 把 iframe 的 src 指过来：
//!
//! ```text
//! Windows / Android : http://lattice-widget.localhost/<id>/<相对路径>
//! macOS / Linux     : lattice-widget://localhost/<id>/<相对路径>
//! ```
//!
//! 路径规则只有一条：**第一段是组件 id，剩下的全部是组件目录内的相对路径**。
//! 任何想跳出自己目录的请求（`..`、盘符、反斜杠）一律 404 ——
//! 一个组件只能读到自己的文件，读不到别的组件，更读不到用户的磁盘。
//!
//! 失败的时候不再回一个空 body：文档导航（`<iframe src>`）会拿到一页说明，
//! 见 `diagnostics.rs`。子资源请求还是空 body —— 往一张图的位置塞 HTML
//! 只会让组件拿到一个和真实原因无关的解析错误。

use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext};

use crate::csp;
use crate::diagnostics::{self, Failure};
use crate::widgets;

/// 协议名。前端 `registry.ts` 里有一份同名常量，改这里要一起改。
pub const SCHEME: &str = "lattice-widget";

/// 桌宠皮肤用的第二个协议（LAT-0041）。
///
/// 为什么不复用 `lattice-widget://`：那个协议的根是 `widgets/`，而皮肤在 `pets/`
/// —— 两者是**两套文件约定**（组件有 `manifest.json`，皮肤有 `pet.json`），
/// 混在一个根里之后，"这个目录是组件还是皮肤"要靠试，而不是靠位置。
///
/// 处理逻辑是同一份（`serve`），差别只有根目录和"要不要往 HTML 里塞错误上报脚本"
/// —— 皮肤里没有 HTML，塞不了也不该塞。
pub const PET_SCHEME: &str = "lattice-pet";

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    serve(ctx, request, widgets::user_widgets_dir, true)
}

pub fn handle_pet<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    serve(ctx, request, crate::pet::skins_dir, false)
}

/// 两个协议共用的一份。
///
/// `root_of` 是"这个协议的文件根在哪"，`inject` 是"要不要往 HTML 里塞错误上报脚本"
/// （只有组件文档需要：沙箱 iframe 里的错宿主看不见，见 `diagnostics.rs`）。
fn serve<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    root_of: fn(&tauri::AppHandle<R>) -> Result<PathBuf, String>,
    inject: bool,
) -> Response<Vec<u8>> {
    let method = request.method().as_str().to_owned();
    /*
     * 失败时给不给一页说明，取决于这次请求是不是"文档导航"。
     *
     * 组件 fetch 一张不存在的图、一个不存在的 json 时，绝不能收到 HTML：
     * `await res.json()` 会抛一个和真实原因毫无关系的语法错误，
     * 排查起来比空 body 还难。所以先判断，再决定失败的形状。
     */
    let document = wants_document(&request);

    if method != "GET" && method != "HEAD" {
        return failure_response(Failure::BadMethod, document, "", "", None);
    }

    let path = request.uri().path().to_owned();
    let Some((id, relative)) = split_path(&path) else {
        return failure_response(Failure::BadPath, document, "", &path, None);
    };
    // 组件目录里用反斜杠的情况不存在，统一成正斜杠再给人看
    let requested = relative.to_string_lossy().replace('\\', "/");

    let root = match root_of(ctx.app_handle()) {
        Ok(dir) => dir,
        Err(_) => return failure_response(Failure::NoStorage, document, &id, &requested, None),
    };

    let file = match resolve(&root, &id, &relative) {
        Ok(file) => file,
        Err(failure) => {
            return failure_response(failure, document, &id, &requested, Some(&root))
        }
    };

    let Ok(bytes) = std::fs::read(&file) else {
        return failure_response(Failure::Unreadable, document, &id, &requested, Some(&root));
    };

    // 组件文档里塞一段错误上报脚本 —— 沙箱 iframe 的错宿主看不见，只能这么办。
    // 皮肤目录里没有 HTML（只有 json 和贴图），所以 `inject` 那边是关的。
    let mut body = bytes;
    if inject && mime_of(&file).starts_with("text/html") {
        let injected = std::str::from_utf8(&body)
            .ok()
            .map(|text| diagnostics::inject_reporter(text).into_bytes());
        if let Some(injected) = injected {
            body = injected;
        }
        // 不是合法 UTF-8 的 HTML 原样发：lossy 转换会把字节改掉
    }

    let length = body.len();
    // HEAD 只要头，不必把文件读出来再丢掉
    let body = if method == "HEAD" { Vec::new() } else { body };

    let mime = mime_of(&file);
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, length)
        // 组件是自己写的，改完刷新就得看到新内容，别缓存
        .header(header::CACHE_CONTROL, "no-cache")
        // iframe 是 sandbox="allow-scripts"，文档源是 opaque 的，
        // 组件 fetch 自己的 json/图片在浏览器看来是跨域 —— 放行
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("X-Content-Type-Options", "nosniff");

    /*
     * CSP 只发给文档。浏览器对子资源响应上的 CSP 一律忽略，发给 .js/.css
     * 只是白占几十字节；真正管事的是导航那一次。
     */
    if mime.starts_with("text/html") {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, csp::document_policy());
    }

    builder
        .body(body)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

/// 这次请求是不是要把结果当文档渲染（而不是组件代码在取资源）。
///
/// `Sec-Fetch-*` 由浏览器生成，属于禁止脚本修改的请求头，所以可以信它。
/// 老一点的 WebView 不发这组头，退回看 `Accept`。
fn wants_document(request: &Request<Vec<u8>>) -> bool {
    if let Some(dest) = request
        .headers()
        .get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok())
    {
        // 顶层导航是 document，`<iframe src>` 是 iframe
        return matches!(dest, "document" | "iframe" | "frame");
    }
    request
        .headers()
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"))
}

/// 失败时的响应：导航给一页说明，其余给空 body。
fn failure_response(
    failure: Failure,
    document: bool,
    id: &str,
    relative: &str,
    root: Option<&Path>,
) -> Response<Vec<u8>> {
    let status = StatusCode::from_u16(failure.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    if !document {
        return empty(status);
    }

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        // 说明页随状态变，缓存下来只会让人看到过期的原因
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        // 说明页也是组件协议发出来的 HTML 文档，一样带上策略：
        // 它自己不需要脚本，但"凡是文档都有 CSP"这条规矩别开口子
        .header(header::CONTENT_SECURITY_POLICY, csp::document_policy());
    if failure == Failure::BadMethod {
        builder = builder.header(header::ALLOW, "GET, HEAD");
    }

    // 故意不发 CORS 头：这一页只给导航看。万一被组件 fetch 到了也读不出内容
    builder
        .body(diagnostics::error_document(failure, id, relative, root).into_bytes())
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .expect("an empty header map is always valid")
}

/// `/lattice.todo/index.html` → (`lattice.todo`, `index.html`)
///
/// 返回 None 的几种情况都当作 404 处理，不区分「id 非法」和「文件不存在」：
/// 对组件来说结果一样，对探测者来说少给一点信息。
fn split_path(raw: &str) -> Option<(String, PathBuf)> {
    let trimmed = raw.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    let mut parts = trimmed.splitn(2, '/');
    let id = parts.next()?;
    let rest = parts.next().unwrap_or("");
    if !is_safe_id(id) || rest.is_empty() {
        return None;
    }

    let mut relative = PathBuf::new();
    for segment in rest.split('/') {
        let segment = percent_decode(segment)?;
        if segment.is_empty() || segment == "." {
            continue;
        }
        // 这一层的检查是真正防穿越的地方：解码之后再判断，
        // 免得 `%2e%2e` 这类写法绕过
        if segment == ".." || segment.contains('\\') || segment.contains(':') {
            return None;
        }
        relative.push(segment);
    }

    if relative.as_os_str().is_empty() {
        return None;
    }
    Some((id.to_string(), relative))
}

/// 和安装、备份、报告用的是同一套规则 —— 别再写第二份。
///
/// 以前这里抄了一份，四份都少了"不许以点或连字符开头/结尾"那一句，
/// 于是 `/../index.html` 的 id 是 `..`，`root.join("..")` 直接跳到父目录。
fn is_safe_id(id: &str) -> bool {
    crate::signature_policy::safe_id(id).is_some()
}

/// 把相对路径拼到组件目录下，并确认拼完还在目录里。
///
/// 失败要分类，不能一律 404 —— 兜底页要告诉用户到底是"组件没装"
/// 还是"目录在但文件不在"，这两件事的修法完全不同。
fn resolve(root: &Path, id: &str, relative: &Path) -> Result<PathBuf, Failure> {
    let dir = root
        .join(id)
        .canonicalize()
        .map_err(|_| Failure::MissingWidget)?;
    let candidate = dir
        .join(relative)
        .canonicalize()
        .map_err(|_| Failure::MissingFile)?;
    // 符号链接能绕过上面的分段检查，canonicalize 之后再比一次
    if !candidate.starts_with(&dir) {
        return Err(Failure::BadPath);
    }
    if !candidate.is_file() {
        return Err(Failure::MissingFile);
    }
    Ok(candidate)
}

fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        // 未知类型按二进制发：宁可下载也不要让浏览器猜成 HTML 执行
        _ => "application/octet-stream",
    }
}

/// 只处理 %XX，不处理 `+`（那是 query string 的规则，路径里加号就是加号）
fn percent_decode(input: &str) -> Option<String> {
    if !input.contains('%') {
        return Some(input.to_string());
    }

    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = input.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_splits_into_id_and_relative() {
        let (id, relative) = split_path("/lattice.todo/index.html").unwrap();
        assert_eq!(id, "lattice.todo");
        assert_eq!(relative, PathBuf::from("index.html"));
    }

    #[test]
    fn nested_entry_keeps_its_subdirectory() {
        let (_, relative) = split_path("/demo/src/app.js").unwrap();
        assert_eq!(relative, PathBuf::from("src").join("app.js"));
    }

    #[test]
    fn traversal_is_rejected() {
        assert!(split_path("/demo/../secret.txt").is_none());
        assert!(split_path("/demo/%2e%2e/secret.txt").is_none());
        assert!(split_path("/demo/..%5csecret.txt").is_none());
        assert!(split_path("/demo/C:/Windows/win.ini").is_none());
    }

    #[test]
    fn bad_ids_are_rejected() {
        assert!(split_path("/Lattice.Todo/index.html").is_none());
        assert!(split_path("/../index.html").is_none());
        assert!(split_path("/").is_none());
    }

    #[test]
    fn percent_decoding_handles_utf8() {
        assert_eq!(percent_decode("%E4%BE%BF%E7%AD%BE.html").unwrap(), "便签.html");
        assert_eq!(percent_decode("a+b").unwrap(), "a+b");
    }

    #[test]
    fn mime_covers_the_usual_suspects() {
        assert_eq!(mime_of(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_of(Path::new("a.WOFF2")), "font/woff2");
        assert_eq!(mime_of(Path::new("a.unknown")), "application/octet-stream");
    }
}
