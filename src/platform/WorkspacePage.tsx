import type { ReactNode } from "react";

interface WorkspacePageProps {
  libraryOpen: boolean;
  inspectorOpen: boolean;
  children: ReactNode;
}

/** 原有组件库、Canvas 与 Inspector 三栏工作台；Canvas 的实例生命周期由调用方保留。 */
export function WorkspacePage({ libraryOpen, inspectorOpen, children }: WorkspacePageProps) {
  return (
    <main
      className={[
        "lattice-main",
        libraryOpen ? "" : "is-left-collapsed",
        inspectorOpen ? "" : "is-right-collapsed",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </main>
  );
}
