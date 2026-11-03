import { act } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { AppShell } from "../src/platform/AppShell";
import { Canvas } from "../src/platform/Canvas";
import { DashboardPage } from "../src/platform/DashboardPage";
import { WorkspacePage } from "../src/platform/WorkspacePage";
import { useLattice } from "../src/platform/store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const lines: string[] = [];
const log = (pass: boolean, message: string) => lines.push(`${pass ? "PASS" : "FAIL"} ${message}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  useLattice.setState({ sidebarExpanded: true });
  const root = createRoot(document.querySelector<HTMLDivElement>("#app")!);
  await act(async () => {
    root.render(
      <AppShell
        topbar={null}
        dashboard={<DashboardPage />}
        workspace={<WorkspacePage libraryOpen inspectorOpen><Canvas records={new Map()} installedIds={new Set()} onDropWidget={() => {}} /></WorkspacePage>}
      />,
    );
  });
  await act(async () => wait(30));

  log(useLattice.getState().activeView === "dashboard", "new session opens Dashboard by default");
  const canvas = document.querySelector<HTMLElement>(".lattice-canvas");
  log(canvas !== null, "Canvas is mounted inside Workspace");
  const originalCanvas = canvas;

  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>(".lattice-nav-item")]
      .find((button) => button.textContent?.trim() === "Workspace")
      ?.click();
  });
  const workspace = document.querySelector<HTMLElement>('.lattice-page-layer[aria-label="Workspace"]');
  const dashboard = document.querySelector<HTMLElement>('.lattice-page-layer[aria-label="Dashboard"]');
  log(document.querySelector(".lattice-canvas") === originalCanvas, "Canvas DOM instance survives navigation to Workspace");
  log(Boolean(canvas && canvas.getBoundingClientRect().height > 0), "hidden Workspace retains a non-zero Canvas size");
  log(workspace?.getAttribute("aria-hidden") === "false" && !workspace.hasAttribute("inert"), "active Workspace is exposed and interactive");
  log(dashboard?.getAttribute("aria-hidden") === "true" && dashboard.hasAttribute("inert"), "inactive Dashboard is hidden from assistive tech and interaction");

  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>(".lattice-nav-item")]
      .find((button) => button.textContent?.trim() === "Dashboard")
      ?.click();
  });
  log(document.querySelector(".lattice-canvas") === originalCanvas, "Canvas DOM instance survives navigation back to Dashboard");
  log(workspace?.getAttribute("aria-hidden") === "true" && workspace.hasAttribute("inert"), "inactive Workspace cannot receive interaction");

  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await wait(0);
  });
  await act(async () => document.querySelector<HTMLButtonElement>(".lattice-sidebar-toggle")?.click());
  await act(async () => wait(50));
  const saved = localStorage.getItem("lattice.platform.v1");
  const persisted = saved ? JSON.parse(saved).state : null;
  log(persisted?.sidebarExpanded === false, "manual sidebar preference is persisted");
  log(!persisted || !("activeView" in persisted), "active page is not persisted");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 980 });
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await wait(0);
  });
  log(!useLattice.getState().sidebarExpanded, "responsive rail leaves the manual sidebar preference unchanged");
  log(
    document.querySelector(".lattice-shell")?.classList.contains("is-responsive-rail") === true,
    "responsive rail follows window width independently of the manual preference",
  );

  document.querySelector<HTMLElement>("#out")!.textContent = lines.join("\n");
  await act(async () => root.unmount());
}

void run();
