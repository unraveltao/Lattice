import { Glyph, ICON } from "./icons";
import { useLattice } from "./store";
import { useT } from "../runtime/i18n";

const SECTIONS = [
  { id: "quick-actions", title: "Quick Actions", icon: ICON.grid },
  { id: "my-widgets", title: "My Widgets", icon: ICON.monitor },
  { id: "recent-projects", title: "Recent Projects", icon: ICON.grid },
  { id: "agent-overview", title: "Agent Overview", icon: ICON.agent },
] as const;

export function DashboardPage() {
  const setActiveView = useLattice((state) => state.setActiveView);
  const t = useT();

  return (
    <main className="lattice-dashboard">
      <div className="lattice-dashboard-page">
        <header className="lattice-dashboard-heading">
          <div>
            <p className="lattice-dashboard-eyebrow">{t("Your desktop, at a glance")}</p>
            <h1>{t("Welcome to Lattice")}</h1>
            <p className="lattice-dashboard-intro">{t("A clear starting point for your widgets, workspace, and tools.")}</p>
          </div>
          <span className="lattice-dashboard-preview">{t("Dashboard preview")}</span>
        </header>

        <div className="lattice-dashboard-grid">
          <section className="lattice-dashboard-card" aria-labelledby="dashboard-quick-actions">
            <header className="lattice-dashboard-card-heading">
              <span className="lattice-dashboard-icon" aria-hidden="true"><Glyph d={SECTIONS[0].icon} /></span>
              <div><h2 id="dashboard-quick-actions">{t(SECTIONS[0].title)}</h2><p>{t("Jump straight into your flow.")}</p></div>
            </header>
            <div className="lattice-dashboard-actions">
              <button className="lattice-dashboard-action" type="button" onClick={() => setActiveView("workspace")}>
                <span className="lattice-dashboard-action-icon" aria-hidden="true"><Glyph d={ICON.monitor} /></span>
                <span><b>{t("Open Workspace")}</b><small>{t("Arrange and manage widgets")}</small></span>
                <Glyph d={ICON.chevron} />
              </button>
              <button className="lattice-dashboard-action" type="button" disabled aria-describedby="dashboard-search-hint">
                <span className="lattice-dashboard-action-icon" aria-hidden="true"><Glyph d={ICON.search} /></span>
                <span><b>{t("Global Search")}</b><small id="dashboard-search-hint">{t("Connects to Search in the next implementation slice.")}</small></span>
                <kbd>Ctrl+Shift+F</kbd>
              </button>
              <button className="lattice-dashboard-action" type="button" disabled aria-describedby="dashboard-assistant-hint">
                <span className="lattice-dashboard-action-icon" aria-hidden="true"><Glyph d={ICON.agent} /></span>
                <span><b>{t("Open Assistant")}</b><small id="dashboard-assistant-hint">{t("Connects to Assistant in the next implementation slice.")}</small></span>
                <kbd>Ctrl+K</kbd>
              </button>
            </div>
            <p className="lattice-dashboard-footnote">{t("Existing Lattice shortcuts stay unchanged.")}</p>
          </section>

          <section className="lattice-dashboard-card" aria-labelledby="dashboard-my-widgets">
            <header className="lattice-dashboard-card-heading">
              <span className="lattice-dashboard-icon" aria-hidden="true"><Glyph d={SECTIONS[1].icon} /></span>
              <div><h2 id="dashboard-my-widgets">{t(SECTIONS[1].title)}</h2><p>{t("Installed widgets and canvas placements.")}</p></div>
            </header>
            <div className="lattice-dashboard-empty" role="status">
              <Glyph d={ICON.monitor} />
              <b>{t("Widget status is being connected.")}</b>
              <small>{t("No sample installation data is shown.")}</small>
            </div>
          </section>

          <section className="lattice-dashboard-card" aria-labelledby="dashboard-recent-projects">
            <header className="lattice-dashboard-card-heading">
              <span className="lattice-dashboard-icon" aria-hidden="true"><Glyph d={SECTIONS[2].icon} /></span>
              <div><h2 id="dashboard-recent-projects">{t(SECTIONS[2].title)}</h2><p>{t("A future home for project context.")}</p></div>
              <span className="lattice-dashboard-badge">{t("Preview")}</span>
            </header>
            <div className="lattice-dashboard-empty">
              <Glyph d={ICON.info} />
              <b>{t("No project data source is connected.")}</b>
              <small>{t("Projects will appear here when an approved source is available.")}</small>
            </div>
          </section>

          <section className="lattice-dashboard-card" aria-labelledby="dashboard-agent-overview">
            <header className="lattice-dashboard-card-heading">
              <span className="lattice-dashboard-icon" aria-hidden="true"><Glyph d={SECTIONS[3].icon} /></span>
              <div><h2 id="dashboard-agent-overview">{t(SECTIONS[3].title)}</h2><p>{t("A future control surface for agent work.")}</p></div>
              <span className="lattice-dashboard-badge">{t("DEMO · NOT CONNECTED")}</span>
            </header>
            <div className="lattice-dashboard-agent-state">
              <span className="lattice-dashboard-status-dot" aria-hidden="true" />
              <div><b>{t("No agent connection")}</b><small>{t("No live agents, tasks, or activity are available.")}</small></div>
            </div>
            <div className="lattice-dashboard-concepts">
              <span>{t("Schedules")}</span><span>{t("Approvals")}</span><span>{t("Activity")}</span>
              <small>{t("Future concept")}</small>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
