import { useT } from "../runtime/i18n";
import { useLattice } from "./store";

export function DashboardPage() {
  const setActiveView = useLattice((state) => state.setActiveView);
  const t = useT();

  return (
    <main className="lattice-dashboard">
      <div className="lattice-dashboard-content">
        <p className="lattice-dashboard-eyebrow">LATTICE</p>
        <h2>{t("A calm place to start")}</h2>
        <p>{t("Your workspace is ready when you are.")}</p>
        <button type="button" className="lattice-btn is-primary" onClick={() => setActiveView("workspace")}>
          {t("Open workspace")}
        </button>
      </div>
    </main>
  );
}
