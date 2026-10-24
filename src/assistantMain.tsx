/**
 * assistant 桌面小窗的入口。
 *
 * 和 `main.tsx` 分开是**故意的**：主入口会拉起整个平台外壳（画布、面板、
 * 桌面同步、agent 桥）。这个窗口只要一块对话面板 —— 装不下的东西越多，
 * 两个窗口"谁在改状态"的边界就越容易糊掉。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { AssistantWindow } from "./platform/AssistantWindow";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <AssistantWindow />
  </StrictMode>,
);
