/**
 * 仓库地址，以及"把它打开"这一下。
 *
 * 单独一个文件是因为它是**平台自己唯一一处往外开链接的地方**（组件走的是桥
 * 里的 `shell.open`，权限另算）。放成常量，是为了"这个应用会打开哪些外部
 * 地址"能一眼看全，而不是散在几处 JSX 里。
 *
 * # 为什么没有 star 数
 *
 * 参考的那种关于页会写 `★ 10.8k`。这里不写，两个理由：
 *
 * 1. 它要一次 `api.github.com` 请求。这个应用的卖点之一是"不往外打电话"，
 *    为了一个点不动也照样能点的数字破这条不值 —— AGENTS.md §487 那条
 *    "别在渲染进程里直接 fetch 远端目录"是同一个理由的另一种说法。
 * 2. 一个数字**能看不能点**时，它就只是装饰；而装饰会过期（缓存一天？断网
 *    呢？），过期的东西在这个仓库里一律不画。
 *
 * 要真想加，走 Rust 侧一条命令 + 磁盘缓存，别在渲染进程里 fetch。
 */
import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../runtime/registry";

/** `owner/name`，显示用。仓库换了只改这一行 */
export const REPO = "unraveltao/lattice";

export const REPO_URL = `https://github.com/${REPO}`;

/** 有问题去这儿开一个。帮助页最后一行用它 */
export const ISSUES_URL = `${REPO_URL}/issues`;

/**
 * 仓库里某一份文件在网页上的地址。
 *
 * 分支写死 `main`：这是个只有一条主线的仓库，而 `blob/HEAD/…` 那个写法
 * GitHub 不认。真有一天开了 `dev` 分支，帮助页的"在 GitHub 打开"要跟着改。
 */
export function repoBlobUrl(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}

/**
 * 交给系统默认浏览器。
 *
 * 走 `open_external` 而不是 `window.open`：那条命令会先过 `open_policy`
 * 的协议白名单（只有 http/https），而 WebView 里的 `window.open` 要么被
 * 拦、要么在应用内部开一个新窗口 —— 都不是用户想要的。
 *
 * 浏览器预览（`npm run dev`）里没有那条命令，退回 `window.open` 就行：
 * 那是开发者的浏览器，不是用户的。
 */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await invoke("open_external", { url });
}

export async function openRepo(): Promise<void> {
  await openExternal(REPO_URL);
}
