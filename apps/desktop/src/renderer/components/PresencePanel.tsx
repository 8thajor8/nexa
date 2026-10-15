import type { PttVoiceStatus } from "../voice/ptt-voice-controller";
import { HolographicFrame } from "./HolographicFrame";

const futureModes = ["Sidebar", "Mini Presence", "Renderizador externo"];

interface PresencePanelProps {
  status: PttVoiceStatus;
  statusLabel: string;
  className?: string;
  isHidden?: boolean;
}

export function PresencePanel({ status, statusLabel, className = "", isHidden = false }: PresencePanelProps) {
  return (
    <aside className={`presence-panel surface-panel${className ? ` ${className}` : ""}`} aria-labelledby="presence-title" data-renderer-slot="presence" data-voice-state={status}
      aria-hidden={isHidden} inert={isHidden}>
      <HolographicFrame />
      <header className="panel-heading presence-heading">
        <h2 id="presence-title">Nexa Presence</h2>
        <span className={`presence-state presence-state--${status}`} aria-label={`Estado de voz: ${statusLabel}`}><span /> {statusLabel}</span>
      </header>

      <div className="presence-viewport" data-renderer-mode="external" aria-label="Contenedor vacío para el renderizador Presence">
        <span className="viewport-corner viewport-corner--tl" aria-hidden="true" />
        <span className="viewport-corner viewport-corner--tr" aria-hidden="true" />
        <span className="viewport-corner viewport-corner--bl" aria-hidden="true" />
        <span className="viewport-corner viewport-corner--br" aria-hidden="true" />
        <div className="viewport-grid" aria-hidden="true" />
        <div className="presence-placeholder">
          <span className="presence-index">C-4 <span>·</span> PRESENCE SÍNTESIS</span>
          <span className="presence-empty-mark" aria-hidden="true"><span /><span /></span>
          <strong>Sin visualización</strong>
          <span className="presence-placeholder-copy">El renderizador se conectará en una etapa posterior.</span>
          <span className="presence-voice-status" aria-hidden="true">{statusLabel}</span>
        </div>
        <span className="viewport-coordinate viewport-coordinate--top">NEXA / P-01</span>
        <span className="viewport-coordinate viewport-coordinate--bottom">SLOT DISPONIBLE</span>
      </div>

      <section className="presence-architecture" aria-label="Modalidades previstas de Presence">
        <div className="presence-architecture-heading"><span>MODALIDADES PREVISTAS</span><span>FUTURO</span></div>
        <ul>{futureModes.map((mode) => <li key={mode}><span className="mode-marker" aria-hidden="true" />{mode}</li>)}</ul>
      </section>
    </aside>
  );
}
