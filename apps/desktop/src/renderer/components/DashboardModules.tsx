import { availableToolsMock, systemStatusMock } from "../data/dashboard-mock";
import { HolographicFrame } from "./HolographicFrame";
import type { CSSProperties } from "react";
import type { HomeAssistantUiLight, MasterVolumeStatus, SpotifyLiveStatus, SpotifyPlaybackControl } from "../../shared/ipc-contract";

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
  masterVolume?: MasterVolumeStatus;
  onMasterVolumeChange?: (value: number) => void;
  onSpotifyControl?: (action: SpotifyPlaybackControl) => void;
  onOpenSpotifyTrack?: (url: string) => void;
  voiceRepliesEnabled?: boolean;
  onVoiceRepliesChange?: (enabled: boolean) => void;
  homeLights?: HomeAssistantUiLight[];
  homeLoading?: boolean;
  homeError?: string | null;
  homeBusyEntities?: ReadonlySet<string>;
  homeOutcomes?: Readonly<Record<string, string>>;
  onHomeToggle?: (light: HomeAssistantUiLight) => void;
  onOpenHome?: () => void;
  onRefreshHome?: () => void;
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
  masterVolume = { available: false, volume: null, errorCode: "device_unavailable" }, onMasterVolumeChange,
  onSpotifyControl, onOpenSpotifyTrack, voiceRepliesEnabled = false, onVoiceRepliesChange, homeLights = [], homeLoading = false,
  homeError = null, homeBusyEntities = new Set<string>(), homeOutcomes = {}, onHomeToggle, onOpenHome, onRefreshHome,
  className = "", isHidden = false }: DashboardModulesProps) {
  return (
    <section className={`dashboard-modules${className ? ` ${className}` : ""}`} aria-label="Módulos del Command Center"
      aria-hidden={isHidden} inert={isHidden}>
      <section className="dashboard-module surface-panel" aria-labelledby="nexa-home-mini-title">
        <HolographicFrame />
        <ModuleHeading id="nexa-home-mini-title" title="Nexa Home" label="" />
        <button type="button" className="home-mini-open" onClick={onOpenHome} aria-label="Abrir Home">Abrir Home ↗</button>
        <div className="home-mini-list" aria-label="Luces autorizadas" aria-busy={homeLoading}>
          {homeLoading && homeLights.length === 0 && <p className="home-mini-empty">Consultando luces…</p>}
          {!homeLoading && homeLights.length === 0 && <p className="home-mini-empty">{homeError ?? "No hay luces autorizadas."}</p>}
          {homeLights.map(light => {
            const busy = homeBusyEntities.has(light.entityId);
            const stateLabel = busy ? "Ejecutando…" : !light.available ? "No disponible"
              : light.state === "on" ? "Encendida" : light.state === "off" ? "Apagada" : "Estado desconocido";
            return <div className="home-mini-item" key={light.entityId}>
              <div className="home-mini-copy"><strong title={light.name}>{light.name}</strong>
                <small>{light.area ?? "Sin habitación"} · {homeOutcomes[light.entityId] ?? stateLabel}</small></div>
              <button type="button" className="home-switch" role="switch" aria-label={"Luz " + light.name}
                aria-checked={light.state === "on"} aria-busy={busy} disabled={!light.available || busy}
                onClick={() => onHomeToggle?.(light)} title={!light.available ? "Luz no disponible" : busy ? "Ejecutando operación" : "Cambiar " + light.name}>
                <span />
              </button>
            </div>;
          })}
          {homeError && homeLights.length > 0 && <p className="home-mini-error" role="alert">{homeError}</p>}
        </div>
        <button type="button" className="home-mini-refresh" onClick={onRefreshHome} disabled={homeLoading}>Actualizar</button>
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
        <div className="system-module-content" aria-label="Contenido de estado del sistema" tabIndex={0}>
          {spotifyStatus && <SpotifyMiniPlayer status={spotifyStatus} busyAction={spotifyBusyAction} error={spotifyError}
            onControl={onSpotifyControl} onOpenTrack={onOpenSpotifyTrack} />}
          <div className="master-volume-control">
            <label htmlFor="master-volume-slider"><span>Volumen de Windows</span>
              <strong>{masterVolume.available ? `${masterVolume.volume}%` : "No disponible"}</strong></label>
            <input id="master-volume-slider" type="range" min={0} max={100} step={1}
              value={masterVolume.volume ?? 0} disabled={!masterVolume.available}
              style={{ "--volume-progress": `${masterVolume.volume ?? 0}%` } as CSSProperties}
              aria-label="Volumen general de Windows" aria-valuetext={masterVolume.available ? `${masterVolume.volume}%` : "No disponible"}
              onChange={(event) => onMasterVolumeChange?.(Number(event.currentTarget.value))} />
            {!masterVolume.available && <small className="master-volume-control__error">
              {masterVolume.errorCode === "access_denied" ? "No se pudo acceder al control de audio."
                : masterVolume.errorCode === "operation_failed" ? "No se pudo consultar o ajustar el audio."
                  : "Dispositivo de salida no disponible."}
            </small>}
          </div>
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
        </div>
      </section>
    </section>
  );
}
