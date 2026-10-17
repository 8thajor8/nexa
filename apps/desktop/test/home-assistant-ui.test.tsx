// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantPanel } from "../src/renderer/components/HomeAssistantPanel";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { DashboardModules } from "../src/renderer/components/DashboardModules";
import type { HomeAssistantUiLight } from "../src/shared/ipc-contract";

const light: HomeAssistantUiLight = { entityId: "light.office", name: "Desk lamp", area: "Study", aliases: ["Desk"],
  state: "off", available: true, brightnessPct: 60, rgbColor: [25, 30, 40],
  rgbwColor: null, colorTemperatureKelvin: null, effect: null, effectList: [],
  capabilities: { brightness: true, color: true } };
function setApi(api: Record<string, unknown>) {
  Object.defineProperty(window, "nexaDesktop", { configurable: true, value: { isIsolated: false,
    isSyntheticOrganicPilot: false, homeAssistant: api } });
}
afterEach(() => { cleanup(); vi.useRealTimers(); delete (window as unknown as { nexaDesktop?: unknown }).nexaDesktop; });

describe("Nexa Home UI", () => {
  it("routes Home and back navigation, and removes Memory from the sidebar", () => {
    const onHome = vi.fn(); const onCommand = vi.fn(); const onConversations = vi.fn();
    render(<Sidebar activeView="home" onOpenHome={onHome} onOpenCommandCenter={onCommand}
      onOpenConversations={onConversations} />);
    const labels = [...document.querySelectorAll(".nav-label")].map(node => node.textContent);
    expect(labels.slice(0, 3)).toEqual(["Command Center", "Conversations", "Home"]);
    expect(labels).not.toContain("Memory");
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Command Center" }));
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(onHome).toHaveBeenCalledOnce(); expect(onCommand).toHaveBeenCalledOnce(); expect(onConversations).toHaveBeenCalledOnce();
  });

  it("shows independent confirmed switch state and capability-specific controls", () => {
    const onControl = vi.fn();
    const view = render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={onControl} />);
    expect(screen.getByRole("switch", { name: "Luz Desk lamp" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByLabelText(/Brillo/)).toBeTruthy();
    expect(document.getElementById("color-light.office")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Luz Desk lamp" }));
    expect(onControl).toHaveBeenCalledWith(light, { action: "turn_on" });
    onControl.mockClear();
    view.rerender(<HomeAssistantPanel lights={[{ ...light, state: "on" }]} loading={false} error={null}
      busyEntities={new Set()} outcomes={{}} onRefresh={vi.fn()} onControl={onControl} />);
    fireEvent.click(screen.getByRole("switch", { name: "Luz Desk lamp" }));
    expect(onControl).toHaveBeenCalledWith({ ...light, state: "on" }, { action: "turn_off" });
  });

  it("debounces brightness into one automatic request and keeps color as an explicit action", async () => {
    vi.useFakeTimers();
    const onControl = vi.fn();
    render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={onControl} />);

    const brightness = screen.getByLabelText(/Brillo/);
    fireEvent.change(brightness, { target: { value: "68" } });
    fireEvent.change(brightness, { target: { value: "72" } });
    expect(screen.getByText("72%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aplicar brillo" })).toBeNull();
    expect(onControl).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); });
    expect(onControl).toHaveBeenLastCalledWith(light, { action: "turn_on", brightnessPct: 72 });
    expect(onControl).toHaveBeenCalledOnce();

    fireEvent.change(document.getElementById("color-light.office")!, { target: { value: "#ff0080" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar color" }));
    expect(onControl).toHaveBeenLastCalledWith(light, { action: "turn_on", rgbColor: [255, 0, 128] });
    vi.useRealTimers();
  });

  it("keeps the newest slider draft when an older request returns", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>(resolve => { releaseFirst = resolve; });
    const onControl = vi.fn().mockImplementationOnce(() => firstRequest).mockResolvedValue(undefined);
    const view = render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={onControl} />);
    const slider = document.getElementById("brightness-light.office") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "75" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(onControl).toHaveBeenCalledOnce();
    fireEvent.change(slider, { target: { value: "90" } });
    view.rerender(<HomeAssistantPanel lights={[{ ...light, brightnessPct: 75 }]} loading={false} error={null}
      busyEntities={new Set()} outcomes={{}} onRefresh={vi.fn()} onControl={onControl} />);
    expect(screen.getByText("90%")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(300); });
    releaseFirst();
    await act(async () => { await firstRequest; await Promise.resolve(); await Promise.resolve(); });
    expect(onControl).toHaveBeenCalledTimes(2);
    expect(onControl).toHaveBeenLastCalledWith(light, { action: "turn_on", brightnessPct: 90 });
    expect(screen.getByText("90%")).toBeTruthy();
  });

  it("shows only reported effects in the Nexa picker and applies the selected effect explicitly", () => {
    const onApplyEffect = vi.fn();
    const effectLight: HomeAssistantUiLight = { ...light, effectList: ["Party", "Ocean", "Fireplace"] };
    render(<HomeAssistantPanel lights={[effectLight]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} onApplyEffect={onApplyEffect} />);
    const picker = document.getElementById("effect-light.office") as HTMLButtonElement;
    const apply = screen.getByRole("button", { name: "Aplicar efecto" }) as HTMLButtonElement;
    expect(picker).toBeTruthy();
    expect(document.querySelector("select#effect-light\\.office")).toBeNull();
    expect(apply.disabled).toBe(true);
    fireEvent.click(picker);
    const listbox = screen.getByRole("listbox", { name: "Efectos disponibles para Desk lamp" });
    expect([...listbox.querySelectorAll('[role="option"]')].map(option => option.textContent?.trim())).toEqual(["Party", "Ocean", "Fireplace"]);
    fireEvent.scroll(listbox);
    expect(listbox.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: "Ocean" }));
    expect(picker.textContent).toContain("Ocean");
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(onApplyEffect).toHaveBeenCalledWith(effectLight, "Ocean");
  });

  it("supports keyboard navigation and selection in the effect picker", () => {
    const effectLight: HomeAssistantUiLight = { ...light, effectList: ["Party", "Ocean", "Fireplace"] };
    render(<HomeAssistantPanel lights={[effectLight]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);
    const picker = screen.getByRole("button", { name: "Elegir un efecto para Desk lamp" });
    fireEvent.click(picker);
    const listbox = screen.getByRole("listbox", { name: "Efectos disponibles para Desk lamp" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(picker.textContent).toContain("Ocean");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the effect picker with Escape and an outside pointer without changing the reported effect list", () => {
    const effectLight: HomeAssistantUiLight = { ...light, effect: "Party", effectList: ["Party", "Ocean"] };
    render(<HomeAssistantPanel lights={[effectLight]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);
    const picker = document.getElementById("effect-light.office") as HTMLButtonElement;
    expect(screen.getByText("Efecto: Party")).toBeTruthy();
    fireEvent.click(picker);
    let listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(picker);
    listbox = screen.getByRole("listbox");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps one color and one effect control while showing their confirmed state separately", () => {
    const effectLight: HomeAssistantUiLight = { ...light, effect: "Ocean", effectList: ["Ocean", "Party"] };
    const { container } = render(<HomeAssistantPanel lights={[effectLight]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);
    expect(container.querySelectorAll('input[type="color"]')).toHaveLength(1);
    expect(container.querySelectorAll(".home-effect-picker__trigger")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Aplicar color" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Aplicar efecto" })).toHaveLength(1);
    expect(screen.getByText("Estado confirmado")).toBeTruthy();
    expect(screen.getByText("Efecto: Ocean")).toBeTruthy();
    expect(screen.getByText("Cambiar efecto WiZ")).toBeTruthy();
  });

  it("prioritizes confirmed effects over color and reflects externally observed color state", () => {
    const effectLight: HomeAssistantUiLight = { ...light, effect: "TV time", effectList: ["TV time"] };
    const view = render(<HomeAssistantPanel lights={[effectLight]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);
    expect(screen.getByText("Efecto: TV time")).toBeTruthy();
    expect(screen.queryByLabelText("Color confirmado")).toBeNull();
    expect((document.getElementById("color-light.office") as HTMLInputElement).value).toBe("#ffffff");
    view.rerender(<HomeAssistantPanel lights={[{ ...light, rgbColor: [0, 80, 240] }]} loading={false} error={null}
      busyEntities={new Set()} outcomes={{}} onRefresh={vi.fn()} onControl={vi.fn()} />);
    expect((document.getElementById("color-light.office") as HTMLInputElement).value).toBe("#0050f0");
    expect(screen.getByLabelText("Color confirmado")).toBeTruthy();
  });

  it("describes RGBW, color temperature, and unavailable color without inventing RGB", () => {
    const view = render(<HomeAssistantPanel lights={[{ ...light, rgbColor: null, rgbwColor: [10, 20, 30, 40],
      capabilities: { brightness: true, color: false } }]}
      loading={false} error={null} busyEntities={new Set()} outcomes={{}} onRefresh={vi.fn()} onControl={vi.fn()} />);
    expect(screen.getByText("RGBW: 10, 20, 30, 40")).toBeTruthy();
    view.rerender(<HomeAssistantPanel lights={[{ ...light, rgbColor: null, rgbwColor: null, colorTemperatureKelvin: 2700 }]}
      loading={false} error={null} busyEntities={new Set()} outcomes={{}} onRefresh={vi.fn()} onControl={vi.fn()} />);
    expect(screen.getByText("Blanco: 2700 K")).toBeTruthy();
    view.rerender(<HomeAssistantPanel lights={[{ ...light, rgbColor: null, rgbwColor: null, colorTemperatureKelvin: null }]}
      loading={false} error={null} busyEntities={new Set()} outcomes={{}} onRefresh={vi.fn()} onControl={vi.fn()} />);
    expect(screen.getByText("Color no disponible")).toBeTruthy();
    expect(screen.queryByLabelText("Color confirmado")).toBeNull();
  });

  it("closes and reopens device discovery without authorizing discovered lights", async () => {
    const discoverLights = vi.fn().mockResolvedValue({ ok: true, value: { lights: [] } });
    const authorizeLight = vi.fn();
    setApi({ discoverLights, authorizeLight, updateLightMetadata: vi.fn(), removeAuthorizedLight: vi.fn() });
    render(<HomeAssistantPanel lights={[]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Agregar dispositivo" }));
    expect(await screen.findByRole("region", { name: "Agregar luz autorizada" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Agregar luz autorizada" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Agregar dispositivo" }));
    expect(await screen.findByRole("region", { name: "Agregar luz autorizada" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Buscar luces" }));
    await waitFor(() => expect(discoverLights).toHaveBeenCalledOnce());
    expect(authorizeLight).not.toHaveBeenCalled();
  });

  it("keeps authorized light cards mounted and preserves their control state through discovery transitions", async () => {
    setApi({ discoverLights: vi.fn().mockResolvedValue({ ok: true, value: { lights: [] } }),
      authorizeLight: vi.fn(), updateLightMetadata: vi.fn(), removeAuthorizedLight: vi.fn() });
    const { container } = render(<HomeAssistantPanel lights={[light]} loading={false} error={null}
      busyEntities={new Set()} outcomes={{}} onRefresh={vi.fn()} onControl={vi.fn()} />);
    const card = container.querySelector(".home-light-card");
    const brightness = screen.getByLabelText(/Brillo/) as HTMLInputElement;
    fireEvent.change(brightness, { target: { value: "73" } });

    fireEvent.click(screen.getByRole("button", { name: "Agregar dispositivo" }));
    const discovery = await screen.findByRole("region", { name: "Agregar luz autorizada" });
    expect(discovery.classList.contains("home-discovery--open")).toBe(true);
    expect(container.querySelector(".home-light-card")).toBe(card);
    expect(screen.getByLabelText(/Brillo/)).toBe(brightness);
    expect(brightness.value).toBe("73");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(discovery.classList.contains("home-discovery--open")).toBe(false);
    expect(container.querySelector(".home-light-card")).toBe(card);
    expect(screen.getByLabelText(/Brillo/)).toBe(brightness);
    expect(brightness.value).toBe("73");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Agregar luz autorizada" })).toBeNull());
    expect(container.querySelector(".home-light-card")).toBe(card);
    expect(brightness.value).toBe("73");
  });

  it("uses an in-flow 210 ms discovery expansion and reduces its motion when requested", () => {
    const stylesheet = readFileSync("src/renderer/styles.css", "utf8");
    const collapsed = stylesheet.match(/\.home-discovery\s*\{([^}]*)\}/u)?.[1] ?? "";
    const expanded = stylesheet.match(/\.home-discovery--open\s*\{([^}]*)\}/u)?.[1] ?? "";
    const homeMotion = stylesheet.slice(stylesheet.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(collapsed).toContain("grid-template-rows: 0fr");
    expect(collapsed).toContain("grid-template-rows 210ms ease");
    expect(expanded).toContain("grid-template-rows: 1fr");
    expect(homeMotion).toMatch(/\.home-discovery\s*\{\s*transition-duration:\s*1ms;/u);
  });

  it("keeps controls available after an IPC error state so the user can retry", () => {
    const onControl = vi.fn();
    render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()}
      outcomes={{ [light.entityId]: "Error" }} onRefresh={vi.fn()} onControl={onControl} />);

    expect(screen.getByText("Error")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Luz Desk lamp" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(onControl).toHaveBeenCalledOnce();
  });

  it("marks unavailable lights and does not allow a switch operation", () => {
    const offline = { ...light, available: false, state: "unavailable" as const };
    const onControl = vi.fn();
    render(<HomeAssistantPanel lights={[offline]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={onControl} />);
    expect((screen.getByRole("switch", { name: "Luz Desk lamp" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Luz Desk lamp" }));
    expect(onControl).not.toHaveBeenCalled();
    expect(screen.getByText("No disponible")).toBeTruthy();
  });

  it("does not authorize a discovered light until the explicit authorize button is selected", async () => {
    const authorizeLight = vi.fn().mockResolvedValue({ ok: true, value: { changed: true, authorizedLights: [] } });
    setApi({ discoverLights: vi.fn().mockResolvedValue({ ok: true, value: { lights: [{ entityId: "light.guest", name: "Guest",
      state: "off", available: true, capabilities: { brightness: false, color: false }, alreadyAuthorized: false }] } }),
      authorizeLight, updateLightMetadata: vi.fn(), removeAuthorizedLight: vi.fn() });
    render(<HomeAssistantPanel lights={[]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Agregar dispositivo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Buscar luces" }));
    expect(await screen.findByText("Guest")).toBeTruthy();
    expect(authorizeLight).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Autorizar" }));
    await waitFor(() => expect(authorizeLight).toHaveBeenCalledWith({ entityId: "light.guest", name: "Guest" }));
  });

  it("supports metadata edits and requires explicit removal confirmation", async () => {
    const updateLightMetadata = vi.fn().mockResolvedValue({ ok: true, value: { authorizedLights: [] } });
    const removeAuthorizedLight = vi.fn().mockResolvedValue({ ok: true, value: { authorizedLights: [] } });
    setApi({ updateLightMetadata, removeAuthorizedLight, discoverLights: vi.fn(), authorizeLight: vi.fn() });
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar nombre, habitación y alias" }));
    fireEvent.change(screen.getByLabelText("Habitación"), { target: { value: "Office" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(updateLightMetadata).toHaveBeenCalledWith({ entityId: "light.office", name: "Desk lamp",
      area: "Office", aliases: ["Desk"] }));
    fireEvent.click(screen.getByRole("button", { name: "Retirar autorización" }));
    expect(removeAuthorizedLight).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shows speed discovery candidates without linking until Dirección confirms", async () => {
    const candidate = { entityId: "number.office_effect_speed", name: "Effect speed", available: true, sameDeviceVerified: true as const };
    const discoverEffectSpeedCandidates = vi.fn().mockResolvedValue({ ok: true,
      value: { lightEntityId: "light.office", candidates: [candidate] } });
    const linkEffectSpeed = vi.fn().mockResolvedValue({ ok: true, value: { authorizedLights: [
      { entityId: light.entityId, name: light.name, area: light.area, aliases: light.aliases, effectSpeedEntityId: candidate.entityId },
    ] } });
    setApi({ discoverEffectSpeedCandidates, linkEffectSpeed, unlinkEffectSpeed: vi.fn(), setEffectSpeed: vi.fn() });
    render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);

    expect(document.querySelector('input[type="range"][id^="effect-speed-"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Vincular velocidad del efecto" }));
    expect(await screen.findByText("Effect speed · disponible")).toBeTruthy();
    expect(linkEffectSpeed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Vincular" }));
    await waitFor(() => expect(linkEffectSpeed).toHaveBeenCalledWith({ lightEntityId: "light.office", entityId: candidate.entityId }));
    expect(await screen.findByText("Control de velocidad vinculado.")).toBeTruthy();
    expect(screen.queryByText("No se encontró un control de velocidad de efectos para esta luz.")).toBeNull();
  });

  it("does not claim a speed link unless Main returns the persisted association", async () => {
    const candidate = { entityId: "number.office_effect_speed", name: "Effect speed", available: true, sameDeviceVerified: true as const };
    const discoverEffectSpeedCandidates = vi.fn().mockResolvedValue({ ok: true,
      value: { lightEntityId: light.entityId, candidates: [candidate] } });
    const linkEffectSpeed = vi.fn().mockResolvedValue({ ok: true, value: { authorizedLights: [] } });
    setApi({ discoverEffectSpeedCandidates, linkEffectSpeed, unlinkEffectSpeed: vi.fn(), setEffectSpeed: vi.fn() });
    render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Vincular velocidad del efecto" }));
    fireEvent.click(await screen.findByRole("button", { name: "Vincular" }));
    expect(await screen.findByText(/Nexa no confirmó la vinculación guardada/)).toBeTruthy();
    expect(screen.queryByText("Control de velocidad vinculado.")).toBeNull();
    expect(screen.queryByText("No se encontró un control de velocidad de efectos para esta luz.")).toBeNull();
  });

  it("shows a useful safe message for a persistent-store link failure", async () => {
    const candidate = { entityId: "number.office_effect_speed", name: "Effect speed", available: true, sameDeviceVerified: true as const };
    const discoverEffectSpeedCandidates = vi.fn().mockResolvedValue({ ok: true,
      value: { lightEntityId: light.entityId, candidates: [candidate] } });
    const linkEffectSpeed = vi.fn().mockResolvedValue({ ok: false, error: "home_assistant_device_store_write_failed" });
    setApi({ discoverEffectSpeedCandidates, linkEffectSpeed, unlinkEffectSpeed: vi.fn(), setEffectSpeed: vi.fn() });
    render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Vincular velocidad del efecto" }));
    fireEvent.click(await screen.findByRole("button", { name: "Vincular" }));
    expect(await screen.findByText("Nexa no pudo guardar la vinculación del control de velocidad.")).toBeTruthy();
    expect(screen.queryByText("No se pudo completar la operación de Nexa Home.")).toBeNull();
    expect(screen.queryByText("Control de velocidad vinculado.")).toBeNull();
  });

  it("does not present a failed registry lookup as a successful empty discovery", async () => {
    const discoverEffectSpeedCandidates = vi.fn().mockResolvedValue({ ok: false, error: "home_assistant_request_rejected" });
    setApi({ discoverEffectSpeedCandidates, linkEffectSpeed: vi.fn(), unlinkEffectSpeed: vi.fn(), setEffectSpeed: vi.fn() });
    render(<HomeAssistantPanel lights={[light]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Vincular velocidad del efecto" }));
    expect(await screen.findByText("Home Assistant rechazó la consulta del control de velocidad.")).toBeTruthy();
    expect(screen.queryByText("No se encontró un control de velocidad de efectos para esta luz.")).toBeNull();
    expect(screen.queryByText("No se pudo completar la operación de Nexa Home.")).toBeNull();
  });

  it("renders the speed slider with live limits and debounces a fixed light/value request", async () => {
    vi.useFakeTimers();
    const setEffectSpeed = vi.fn().mockResolvedValue({ ok: true, value: { outcome: "confirmed", state: null } });
    setApi({ discoverEffectSpeedCandidates: vi.fn(), linkEffectSpeed: vi.fn(), unlinkEffectSpeed: vi.fn(), setEffectSpeed });
    const speedLight: HomeAssistantUiLight = { ...light, effectSpeed: { lightEntityId: light.entityId, linked: true,
      available: true, stale: false, value: 37, min: 7, max: 97, step: 3, entityName: "Effect speed", error: null } };
    render(<HomeAssistantPanel lights={[speedLight]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);
    const slider = document.getElementById("effect-speed-light.office") as HTMLInputElement;
    expect(slider.min).toBe("7"); expect(slider.max).toBe("97"); expect(slider.step).toBe("3"); expect(slider.value).toBe("37");
    fireEvent.change(slider, { target: { value: "40" } });
    expect(screen.getByText("40")).toBeTruthy();
    expect(setEffectSpeed).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); });
    expect(setEffectSpeed).toHaveBeenCalledOnce();
    expect(setEffectSpeed).toHaveBeenCalledWith({ lightEntityId: "light.office", value: 40 });
    vi.useRealTimers();
  });

  it("offers rediscovery for a stale association without exposing a speed control", async () => {
    const candidate = { entityId: "number.office_effect_speed", name: "Effect speed", available: true, sameDeviceVerified: true as const };
    const discoverEffectSpeedCandidates = vi.fn().mockResolvedValue({ ok: true,
      value: { lightEntityId: "light.office", candidates: [candidate] } });
    const linkEffectSpeed = vi.fn().mockResolvedValue({ ok: true, value: { authorizedLights: [] } });
    setApi({ discoverEffectSpeedCandidates, linkEffectSpeed, unlinkEffectSpeed: vi.fn(), setEffectSpeed: vi.fn() });
    const staleLight: HomeAssistantUiLight = { ...light, effectSpeed: { lightEntityId: light.entityId, linked: true,
      available: false, stale: true, value: null, min: null, max: null, step: null, entityName: null, error: null } };
    render(<HomeAssistantPanel lights={[staleLight]} loading={false} error={null} busyEntities={new Set()} outcomes={{}}
      onRefresh={vi.fn()} onControl={vi.fn()} />);
    expect(document.querySelector('input[type="range"][id^="effect-speed-"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Buscar nueva vinculación" }));
    await waitFor(() => expect(discoverEffectSpeedCandidates).toHaveBeenCalledWith({ lightEntityId: "light.office" }));
    expect(await screen.findByText("Effect speed · disponible")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Vincular" }));
    await waitFor(() => expect(linkEffectSpeed).toHaveBeenCalledWith({ lightEntityId: "light.office", entityId: candidate.entityId }));
  });

  it("keeps the Command Center summary scrollable and delegates each switch to one light", () => {
    const onHomeToggle = vi.fn();
    render(<DashboardModules assistantState="Listo" homeLights={[light]} homeLoading={false} homeBusyEntities={new Set()}
      homeOutcomes={{}} onHomeToggle={onHomeToggle} onOpenHome={vi.fn()} onRefreshHome={vi.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Luz Desk lamp" }));
    expect(onHomeToggle).toHaveBeenCalledWith(light);
    expect(document.querySelector(".home-mini-list")).toBeTruthy();
  });
});
