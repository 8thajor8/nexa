import { availableToolsMock, recentActivityMock, systemStatusMock } from "../data/dashboard-mock";
import { HolographicFrame } from "./HolographicFrame";
import type { SpotifyLiveStatus, SpotifyPlaybackControl } from "../../shared/ipc-contract";

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

interface DashboardModulesProps {
  assistantState: string;
  spotifyStatus?: SpotifyLiveStatus;
  spotifyBusyAction?: SpotifyPlaybackControl | null;
  spotifyError?: string | null;
  onSpotifyControl?: (action: SpotifyPlaybackControl) => void;
  onOpenSpotifyTrack?: (url: string) => void;
  voiceRepliesEnabled?: boolean;
  onVoiceRepliesChange?: (enabled: boolean) => void;
  className?: string;
  isHidden?: boolean;
}

function SpotifyMiniPlayer({ status, busyAction, error, onControl, onOpenTrack }: {
  status: SpotifyLiveStatus; busyAction: SpotifyPlaybackControl | null; error: string | null;
  onControl?: (action: SpotifyPlaybackControl) => void; onOpenTrack?: (url: string) => void;
}) {
  const currentAction: SpotifyPlaybackControl = status.state === "playing" ? "pause" : "play";
  const stateLabel: Record<SpotifyLiveStatus["state"], string> = {
    loading: "Actualizando", playing: "Conectado · reproduciendo", paused: "Conectado · en pausa", no_track: "Conectado",
    not_connected: "Sin conectar", no_device: "Sin dispositivo", unavailable: "No disponible",
  };
  const disabled = !status.controlsEnabled || busyAction !== null;
  return (
    <section className="spotify-mini-player" aria-label="Reproductor de Spotify" aria-busy={busyAction !== null}>
      {status.track?.imageUrl
        ? <img className="spotify-mini-player__artwork" src={status.track.imageUrl} alt="" referrerPolicy="no-referrer" />
        : <div className="spotify-mini-player__artwork spotify-mini-player__artwork--empty" aria-label="Carátula no disponible">♫</div>}
      <div className="spotify-mini-player__meta">
        <span className={`spotify-mini-player__state spotify-mini-player__state--${status.state}`}>
          {busyAction ? "Actualizando…" : stateLabel[status.state]}
        </span>
        <strong title={status.track?.name ?? undefined}>{status.track?.name ?? (status.state === "not_connected" ? "Conectá Spotify desde el chat" : "Nada está sonando")}</strong>
        <span title={status.track?.artists.join(", ")}>{status.track?.artists.join(", ") ?? "Esperando estado de Spotify"}</span>
        {status.track?.spotifyUrl && <button type="button" className="spotify-mini-player__open" aria-label="Abrir pista en Spotify"
          onClick={() => onOpenTrack?.(status.track!.spotifyUrl!)}>Abrir en Spotify ↗</button>}
      </div>
      <div className="spotify-mini-player__controls" aria-label="Controles de reproducción">
        <button type="button" aria-label="Pista anterior" title="Anterior" disabled={disabled} onClick={() => onControl?.("previous")}>|◀</button>
        <button type="button" className="spotify-mini-player__primary" aria-label={currentAction === "pause" ? "Pausar Spotify" : "Reanudar Spotify"}
          title={currentAction === "pause" ? "Pausar" : "Reproducir"} disabled={disabled} onClick={() => onControl?.(currentAction)}>
          {busyAction === currentAction ? "…" : currentAction === "pause" ? "Ⅱ" : "▶"}
        </button>
        <button type="button" aria-label="Pista siguiente" title="Siguiente" disabled={disabled} onClick={() => onControl?.("next")}>▶|</button>
      </div>
      {(error || status.message) && <small className="spotify-mini-player__notice" role={error ? "alert" : undefined}>{error ?? status.message}</small>}
    </section>
  );
}

export function DashboardModules({ assistantState, spotifyStatus, spotifyBusyAction = null, spotifyError = null,
  onSpotifyControl, onOpenSpotifyTrack, voiceRepliesEnabled = false, onVoiceRepliesChange, className = "", isHidden = false }: DashboardModulesProps) {
  return (
    <section className={`dashboard-modules${className ? ` ${className}` : ""}`} aria-label="Módulos del Command Center"
      aria-hidden={isHidden} inert={isHidden}>
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
        <ul className="tool-list" aria-label="Herramientas y preferencias">
          {availableToolsMock.map((tool, index) => tool.id === "memory" ? (
            <li className="tool-item tool-item--voice" key={tool.id}>
              <button type="button" className="tool-item__voice-button" role="switch" aria-label="Respuestas por voz"
                aria-checked={voiceRepliesEnabled} aria-describedby="voice-replies-state"
                onClick={() => onVoiceRepliesChange?.(!voiceRepliesEnabled)}>
                <svg className="tool-glyph tool-glyph--voice" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M3 8v4h3l4 3V5L6 8H3Z" /><path d="M13 7a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10" />
                </svg>
                <span>Respuestas por voz</span>
                <small id="voice-replies-state">{voiceRepliesEnabled ? "ACTIVADO" : "DESACTIVADO"}</small>
              </button>
            </li>
          ) : (
            <li className="tool-item" key={tool.id} title={`${tool.label}: integración futura, no operativa`}>
              <span className={`tool-glyph tool-glyph--${index % 4}`} aria-hidden="true">{["▦", "◉", "◎", "◌", "▱", "✉"][index]}</span>
              <span>{tool.label}</span>
              <small>{tool.state}</small>
            </li>
          ))}
        </ul>
      </section>

      <section className="dashboard-module dashboard-module--system surface-panel" aria-labelledby="system-title">
        <HolographicFrame />
        <ModuleHeading id="system-title" title="Estado del sistema" label="SPOTIFY" />
        {spotifyStatus && <SpotifyMiniPlayer status={spotifyStatus} busyAction={spotifyBusyAction} error={spotifyError}
          onControl={onSpotifyControl} onOpenTrack={onOpenSpotifyTrack} />}
        <ul className="system-list" aria-label="Otros indicadores del sistema">
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
        <p className="system-disclaimer">Los demás indicadores son demostrativos.</p>
      </section>
    </section>
  );
}
