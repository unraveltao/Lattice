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
/*
 * 这个窗口独有的一层样式（底板三层、标题栏按钮、缩放手柄）。
 * 单独一份而不是塞进 styles.css：`styles.css` 是平台外壳的样式层，
 * 而这里的每一条都只在这个窗口里有意义。
 */
import "./assistant-window.css";
import { AssistantWindow } from "./platform/AssistantWindow";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <AssistantWindow />
  </StrictMode>,
);
