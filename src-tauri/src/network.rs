//! 网络白名单代理：`network` 权限真正的落地
//!
//! # 组件不直连
//!
//! 组件文档的 CSP 里 `connect-src` 只有它自己的协议源 —— `fetch("https://…")`
//! 在浏览器层面就抛 `TypeError`。要联网，只能走桥上的 `network.fetch`，
//! 由这里替它发请求。
//!
//! 这条路比"在本地起一个 HTTP 代理、把 `connect-src` 指向它"更严：
//!
//! - 没有本地端口，组件**没有办法**绕过代理直连（HTTP 代理总有 bypass 的缝：
//!   `connect-src` 写 `http://127.0.0.1:PORT` 的同时还得放行别的，否则组件
//!   连自己的 `data.json` 都读不了）
//! - 白名单在 Rust 侧、按**实例**校验，组件改不了自己的清单
//! - 每次请求都能留痕（`LATTICE_NET_TRACE=1`）
//!
//! # 三层闸门
//!
//! 1. **权限**：宿主页必须拿到 `network`（`HostConfig.permissions`），否则直接拒
//! 2. **主机白名单**：清单里的 `network.hosts`，只认列出来的
//! 3. **形状**：只允许 http/https、方法限于 GET/HEAD/POST/PUT/PATCH/DELETE、
//!    请求体 ≤ 256KB、响应 ≤ 1MB、总超时 20 秒
//!
//! # 重定向必须关掉
//!
//! WinHTTP 默认自动跟随重定向 —— 那等于白名单形同虚设：`https://good.com`
//! 302 到 `https://evil.com`，请求就出去了，而白名单只检查了第一跳。
//! 所以 `WINHTTP_OPTION_REDIRECT_POLICY` 设成 `NEVER`，3xx 原样回给组件，
//! 组件要跟就再发一次 —— 那时会重新过一遍白名单。

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use serde::Serialize;
use tauri::State;

use crate::network_policy::{egress_for, host_allowed, parse_url, ALLOWED_METHODS, Target};
use crate::runner::Runner;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Networking::WinHttp::{
    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_REDIRECT_POLICY,
    WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_RAW_HEADERS_CRLF,
    WINHTTP_QUERY_STATUS_CODE, WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
    WinHttpSetOption, WinHttpSetTimeouts,
};

/// 请求体上限。组件的用途是"取一段 JSON / 提交一小段数据"，不是传文件
const MAX_REQUEST_BYTES: usize = 256 * 1024;
/// 响应上限。超过就截断并标记，绝不把 20MB 的字符串塞进 postMessage
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkResponse {
    pub status: u16,
    pub ok: bool,
    /// 头名统一小写；重名只留最后一个（`Set-Cookie` 这种多值头不展开）
    pub headers: BTreeMap<String, String>,
    pub body: String,
    /// 响应超过 `MAX_RESPONSE_BYTES`，被截断了
    pub truncated: bool,
}

/// 发一次请求的**原始**结果：body 是字节，不是字符串。
///
/// 组件那条路（`network_fetch`）随后按 UTF-8 有损转成文本；组件商店那条路
/// （`store.rs`）拿的是 `.lattice` 包，必须一个字节都不许动 —— 所以真正发
/// 请求的这一层只能给字节，转文本是**调用方**的选择。
pub(crate) struct RawResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub truncated: bool,
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

/// 句柄的 RAII 包装：WinHTTP 的 handle 关早关晚都会漏，包一层省心
struct Handle(*mut core::ffi::c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: 句柄是本结构体持有的，只在这里关一次
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}

fn last_error(what: &str) -> String {
    // SAFETY: 只是读线程局部错误码
    let code = unsafe { GetLastError() };
    format!("{what} failed (Win32 error {code})")
}

/// 普通请求等响应体的上限。DNS / 连接 / 发送各有自己的超时，这个只管"连上了
/// 之后多久没字节算超时"
const RECEIVE_TIMEOUT_MS: i32 = 15_000;
/// 流式请求的读超时，**故意只有 1 秒**。
///
/// 取消没有别的地方可以落地：WinHTTP 是阻塞 API，一个正在 `WinHttpReadData`
/// 的句柄不能关（关了是未定义行为），唯一能让控制权回到我们手里的就是"读超时"。
/// 所以每 1 秒回到循环一次，看一眼取消标志，再接着读。正常人看不见这个 1 秒 ——
/// 供应商在吐字的时候根本不会超时。
const STREAM_READ_TIMEOUT_MS: i32 = 1_000;
/// `WinHttpReadData` 读超时的错误码（`ERROR_WINHTTP_TIMEOUT`）
const ERROR_WINHTTP_TIMEOUT: u32 = 12_002;

/// 一次请求的三层句柄。**声明顺序就是析构顺序**：先关请求、再关连接、
/// 最后关会话。反过来的话，子句柄会指着一个已经没了的父句柄。
///
/// 其中 `session` / `connect` 从不被读 —— 它们的作用就是"活到请求结束"。
#[allow(dead_code)]
struct Chain {
    session: Handle,
    connect: Handle,
    request: Handle,
}

impl Chain {
    fn request(&self) -> *mut core::ffi::c_void {
        self.request.0
    }
}

/// 已经拿到响应头、等着读响应体的请求
struct Opened {
    chain: Chain,
    status: u16,
    headers: BTreeMap<String, String>,
}

/// 建会话 → 连接 → 发请求 → 等响应 → 读状态和头。**发完这一步之后两条路
/// （整包读 / 边读边交）就只剩"怎么读 body"不一样了**，所以它必须只有一份。
///
/// `receive_timeout` 是"多久没字节算超时"（毫秒）。普通请求给 15 秒，流式给 1 秒。
fn open(
    target: &Target,
    method: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
    receive_timeout: i32,
) -> Result<Opened, String> {
    let agent = wide("Lattice/0.1");
    // SAFETY: 字符串以 NUL 结尾；AUTOMATIC_PROXY 用系统代理设置（企业环境常见）
    let session = Handle(unsafe {
        WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        )
    });
    if session.0.is_null() {
        return Err(last_error("opening a WinHTTP session"));
    }

    // SAFETY: 句柄有效。四个超时都设，缺一个就可能在 DNS 上挂住十几秒
    unsafe { WinHttpSetTimeouts(session.0, 5_000, 5_000, 10_000, receive_timeout) };

    let host = wide(&target.host);
    // SAFETY: 同上
    let connect = Handle(unsafe {
        WinHttpConnect(session.0, host.as_ptr(), target.port, 0)
    });
    if connect.0.is_null() {
        return Err(last_error("connecting to the host"));
    }

    let verb = wide(method);
    let path = wide(&target.path);
    let flags = if target.secure { WINHTTP_FLAG_SECURE } else { 0 };
    // SAFETY: 同上；不接受自定义 Accept-Type（null）
    let request = Handle(unsafe {
        WinHttpOpenRequest(
            connect.0,
            verb.as_ptr(),
            path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            flags,
        )
    });
    if request.0.is_null() {
        return Err(last_error("opening the request"));
    }

    // 关掉自动重定向：否则 302 一出，白名单只检查了第一跳
    let policy: u32 = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    // SAFETY: 传的是 u32 的指针和长度，选项值就是这个 DWORD
    unsafe {
        WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_REDIRECT_POLICY,
            &policy as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }

    // 头拼成 CRLF 串。Host 由 WinHTTP 自己加，这里不要重复
    let mut header_block = String::new();
    for (name, value) in headers {
        // 头里出现换行 = 头注入，直接拒
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            return Err("a request header contains a line break".to_string());
        }
        header_block.push_str(name.trim());
        header_block.push_str(": ");
        header_block.push_str(value.trim());
        header_block.push_str("\r\n");
    }
    let header_wide = wide(&header_block);
    /*
     * 注意：`WinHttpSendRequest` 的 `dwHeadersLength` 是**字符数**，不是字节数。
     *
     * 这条和别的 Win32 字符串参数不一样（注册表那几个 API 收的是字节数，
     * 见 autostart.rs），传成字节数不会报"参数不对"以外的任何线索 ——
     * 真实症状是每个带自定义头的请求都失败，`GetLastError()` 只给一个
     * `ERROR_INVALID_PARAMETER (87)`。只有不带头的请求能过，所以
     * "组件联网时灵时不灵"会往错误的方向查很久。
     */
    let header_chars = (header_wide.len() - 1) as u32;
    let body_len = body.map(|bytes| bytes.len()).unwrap_or(0) as u32;

    // SAFETY: 指针与长度一一对应；body 为 None 时传空指针 + 0
    let sent = unsafe {
        WinHttpSendRequest(
            request.0,
            if header_block.is_empty() { std::ptr::null() } else { header_wide.as_ptr() },
            if header_block.is_empty() { 0 } else { header_chars },
            body.map(|bytes| bytes.as_ptr() as *const core::ffi::c_void)
                .unwrap_or(std::ptr::null()),
            body_len,
            body_len,
            0,
        )
    };
    if sent == 0 {
        return Err(last_error("sending the request"));
    }

    // SAFETY: 句柄有效
    if unsafe { WinHttpReceiveResponse(request.0, std::ptr::null_mut()) } == 0 {
        return Err(last_error("waiting for the response"));
    }

    let mut status: u32 = 0;
    let mut status_len = std::mem::size_of::<u32>() as u32;
    // SAFETY: 缓冲区是 u32，配合 QUERY_FLAG_NUMBER 拿到数字状态码
    let ok = unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            &mut status as *mut u32 as *mut core::ffi::c_void,
            &mut status_len,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(last_error("reading the status code"));
    }

    let headers = read_headers(request.0);
    Ok(Opened {
        chain: Chain {
            session,
            connect,
            request,
        },
        status: status as u16,
        headers,
    })
}

/// 发一次请求。阻塞 —— 调用方负责丢到线程池里。
///
/// `limit` 是响应体上限：组件那条路是 1MB，商店下载包放宽到 16MB
/// （包本身受 `package_policy` 的 64MB 总量限制，这里只是别把整个文件读进内存
/// 之前就撑爆）。
pub(crate) fn send(
    target: &Target,
    method: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
    limit: usize,
) -> Result<RawResponse, String> {
    let opened = open(target, method, headers, body, RECEIVE_TIMEOUT_MS)?;
    let (body, truncated) = read_body(opened.chain.request(), limit)?;

    Ok(RawResponse {
        status: opened.status,
        ok: (200..300).contains(&opened.status),
        headers: opened.headers,
        body,
        truncated,
    })
}

/// 边收边交出去的两个钩子。
///
/// 分成"来了字节"和"读超时了"两条，是因为它们要做的事不一样：前者解析增量、
/// 可能见到 `[DONE]`；后者只是"这 1 秒什么都没来，顺便问一句还要不要继续"。
pub(crate) struct StreamSink<'a> {
    /// 收到一段原始字节。返回 `false` = 不用再读了
    pub chunk: &'a mut dyn FnMut(&[u8]) -> bool,
    /// 读超时（1 秒没有新字节）。返回 `false` = 用户取消
    pub idle: &'a mut dyn FnMut() -> bool,
}

/// 流式请求的结果。**body 是原始字节**：调用方要自己切 SSE 帧（`llm_policy`），
/// 而且在 `!ok` 时它拿到的是一段普通 JSON 错误体，不是事件流。
pub(crate) struct StreamedResponse {
    pub status: u16,
    pub ok: bool,
    pub body: Vec<u8>,
    pub truncated: bool,
    /// 是钩子叫停的（`[DONE]` 或用户取消），不是读完了
    pub cancelled: bool,
}

/// 发请求，然后**边读边交**。返回时 `body` 里是已经收到的全部字节 ——
/// 流式解析只发生在调用方，这里不解释内容。
pub(crate) fn stream(
    target: &Target,
    method: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
    limit: usize,
    sink: &mut StreamSink,
) -> Result<StreamedResponse, String> {
    let opened = open(target, method, headers, body, STREAM_READ_TIMEOUT_MS)?;
    let Opened { chain, status, .. } = opened;
    let request = chain.request();

    let mut collected: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 16 * 1024];
    let mut truncated = false;
    let mut cancelled = false;

    loop {
        let mut read: u32 = 0;
        // SAFETY: 缓冲区独占，长度对得上
        let ok = unsafe {
            WinHttpReadData(
                request,
                chunk.as_mut_ptr() as *mut core::ffi::c_void,
                chunk.len() as u32,
                &mut read,
            )
        };
        if ok == 0 {
            // SAFETY: 只读线程局部错误码
            let code = unsafe { GetLastError() };
            if code == ERROR_WINHTTP_TIMEOUT {
                // 1 秒没字节：**这里**才是能取消的地方
                if !(sink.idle)() {
                    cancelled = true;
                    break;
                }
                continue;
            }
            return Err(last_error("reading the response body"));
        }
        if read == 0 {
            // 正常收尾（EOF）
            break;
        }
        let piece = &chunk[..read as usize];
        collected.extend_from_slice(piece);
        if collected.len() >= limit {
            collected.truncate(limit);
            truncated = true;
            break;
        }
        if !(sink.chunk)(piece) {
            cancelled = true;
            break;
        }
    }

    Ok(StreamedResponse {
        status,
        ok: (200..300).contains(&status),
        body: collected,
        truncated,
        cancelled,
    })
}

/// 读原始头块，拆成小写名字的 map
fn read_headers(request: *mut core::ffi::c_void) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut size: u32 = 0;

    // 第一遍只问长度：这个 API 用"缓冲区不够"来告诉你该给多大
    // SAFETY: 空缓冲区 + 长度指针是它的标准用法
    unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_RAW_HEADERS_CRLF,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
        )
    };
    if size == 0 {
        return out;
    }

    let mut buffer = vec![0u16; (size as usize / 2) + 1];
    // SAFETY: 缓冲区按上面问到的字节数分配
    let ok = unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_RAW_HEADERS_CRLF,
            std::ptr::null(),
            buffer.as_mut_ptr() as *mut core::ffi::c_void,
            &mut size,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return out;
    }

    let raw = String::from_utf16_lossy(&buffer);
    for line in raw.split("\r\n") {
        // 第一行是 `HTTP/1.1 200 OK`，没有冒号
        let Some((name, value)) = line.split_once(':') else { continue };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        out.insert(name, value.trim().to_string());
    }
    out
}

/// 一直读到没有为止，超过上限就截断
fn read_body(request: *mut core::ffi::c_void, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut collected: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 16 * 1024];

    loop {
        let mut read: u32 = 0;
        // SAFETY: 缓冲区独占，长度对得上
        let ok = unsafe {
            WinHttpReadData(
                request,
                chunk.as_mut_ptr() as *mut core::ffi::c_void,
                chunk.len() as u32,
                &mut read,
            )
        };
        if ok == 0 {
            return Err(last_error("reading the response body"));
        }
        if read == 0 {
            break;
        }
        collected.extend_from_slice(&chunk[..read as usize]);
        if collected.len() >= limit {
            collected.truncate(limit);
            return Ok((collected, true));
        }
    }

    Ok((collected, false))
}

/// 组件侧的入口。
///
/// 参数都走单独的名字而不是一个结构体：桥那边 `params` 的形状由组件决定，
/// 少一层嵌套少一处校验。
///
/// `hosts` 只对**画布上的实例**有用 —— 它们不是窗口，不在注册表里，白名单
/// 只能由宿主页随请求带过来。桌面窗口在册，这个参数被忽略（见 `egress_for`）。
#[tauri::command]
pub async fn network_fetch(
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    url: String,
    method: Option<String>,
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
    hosts: Option<Vec<String>>,
) -> Result<NetworkResponse, String> {
    // 先在同步阶段把该查的都查完：State 不跨 await 持有
    let registered = runner.get(window.label());

    /*
     * 权限这一层只在桌面窗口查得到。
     *
     * 画布上没有 HostConfig，也就没有"用户授了哪几项"—— 但那里不需要：
     * 桥在 JS 侧已经把 `network` 挡在方法表上了（没授权根本发不出这次
     * invoke）。Rust 这边再查一遍，是因为桌面窗口的宿主页在另一个 webview 里，
     * 不能假设它一定挡住了。
     */
    if let Some(config) = &registered {
        if !config.permissions.iter().any(|item| item == "network") {
            return Err("permission not granted: network".to_string());
        }
    }

    let (widget_id, allowed) = egress_for(
        registered.map(|config| (config.widget_id, config.network)),
        hosts,
    )
    .ok_or_else(|| "this window is not a registered widget window".to_string())?;

    let target = parse_url(&url)?;
    if !host_allowed(&allowed, &target) {
        // 这条日志很重要：组件"突然连不上了"和"清单里根本没写这个主机"
        // 从外面看一模一样
        eprintln!(
            "[lattice] network blocked ({}): {} — not in the manifest's network.hosts",
            widget_id, target.host
        );
        return Err(format!(
            "host \"{}\" is not listed in this widget's network.hosts",
            target.host
        ));
    }

    let method = method.unwrap_or_else(|| "GET".to_string()).to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!(
            "method \"{method}\" is not allowed (use GET / HEAD / POST / PUT / PATCH / DELETE)"
        ));
    }

    let headers = headers.unwrap_or_default();
    if headers.len() > 32 {
        return Err("too many request headers (max 32)".to_string());
    }

    let body = body.unwrap_or_default();
    if body.len() > MAX_REQUEST_BYTES {
        return Err(format!(
            "the request body is larger than {} KB",
            MAX_REQUEST_BYTES / 1024
        ));
    }

    if std::env::var("LATTICE_NET_TRACE").is_ok_and(|value| value != "0") {
        eprintln!(
            "[lattice] network {} {} ({} bytes)",
            method,
            url,
            body.len()
        );
    }

    let payload = if body.is_empty() || method == "GET" || method == "HEAD" {
        None
    } else {
        Some(body.into_bytes())
    };

    // WinHTTP 是阻塞 API，扔到线程池里跑，别占着异步运行时的线程
    let result = tauri::async_runtime::spawn_blocking(move || {
        send(&target, &method, &headers, payload.as_deref(), MAX_RESPONSE_BYTES)
    })
    .await
    .map_err(|error| format!("the network request task failed: {error}"))?;

    match &result {
        Ok(response) => {
            if std::env::var("LATTICE_NET_TRACE").is_ok_and(|value| value != "0") {
                eprintln!(
                    "[lattice] network <- {widget_id} {} {}",
                    response.status,
                    response.body.len()
                );
            }
        }
        Err(error) => eprintln!("[lattice] network failed ({widget_id}): {error}"),
    }

    result.map(|raw| NetworkResponse {
        status: raw.status,
        ok: raw.ok,
        headers: raw.headers,
        // 截断点可能落在多字节字符中间，from_utf8_lossy 会把它换成替换符，
        // 不会 panic —— 组件要的是"能读"，不是"一字不差"
        body: String::from_utf8_lossy(&raw.body).to_string(),
        truncated: raw.truncated,
    })
}
