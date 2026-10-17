import { useEffect, useRef, useState } from "react";
import type { DesktopPreferences } from "../desktop-preferences";
import { availableTimeZones, cityLabelFromTimeZone, isSafeWeatherLocation, isValidTimeZone } from "../desktop-preferences";
import type { MicrophoneDeviceStore } from "../audio/microphone-device-store";
import { VoiceInputSettings } from "./VoiceInputSettings";
import { HolographicFrame } from "./HolographicFrame";
import type { DesktopMemoryMode, DesktopMemoryModeResult, DesktopMemoryModeStatus,
  WindowPreferences, WindowSettingsSnapshot } from "../../shared/ipc-contract";

interface SettingsModalProps {
  preferences: DesktopPreferences;
  onPreferencesChange: (next: DesktopPreferences) => void;
  microphoneDevices: MicrophoneDeviceStore;
  microphoneDisabled: boolean;
  onClose: () => void;
  onMemoryModeChange: (mode: DesktopMemoryMode) => Promise<DesktopMemoryModeResult>;
}

export function SettingsModal({ preferences, onPreferencesChange, microphoneDevices, microphoneDisabled, onClose, onMemoryModeChange }: SettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [clockToAdd, setClockToAdd] = useState("");
  const [weatherDraft, setWeatherDraft] = useState(preferences.weatherLocation);
  const [windowSettings, setWindowSettings] = useState<WindowSettingsSnapshot | null>(null);
  const [windowSettingsError, setWindowSettingsError] = useState<string | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<DesktopMemoryModeStatus | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryClearConfirming, setMemoryClearConfirming] = useState(false);
  const [memoryClearPending, setMemoryClearPending] = useState(false);
  const [memoryClearError, setMemoryClearError] = useState<string | null>(null);
  const [memoryClearSuccess, setMemoryClearSuccess] = useState(false);
  const [restartConfirming, setRestartConfirming] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const restartInFlight = useRef(false);
  const zones = availableTimeZones();

  useEffect(() => {
    let mounted = true;
    const api = window.nexaDesktop?.windowSettings;
    if (!api) {
      setWindowSettingsError("La configuración de pantallas no está disponible.");
      return () => { mounted = false; };
    }
    const unsubscribe = api.onChanged((settings) => {
      if (mounted) setWindowSettings(settings);
    });
    void api.get().then((settings) => {
      if (mounted) setWindowSettings(settings);
    }).catch(() => {
      if (mounted) setWindowSettingsError("No se pudo consultar la configuración de pantallas.");
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    let mounted = true;
    void window.nexaDesktop?.memory?.getStatus().then(status => {
      if (mounted) setMemoryStatus(status);
    }).catch(() => {
      if (mounted) setMemoryError("No se pudo consultar el modo de memoria.");
    });
    return () => { mounted = false; };
  }, []);

  const changeMemoryMode = async (mode: DesktopMemoryMode) => {
    if (memoryLoading || memoryClearPending || !memoryStatus) return;
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const result = await onMemoryModeChange(mode);
      if (result.ok) setMemoryStatus(result.status);
      else {
        setMemoryError(result.error === "busy"
          ? "Finaliza la conversación activa antes de cambiar la memoria."
          : result.error === "memory2_unavailable"
            ? "El almacén sintético Memory2 no está disponible o no es válido."
            : result.error === "memory2_write_unavailable"
              ? "No está disponible el almacén sintético temporal de escritura."
            : "No se pudo cambiar el modo de memoria.");
        const latest = await window.nexaDesktop.memory.getStatus();
        setMemoryStatus(latest);
      }
    } catch {
      setMemoryError("No se pudo cambiar el modo de memoria.");
    } finally {
      setMemoryLoading(false);
    }
  };

  const changeRelationshipLearning = async (enabled: boolean) => {
    if (memoryLoading || memoryClearPending || !memoryStatus) return;
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const result = await window.nexaDesktop.memory.setRelationshipLearningEnabled(enabled);
      if (result.ok) setMemoryStatus(result.status);
      else {
        setMemoryError("No se pudo actualizar el permiso de relaciones personales.");
        setMemoryStatus(await window.nexaDesktop.memory.getStatus());
      }
    } catch {
      setMemoryError("No se pudo actualizar el permiso de relaciones personales.");
    } finally {
      setMemoryLoading(false);
    }
  };

  const changeThirdPartyLearning = async (enabled: boolean) => {
    if (memoryLoading || memoryClearPending || !memoryStatus) return;
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const result = await window.nexaDesktop.memory.setThirdPartyLearningEnabled(enabled);
      if (result.ok) setMemoryStatus(result.status);
      else {
        setMemoryError("No se pudo actualizar el permiso para información sobre otras personas.");
        setMemoryStatus(await window.nexaDesktop.memory.getStatus());
      }
    } catch {
      setMemoryError("No se pudo actualizar el permiso para información sobre otras personas.");
    } finally {
      setMemoryLoading(false);
    }
  };

  const clearAllMemory = async () => {
    if (memoryClearPending || memoryLoading || memoryStatus?.switching
      || !memoryStatus?.memory2WriteAvailable) return;
    setMemoryClearPending(true);
    setMemoryClearError(null);
    setMemoryClearSuccess(false);
    try {
      const result = await window.nexaDesktop.memory.clearAll();
      if (result.ok) {
        setMemoryClearConfirming(false);
        setMemoryClearSuccess(true);
      } else {
        setMemoryClearError(result.error === "busy"
          ? "Finaliza la operación activa antes de borrar los recuerdos."
          : result.error === "memory2_write_unavailable"
            ? "Selecciona Memory2 con escritura para borrar sus recuerdos."
            : "No se pudieron borrar los recuerdos de Memory2.");
      }
    } catch {
      setMemoryClearError("No se pudieron borrar los recuerdos de Memory2.");
    } finally {
      setMemoryClearPending(false);
    }
  };

  const updateWindowSettings = async (patch: Partial<WindowPreferences>) => {
    if (!windowSettings) return;
    setWindowSettingsError(null);
    try {
      const next = await window.nexaDesktop.windowSettings.set({ ...windowSettings.preferences, ...patch });
      setWindowSettings(next);
    } catch {
      setWindowSettingsError("No se pudo aplicar la configuración de ventanas.");
    }
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => dialog?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
    ) ?? [];
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const elements = [...focusable()];
      if (!elements.length) { event.preventDefault(); dialog?.focus(); return; }
      const first = elements[0]; const last = elements.at(-1);
      if (!dialog?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); previousFocus?.focus(); };
  }, [onClose]);

  const update = (patch: Partial<DesktopPreferences>) => onPreferencesChange({ ...preferences, ...patch });
  const confirmRestart = async () => {
    if (restartInFlight.current || memoryLoading || memoryClearPending || memoryStatus?.switching || windowSettings?.transitioning) return;
    restartInFlight.current = true;
    setRestartPending(true);
    setRestartError(null);
    try {
      const result = await window.nexaDesktop.restartDesktop();
      if (result.ok) return;
      setRestartError(result.error === "restart_unavailable"
        ? "El reinicio no está disponible desde esta forma de inicio. Cierra Nexa y vuelve a iniciarla manualmente."
        : result.error === "restart_pending" ? "El reinicio ya está en curso." : "No se pudo reiniciar Nexa.");
    } catch {
      setRestartError("No se pudo solicitar el reinicio de Nexa.");
    }
    restartInFlight.current = false;
    setRestartPending(false);
  };
  const addClock = () => {
    if (!isValidTimeZone(clockToAdd) || preferences.clocks.some((clock) => clock.timeZone === clockToAdd)
      || preferences.clocks.length >= 8) return;
    update({ clocks: [...preferences.clocks, { id: clockToAdd, label: cityLabelFromTimeZone(clockToAdd), timeZone: clockToAdd }] });
    setClockToAdd("");
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="settings-dialog surface-panel" role="dialog" aria-modal="true"
        aria-labelledby="settings-title" tabIndex={-1}>
        <HolographicFrame />
        <header className="settings-dialog__header">
          <div><span className="settings-dialog__eyebrow">NEXA / PREFERENCIAS</span><h2 id="settings-title">Settings</h2></div>
          <button className="settings-dialog__close" type="button" aria-label="Cerrar Settings" onClick={onClose}>×</button>
        </header>
        <div className="settings-dialog__content">
          <section className="settings-section" aria-labelledby="settings-audio-title">
            <div className="settings-section__heading"><span>01</span><div><h3 id="settings-audio-title">Audio</h3><p>Dispositivo de entrada para Push-to-Talk.</p></div></div>
            <VoiceInputSettings store={microphoneDevices} disabled={microphoneDisabled} presentation="inline" />
          </section>

          <section className="settings-section" aria-labelledby="settings-appearance-title">
            <div className="settings-section__heading"><span>02</span><div><h3 id="settings-appearance-title">Apariencia</h3><p>Personaliza el fondo del Command Center.</p></div></div>
            <label className="settings-switch-row"><span><strong>Wallpaper de Windows</strong><small>Usar el fondo local como capa ambiental.</small></span>
              <input type="checkbox" checked={preferences.wallpaperEnabled} onChange={(event) => update({ wallpaperEnabled: event.target.checked })} />
            </label>
          </section>

          <section className="settings-section" aria-labelledby="settings-time-title">
            <div className="settings-section__heading"><span>03</span><div><h3 id="settings-time-title">Fecha y hora</h3><p>Relojes locales con reglas IANA y cambios de horario automáticos.</p></div></div>
            <label className="settings-field"><span>Zona horaria principal</span>
              <select value={preferences.primaryTimeZone} onChange={(event) => update({ primaryTimeZone: event.target.value })}>
                {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </label>
            <ul className="settings-clock-list" aria-label="Relojes internacionales">
              {preferences.clocks.map((clock) => <li key={clock.id}><span><strong>{clock.label}</strong><small>{clock.timeZone}</small></span>
                <button type="button" aria-label={`Quitar reloj de ${clock.label}`} onClick={() => update({ clocks: preferences.clocks.filter((item) => item.id !== clock.id) })}>Quitar</button></li>)}
            </ul>
            <div className="settings-add-clock"><label className="settings-field"><span>Agregar reloj</span>
              <select value={clockToAdd} onChange={(event) => setClockToAdd(event.target.value)}>
                <option value="">Elegir una zona horaria</option>
                {zones.filter((zone) => !preferences.clocks.some((clock) => clock.timeZone === zone)).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </label><button type="button" disabled={!clockToAdd || preferences.clocks.length >= 8} onClick={addClock}>Agregar</button></div>
          </section>

          <section className="settings-section" aria-labelledby="settings-weather-title">
            <div className="settings-section__heading"><span>04</span><div><h3 id="settings-weather-title">Clima</h3><p>Ubicación consultada mediante el proveedor disponible en Runtime.</p></div></div>
            <form className="settings-weather-form" onSubmit={(event) => {
              event.preventDefault();
              if (isSafeWeatherLocation(weatherDraft)) update({ weatherLocation: weatherDraft.trim() });
            }}>
              <label className="settings-field"><span>Ciudad</span><input value={weatherDraft} maxLength={100} onChange={(event) => setWeatherDraft(event.target.value)} placeholder="Barcelona" /></label>
              <button type="submit" disabled={!isSafeWeatherLocation(weatherDraft)}>Guardar ubicación</button>
            </form>
            <p className="settings-weather-note">Ubicación seleccionada: <strong>{preferences.weatherLocation}</strong>. El encabezado indicará «Clima no disponible» si el servicio no responde.</p>
          </section>

          <section className="settings-section" aria-labelledby="settings-window-title">
            <div className="settings-section__heading"><span>05</span><div><h3 id="settings-window-title">Ventana y pantallas</h3><p>Elige dónde aparece Nexa y cómo inicia.</p></div></div>
            <label className="settings-field"><span>Pantalla</span>
              <select aria-label="Pantalla" disabled={!windowSettings || windowSettings.transitioning}
                value={windowSettings?.transitionTargetDisplayId ?? windowSettings?.effectiveDisplayId ?? ""}
                onChange={(event) => { void updateWindowSettings({ displayId: event.target.value }); }}>
                {(windowSettings?.displays ?? []).map((display) => <option key={display.id} value={display.id}>
                  {display.label} · {display.resolution}
                </option>)}
              </select>
            </label>
            <label className="settings-switch-row"><span><strong>Iniciar en pantalla completa</strong><small>Puedes salir o volver con F11.</small></span>
              <input type="checkbox" aria-label="Iniciar en pantalla completa" disabled={!windowSettings || windowSettings.transitioning}
                checked={windowSettings?.transitionTargetFullscreen ?? windowSettings?.preferences.startFullscreen ?? true}
                onChange={(event) => { void updateWindowSettings({ startFullscreen: event.target.checked }); }} />
            </label>
            {windowSettings && !windowSettings.transitioning
              && windowSettings.effectiveFullscreen !== windowSettings.preferences.startFullscreen
              && <p role="status" className="settings-weather-note">Modo actual confirmado: {windowSettings.effectiveFullscreen ? "pantalla completa" : "ventana"}.</p>}
            {windowSettingsError && <p role="status" className="settings-weather-note">{windowSettingsError}</p>}
          </section>

          <section className="settings-section" aria-labelledby="settings-memory-title">
            <div className="settings-section__heading"><span>06</span><div><h3 id="settings-memory-title">Memoria</h3>
              <p>Memory1 es el modo predeterminado. La selección se conserva localmente. El aprendizaje orgánico solo está activo en Memory2 con escritura.</p></div></div>
            <label className="settings-field"><span>Backend activo</span>
              <select aria-label="Backend de memoria" value={memoryStatus?.mode ?? "memory1"}
                disabled={!memoryStatus || memoryLoading || memoryClearPending || memoryStatus.switching}
                onChange={event => { void changeMemoryMode(event.target.value as DesktopMemoryMode); }}>
                <option value="memory1">Memory1 · predeterminado</option>
                <option value="memory2-readonly" disabled={!memoryStatus?.memory2Available}>Memory2 · solo lectura (almacén sintético)</option>
                <option value="memory2-confirmed-write" disabled={!memoryStatus?.memory2WriteAvailable}>Memory2 · escritura y aprendizaje de preferencias</option>
              </select>
            </label>
            <p className="settings-weather-note" role="status">{memoryLoading || memoryStatus?.switching
              ? "Cambiando Runtime…"
              : memoryStatus?.mode === "memory2-readonly"
                ? "Memory2 activo para esta sesión. El almacén sintético no se modifica."
                : memoryStatus?.mode === "memory2-confirmed-write"
                  ? "Memory2 personal está activo. Las preferencias cotidianas claras pueden aprenderse automáticamente; las sensibles, ambiguas o hipotéticas no se guardan. Las solicitudes explícitas de guardar siguen pidiendo confirmación."
                : memoryStatus?.memory2Available
                  ? "Memory1 activo. Hay un almacén sintético Memory2 disponible para lectura."
                  : memoryStatus?.memory2WriteAvailable
                    ? "Memory1 activo. Memory2 personal estará disponible al seleccionar escritura."
                    : "Memory1 activo. No hay un almacén Memory2 disponible."}</p>
            <label className="settings-switch-row"><span><strong>Recordar relaciones personales</strong>
              <small>Permite el aprendizaje orgánico de relaciones propias solo cuando Memory2 con escritura y el aprendizaje orgánico general están activos.</small></span>
              <input type="checkbox" aria-label="Recordar relaciones personales"
                disabled={!memoryStatus || memoryLoading || memoryClearPending || memoryStatus.switching}
                checked={memoryStatus?.relationshipLearningEnabled ?? false}
                onChange={(event) => { void changeRelationshipLearning(event.target.checked); }} />
            </label>
            <p className="settings-weather-note" role="status">{memoryStatus?.relationshipLearningEffective
              ? "Permiso activo para relaciones personales propias. No modifica recuerdos existentes."
              : memoryStatus?.relationshipLearningEnabled
                ? "Permiso guardado, pero inactivo hasta seleccionar Memory2 con escritura. No habilita escrituras por sí solo."
                : "Permiso desactivado. Los recuerdos existentes se conservan."}</p>
            <label className="settings-switch-row"><span><strong>Recordar información sobre otras personas</strong>
              <small>Aprende datos cotidianos no sensibles solo de personas ya identificadas sin ambigüedad en Memory2.</small></span>
              <input type="checkbox" aria-label="Recordar información sobre otras personas"
                disabled={!memoryStatus || memoryLoading || memoryClearPending || memoryStatus.switching}
                checked={memoryStatus?.thirdPartyLearningEnabled ?? true}
                onChange={event => { void changeThirdPartyLearning(event.target.checked); }} />
            </label>
            <p className="settings-weather-note" role="status">{memoryStatus?.thirdPartyLearningEffective
              ? "Permiso activo para información no sensible sobre personas identificadas. No modifica recuerdos existentes."
              : memoryStatus?.thirdPartyLearningEnabled
                ? "Permiso guardado, pero inactivo hasta seleccionar Memory2 con escritura."
                : "Permiso desactivado. Los recuerdos existentes se conservan."}</p>
            {memoryStatus?.fallbackReason && <p className="settings-weather-note" role="alert">
              {memoryStatus.fallbackReason === "invalid_preference"
                ? "La selección guardada del modo de memoria no era válida. Se inició Memory1."
                : "El modo de memoria guardado no está disponible. Se inició Memory1; no se cambió ningún almacén."}
            </p>}
            {memoryError && <p role="alert" className="settings-weather-note">{memoryError}</p>}
            <div className="settings-restart-confirmation" aria-label="Mantenimiento de Memory2">
              <p>Elimina únicamente los recuerdos persistidos por Memory2. Las conversaciones, personalidad y ajustes se conservan.</p>
              {!memoryClearConfirming ? <button type="button" className="settings-restart-button"
                disabled={!memoryStatus?.memory2WriteAvailable || memoryLoading
                  || memoryStatus.switching || memoryClearPending}
                onClick={() => { setMemoryClearError(null); setMemoryClearSuccess(false); setMemoryClearConfirming(true); }}>
                Borrar recuerdos de Memory2
              </button> : <div>
                <p><strong>¿Borrar toda la memoria de Nexa?</strong></p>
                <p>Se eliminarán permanentemente los recuerdos guardados, incluidos datos personales, preferencias, relaciones e historial de actividades.</p>
                <p>Esta acción no se puede deshacer.</p>
                <div className="settings-restart-actions">
                  <button type="button" disabled={memoryClearPending} onClick={() => setMemoryClearConfirming(false)}>Cancelar</button>
                  <button type="button" disabled={memoryClearPending || memoryLoading || memoryStatus?.switching}
                    onClick={() => { void clearAllMemory(); }}>
                    {memoryClearPending ? "Borrando…" : "Sí, borrar toda la memoria"}
                  </button>
                </div>
              </div>}
              {!memoryStatus?.memory2WriteAvailable && <p className="settings-weather-note" role="status">
                El Store personal de Memory2 no está disponible para borrado.
              </p>}
              {memoryClearError && <p role="alert" className="settings-weather-note">{memoryClearError}</p>}
              {memoryClearSuccess && <p role="status" className="settings-weather-note">Se borraron los recuerdos de Memory2. Las conversaciones y los ajustes se conservaron.</p>}
            </div>
          </section>
          <section className="settings-section" aria-labelledby="settings-app-title">
            <div className="settings-section__heading"><span>07</span><div><h3 id="settings-app-title">Aplicación</h3>
              <p>Reinicia Nexa cuando necesites volver a cargar la aplicación.</p></div></div>
            {!restartConfirming ? <button type="button" className="settings-restart-button"
              onClick={() => { setRestartError(null); setRestartConfirming(true); }}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M20 11a8 8 0 1 1-2.35-5.65M20 4v6h-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Reiniciar Nexa
            </button> : <div className="settings-restart-confirmation">
              <p>¿Reiniciar Nexa ahora? La ventana se cerrará y volverá a abrirse.</p>
              <div className="settings-restart-actions">
                <button type="button" disabled={restartPending} onClick={() => setRestartConfirming(false)}>Cancelar</button>
              <button type="button" disabled={restartPending || memoryLoading || memoryClearPending || !!memoryStatus?.switching || !!windowSettings?.transitioning}
                  onClick={() => { void confirmRestart(); }}>Confirmar reinicio</button>
              </div>
            </div>}
            {restartError && <p className="settings-weather-note" role="alert">{restartError}</p>}
          </section>
        </div>
        <footer className="settings-dialog__footer"><span>Las preferencias se guardan en este dispositivo.</span><button type="button" onClick={onClose}>Listo</button></footer>
      </div>
    </div>
  );
}
