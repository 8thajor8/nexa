import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ASSISTANT_STATE_LABELS, createMockAssistantStateProvider } from "../shared/assistant-state";
import { ConversationPanel } from "./components/ConversationPanel";
import { PresencePanel } from "./components/PresencePanel";
import { Sidebar } from "./components/Sidebar";
import { WindowChrome } from "./components/WindowChrome";
import { HolographicFrame } from "./components/HolographicFrame";
import { DashboardModules } from "./components/DashboardModules";

export default function App() {
  const stateProvider = useMemo(() => createMockAssistantStateProvider(), []);
  const assistantState = useSyncExternalStore(
    stateProvider.subscribe, stateProvider.getSnapshot, stateProvider.getSnapshot,
  );
  const [pingState, setPingState] = useState<"idle" | "busy" | "success" | "error">("idle");
  const [wallpaperEnabled, setWallpaperEnabled] = useState(true);
  const [wallpaperDataUrl, setWallpaperDataUrl] = useState<string | null>(null);
  const [wallpaperLoading, setWallpaperLoading] = useState(false);
  const [wallpaperMessage, setWallpaperMessage] = useState("Buscando fondo de Windows");
  const initialWallpaperRequestStarted = useRef(false);

  async function refreshWallpaper() {
    if (!window.nexaDesktop?.getWallpaper) {
      setWallpaperDataUrl(null);
      setWallpaperMessage("Wallpaper no disponible; se usa el fondo Nexa");
      return;
    }
    setWallpaperLoading(true);
    try {
      const result = await window.nexaDesktop.getWallpaper();
      if (result.available) {
        setWallpaperDataUrl(result.dataUrl);
        setWallpaperMessage("Wallpaper local de Windows");
      } else {
        setWallpaperDataUrl(null);
        setWallpaperMessage("Wallpaper no disponible; se usa el fondo Nexa");
      }
    } catch {
      setWallpaperDataUrl(null);
      setWallpaperMessage("Wallpaper no disponible; se usa el fondo Nexa");
    } finally {
      setWallpaperLoading(false);
    }
  }

  useEffect(() => {
    if (initialWallpaperRequestStarted.current) return;
    initialWallpaperRequestStarted.current = true;
    void refreshWallpaper();
  }, []);

  async function checkElectronBridge() {
    setPingState("busy");
    stateProvider.setState("executing");
    try {
      await window.nexaDesktop.ping();
      setPingState("success");
    } catch {
      setPingState("error");
    } finally {
      stateProvider.setState("idle");
    }
  }

  const pingLabel = {
    idle: "Probar IPC",
    busy: "Comprobando…",
    success: "IPC disponible",
    error: "Error de IPC",
  }[pingState];

  return (
    <div className={`app-shell${wallpaperEnabled && wallpaperDataUrl ? " app-shell--wallpaper" : ""}`}>
      {wallpaperEnabled && wallpaperDataUrl && (
        <img className="wallpaper-background" src={wallpaperDataUrl} alt="" aria-hidden="true" />
      )}
      <WindowChrome />
      <Sidebar />
      <main className="workspace-shell">
        <header className="workspace-header" aria-label="Controles del Command Center">
          <div className="workspace-controls">
            <div className="assistant-status" aria-live="polite" data-testid="assistant-state">
              <span className={`status-indicator status-indicator--${assistantState}`} />
              <span className="status-copy"><span>Estado simulado</span><strong>{ASSISTANT_STATE_LABELS[assistantState]}</strong></span>
              <HolographicFrame variant="control" />
            </div>
            <button
              className={`ping-button${pingState === "success" ? " ping-button--success" : ""}${pingState === "error" ? " ping-button--error" : ""}`}
              type="button"
              onClick={checkElectronBridge}
              disabled={pingState === "busy"}
              aria-label="Comprobar el puente IPC local"
              title="Prueba técnica local; no envía mensajes al asistente"
            >
              <span className="ping-button-dot" />
              {pingLabel}
              <HolographicFrame variant="control" />
            </button>
            <div className="wallpaper-controls">
              <button
                className={`wallpaper-control wallpaper-toggle${wallpaperEnabled ? " wallpaper-toggle--active" : ""}`}
                type="button"
                aria-pressed={wallpaperEnabled}
                aria-label={`Fondo de Windows ${wallpaperEnabled ? "activado" : "desactivado"}`}
                title={wallpaperMessage}
                onClick={() => setWallpaperEnabled((enabled) => !enabled)}
              >
                <span className="wallpaper-control-dot" />
                Wallpaper {wallpaperEnabled ? "ON" : "OFF"}
                <HolographicFrame variant="control" />
              </button>
              <button
                className="wallpaper-control wallpaper-refresh"
                type="button"
                onClick={() => void refreshWallpaper()}
                disabled={wallpaperLoading}
                aria-label="Actualizar el wallpaper de Windows"
                title={wallpaperMessage}
              >
                {wallpaperLoading ? "Cargando…" : "Actualizar"}
                <HolographicFrame variant="control" />
              </button>
            </div>
          </div>
        </header>

        <div className="workspace-grid">
          <ConversationPanel />
          <PresencePanel />
        </div>

        <footer className="workspace-footer">
          <span><span className="footer-dot" /> SESIÓN LOCAL</span>
          <span>Sin conexión a Core, OpenAI o herramientas</span>
          <span>BUILD UI-02.2</span>
        </footer>
      </main>
      <DashboardModules assistantState={ASSISTANT_STATE_LABELS[assistantState]} />
    </div>
  );
}
