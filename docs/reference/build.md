# 构建与发版

> 这一页是**操作手册**：照着做就能编出来、发出去。为什么这么设计不在这里 —— 那是 [`../ROADMAP.md`](../ROADMAP.md) 的事。
>
> 只在这台 Windows 机器上验过。换 MSVC 工具链的话，下面「工具链」一节整节作废。

## 一、工具链（windows-gnu）

默认工具链是 `stable-x86_64-pc-windows-gnu`。它不自带 `windres`，也没有 `gcc`，而 `tauri-build` 要用 `windres` 编 `resource.rc`、`windres` 又要调 `gcc -E`。

`scripts/tauri.mjs` 在启动 `tauri` 之前把这些目录塞进 `PATH`：

```
.toolchain/intl                 # ld 的两个 DLL（libintl-8 / libiconv-2），排最前
.toolchain/windres-shim         # 替身 windres：预处理改用 gcc-shim（有真 gcc 时必须用它）
.toolchain/msys64/mingw64/bin   # 完整 mingw-w64 工具链（gcc + as + ld + binutils）
.toolchain/mingw64/bin          # 只有 binutils（windres.exe 在这里）
.toolchain/gcc-shim             # 只做透传的 gcc.exe —— 没有真 gcc 时才用它
```

顺序是四条规矩，每一条都对应一次真实的失败：

1. **`intl` 在最前** —— 它和工具链不是一回事，缺了 `ld` 连 `--version` 都跑不起来。
2. **`windres-shim` 在真 gcc 之前** —— windres 是按名字找 `x86_64-w64-mingw32-windres`。
3. **真 gcc 在 `mingw64/bin` 之前** —— 它的 `as` / `ld` 要和自带 binutils 配套，混用两套会出怪问题。
4. **`gcc-shim` 只在没有真 gcc 时才出现** —— 两个都在，`ring` 的 `.c` 会被原样拷成 `.o`。

### 为什么必须装一个真的 gcc

加了自动更新之后，依赖里第一次出现 `ring`（更新器的 TLS 用它），它有一批 `.c` 文件要现编。而 `gcc-shim` 只会**把 `.c` 原样拷成 `.o`** —— 它本来只服务 `windres` 的预处理。结果是一堆「内容其实是 C 源码」的目标文件，链接时几百行 `undefined reference to ring_core_0_17_14__…`，看着像 ABI 或 LTO 问题，实际是根本没编译过。

诊断方法：`od -An -tx1 -N8 <ring 的 .o>`。正常目标文件开头是机器码，出问题的时候是 `2f 2f 20 43`（`// C`）。

装法不动系统 `PATH`、也不需要 pacman：从 MSYS2 镜像取 `gcc` / `crt` / `headers` / `winpthreads` / `isl` / `gmp` / `mpfr` / `mpc` / `zlib` / `zstd` / `libgcc` / `libstdc++` 这批 `.pkg.tar.zst`，用系统自带的 `bsdtar`（`C:\Windows\System32\tar.exe`，带 libzstd）解到 `.toolchain/msys64/`。包装脚本发现 `.toolchain/msys64/mingw64/bin/gcc.exe`，就把它排在最前，并且**不再**放 `gcc-shim`。

### 装了真 gcc 之后还多一层 `windres-shim`

windres 预处理 `.rc` 时会自己 spawn `gcc -E -xc-header`，而 MSYS2 gcc 16.2.0 对**任何** `-x` 都静默退出 1（一个字的诊断都没有），windres 于是只报一句 `windres: preprocessing failed.`。

替身只做一件事：把 `--preprocessor <.toolchain>/gcc-shim/gcc.exe` 塞进参数再转发给真 windres（`.rc` 里没有 `#include` / `#ifdef`，「原样复制」就是正确的预处理结果），`-V` / `--version` 的探测请求原样转发。改了它要重编，命令在 `windres-shim.rs` 的文件头。

**两个 shim 各管一件事**：`windres-shim` 管「谁来预处理」，`gcc-shim` 管「预处理怎么做」。

### `cargo test` 在这台机器上跑不了

本机安全策略禁止写 `target\debug\deps\*.exe`，而测试二进制正好生成在那里 —— 表现是链接出来的 exe 不完整，一跑就 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`（看着像链接错误，其实是文件没写全）。同一个策略也是「dev 任务莫名挂掉、报 `beforeDevCommand terminated with a non-zero status code`」的真正原因。

换 `CARGO_TARGET_DIR` 也不行 —— 试过 `.scratch/cargo-target`，规则匹配的是 `deps\*.exe` 这个形状，换目录照样拦（还白编了 7 分钟依赖）。

所以这台机器上要完整 `cargo test` 的那 50 条单测，**只能在 CI 或者别的机器上跑**（`ci.yml` 的 `rust` job 在 `windows-latest` 上跑 `cargo test --lib`）。其余 363 条走 `rustc --test` 壳子，见 [`../../AGENTS.md`](../../AGENTS.md) §11。

## 二、构建命令

```bash
npm run tauri:dev      # 开发：前端 HMR + Rust 增量编译
npm run tauri:build    # 出安装包
```

两个都走 `scripts/tauri.mjs` 这个包装脚本，所以工具链那套 `PATH` 自动生效 —— 直接敲 `cargo tauri dev` 会漏掉它。

产物：`src-tauri/target/release/bundle/nsis/Lattice_<version>_x64-setup.exe`（本机实测 2.7 MB）+ 同名 `.sig`。

**改 Rust 之前先停掉应用。** 文件监听触发重建时，旧的 `lattice.exe` 还活着，两个实例抢同一个 WebView2 用户数据目录，新进程直接 panic：`HRESULT(0x800700AA) The requested resource is in use`。前端改动走 HMR，不用停。

## 三、运行时开关

| 变量 | 作用 |
| --- | --- |
| `LATTICE_GPU=1` | 不注入 `--in-process-gpu`，恢复 WebView2 默认行为 |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=...` | 自己指定 WebView2 启动参数（优先级最高） |
| `LATTICE_EGRESS_TRACE=1` | 放行的出网请求也打一行日志（默认只打被拦的） |

## 四、发一个组件版本

```bash
1. 改组件（public/widgets/<id>/ 或自己的目录）
2. 改 manifest.json 的 version（语义化版本，必须三段）
3. npm run store:index        # 打包 + 签名 + 写 registry.json
4. 把 public/store/ 整个目录传上去（内置目录则跟着应用一起发）
```

自己的密钥：`npm run sign:widget -- --gen-key --out publisher.key`，把公钥写进 `registry.json` 的 `publisher.key`。

仓库里那把 `scripts/dev-publisher.key` 是**公开的**，只签官方自带的组件 —— 它证明的是「这个包和这份目录是一起发的」，不是「这个人可信」。公开发布不要用它。

## 五、发一个平台版本

```
1. 改 tauri.conf.json 的 version
2. 打 tag 并推：git tag v0.x.y && git push origin v0.x.y
3. Actions 出草稿 release（不是直接发布）
4. 下载安装包，在一台干净机器上装一遍
5. 回 release 页面点 Publish
6. 旧版本点 Check for updates，确认能升上来
```

**第 3 步别勾 "Set as a pre-release"。** 勾了之后 release 页面正常、产物都在，唯独更新器会去敲的那个地址是 404，而它报出来的话是「检查你的网络」—— 症状和原因长得完全不像。完整的一条在 [`../PITFALLS.md`](../PITFALLS.md)「目录、签名与网络」。

## 六、密钥与产物速查

| | 组件 | 平台 |
| --- | --- | --- |
| 清单 | `registry.json`（目录） | `latest.json`（release 附件） |
| 产物 | `.lattice`（zip，解压即用） | `.exe` / `.msi`（跑安装器） |
| 签名 | ed25519（`scripts/sign-widget.mjs`） | minisign（`tauri signer`） |
| 私钥位置 | 作者自己的机器 | `.keys/updater.key`（不进仓库）+ CI Secrets |
| 装法 | 解到 `%APPDATA%` | 覆盖安装 + 重启 |

两套共用「静态文件 + 签名 + 没有服务端」这个思路，代码路径一行都不重叠。别把 `planInstall` 那套复用到平台更新上 —— 安装包不是解压，是跑一个安装器。

## 七、CI 跑什么

推上去之后 `.github/workflows/ci.yml` 分三个 job，谁红看谁：

| job | 跑什么 | 为什么在这儿 |
| --- | --- | --- |
| `frontend` | `typecheck` → `build` → `test:injection` → `test:sdk` → `test:agent` → `test:tokens` → `check:tokens` → `check:docs` | 都不需要 dev server，几秒钟跑完 |
| `browser` | 起 dev server → `test:browser`（全部 `tests/*.html`） | 页面 import 的是 `.ts` / `.tsx`，必须有转译；本机也能跑，只是慢 |
| `rust` | `cargo test --lib` | **本机跑不了**（安全策略拦 `target/debug/deps` 下的 exe），runner 是唯一的机会 |

`ci.yml` 里有一句话值得抄在这儿：**不写具体条数**。写过一次，写的时候就已经过期了 —— 没有人会去核一个注释。要数字就跑命令，或者看 README（那个有 `check:docs` 盯着）。

`check:docs` 管两件事：**相对链接是否可达**，以及 **README 的数字和代码对不对得上**。计数类（组件 / 权限 / 命令 / 坑）必须精确相等；六项代码行数按 **1% 容差** —— 行数每次提交都动，精确相等会让每个 PR 都得改 README，而一张没人愿意维护的表最后会被删掉。改完文档先在本地跑一次，别等 CI 告诉你。

## 八、发版的三条规矩

照着做只要记住这三句，**论证**在 [`../ROADMAP.md`](../ROADMAP.md) v0.7 的「三条边界，别改」：

1. **只在用户点击时检查**，不后台轮询。一年发几次版，让每台机器每天替你发一次请求，换来的只是「可能早点知道」。
2. **release 先出草稿**，在一台干净机器上验过再点 Publish。反过来（先发再验）就是「所有用户帮你做灰度」。
3. **装完必须 `restart()`，不是 `exit()`**。新二进制只有新进程才会跑；更新完应用自己消失，在用户眼里就是更新失败。走自定义命令 `restart_app`（`app.restart()`），不引 `@tauri-apps/plugin-process` —— 少一个依赖，行为一样。
