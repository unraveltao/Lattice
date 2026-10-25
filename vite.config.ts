import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// 浏览器预览里的 assistant：把 llm_* 命令搬到 dev server 的 /api/llm 上
// @ts-expect-error 插件是 .mjs，没带类型声明
import { devLlmProxy } from "./scripts/dev-llm-proxy.mjs";
// 内置组件的错误上报注入：用户组件走 Rust 协议层，内置组件走这里
// @ts-expect-error 插件是 .mjs，没带类型声明
import { widgetDiagnostics } from "./scripts/widget-diagnostics-plugin.mjs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), widgetDiagnostics(), devLlmProxy()],

  // 三个入口：主窗口的平台外壳、每个桌面组件窗口用的宿主页，以及 assistant 小窗
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        widgetHost: "widget-host.html",
        assistant: "assistant.html",
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
