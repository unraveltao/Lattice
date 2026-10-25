#!/usr/bin/env node
/**
 * 包一层 tauri CLI，只为了补本机缺的东西：
 *   1. windres（Rust 的 windows-gnu 工具链不自带，tauri-winres 要用它编 .rc）
 *   2. gcc（windres 默认 spawn 它做预处理，见 .toolchain/gcc-shim）
 *   3. 真正能编译 C 的 gcc（见下）
 *
 * 都放在项目旁边的 .toolchain/ 里，不改系统 PATH，也不动全局环境。
 * 想换位置就设 `LATTICE_TOOLCHAIN` 环境变量。
 *
 * # 为什么从"够用就行"变成"要一个真编译器"
 *
 * 加了自动更新之后，依赖树里第一次出现了 **ring**（更新器的 TLS 要用它）。
 * ring 有几十个 `.c` 文件，构建时由 `cc` crate 现编 —— 而 gcc-shim 只会
 * **把 .c 原样拷成 .o**（它本来只服务 windres 的预处理）。结果是一堆
 * "内容其实是源码"的目标文件，链接时报几百行
 * `undefined reference to ring_core_0_17_14__...`，症状看着像 ABI 问题，
 * 实际是根本没有编译过。
 *
 * 所以这里优先找 `.toolchain/msys64/mingw64/bin/gcc.exe`（MSYS2 装的完整
 * 工具链）；找到了就**不再**把 gcc-shim 放进 PATH —— 让真 gcc 同时承担
 * 预处理和 C 编译。只有在没有真 gcc 时才退回 shim，那种情况下构建
 * 只能编到"不需要 C 编译器"为止。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const toolchain = process.env.LATTICE_TOOLCHAIN || resolve(root, "..", ".toolchain");

const binDir = join(toolchain, "mingw64", "bin");
const shimDir = join(toolchain, "gcc-shim");
const msysBin = join(toolchain, "msys64", "mingw64", "bin");
/**
 * `ld.exe` 的两个依赖（`libintl-8.dll` / `libiconv-2.dll`）。
 *
 * 少了它们 `ld` 一启动就 `STATUS_DLL_NOT_FOUND` 退出，而 GCC 只会转述一句
 * `collect2.exe: error: ld returned 53 exit status` —— 看起来像链接器内存不够，
 * 实际连一句诊断都没打出来。**`cargo build` 连 hello world 都编不过**就是这个。
 * 放在 `.toolchain/intl`（从 MSYS2 的 gettext 里拿的两个 DLL），PATH 里排最前。
 */
const intlDir = join(toolchain, "intl");
/**
 * `x86_64-w64-mingw32-windres` 的替身（见 `.toolchain/windres-shim/windres-shim.rs`）。
 *
 * 有真 gcc 之后 windres 会 spawn **它** 做 `.rc` 预处理，而 MSYS2 gcc 16.2.0 对
 * 任何 `-x` 都静默退出 1（`gcc -E -x c foo.c` 也是 1，没有一行诊断），windres
 * 只会说一句 `windres: preprocessing failed.` —— 整个 Rust 编译停在 build script
 * 上，看着像 windres 装坏了。这一层把 `--preprocessor <gcc-shim>` 塞进去，
 * 让"原样复制"继续承担 `.rc` 预处理（.rc 里没有 `#include`，复制就是对的）。
 */
const windresShimDir = join(toolchain, "windres-shim");

const hasRealGcc = existsSync(join(msysBin, "gcc.exe"));

const prepend = [];
// 链接器的 DLL 依赖排最前：它和工具链是两回事，缺了连 --version 都跑不起来
if (existsSync(join(intlDir, "libintl-8.dll"))) prepend.push(intlDir);
// windres 替身排在真 gcc **之前**：windres 是按名字找 `x86_64-w64-mingw32-windres`
if (existsSync(join(windresShimDir, "x86_64-w64-mingw32-windres.exe"))) {
  prepend.push(windresShimDir);
}
// 真 gcc 排在前面：它的 as/ld 和自带 binutils 配套，混用两套 binutils 会出怪问题
if (hasRealGcc) prepend.push(msysBin);
if (existsSync(join(binDir, "windres.exe"))) prepend.push(binDir);
if (!hasRealGcc && existsSync(join(shimDir, "gcc.exe"))) prepend.push(shimDir);

if (prepend.length === 0) {
  console.warn(`[lattice] 没在 ${toolchain} 找到 windres/gcc，直接沿用系统 PATH。`);
  console.warn("[lattice] 如果编译报 windres 相关错误，见 docs/reference/build.md 的工具链一节。");
} else {
  console.log(`[lattice] 工具链：${prepend.join(" ; ")}`);
  if (!hasRealGcc) {
    console.warn("[lattice] 只有 gcc-shim，没有真 C 编译器：依赖里有 C 代码（ring）时链接会失败。");
    console.warn(`[lattice] 装一个：见 docs/reference/build.md「工具链」一节（${msysBin}）。`);
  }
}

const env = {
  ...process.env,
  PATH: [...prepend, process.env.PATH ?? ""].join(";"),
};

const child = spawn("npx", ["tauri", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
