import { availableToolsMock, recentActivityMock, systemStatusMock } from "../data/dashboard-mock";
import { HolographicFrame } from "./HolographicFrame";

function ActivityGlyph({ icon }: { icon: (typeof recentActivityMock)[number]["icon"] }) {
  if (icon === "window") return <svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3 7h14" /></svg>;
  if (icon === "ipc") return <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5" /><path d="M6.5 10h7M10 6.5v7" /></svg>;
  return <svg viewBox="0 0 20 20"><path d="M10 3v8m-3-3 3 3 3-3M4 13v3h12v-3" /></svg>;
}

function ModuleHeading({ id, title, label }: { id: string; title: string; label: string }) {
  return (
    <header className="dashboard-module-heading">
      <h2 id={id}><span className="module-kicker-mark" aria-hidden="true" />{title}</h2>
      <span className="dashboard-module-label">{label}</span>
    </header>
  );
}

export function DashboardModules({ assistantState }: { assistantState: string }) {
  return (
    <section className="dashboard-modules" aria-label="Módulos del Command Center">
      <section className="dashboard-module surface-panel" aria-labelledby="activity-title">
        <HolographicFrame />
        <ModuleHeading id="activity-title" title="Actividad reciente" label="DEMO · MOCK" />
        <ul className="activity-list" aria-label="Eventos de ejemplo">
          {recentActivityMock.map((item) => (
            <li className="activity-item" key={item.id}>
              <span className={`activity-icon activity-icon--${item.icon}`} aria-hidden="true"><ActivityGlyph icon={item.icon} /></span>
              <span className="activity-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
              <time>{item.time}</time>
            </li>
          ))}
        </ul>
      </section>

      <section className="dashboard-module dashboard-module--tools surface-panel" aria-labelledby="tools-title">
        <HolographicFrame />
        <ModuleHeading id="tools-title" title="Herramientas disponibles" label="FUTURO" />
        <ul className="tool-list" aria-label="Capacidades futuras, aún no conectadas">
          {availableToolsMock.map((tool, index) => (
            <li className="tool-item" key={tool.id} title={`${tool.label}: integración futura, no operativa`}>
              <span className={`tool-glyph tool-glyph--${index % 4}`} aria-hidden="true">{["▦", "◉", "◎", "◌", "▱", "✉"][index]}</span>
              <span>{tool.label}</span>
              <small>{tool.state}</small>
            </li>
          ))}
        </ul>
      </section>

      <section className="dashboard-module surface-panel" aria-labelledby="system-title">
        <HolographicFrame />
        <ModuleHeading id="system-title" title="Estado del sistema" label="DEMO" />
        <ul className="system-list" aria-label="Indicadores de demostración">
          {systemStatusMock.map((item) => {
            const isAssistant = item.valueKind === "assistant";
            const value = isAssistant ? assistantState : item.value;
            const state = isAssistant ? "simulated" : item.state;
            return (
              <li className="system-item" key={item.id}>
                <span className={`system-indicator system-indicator--${state}`} aria-hidden="true" />
                <span>{item.label}</span>
                <strong>{value}</strong>
              </li>
            );
          })}
        </ul>
        <p className="system-disclaimer">Sin métricas de rendimiento ni monitorización real.</p>
      </section>
    </section>
  );
}
