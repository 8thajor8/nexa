import type { ReactNode } from "react";
import { HolographicFrame } from "./HolographicFrame";

type IconName = "command" | "conversations" | "tools" | "activity" | "memory" | "files" | "settings";

const navigation: { label: string; icon: IconName; active?: boolean }[] = [
  { label: "Command Center", icon: "command", active: true },
  { label: "Conversations", icon: "conversations" },
  { label: "Tools", icon: "tools" },
  { label: "Activity", icon: "activity" },
  { label: "Memory", icon: "memory" },
  { label: "Files", icon: "files" },
  { label: "Settings", icon: "settings" },
];

function NavIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    command: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
    conversations: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-5.4a7.5 7.5 0 1 1 17-4.1Z" /><path d="M8 11h8M8 14h5" /></>,
    tools: <><path d="M14.5 6.5a4 4 0 0 0-5.7 5.7l-5.4 5.4a2 2 0 0 0 2.8 2.8l5.4-5.4a4 4 0 0 0 5.7-5.7l-2.6 2.6-2.8-2.8 2.6-2.6Z" /><path d="m17 4 3 3" /></>,
    activity: <><path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" /></>,
    memory: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
    files: <><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5M8 13h8M8 17h8" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.5.9L16 20.5h-2.8l-.3-1.8a8 8 0 0 1-1.7 0l-.3 1.8H8l-.3-1.7a8 8 0 0 1-1.5-.9l-1.7.7-1.4-2.4 1.4-1.1a8 8 0 0 1-.2-1.8l-1.6-.8v-2.8l1.7-.5a8 8 0 0 1 .6-1.6L4 6.2l2-2 1.4 1a8 8 0 0 1 1.7-.7L9.5 3h2.8l.4 1.7a8 8 0 0 1 1.7.6l1.4-1 2 2-1 1.5a8 8 0 0 1 .7 1.7l1.7.4v2.8l-1.7.5a8 8 0 0 1-.6 1.8Z" /></>,
  };

  return <svg aria-hidden="true" className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Navegación principal">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true"><span>N</span></span>
        <span className="brand-copy"><strong>NEXA</strong><small>COMMAND SYSTEM</small></span>
      </div>

      <div className="sidebar-section-label">ESPACIO DE TRABAJO</div>
      <nav className="primary-nav" aria-label="Secciones, lista desplazable" tabIndex={0}>
        {navigation.map((item) => {
          const contents = <><NavIcon name={item.icon} /><span className="nav-label">{item.label}</span>{!item.active && <span className="nav-soon">PRONTO</span>}<HolographicFrame variant="navigation" /></>;
          return item.active ? (
            <div className="nav-item nav-item--active" key={item.label} aria-current="page" aria-label={item.label}>
              {contents}
            </div>
          ) : (
            <button
              className="nav-item nav-item--future"
              key={item.label}
              type="button"
              disabled
              aria-label={item.label}
              title={`${item.label} · Demostración, no disponible`}
            >
              {contents}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-spacer" />

      <section className="connection-card" aria-label="Conexión local">
        <div className="connection-card-top"><span className="connection-signal" /><span>ENTORNO LOCAL</span></div>
        <p>Interfaz de demostración</p>
        <small>El motor Nexa aún no está conectado.</small>
      </section>

      <div className="sidebar-bottom"><span className="sidebar-version">NEXA DESKTOP <span>·</span> 0.1</span><span className="sidebar-build-dot" aria-hidden="true" /></div>
    </aside>
  );
}
