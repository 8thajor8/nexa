import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthorizedHomeAssistantLight, DiscoveredHomeAssistantLight, HomeAssistantEffectSpeedCandidate, HomeAssistantUiLight } from "../../shared/ipc-contract";
import { HolographicFrame } from "./HolographicFrame";
import { HomeEffectPicker } from "./HomeEffectPicker";
import { HomeLightBrightnessQueue } from "../home-light-brightness-queue";
import { HomeLightSpeedQueue } from "../home-light-speed-queue";

interface HomeAssistantPanelProps {
  lights: HomeAssistantUiLight[];
  loading: boolean;
  error: string | null;
  busyEntities: ReadonlySet<string>;
  outcomes: Readonly<Record<string, string>>;
  onRefresh: () => void;
  onControl: (light: HomeAssistantUiLight, input: { action: "turn_on" | "turn_off"; brightnessPct?: number; rgbColor?: [number, number, number] }) => void | Promise<void>;
  onApplyEffect?: (light: HomeAssistantUiLight, effect: string) => void | Promise<void>;
}
function colorHex(rgb: [number, number, number] | null): string {
  return rgb ? "#" + rgb.map(value => value.toString(16).padStart(2, "0")).join("") : "#ffffff";
}
function colorRgb(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/iu.test(hex)) return null;
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}
function errorLabel(error: string): string {
  const messages: Record<string, string> = {
    home_assistant_not_configured: "Home Assistant todavía no está configurado.",
    home_assistant_configuration_invalid: "La configuración de Home Assistant no es válida.",
    home_assistant_unavailable: "No se pudo conectar con Home Assistant.",
    home_assistant_timeout: "Home Assistant tardó demasiado en responder.",
    home_assistant_unauthorized: "Home Assistant rechazó la autorización configurada.",
    home_assistant_device_store_invalid: "El registro de luces no se pudo validar. Nexa bloqueó el control.",
    home_assistant_device_store_io_error: "Nexa no pudo leer el registro de luces.",
    home_assistant_light_not_discovered: "La luz ya no aparece como dispositivo descubierto.",
    home_assistant_light_not_authorized: "La luz dejó de estar autorizada.",
    home_assistant_effect_not_supported: "Home Assistant no ofrece ese efecto para esta luz.",
    home_assistant_speed_not_linked: "Esta luz no tiene un control de velocidad vinculado.",
    home_assistant_speed_link_stale: "La asociación de velocidad cambió en Home Assistant. Volvé a vincularla.",
      home_assistant_speed_unavailable: "El control de velocidad no está disponible en este momento.",
    home_assistant_speed_value_invalid: "Ese valor está fuera de los límites o incrementos admitidos.",
    home_assistant_forbidden: "Home Assistant no autorizó la consulta del registro.",
    home_assistant_response_invalid: "La información de velocidad no se pudo validar.",
    home_assistant_request_failed: "No se pudo consultar el control de velocidad.",
    home_assistant_request_rejected: "Home Assistant rechazó la consulta del control de velocidad.",
    home_assistant_device_store_write_failed: "Nexa no pudo guardar la vinculación del control de velocidad.",
    home_assistant_legacy_configuration_invalid: "La configuración anterior de luces no se pudo validar.",
    invalid_request: "La solicitud de vinculación no es válida.",
  };
  return messages[error] ?? "No se pudo completar la operación de Nexa Home.";
}
function colorDescription(light: HomeAssistantUiLight): string {
  if (light.effect) return `Efecto: ${light.effect}`;
  if (light.rgbColor) return `RGB: ${light.rgbColor.join(", ")}`;
  if (light.rgbwColor) return `RGBW: ${light.rgbwColor.join(", ")}`;
  if (light.colorTemperatureKelvin) return `Blanco: ${light.colorTemperatureKelvin} K`;
  return "Color no disponible";
}
function fixedColor(light: HomeAssistantUiLight): [number, number, number] | null {
  return light.effect ? null : light.rgbColor;
}
export function HomeAssistantPanel({ lights, loading, error, busyEntities, outcomes, onRefresh, onControl,
  onApplyEffect = () => undefined }: HomeAssistantPanelProps) {
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [discoveryMounted, setDiscoveryMounted] = useState(false);
  const discoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredHomeAssistantLight[]>([]);
  const [adminBusy, setAdminBusy] = useState<string | null>(null);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, { name: string; area: string; aliases: string }>>({});
  const [controls, setControls] = useState<Record<string, { brightness: number; color: string }>>({});
  const [speedDrafts, setSpeedDrafts] = useState<Record<string, number>>({});
  const [speedDiscovery, setSpeedDiscovery] = useState<Record<string, { loading: boolean; error: string | null; candidates: HomeAssistantEffectSpeedCandidate[] }>>({});
  const [speedMessages, setSpeedMessages] = useState<Record<string, string>>({});
  const [selectedEffects, setSelectedEffects] = useState<Record<string, string>>({});
  const brightnessQueue = useRef<HomeLightBrightnessQueue | null>(null);
  if (brightnessQueue.current === null) brightnessQueue.current = new HomeLightBrightnessQueue(300);
  const queue = brightnessQueue.current;
  const speedQueueRef = useRef<HomeLightSpeedQueue | null>(null);
  if (speedQueueRef.current === null) speedQueueRef.current = new HomeLightSpeedQueue(300);
  const speedQueue = speedQueueRef.current;
  const authorizedLightIds = lights.filter(light => light.available).map(light => light.entityId).sort().join("|");
  const grouped = useMemo(() => {
    const map = new Map<string, HomeAssistantUiLight[]>();
    for (const light of lights) {
      const area = light.area?.trim() || "Sin habitación";
      map.set(area, [...(map.get(area) ?? []), light]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, "es"));
  }, [lights]);
  useEffect(() => {
    queue.activate();
    return () => queue.dispose();
  }, [queue]);
  useEffect(() => {
    speedQueue.activate();
    return () => speedQueue.dispose();
  }, [speedQueue]);
  useEffect(() => () => { if (discoveryTimer.current !== null) clearTimeout(discoveryTimer.current); }, []);
  useEffect(() => { queue.setAuthorizedEntities(authorizedLightIds ? authorizedLightIds.split("|") : []); }, [authorizedLightIds, queue]);
  const speedAuthorizedIds = lights.filter(light => light.effectSpeed?.linked && !light.effectSpeed.stale)
    .map(light => light.entityId).sort().join("|");
  useEffect(() => { speedQueue.setAuthorizedEntities(speedAuthorizedIds ? speedAuthorizedIds.split("|") : []); }, [speedAuthorizedIds, speedQueue]);
  useEffect(() => {
    setSpeedDrafts(current => {
      const next = { ...current };
      for (const light of lights) {
        const observed = light.effectSpeed?.value;
        if (typeof observed === "number" && !speedQueue.hasPendingOrInFlight(light.entityId)) next[light.entityId] = observed;
        if (!light.effectSpeed?.linked || light.effectSpeed.stale) delete next[light.entityId];
      }
      return next;
    });
  }, [lights, speedQueue]);
  useEffect(() => {
    setControls(current => {
      const next = { ...current };
      for (const light of lights) {
        const prior = next[light.entityId] ?? { brightness: light.brightnessPct ?? 100, color: colorHex(fixedColor(light)) };
        next[light.entityId] = { ...prior,
          brightness: queue.hasPendingOrInFlight(light.entityId) ? prior.brightness : light.brightnessPct ?? 100,
          color: colorHex(fixedColor(light)) };
      }
      return next;
    });
  }, [lights, queue]);
  function openDiscovery() {
    if (discoveryTimer.current !== null) clearTimeout(discoveryTimer.current);
    discoveryTimer.current = null;
    setDiscoveryMounted(true);
    setShowDiscovery(false);
    discoveryTimer.current = setTimeout(() => { setShowDiscovery(true); discoveryTimer.current = null; }, 0);
    setDiscoveryError(null);
  }
  function closeDiscovery() {
    if (discoveryTimer.current !== null) clearTimeout(discoveryTimer.current);
    setShowDiscovery(false);
    discoveryTimer.current = setTimeout(() => { setDiscoveryMounted(false); discoveryTimer.current = null; }, 240);
  }
  function finishDiscoveryClose(event: React.TransitionEvent<HTMLElement>) {
    if (showDiscovery || event.target !== event.currentTarget || event.propertyName !== "opacity") return;
    if (discoveryTimer.current !== null) clearTimeout(discoveryTimer.current);
    discoveryTimer.current = null;
    setDiscoveryMounted(false);
  }
  function localControls(light: HomeAssistantUiLight) {
    return controls[light.entityId] ?? { brightness: light.brightnessPct ?? 100, color: colorHex(fixedColor(light)) };
  }
  async function discover() {
    setDiscoveryBusy(true); setDiscoveryError(null); setDiscovered([]);
    try {
      const result = await window.nexaDesktop.homeAssistant.discoverLights();
      if (!result.ok) setDiscoveryError(errorLabel(result.error));
      else setDiscovered(result.value.lights);
    } catch { setDiscoveryError("No se pudieron consultar dispositivos de Home Assistant."); }
    finally { setDiscoveryBusy(false); }
  }
  async function discoverSpeed(light: HomeAssistantUiLight) {
    setSpeedDiscovery(current => ({ ...current, [light.entityId]: { loading: true, error: null, candidates: [] } }));
    setSpeedMessages(current => ({ ...current, [light.entityId]: "" }));
    try {
      const result = await window.nexaDesktop.homeAssistant.discoverEffectSpeedCandidates({ lightEntityId: light.entityId });
      setSpeedDiscovery(current => ({ ...current, [light.entityId]: { loading: false,
        error: result.ok ? null : errorLabel(result.error), candidates: result.ok ? result.value.candidates : [] } }));
    } catch {
      setSpeedDiscovery(current => ({ ...current, [light.entityId]: { loading: false,
        error: "No se pudo comprobar la asociación en Home Assistant.", candidates: [] } }));
    }
  }
  async function linkSpeed(light: HomeAssistantUiLight, candidate: HomeAssistantEffectSpeedCandidate) {
    setAdminBusy(light.entityId); setSpeedMessages(current => ({ ...current, [light.entityId]: "" }));
    try {
      const result = await window.nexaDesktop.homeAssistant.linkEffectSpeed({ lightEntityId: light.entityId, entityId: candidate.entityId });
      if (!result.ok) setSpeedMessages(current => ({ ...current, [light.entityId]: errorLabel(result.error) }));
      else if (result.value.authorizedLights.some(item => item.entityId === light.entityId
        && item.effectSpeedEntityId === candidate.entityId)) {
        setSpeedMessages(current => ({ ...current, [light.entityId]: "Control de velocidad vinculado." }));
        setSpeedDiscovery(current => { const next = { ...current }; delete next[light.entityId]; return next; });
        onRefresh();
      } else {
        setSpeedMessages(current => ({ ...current, [light.entityId]: "Nexa no confirmó la vinculación guardada. Actualizá el estado e intentá de nuevo." }));
        setSpeedDiscovery(current => { const next = { ...current }; delete next[light.entityId]; return next; });
        onRefresh();
      }
    } catch { setSpeedMessages(current => ({ ...current, [light.entityId]: "No se pudo guardar la vinculación." })); }
    finally { setAdminBusy(null); }
  }
  async function unlinkSpeed(light: HomeAssistantUiLight) {
    if (!window.confirm(`¿Desvincular el control de velocidad de ${light.name}?`)) return;
    setAdminBusy(light.entityId);
    try {
      const result = await window.nexaDesktop.homeAssistant.unlinkEffectSpeed({ lightEntityId: light.entityId });
      setSpeedMessages(current => ({ ...current, [light.entityId]: result.ok ? "Control de velocidad desvinculado." : errorLabel(result.error) }));
      if (result.ok) { speedQueue.setAuthorizedEntities(lights.filter(item => item.entityId !== light.entityId
        && item.effectSpeed?.linked && !item.effectSpeed.stale).map(item => item.entityId)); onRefresh(); }
    } catch { setSpeedMessages(current => ({ ...current, [light.entityId]: "No se pudo quitar la vinculación." })); }
    finally { setAdminBusy(null); }
  }
  async function setSpeed(light: HomeAssistantUiLight, value: number) {
    try {
      const result = await window.nexaDesktop.homeAssistant.setEffectSpeed({ lightEntityId: light.entityId, value });
      if (!result.ok) setSpeedMessages(current => ({ ...current, [light.entityId]: errorLabel(result.error) }));
      else {
        setSpeedMessages(current => ({ ...current, [light.entityId]: result.value.outcome === "confirmed"
          ? "Velocidad confirmada." : "Solicitud aceptada; velocidad sin confirmar." }));
        onRefresh();
      }
    } catch { setSpeedMessages(current => ({ ...current, [light.entityId]: "No se pudo confirmar la velocidad." })); }
  }
  async function authorize(light: DiscoveredHomeAssistantLight) {
    setAdminBusy(light.entityId); setAdminMessage(null);
    try {
      const result = await window.nexaDesktop.homeAssistant.authorizeLight({ entityId: light.entityId, name: light.name });
      if (!result.ok) setAdminMessage(errorLabel(result.error));
      else { setAdminMessage(result.value.changed ? "Luz autorizada." : "La luz ya estaba autorizada."); setDiscovered(items => items.map(item => item.entityId === light.entityId ? { ...item, alreadyAuthorized: true } : item)); onRefresh(); }
    } catch { setAdminMessage("No se pudo guardar la autorización de la luz."); }
    finally { setAdminBusy(null); }
  }
  function startEdit(light: AuthorizedHomeAssistantLight) {
    setEditing(light.entityId);
    setFormValues(current => ({ ...current, [light.entityId]: {
      name: light.name ?? "", area: light.area ?? "", aliases: light.aliases?.join(", ") ?? "",
    } }));
  }
  async function saveMetadata(entityId: string) {
    const value = formValues[entityId];
    if (!value) return;
    setAdminBusy(entityId); setAdminMessage(null);
    try {
      const aliases = value.aliases.split(",").map(alias => alias.trim()).filter(Boolean);
      const result = await window.nexaDesktop.homeAssistant.updateLightMetadata({ entityId,
        name: value.name.trim() || null, area: value.area.trim() || null, aliases });
      if (!result.ok) setAdminMessage(errorLabel(result.error));
      else { setAdminMessage("Datos de la luz actualizados."); setEditing(null); onRefresh(); }
    } catch { setAdminMessage("No se pudieron actualizar los datos de la luz."); }
    finally { setAdminBusy(null); }
  }
  async function remove(light: HomeAssistantUiLight) {
    if (!window.confirm("¿Retirar la autorización de " + light.name + "? Nexa dejará de controlarla.")) return;
    setAdminBusy(light.entityId); setAdminMessage(null);
    try {
      const result = await window.nexaDesktop.homeAssistant.removeAuthorizedLight({ entityId: light.entityId });
      if (!result.ok) setAdminMessage(errorLabel(result.error));
      else { setAdminMessage("Autorización retirada."); onRefresh(); }
    } catch { setAdminMessage("No se pudo retirar la autorización."); }
    finally { setAdminBusy(null); }
  }
  return (
    <section className="home-page surface-panel" aria-label="Control de Nexa Home">
      <HolographicFrame />
      <header className="home-page-heading">
        <div><p className="section-kicker"><span className="eyebrow-line" />NEXA HOME</p><h1>Luces autorizadas</h1>
          <p>Controlá cada luz individualmente. El estado solo cambia cuando Home Assistant confirma el resultado.</p></div>
        <div className="home-page-actions">
          <button type="button" className="home-action-button" onClick={onRefresh} disabled={loading}>Actualizar estados</button>
          <button type="button" className="home-action-button home-action-button--primary" aria-expanded={showDiscovery} aria-controls="home-discovery-panel"
            onClick={() => { if (showDiscovery) closeDiscovery(); else openDiscovery(); }}>Agregar dispositivo</button>
        </div>
      </header>
      {(error || adminMessage) && <p className="home-page-notice" role={error ? "alert" : "status"}>{error ? errorLabel(error) : adminMessage}</p>}
      {discoveryMounted && <section id="home-discovery-panel" className={`home-discovery${showDiscovery ? " home-discovery--open" : ""}`}
        aria-label="Agregar luz autorizada" aria-hidden={!showDiscovery} inert={!showDiscovery} onTransitionEnd={finishDiscoveryClose}>
        <div className="home-discovery__inner">
          <div className="home-discovery-heading"><h2>Dispositivos encontrados</h2><div><button type="button" className="home-action-button" onClick={() => void discover()} disabled={discoveryBusy}>{discoveryBusy ? "Buscando…" : "Buscar luces"}</button><button type="button" className="home-action-button" onClick={closeDiscovery}>Cerrar</button></div></div>
          <p>Encontrar dispositivos no los autoriza. Elegí cada luz para incorporarla al registro de Nexa.</p>
          {discoveryError && <p className="home-page-notice" role="alert">{discoveryError}</p>}
          {!discoveryBusy && discovered.length === 0 && !discoveryError && <p className="home-muted">Buscá para mostrar las luces disponibles en Home Assistant.</p>}
          <ul className="home-discovered-list">
            {discovered.map(light => <li key={light.entityId}>
              <span><strong>{light.name}</strong><small>{light.entityId} · {light.available ? light.state : "No disponible"}</small></span>
              <button type="button" className="home-action-button" disabled={light.alreadyAuthorized || adminBusy === light.entityId || !light.available}
                onClick={() => void authorize(light)}>{light.alreadyAuthorized ? "Autorizada" : adminBusy === light.entityId ? "Guardando…" : "Autorizar"}</button>
            </li>)}
          </ul>
        </div>
      </section>}
      {loading && lights.length === 0 && <div className="home-empty" role="status">Consultando Home Assistant…</div>}
      {!loading && lights.length === 0 && !error && <div className="home-empty"><strong>No hay luces autorizadas todavía.</strong><span>Usá “Agregar dispositivo” para descubrir y autorizar una luz.</span></div>}
      <div className="home-room-list" aria-busy={loading}>
        {grouped.map(([area, roomLights]) => <section className="home-room" key={area} aria-label={area}>
          <h2>{area}</h2>
          <div className="home-room-lights">{roomLights.map(light => {
            const busy = busyEntities.has(light.entityId) || adminBusy === light.entityId;
            const status = busyEntities.has(light.entityId) ? "Ejecutando operación…"
              : outcomes[light.entityId] ?? (!light.available ? "No disponible"
                : light.state === "on" ? "Encendida" : light.state === "off" ? "Apagada" : "Estado no confirmado");
            const values = localControls(light);
            const selectedEffect = light.effectList.includes(selectedEffects[light.entityId] ?? "")
              ? selectedEffects[light.entityId] : "";
            const speed = light.effectSpeed;
            const speedValue = speedDrafts[light.entityId] ?? speed?.value ?? null;
            const candidates = speedDiscovery[light.entityId];
            const stored: AuthorizedHomeAssistantLight = { entityId: light.entityId, name: light.name, area: light.area ?? undefined, aliases: light.aliases };
            const form = formValues[light.entityId] ?? { name: light.name, area: light.area ?? "", aliases: light.aliases.join(", ") };
            return <article className="home-light-card" key={light.entityId} aria-busy={busy}>
              <div className="home-light-card__top">
                <div className="home-light-title"><span className={"home-state-dot home-state-dot--" + (light.available ? light.state : "unavailable")} />
                  <div><h3>{light.name}</h3><span>{status}</span></div></div>
                <button type="button" className="home-switch" role="switch" aria-label={"Luz " + light.name}
                  aria-checked={light.state === "on"} aria-busy={busy} disabled={!light.available || busy}
                  onClick={() => onControl(light, { action: light.state === "on" ? "turn_off" : "turn_on" })}><span /></button>
              </div>
              <div className="home-light-meta"><span>{light.area ?? "Sin habitación"}</span><small>{light.entityId}</small></div>
              <div className="home-light-visual-state" aria-live="polite" aria-label="Estado visual confirmado">
                <span>Estado confirmado</span>
                <strong>{colorDescription(light)}</strong>
                {fixedColor(light) && <span className="home-confirmed-color" aria-label="Color confirmado" style={{ backgroundColor: colorHex(fixedColor(light)) }} />}
              </div>
              {light.capabilities.brightness && <div className="home-light-control">
                <label htmlFor={"brightness-" + light.entityId}><span>Brillo</span><strong>{values.brightness}%</strong></label>
                <input id={"brightness-" + light.entityId} type="range" min="1" max="100" step="1" value={values.brightness}
                  disabled={!light.available || adminBusy === light.entityId} onChange={event => {
                    const brightness = Number(event.currentTarget.value);
                    setControls(current => ({ ...current, [light.entityId]: { ...localControls(light), brightness } }));
                    queue.schedule(light.entityId, brightness, (entityId, brightnessPct) =>
                      onControl(light, { action: "turn_on", brightnessPct }));
                  }} />
              </div>}
              {light.capabilities.color && <div className="home-light-control home-light-control--color">
                <label htmlFor={"color-" + light.entityId}><span>Cambiar color</span></label>
                <input id={"color-" + light.entityId} type="color" value={values.color} disabled={!light.available || busy}
                  onChange={event => { const color = event.currentTarget.value; setControls(current => ({ ...current, [light.entityId]: { ...localControls(light), color } })); }} />
                <button type="button" className="home-secondary-button home-effect-button--color" disabled={!light.available || busy}
                  aria-busy={busy} onClick={() => { const rgbColor = colorRgb(values.color); if (rgbColor) onControl(light, { action: "turn_on", rgbColor }); }}>{busy ? "Aplicando…" : "Aplicar color"}</button>
              </div>}
              {light.effectList.length > 0 && <div className="home-light-control home-light-control--effect">
                <label htmlFor={"effect-" + light.entityId}><span>Cambiar efecto WiZ</span></label>
                <HomeEffectPicker id={"effect-" + light.entityId} lightName={light.name} effects={light.effectList}
                  value={selectedEffect} disabled={!light.available || busy}
                  onChange={effect => setSelectedEffects(current => ({ ...current, [light.entityId]: effect }))} />
                <button type="button" className="home-secondary-button home-effect-button" disabled={!light.available || busy || !selectedEffect}
                  aria-busy={busy} onClick={() => { if (selectedEffect) void onApplyEffect(light, selectedEffect); }}>{busy ? "Aplicando…" : "Aplicar efecto"}</button>
              </div>}
              <div className="home-effect-speed" aria-live="polite">
                {speed?.linked && !speed.stale && speed.available && speedValue !== null ? <>
                  <label htmlFor={`effect-speed-${light.entityId}`}><span>Velocidad del efecto</span><strong>{speedValue}</strong></label>
                  <input id={`effect-speed-${light.entityId}`} type="range" min={speed.min!} max={speed.max!}
                    step={speed.step ?? "any"} value={speedValue} disabled={busy || adminBusy === light.entityId}
                    onChange={event => {
                      const value = Number(event.currentTarget.value);
                      setSpeedDrafts(current => ({ ...current, [light.entityId]: value }));
                      speedQueue.schedule(light.entityId, value, (_entityId, next) => setSpeed(light, next));
                    }} />
                  <div className="home-effect-speed__ends"><span>Lento · {speed.min}</span><span>Rápido · {speed.max}</span></div>
                  <button type="button" className="home-link-button" disabled={adminBusy === light.entityId}
                    onClick={() => void unlinkSpeed(light)}>Desvincular velocidad</button>
                </> : speed?.linked && speed.error ? <p className="home-muted">{errorLabel(speed.error)}</p>
                  : speed?.linked && speed.stale ? <>
                    <p className="home-muted">La entidad asociada cambió o ya no pertenece a esta luz. Volvé a vincularla.</p>
                    <button type="button" className="home-link-button" disabled={!light.available || adminBusy === light.entityId || candidates?.loading}
                      onClick={() => void discoverSpeed(light)}>{candidates?.loading ? "Buscando control de velocidad…" : "Buscar nueva vinculación"}</button>
                  </>
                  : speed?.linked ? <p className="home-muted">El control de velocidad no está disponible en este momento.</p>
                    : <button type="button" className="home-link-button" disabled={!light.available || adminBusy === light.entityId || candidates?.loading}
                      onClick={() => void discoverSpeed(light)}>{candidates?.loading ? "Buscando control de velocidad…" : "Vincular velocidad del efecto"}</button>}
                {speedMessages[light.entityId] && <small className="home-effect-speed__message" role="status">{speedMessages[light.entityId]}</small>}
                {candidates?.error && <small className="home-effect-speed__message" role="alert">{candidates.error}</small>}
                {candidates && !candidates.loading && !candidates.error && (!speed?.linked || speed.stale) && <>
                  {candidates.candidates.length === 0 && <small className="home-muted">No se encontró un control de velocidad de efectos para esta luz.</small>}
                  {candidates.candidates.length > 1 && <small className="home-muted">Hay varios controles compatibles. Elegí explícitamente el que corresponde.</small>}
                  {candidates.candidates.map(candidate => <div className="home-effect-speed__candidate" key={candidate.entityId}>
                    <span>{candidate.name}{candidate.available ? " · disponible" : " · temporalmente no disponible"}</span>
                    <button type="button" className="home-action-button" disabled={adminBusy === light.entityId}
                      onClick={() => void linkSpeed(light, candidate)}>Vincular</button>
                  </div>)}
                  <button type="button" className="home-link-button" onClick={() => setSpeedDiscovery(current => {
                    const next = { ...current }; delete next[light.entityId]; return next;
                  })}>Cerrar</button>
                </>}
              </div>
              {editing === light.entityId ? <div className="home-metadata-editor">
                <label>Nombre<input maxLength={120} value={form.name} onChange={event => { const name = event.currentTarget.value; setFormValues(current => ({ ...current, [light.entityId]: { ...form, name } })); }} /></label>
                <label>Habitación<input maxLength={80} value={form.area} onChange={event => { const area = event.currentTarget.value; setFormValues(current => ({ ...current, [light.entityId]: { ...form, area } })); }} /></label>
                <label>Alias separados por coma<input maxLength={400} value={form.aliases} onChange={event => { const aliases = event.currentTarget.value; setFormValues(current => ({ ...current, [light.entityId]: { ...form, aliases } })); }} /></label>
                <div><button type="button" className="home-secondary-button" disabled={busy} onClick={() => setEditing(null)}>Cancelar</button>
                  <button type="button" className="home-action-button" disabled={busy} onClick={() => void saveMetadata(light.entityId)}>Guardar</button></div>
              </div> : <div className="home-light-admin">
                <button type="button" className="home-link-button" disabled={busy}
                  onClick={() => startEdit(stored)}>Editar nombre, habitación y alias</button>
                <button type="button" className="home-link-button home-link-button--danger" disabled={busy}
                  onClick={() => void remove(light)}>Retirar autorización</button>
              </div>}
            </article>;
          })}</div>
        </section>)}
      </div>
    </section>
  );
}
