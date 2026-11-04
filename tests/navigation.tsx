import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import App from "../src/App";
import { useLattice } from "../src/platform/store";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const lines: string[] = [];
const log = (pass: boolean, message: string) => lines.push(`${pass ? "PASS" : "FAIL"} ${message}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pressShortcut(key: string, shiftKey = false) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey, bubbles: true }));
  });
}

async function run() {
  useLattice.setState({ sidebarExpanded: true });
  const root = createRoot(document.querySelector<HTMLDivElement>("#app")!);
  await act(async () => {
    root.render(createElement(App));
  });
  await act(async () => wait(30));

  log(useLattice.getState().activeView === "dashboard", "new session opens Dashboard by default");
  const dashboardCards = [...document.querySelectorAll<HTMLElement>(".lattice-dashboard-card")];
  log(dashboardCards.length === 4, "Dashboard renders all four P0.2 sections");
  log(
    dashboardCards.map((card) => card.querySelector("h2")?.textContent?.trim()).join("|") ===
      "Quick Actions|My Widgets|Recent Projects|Agent Overview",
    "Dashboard section order matches the frozen design",
  );
  const dashboardGrid = document.querySelector<HTMLElement>(".lattice-dashboard-grid");
  const gridCards = dashboardGrid
    ? [...dashboardGrid.querySelectorAll<HTMLElement>(".lattice-dashboard-card")]
    : [];
  const firstCard = gridCards[0]?.getBoundingClientRect();
  const secondCard = gridCards[1]?.getBoundingClientRect();
  const renderedTwoColumns = Boolean(firstCard && secondCard && Math.abs(firstCard.top - secondCard.top) < 1);
  log(
    renderedTwoColumns === (window.innerWidth > 760),
    "Dashboard column count matches the narrow breakpoint at the actual browser viewport",
  );
  log(
    !document.querySelector(".lattice-dashboard")?.textContent?.includes("SAMPLE DATA") &&
      document.querySelector(".lattice-dashboard-card[aria-labelledby='dashboard-recent-projects']")?.textContent?.includes("No project data source is connected."),
    "Dashboard does not present sample widget or project records as real data",
  );
  log(
    document.querySelector(".lattice-dashboard-card[aria-labelledby='dashboard-agent-overview']")?.textContent?.includes("DEMO · NOT CONNECTED"),
    "Agent section is explicitly marked demo and not connected",
  );
  const canvas = document.querySelector<HTMLElement>(".lattice-canvas");
  log(canvas !== null, "Canvas is mounted inside Workspace");
  const originalCanvas = canvas;

  const quickAction = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".lattice-dashboard-actions button")]
      .find((button) => button.querySelector("b")?.textContent?.trim() === label);
  await act(async () => quickAction("Global Search")?.click());
  log(document.querySelector(".lattice-search-overlay") !== null, "Dashboard Global Search opens the existing Search Overlay");
  log(useLattice.getState().activeView === "dashboard", "Dashboard Global Search leaves the active page unchanged");
  log(document.querySelector(".lattice-canvas") === originalCanvas, "Dashboard Global Search preserves the Canvas DOM instance");
  await act(async () => document.querySelector<HTMLInputElement>(".lattice-search-field input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  log(document.querySelector(".lattice-search-overlay") === null, "Escape closes the Search Overlay opened from Dashboard");

  pressShortcut("f", true);
  log(document.querySelector(".lattice-search-overlay") !== null, "Ctrl+Shift+F opens the existing Search Overlay");
  log(useLattice.getState().activeView === "dashboard", "Ctrl+Shift+F leaves the active page unchanged");
  log(document.querySelector(".lattice-canvas") === originalCanvas, "Ctrl+Shift+F preserves the Canvas DOM instance");
  pressShortcut("f", true);
  log(document.querySelector(".lattice-search-overlay") === null, "Ctrl+Shift+F closes the Search Overlay");

  await act(async () => quickAction("Open Assistant")?.click());
  log(document.querySelector(".lattice-assistant") !== null, "Dashboard Open Assistant opens the existing Assistant drawer");
  log(useLattice.getState().activeView === "dashboard", "Dashboard Open Assistant leaves the active page unchanged");
  log(document.querySelector(".lattice-canvas") === originalCanvas, "Dashboard Open Assistant preserves the Canvas DOM instance");
  pressShortcut("k");
  log(document.querySelector(".lattice-assistant") === null, "Ctrl+K closes the Assistant drawer");

  pressShortcut("k");
  log(document.querySelector(".lattice-assistant") !== null, "Ctrl+K opens the existing Assistant drawer");
  log(useLattice.getState().activeView === "dashboard", "Ctrl+K leaves the active page unchanged");
  log(document.querySelector(".lattice-canvas") === originalCanvas, "Ctrl+K preserves the Canvas DOM instance");
  pressShortcut("k");
  log(document.querySelector(".lattice-assistant") === null, "Ctrl+K closes the Assistant drawer after reopening it");

  const openWorkspaceAction = dashboardCards[0]?.querySelector<HTMLButtonElement>(".lattice-dashboard-action");
  await act(async () => openWorkspaceAction?.click());
  log(useLattice.getState().activeView === "workspace", "Dashboard Open Workspace action navigates to Workspace");
  log(document.querySelector(".lattice-canvas") === originalCanvas, "Dashboard Open Workspace action preserves the Canvas DOM instance");

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
