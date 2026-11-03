import { useEffect, useRef, useState, type ReactNode } from "react";
import { Glyph, ICON } from "./icons";
import { useLattice } from "./store";
import { useT } from "../runtime/i18n";

interface AppShellProps {
  topbar: ReactNode;
  dashboard: ReactNode;
  workspace: ReactNode;
  children?: ReactNode;
}

/** 平台外壳控制页面可见性；Workspace 始终留在页面栈里，保留 Canvas 实例。 */
export function AppShell({ topbar, dashboard, workspace, children }: AppShellProps) {
  const activeView = useLattice((state) => state.activeView);
  const expanded = useLattice((state) => state.sidebarExpanded);
  const setActiveView = useLattice((state) => state.setActiveView);
  const setSidebarExpanded = useLattice((state) => state.setSidebarExpanded);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const [responsiveRail, setResponsiveRail] = useState(false);
  const t = useT();
  const isWorkspace = activeView === "workspace";

  useEffect(() => {
    const update = () => setResponsiveRail(window.innerWidth < 1120);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    pageHeading.current?.focus({ preventScroll: true });
  }, [activeView]);

  return (
    <div className={`lattice-shell${expanded ? "" : " is-sidebar-collapsed"}${responsiveRail ? " is-responsive-rail" : ""}`}>
      {topbar}
      <div className="lattice-app-body">
        <aside className="lattice-sidebar" aria-label={t("Main navigation")}>
          <nav className="lattice-sidebar-nav">
            <button
              type="button"
              className={`lattice-nav-item${activeView === "dashboard" ? " is-active" : ""}`}
              onClick={() => setActiveView("dashboard")}
              aria-current={activeView === "dashboard" ? "page" : undefined}
              title={t("Dashboard")}
            >
              <Glyph d={ICON.grid} />
              <span>{t("Dashboard")}</span>
            </button>
            <button
              type="button"
              className={`lattice-nav-item${isWorkspace ? " is-active" : ""}`}
              onClick={() => setActiveView("workspace")}
              aria-current={isWorkspace ? "page" : undefined}
              title={t("Workspace")}
            >
              <Glyph d={ICON.monitor} />
              <span>{t("Workspace")}</span>
            </button>
          </nav>
          <button
            type="button"
            className="lattice-sidebar-toggle"
            onClick={() => setSidebarExpanded(!expanded)}
            disabled={responsiveRail}
            aria-label={responsiveRail ? t("Sidebar is compact at this window width") : expanded ? t("Collapse sidebar") : t("Expand sidebar")}
            aria-expanded={expanded && !responsiveRail}
            title={responsiveRail ? t("Sidebar is compact at this window width") : expanded ? t("Collapse sidebar") : t("Expand sidebar")}
          >
            <Glyph d={ICON.menu} />
            <span>{expanded ? t("Collapse sidebar") : t("Expand sidebar")}</span>
          </button>
        </aside>
        <div className="lattice-page-stack">
          <section
            className="lattice-page-layer"
            aria-label={t("Dashboard")}
            aria-hidden={isWorkspace}
            inert={isWorkspace}
            data-active={!isWorkspace}
          >
            <h1 className="lattice-visually-hidden" tabIndex={-1} ref={!isWorkspace ? pageHeading : undefined}>
              {t("Dashboard")}
            </h1>
            {dashboard}
          </section>
          <section
            className="lattice-page-layer"
            aria-label={t("Workspace")}
            aria-hidden={!isWorkspace}
            inert={!isWorkspace}
            data-active={isWorkspace}
          >
            <h1 className="lattice-visually-hidden" tabIndex={-1} ref={isWorkspace ? pageHeading : undefined}>
              {t("Workspace")}
            </h1>
            {workspace}
          </section>
        </div>
      </div>
      {children}
    </div>
  );
}
