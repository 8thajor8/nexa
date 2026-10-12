import { useState, useSyncExternalStore } from "react";
import type { MicrophoneDeviceStore } from "../audio/microphone-device-store";

interface VoiceInputSettingsProps {
  readonly store: MicrophoneDeviceStore;
  readonly disabled: boolean;
  readonly presentation?: "popover" | "inline";
}

export function VoiceInputSettings({ store, disabled, presentation = "popover" }: VoiceInputSettingsProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = useState(false);
  const defaultLabel = snapshot.defaultDeviceLabel
    ? `Predeterminado de Windows · ${snapshot.defaultDeviceLabel}` : "Predeterminado de Windows";

  const panel = (
    <section id="voice-input-settings-panel" className={`voice-input-settings-panel${presentation === "inline" ? " voice-input-settings-panel--inline" : ""}`} aria-label="Configuración de micrófono">
        <label htmlFor="voice-input-device">Dispositivo de entrada</label>
        <select id="voice-input-device" value={snapshot.selectedDeviceId ?? ""} disabled={disabled || snapshot.loading}
          onChange={(event) => store.select(event.target.value || null)}>
          <option value="">{defaultLabel}</option>
          {snapshot.selectedDeviceId && !snapshot.selectedAvailable && (
            <option value={snapshot.selectedDeviceId} disabled>Micrófono guardado (no disponible)</option>
          )}
          {snapshot.devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}
        </select>
        <button type="button" className="voice-input-refresh" disabled={disabled || snapshot.loading}
          onClick={() => void store.refresh()}>{snapshot.loading ? "Buscando…" : "Actualizar dispositivos"}</button>
        {snapshot.notice && <p role="status" aria-live="polite">{snapshot.notice}</p>}
        {snapshot.error && <p role="status">No se pudo consultar la lista de micrófonos.</p>}
        {!snapshot.loading && !snapshot.devices.length && <p role="status">No hay entradas de micrófono adicionales. Puedes usar el predeterminado de Windows.</p>}
        {disabled && <p>El dispositivo no se puede cambiar durante una grabación.</p>}
    </section>
  );

  return presentation === "inline" ? panel : (
    <div className="voice-input-settings">
      <button type="button" className="voice-input-settings-toggle" aria-expanded={open}
        aria-controls="voice-input-settings-panel" onClick={() => setOpen((value) => !value)}>
        Micrófono
      </button>
      {open && panel}
    </div>
  );
}
