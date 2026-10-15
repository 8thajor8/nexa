// @vitest-environment jsdom

import { createElement, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NexaDesktopApi, VoiceEventEnvelope } from "../src/shared/ipc-contract";
import App from "../src/renderer/App";
import type { PttVoiceController, PttVoiceSnapshot } from "../src/renderer/voice/ptt-voice-controller";
import { MicrophoneDeviceStore } from "../src/renderer/audio/microphone-device-store";
import { MicVAD } from "@ricky0123/vad-web";

vi.mock("@ricky0123/vad-web", () => ({ MicVAD: { new: vi.fn(async () => ({
  start: vi.fn(async () => undefined), pause: vi.fn(async () => undefined), destroy: vi.fn(async () => undefined),
})) } }));

class FakeVoiceController {
  snapshot: PttVoiceSnapshot = { status: "idle", canStart: true };
  readonly listeners = new Set<() => void>();
  readonly subscribe = vi.fn((listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  });
  readonly getSnapshot = vi.fn(() => this.snapshot);
  readonly start = vi.fn(async () => {
    this.publish({ status: "listening", canStart: false, sessionId: "session-live" });
  });
  readonly finish = vi.fn(async () => {
    this.publish({ status: "processing", canStart: false, sessionId: "session-live", requestId: "finish-live" });
  });
  readonly cancel = vi.fn(async () => {
    this.publish({ status: "idle", canStart: true });
  });
  readonly recoverMainCancellation = vi.fn(async () => {
    this.publish({ status: "idle", canStart: true });
  });
  readonly destroy = vi.fn(async () => undefined);

  publish(snapshot: PttVoiceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

let controller: FakeVoiceController;
let bridge: NexaDesktopApi;
let microphoneDevices: MicrophoneDeviceStore;
let previousBridge: PropertyDescriptor | undefined;
let chatListeners: Set<(event: import("../src/shared/ipc-contract").ChatEventEnvelope) => void>;
let speechListeners: Set<(event: import("../src/shared/ipc-contract").VoiceSpeechEvent) => void>;

async function mountApp() {
  const view = render(createElement(StrictMode, null,
    createElement(App, { voiceController: controller as unknown as PttVoiceController, microphoneDevices })));
  await act(async () => { await Promise.resolve(); });
  return view;
}

function controlAnimationFrames() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId;
    pending.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { pending.delete(id); });
  return () => {
    const callbacks = [...pending.values()];
    pending.clear();
    act(() => { callbacks.forEach((callback) => callback(0)); });
  };
}

function finishTransition(element: Element, propertyName: string) {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  fireEvent(element, event);
}

function setScrollMetrics(element: HTMLElement, values: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  let scrollTop = values.scrollTop;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => values.scrollHeight },
    clientHeight: { configurable: true, get: () => values.clientHeight },
    scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
  });
}

beforeEach(async () => {
  window.localStorage.clear();
  controller = new FakeVoiceController();
  microphoneDevices = new MicrophoneDeviceStore({
    mediaDevices: { enumerateDevices: vi.fn(async () => [
      { kind: "audioinput", deviceId: "default", label: "Default - System Mic" },
      { kind: "audioinput", deviceId: "mic-usb", label: "USB Microphone" },
      { kind: "audiooutput", deviceId: "speaker", label: "Speakers" },
    ] as MediaDeviceInfo[]), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    storage: { getItem: () => null, setItem: vi.fn() },
  });
  await microphoneDevices.refresh();
  const eventListeners = new Set<(event: VoiceEventEnvelope) => void>();
  chatListeners = new Set();
  speechListeners = new Set();
  bridge = {
    isIsolated: false,
    ping: vi.fn(async () => ({ ok: true, message: "pong" })),
    getWallpaper: vi.fn(async () => ({ available: false })),
    weather: { getCurrent: vi.fn(async (location: string) => ({ available: false, location, temperatureC: null, condition: null, updatedAt: Date.now() })) },
    spotify: {
      getLiveStatus: vi.fn(async () => ({ state: "unavailable" as const, connected: false, deviceAvailable: false,
        controlsEnabled: false, track: null, message: null, updatedAt: Date.now() })),
      onLiveStatus: vi.fn(() => () => undefined),
    } as unknown as NexaDesktopApi["spotify"],
    masterVolume: {
      get: vi.fn(async () => ({ available: true, volume: 42, errorCode: null })),
      set: vi.fn(async (volume: number) => ({ available: true, volume, errorCode: null })),
      onChanged: vi.fn(() => () => undefined),
    },
    minimizeWindow: vi.fn(),
    toggleMaximizeWindow: vi.fn(async () => false),
    closeWindow: vi.fn(),
    chat: {
      createConversation: vi.fn(async () => ({ ok: true as const, conversationId: "00000000-0000-4000-8000-000000000010" })),
      sendMessage: vi.fn(async ({ conversationId, requestId }) => ({ ok: true as const, accepted: true as const, conversationId, requestId })),
      cancelRequest: vi.fn(async (requestId) => ({ ok: true as const, accepted: true as const, requestId })),
      onEvent: vi.fn((listener) => { chatListeners.add(listener); return () => chatListeners.delete(listener); }),
    },
    voice: {
      recordChatTiming: vi.fn(async () => true),
      endDucking: vi.fn(async () => true),
      ptt: {
        start: vi.fn(async () => ({ ok: false, requestId: "unused", error: { code: "invalid_request", message: "unused" } })),
        finish: vi.fn(async () => ({ ok: false, requestId: "unused", error: { code: "invalid_request", message: "unused" } })),
        cancel: vi.fn(async () => ({ ok: false, requestId: "unused", error: { code: "invalid_request", message: "unused" } })),
      },
      speech: {
        playChatResponse: vi.fn(async () => true),
        acknowledge: vi.fn(async ({ requestId }: { requestId: string }) => ({ ok: true as const, requestId, accepted: true })),
        cancel: vi.fn(async ({ requestId }: { requestId: string }) => ({ ok: true as const, requestId, cancelled: true as const })),
        onEvent: vi.fn((listener: (event: import("../src/shared/ipc-contract").VoiceSpeechEvent) => void) => {
          speechListeners.add(listener);
          return () => speechListeners.delete(listener);
        }),
      },
      onEvent: vi.fn((listener: (event: VoiceEventEnvelope) => void) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      }),
    },
  };
  previousBridge = Object.getOwnPropertyDescriptor(window, "nexaDesktop");
  Object.defineProperty(window, "nexaDesktop", { configurable: true, value: bridge });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (previousBridge) Object.defineProperty(window, "nexaDesktop", previousBridge);
  else Reflect.deleteProperty(window, "nexaDesktop");
});

describe("App PTT DOM integration", () => {
  it("skips automatic Chat, Weather and Spotify IPC initialization in isolated mode", async () => {
    Object.defineProperty(bridge, "isIsolated", { value: true, configurable: true });
    await mountApp();

    expect(bridge.chat.createConversation).not.toHaveBeenCalled();
    expect(bridge.weather.getCurrent).not.toHaveBeenCalled();
    expect(bridge.spotify.getLiveStatus).not.toHaveBeenCalled();
    expect(bridge.masterVolume.get).not.toHaveBeenCalled();
  });

  it("retains automatic Chat, Weather and Spotify initialization in normal mode", async () => {
    await mountApp();

    expect(bridge.chat.createConversation).toHaveBeenCalled();
    expect(bridge.weather.getCurrent).toHaveBeenCalled();
    expect(bridge.spotify.getLiveStatus).toHaveBeenCalled();
    expect(bridge.masterVolume.get).toHaveBeenCalled();
  });

  it("moves side panels before expansion and contracts before their return", async () => {
    const advanceFrame = controlAnimationFrames();
    await mountApp();
    const shell = document.querySelector(".app-shell")!;
    const workspace = document.querySelector(".workspace-grid")!;
    const workspaceShell = document.querySelector(".workspace-shell")!;
    const chat = document.querySelector(".conversation-panel")!;
    const presence = document.querySelector(".presence-panel")!;
    const modules = document.querySelector(".dashboard-modules")!;
    const history = document.querySelector(".conversations-history")!;

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(shell.getAttribute("data-workspace-phase")).toBe("preparing-exit");
    expect(workspace.classList.contains("workspace-grid--conversations")).toBe(false);
    advanceFrame();
    advanceFrame();
    expect(shell.getAttribute("data-workspace-phase")).toBe("exiting");
    expect(presence.classList.contains("presence-panel--offscreen")).toBe(true);
    expect(modules.classList.contains("dashboard-modules--hidden")).toBe(true);
    expect(shell.classList.contains("app-shell--workspace-expanded")).toBe(false);
    finishTransition(presence, "transform");
    expect(shell.getAttribute("data-workspace-phase")).toBe("exiting");
    finishTransition(modules, "transform");
    expect(shell.getAttribute("data-workspace-phase")).toBe("expanding");
    expect(workspace.classList.contains("workspace-grid--conversations")).toBe(true);
    expect(shell.classList.contains("app-shell--workspace-expanded")).toBe(true);
    expect(presence.getAttribute("aria-hidden")).toBe("true");
    expect(presence.hasAttribute("inert")).toBe(true);
    expect(modules.getAttribute("aria-hidden")).toBe("true");
    expect(modules.hasAttribute("inert")).toBe(true);
    expect(history.getAttribute("aria-hidden")).toBe("false");
    expect(history.hasAttribute("inert")).toBe(false);
    finishTransition(workspaceShell, "height");
    expect(shell.getAttribute("data-workspace-phase")).toBe("expanding");
    finishTransition(workspace, "grid-template-columns");
    expect(shell.getAttribute("data-workspace-phase")).toBe("conversations");

    fireEvent.click(screen.getByRole("button", { name: "Command Center" }));
    expect(shell.getAttribute("data-workspace-phase")).toBe("contracting");
    expect(shell.classList.contains("app-shell--workspace-expanded")).toBe(false);
    expect(workspace.classList.contains("workspace-grid--conversations")).toBe(true);
    expect(presence.classList.contains("presence-panel--offscreen")).toBe(true);
    finishTransition(workspaceShell, "height");
    expect(shell.getAttribute("data-workspace-phase")).toBe("preparing-entry");
    expect(workspace.classList.contains("workspace-grid--conversations")).toBe(true);
    expect(history.getAttribute("aria-hidden")).toBe("false");
    expect(presence.classList.contains("presence-panel--offscreen")).toBe(true);
    advanceFrame();
    advanceFrame();
    expect(shell.getAttribute("data-workspace-phase")).toBe("entering");
    expect(workspace.classList.contains("workspace-grid--conversations")).toBe(false);
    expect(presence.classList.contains("presence-panel--offscreen")).toBe(false);
    finishTransition(modules, "transform");
    expect(shell.getAttribute("data-workspace-phase")).toBe("command");
    expect(document.querySelector(".conversation-panel")).toBe(chat);
    expect(document.querySelector(".presence-panel")).toBe(presence);
    expect(document.querySelector(".dashboard-modules")).toBe(modules);
    expect(document.querySelector(".conversations-history")).toBe(history);
    expect(presence.getAttribute("aria-hidden")).toBe("false");
    expect(presence.hasAttribute("inert")).toBe(false);
    expect(modules.getAttribute("aria-hidden")).toBe("false");
    expect(modules.hasAttribute("inert")).toBe(false);
    expect(history.getAttribute("aria-hidden")).toBe("true");
    expect(history.hasAttribute("inert")).toBe(true);
  });

  it("renders and debounces the system master-volume slider", async () => {
    await mountApp();
    const slider = screen.getByRole("slider", { name: "Volumen general de Windows" });
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("42"));
    expect((slider as HTMLInputElement).value).toBe("42");
    expect(screen.getByText("42%")).toBeTruthy();
    fireEvent.change(slider, { target: { value: "56" } });
    fireEvent.change(slider, { target: { value: "63" } });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 220)); });
    expect(bridge.masterVolume.set).toHaveBeenCalledTimes(1);
    expect(bridge.masterVolume.set).toHaveBeenCalledWith(63);
  });

  it("reverses interrupted workspace transitions without leaving panels hidden", async () => {
    const advanceFrame = controlAnimationFrames();
    await mountApp();
    const shell = document.querySelector(".app-shell")!;
    const workspaceShell = document.querySelector(".workspace-shell")!;
    const modules = document.querySelector(".dashboard-modules")!;
    const presence = document.querySelector(".presence-panel")!;

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    advanceFrame();
    advanceFrame();
    expect(shell.getAttribute("data-workspace-phase")).toBe("exiting");
    fireEvent.click(screen.getByRole("button", { name: "Command Center" }));
    expect(shell.getAttribute("data-workspace-phase")).toBe("entering");
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(shell.getAttribute("data-workspace-phase")).toBe("exiting");
    finishTransition(modules, "transform");
    expect(shell.getAttribute("data-workspace-phase")).toBe("expanding");
    fireEvent.click(screen.getByRole("button", { name: "Command Center" }));
    expect(shell.getAttribute("data-workspace-phase")).toBe("contracting");
    finishTransition(workspaceShell, "height");
    advanceFrame();
    advanceFrame();
    finishTransition(modules, "transform");
    expect(shell.getAttribute("data-workspace-phase")).toBe("command");
    expect(presence.getAttribute("aria-hidden")).toBe("false");
    expect(modules.getAttribute("aria-hidden")).toBe("false");
  });

  it("switches views directly when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await mountApp();
    const shell = document.querySelector(".app-shell")!;
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(shell.getAttribute("data-workspace-phase")).toBe("conversations");
    fireEvent.click(screen.getByRole("button", { name: "Command Center" }));
    expect(shell.getAttribute("data-workspace-phase")).toBe("command");
  });

  it("settles an active transition when reduced motion is enabled", async () => {
    let onChange: (() => void) | undefined;
    const preference = { matches: false, addEventListener: vi.fn((_event: string, listener: () => void) => { onChange = listener; }),
      removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", () => preference);
    const advanceFrame = controlAnimationFrames();
    await mountApp();
    const shell = document.querySelector(".app-shell")!;
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    advanceFrame();
    advanceFrame();
    expect(shell.getAttribute("data-workspace-phase")).toBe("exiting");
    preference.matches = true;
    act(() => { onChange?.(); });
    expect(shell.getAttribute("data-workspace-phase")).toBe("conversations");
  });

  it("finishes a workspace transition if the browser omits transitionend", async () => {
    const advanceFrame = controlAnimationFrames();
    await mountApp();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const shell = document.querySelector(".app-shell")!;
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    advanceFrame();
    advanceFrame();
    expect(shell.getAttribute("data-workspace-phase")).toBe("exiting");
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(shell.getAttribute("data-workspace-phase")).toBe("expanding");
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(shell.getAttribute("data-workspace-phase")).toBe("conversations");
  });

  it("keeps the chat event listener stable while Main initializes the conversation", async () => {
    const pending: Array<(value: Awaited<ReturnType<typeof bridge.chat.createConversation>>) => void> = [];
    vi.mocked(bridge.chat.createConversation).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const view = render(createElement(StrictMode, null,
      createElement(App, { voiceController: controller as unknown as PttVoiceController, microphoneDevices })));
    await act(async () => { await Promise.resolve(); });
    const subscriptionsBeforeConversation = vi.mocked(bridge.chat.onEvent).mock.calls.length;
    expect(subscriptionsBeforeConversation).toBeGreaterThan(0);

    await act(async () => {
      pending.forEach((resolve) => resolve({ ok: true, conversationId: "00000000-0000-4000-8000-000000000010" }));
      await Promise.resolve();
    });

    expect(bridge.chat.onEvent).toHaveBeenCalledTimes(subscriptionsBeforeConversation);
    view.unmount();
  });

  it("mounts under StrictMode without starting capture and cleans React subscriptions without destroying the owner", async () => {
    const view = await mountApp();
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.listeners.size).toBe(1);
    expect(controller.subscribe).toHaveBeenCalled();
    expect(controller.destroy).not.toHaveBeenCalled();

    view.unmount();
    expect(controller.listeners.size).toBe(0);
    expect(controller.destroy).not.toHaveBeenCalled();

    await mountApp();
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.listeners.size).toBe(1);
  });

  it("offers the system default and audio inputs, persists selection, and locks changes while PTT is active", async () => {
    await mountApp();
    expect(screen.queryByRole("combobox", { name: "Dispositivo de entrada" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "Dispositivo de entrada" }) as HTMLSelectElement;
    expect([...selector.options].map((option) => option.textContent)).toEqual(["Predeterminado de Windows · Default - System Mic", "USB Microphone"]);
    expect(selector.value).toBe("");
    fireEvent.change(selector, { target: { value: "mic-usb" } });
    expect(selector.value).toBe("mic-usb");
    expect(microphoneDevices.getSnapshot().selectedDeviceId).toBe("mic-usb");

    act(() => controller.publish({ status: "listening", canStart: false, sessionId: "session-live" }));
    expect(selector.disabled).toBe(true);
    expect(screen.getByText("El dispositivo no se puede cambiar durante una grabación.")).toBeTruthy();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("updates the UI from the external snapshot and starts and finishes only after user clicks", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar grabación de voz" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Finalizar grabación y transcribir" }) as HTMLButtonElement).disabled).toBe(false));
    expect(controller.start).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Estado de voz: Escuchando")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Finalizar grabación y transcribir" }));
    await waitFor(() => expect(screen.getByText("Transcripción en curso.")).toBeTruthy());
    expect(controller.finish).toHaveBeenCalledOnce();
    expect(bridge.voice.ptt.finish).not.toHaveBeenCalled();
  });

  it("cancels the PTT session from the unified Stop control", async () => {
    controller.publish({ status: "listening", canStart: false, sessionId: "session-live" });
    await mountApp();
    fireEvent.click(screen.getByRole("button", { name: "Detener interacción" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Iniciar grabación de voz" }) as HTMLButtonElement).disabled).toBe(false));
    expect(controller.cancel).toHaveBeenCalledOnce();
  });

  it("requires explicit recovery before a new start when cancellation is uncertain", async () => {
    controller.publish({ status: "recovery-required", canStart: false, sessionId: "session-old" });
    await mountApp();
    expect((screen.getByRole("button", { name: "Se requiere recuperar la sesión anterior" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Recuperar cancelación pendiente de Main" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Iniciar grabación de voz" }) as HTMLButtonElement).disabled).toBe(false));
    expect(controller.recoverMainCancellation).toHaveBeenCalledOnce();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("shows retry only when an error snapshot permits starting and otherwise offers cancel", async () => {
    controller.publish({ status: "error", canStart: true, error: { code: "permission_denied", message: "denied" } });
    await mountApp();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar grabación de voz" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Finalizar grabación y transcribir" }) as HTMLButtonElement).disabled).toBe(false));
    expect(controller.start).toHaveBeenCalledOnce();

    cleanup();
    controller = new FakeVoiceController();
    controller.publish({ status: "error", canStart: false, sessionId: "session-old", error: { code: "VOICE_PTT_TRANSCRIPTION_FAILED", message: "failed" } });
    await mountApp();
    expect(screen.queryByRole("button", { name: "Reintentar grabación de voz" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Detener interacción" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Iniciar grabación de voz" }) as HTMLButtonElement).disabled).toBe(false));
    expect(controller.cancel).toHaveBeenCalledOnce();
  });

  it("renders a real transcript as Jor's right-aligned voice message and caps deduplicated history at 50", async () => {
    await mountApp();
    const transcript = (sessionId: string, turnId: string, text: string): PttVoiceSnapshot => ({
      status: "transcript-ready", canStart: true, sessionId, requestId: `request-${turnId}`,
      turnId, transcript: text, language: "es",
    });
    act(() => controller.publish(transcript("session-a", "turn-a", "Texto primero")));
    act(() => controller.publish(transcript("session-a", "turn-a", "Duplicado")));
    expect(screen.getAllByText("Texto primero")).toHaveLength(1);
    expect(screen.queryByText("Duplicado")).toBeNull();
    const voiceMessage = document.querySelector('[data-message-source="voice"]');
    expect(voiceMessage?.classList.contains("message--user")).toBe(true);
    expect(voiceMessage?.querySelector("strong")?.textContent).toBe("Jor");
    expect(voiceMessage?.querySelector(".voice-transcript-badge")?.textContent).toContain("Voz");
    expect(voiceMessage?.getAttribute("data-message-source")).toBe("voice");
    expect(screen.queryByRole("region", { name: "Transcripciones reales de voz" })).toBeNull();
    expect(document.querySelector(".message-mock")).toBeNull();

    for (let index = 0; index < 51; index += 1) {
      act(() => controller.publish(transcript(`session-${index}`, `turn-${index}`, `Transcripción ${index}`)));
    }
    await waitFor(() => expect(document.querySelectorAll(".message--voice-transcript")).toHaveLength(50));
    expect(screen.queryByText("Transcripción 0")).toBeNull();
    expect(screen.getByText("Transcripción 50")).toBeTruthy();
  });

  it("shows an explicit empty-result notice without creating a transcript bubble", async () => {
    await mountApp();
    act(() => controller.publish({
      status: "transcript-ready", canStart: true, sessionId: "session-empty", requestId: "finish-empty",
      turnId: "turn-empty", transcript: "  \n", language: "es",
    }));
    expect(screen.getByText(/No se detectó voz/).getAttribute("role")).toBe("status");
    expect(document.querySelectorAll("[data-message-source='voice']")).toHaveLength(0);
  });

  it("scrolls a newly added own transcript into view even when the user was reading older messages", async () => {
    await mountApp();
    const history = screen.getByLabelText("Historial de conversación");
    setScrollMetrics(history, { scrollHeight: 1000, clientHeight: 400, scrollTop: 180 });
    fireEvent.scroll(history);
    act(() => controller.publish({
      status: "transcript-ready", canStart: true, sessionId: "session-scroll", requestId: "finish-scroll",
      turnId: "turn-scroll", transcript: "Nuevo mensaje propio", language: "es",
    }));
    expect(history.scrollTop).toBe(600);
  });

  it("preserves an older reading position but follows new content when already near the end", async () => {
    await mountApp();
    const history = screen.getByLabelText("Historial de conversación");
    setScrollMetrics(history, { scrollHeight: 1000, clientHeight: 400, scrollTop: 180 });
    fireEvent.scroll(history);
    act(() => controller.publish({
      status: "transcript-ready", canStart: true, sessionId: "session-old-reader", requestId: "finish-old-reader",
      turnId: "turn-old-reader", transcript: "", language: "es",
    }));
    expect(history.scrollTop).toBe(180);

    cleanup();
    controller = new FakeVoiceController();
    await mountApp();
    const nearEndHistory = screen.getByLabelText("Historial de conversación");
    setScrollMetrics(nearEndHistory, { scrollHeight: 1000, clientHeight: 400, scrollTop: 560 });
    fireEvent.scroll(nearEndHistory);
    act(() => controller.publish({
      status: "transcript-ready", canStart: true, sessionId: "session-near-end", requestId: "finish-near-end",
      turnId: "turn-near-end", transcript: "", language: "es",
    }));
    expect(nearEndHistory.scrollTop).toBe(600);
  });

  it("does not send transcripts to Brain or invoke Voice finish without the finish action", async () => {
    await mountApp();
    expect((screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }) as HTMLInputElement).disabled).toBe(false);
    expect(bridge.ping).not.toHaveBeenCalled();
    expect(bridge.chat.sendMessage).not.toHaveBeenCalled();
    expect(bridge.voice.ptt.finish).not.toHaveBeenCalled();
    expect(controller.finish).not.toHaveBeenCalled();
  });

  it("times typed text independently of voice when voice replies are disabled", async () => {
    await mountApp();
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Hola Nexa" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    expect(request).toMatchObject({ text: "Hola Nexa", source: "typed" });
    expect(screen.getByText("Hola Nexa").closest("[data-message-source='typed']")).toBeTruthy();
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "processing" })));
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId, requestId: request.requestId, status: "completed", response: "Respuesta real" })));
    expect((await screen.findByText("Respuesta real")).closest("[data-message-source='runtime']")).toBeTruthy();
    expect(bridge.chat.sendMessage).toHaveBeenCalledOnce();
    expect(bridge.voice.speech.playChatResponse).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId,
      origin: "typed", phase: "response_rendered", durationMs: expect.any(Number) })));
    expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId,
      origin: "typed", phase: "runtime_processing_started", durationMs: expect.any(Number) }));
    expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId,
      origin: "typed", phase: "response_final_received", durationMs: expect.any(Number) }));
    expect(JSON.stringify(vi.mocked(bridge.voice.recordChatTiming).mock.calls)).not.toContain("Respuesta real");
  });

  it("renders streamed text progressively, replaces it once with final text, and keeps TTS separate", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Consulta" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "processing" })));
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "text_delta", delta: "Hola " })));
    expect(await screen.findByText("Hola")).toBeTruthy();
    const streamedBubble = document.querySelector(".message--runtime-response");
    expect(streamedBubble).toBeTruthy();
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "text_delta", delta: "Nexa" })));
    expect(await screen.findByText("Hola Nexa")).toBeTruthy();
    expect(document.querySelector(".message--runtime-response")).toBe(streamedBubble);
    expect(bridge.voice.speech.playChatResponse).not.toHaveBeenCalled();
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "completed", response: "Hola Nexa, ¿en qué te ayudo?" })));
    expect(await screen.findByText("Hola Nexa, ¿en qué te ayudo?")).toBeTruthy();
    expect(document.querySelector(".message--runtime-response")).toBe(streamedBubble);
    expect(document.querySelectorAll(".message--runtime-response")).toHaveLength(1);
    expect(document.querySelector(".message--runtime-response .message-marker--nexa .nexa-core-mark__core")).toBeTruthy();
    expect(document.querySelector(".message--runtime-response .message-marker--nexa")?.textContent).toBe("");
    await waitFor(() => expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledOnce());
    expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledWith(request.requestId);
    await waitFor(() => expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId, phase: "first_text_delta_received", durationMs: expect.any(Number) })));
    await waitFor(() => expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId, phase: "first_text_rendered", durationMs: expect.any(Number) })));
  });

  it("discards provisional text on a tool-turn reset and on a terminal error", async () => {
    await mountApp();
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Busca algo" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "text_delta", delta: "Buscando…" })));
    expect(await screen.findByText("Buscando…")).toBeTruthy();
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "text_reset" })));
    await waitFor(() => expect(screen.queryByText("Buscando…")).toBeNull());
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "text_delta", delta: "Texto provisional" })));
    expect(await screen.findByText("Texto provisional")).toBeTruthy();
    await waitFor(() => expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId, phase: "first_text_rendered", durationMs: expect.any(Number) })));
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "error", error: { code: "operation_failed", message: "Falló." } })));
    await waitFor(() => expect(screen.queryByText("Texto provisional")).toBeNull());
    expect(screen.getAllByText("No se pudo completar la solicitud conversacional.").length).toBeGreaterThan(0);
  });

  it("speaks a new typed reply only when enabled, keeps visible text, and opens no follow-up", async () => {
    const view = await mountApp();
    fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
    expect(screen.getByRole("switch", { name: /Respuestas por voz/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Hola" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "completed", response: "Respuesta nueva" })));
    expect(await screen.findByText("Respuesta nueva")).toBeTruthy();
    await waitFor(() => expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledOnce());
    expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledWith(request.requestId);
    act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "preparing" })));
    act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "completed" })));
    expect(bridge.voice.ptt.start).not.toHaveBeenCalled();
    expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledOnce();
    view.rerender(createElement(App, { voiceController: controller as unknown as PttVoiceController, microphoneDevices }));
    expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledOnce();
  });

  it("waits two seconds before one local acknowledgement for a slow typed reply", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Consulta lenta" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
      expect(bridge.voice.speech.acknowledge).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledOnce();
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledWith({ requestId: request.requestId });
      expect(bridge.voice.ptt.start).not.toHaveBeenCalled();
      expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId,
        origin: "typed", phase: "ack_timer_expired", durationMs: expect.any(Number) }));

      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "preparing" })));
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "speaking" })));
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Respuesta final" })));
      expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledWith(request.requestId);
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledOnce();
      expect(bridge.voice.ptt.start).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("skips the typed acknowledgement for a fast reply", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Consulta rápida" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Respuesta rápida" })));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(bridge.voice.speech.acknowledge).not.toHaveBeenCalled();
      expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledOnce();
      expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId,
        origin: "typed", phase: "ack_timer_cancelled_response", durationMs: expect.any(Number) }));
      expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId,
        origin: "typed", phase: "response_rendered", durationMs: expect.any(Number) }));
    } finally { vi.useRealTimers(); }
  });

  it("cancels the typed ACK when the final event arrives just before its threshold", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Casi al límite" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Llegó antes del límite" })));
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(bridge.voice.speech.acknowledge).not.toHaveBeenCalled();
      expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId,
        origin: "typed", phase: "ack_timer_cancelled_response" }));
    } finally { vi.useRealTimers(); }
  });

  it("records when the ACK timer wins a same-turn race with delivery of the final event", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Carrera de límite" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledOnce();
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "La respuesta ya estaba lista" })));
      expect(bridge.voice.recordChatTiming).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId,
        origin: "typed", phase: "response_after_ack_timer" }));
    } finally { vi.useRealTimers(); }
  });

  it("Stop during a typed acknowledgement prevents both late acknowledgement and final voice", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Consulta cancelada" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledWith({ requestId: request.requestId });
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "preparing" })));
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "speaking" })));
      fireEvent.click(screen.getByRole("button", { name: "Detener interacción" }));
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "cancelled" })));
      expect(bridge.voice.speech.cancel).toHaveBeenCalledWith({ requestId: request.requestId });
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledOnce();
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Texto conservado" })));
      expect(bridge.voice.speech.playChatResponse).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("disabling voice replies cancels a pending typed acknowledgement without affecting chat", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Consulta escrita" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(bridge.voice.speech.acknowledge).not.toHaveBeenCalled();
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Texto intacto" })));
      expect(bridge.voice.speech.playChatResponse).not.toHaveBeenCalled();
      expect(bridge.chat.cancelRequest).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("disabling voice replies interrupts a typed acknowledgement without cancelling Runtime", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Consulta en curso" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "preparing" })));
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "speaking" })));
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      expect(bridge.voice.speech.cancel).toHaveBeenCalledWith({ requestId: request.requestId });
      expect(bridge.chat.cancelRequest).not.toHaveBeenCalled();
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "cancelled" })));
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Respuesta escrita conservada" })));
      expect(bridge.voice.speech.playChatResponse).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("keeps a slow typed request eligible for its final reply after acknowledgement audio fails", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Consulta larga" } });
      fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "preparing" })));
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId,
        state: "error", error: { code: "voice_audio_processing_failed" } })));
      expect(bridge.voice.endDucking).toHaveBeenCalledWith(request.requestId, "error");
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Respuesta principal" })));
      expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledWith(request.requestId);
    } finally { vi.useRealTimers(); }
  });

  it("invalidates previous typed audio when a new chat query is sent", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
    const composer = screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" });
    fireEvent.change(composer, { target: { value: "Primera consulta" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const first = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    act(() => chatListeners.forEach((listener) => listener({ conversationId: first.conversationId,
      requestId: first.requestId, status: "completed", response: "Primera respuesta" })));
    expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledWith(first.requestId);

    fireEvent.change(composer, { target: { value: "Segunda consulta" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledTimes(2));
    expect(bridge.voice.speech.cancel).toHaveBeenCalledWith({ requestId: first.requestId });
    expect(bridge.voice.endDucking).toHaveBeenCalledWith(first.requestId, "stop");
    const second = vi.mocked(bridge.chat.sendMessage).mock.calls[1][0];
    act(() => chatListeners.forEach((listener) => listener({ conversationId: second.conversationId,
      requestId: second.requestId, status: "completed", response: "Segunda respuesta" })));
    expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledTimes(2);
    expect(bridge.voice.speech.playChatResponse).toHaveBeenLastCalledWith(second.requestId);
  });

  it("stops an active typed reply when the switch is turned off without cancelling chat", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Hola" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "completed", response: "Texto conservado" })));
    await waitFor(() => expect(bridge.voice.speech.playChatResponse).toHaveBeenCalledWith(request.requestId));
    act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "speaking" })));
    fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
    await waitFor(() => expect(bridge.voice.speech.cancel).toHaveBeenCalledWith({ requestId: request.requestId }));
    await waitFor(() => expect(bridge.voice.endDucking).toHaveBeenCalledWith(request.requestId, "stop"));
    expect(bridge.chat.cancelRequest).not.toHaveBeenCalled();
    expect(await screen.findByText("Texto conservado")).toBeTruthy();
  });

  it("hides a stale Spotify uncertainty notice when a compatible state is observed", async () => {
    let publishStatus: ((status: never) => void) | undefined;
    const playing = { state: "playing", connected: true, deviceAvailable: true, controlsEnabled: true,
      track: { name: "Track", artists: ["Artist"], imageUrl: null, spotifyUrl: null, playing: true }, message: null, updatedAt: 1 };
    const paused = { ...playing, state: "paused", track: { ...playing.track, playing: false }, updatedAt: 2 };
    const control = vi.fn(async (action: string) => control.mock.calls.length === 1
      ? { ok: false as const, action: action as "pause", error: { code: "outcome_uncertain" as const, message: "Spotify no confirmó la acción." } }
      : { ok: false as const, action: action as "pause", observedState: "paused" as const,
        error: { code: "outcome_uncertain" as const, message: "Spotify pausado" } });
    Object.assign(bridge, { spotify: {
      openTrack: vi.fn(async () => true), getLiveStatus: vi.fn(async () => playing), setLiveStatusVisible: vi.fn(),
      onLiveStatus: vi.fn((listener: (status: never) => void) => { publishStatus = listener; return vi.fn(); }), control,
    } });
    await mountApp();
    await waitFor(() => expect(screen.getByRole("button", { name: "Pausar Spotify" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pausar Spotify" }));
    await waitFor(() => expect(screen.getByText("Spotify no confirmó la acción.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pausar Spotify" }));
    await waitFor(() => expect(control).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Spotify no confirmó la acción.")).toBeNull();
    act(() => publishStatus?.(paused as never));
    expect(screen.getByRole("button", { name: "Reanudar Spotify" })).toBeTruthy();
  });

  it("routes each non-empty final Voice transcript through the same chat bridge once", async () => {
    await mountApp();
    act(() => controller.publish({ status: "transcript-ready", canStart: true, sessionId: "session-chat", requestId: "voice-finish",
      turnId: "voice-turn", transcript: "Mensaje hablado", language: "es" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    expect(vi.mocked(bridge.chat.sendMessage).mock.calls[0][0]).toMatchObject({ text: "Mensaje hablado", source: "voice" });
    act(() => controller.publish({ status: "transcript-ready", canStart: true, sessionId: "session-chat", requestId: "voice-finish",
      turnId: "voice-turn", transcript: "Mensaje hablado", language: "es" }));
    expect(bridge.chat.sendMessage).toHaveBeenCalledOnce();
    expect(screen.getAllByText("Mensaje hablado")).toHaveLength(1);
  });

  it("opens one follow-up only after the spoken response completes", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("switch", { name: /Respuestas por voz/ }));
    act(() => controller.publish({ status: "transcript-ready", canStart: true, sessionId: "session-followup",
      requestId: "voice-followup", turnId: "turn-followup", transcript: "Explicame algo", language: "es" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "completed", response: "Respuesta hablada" })));
    act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "preparing" })));
    await waitFor(() => expect(MicVAD.new).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false, baseAssetPath: "nexa-vad://assets/", onnxWASMBasePath: "nexa-vad://assets/",
    })));
    act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "speaking" })));
    expect(bridge.voice.ptt.start).not.toHaveBeenCalled();
    act(() => speechListeners.forEach((listener) => listener({ requestId: "intermediate-acknowledgement", state: "completed" })));
    expect(bridge.voice.ptt.start).not.toHaveBeenCalled();
    vi.mocked(bridge.voice.ptt.start).mockImplementation(async ({ requestId }) => ({
      ok: true as const, requestId, sessionId: "session-followup-vad",
    }));
    act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "completed" })));
    await waitFor(() => expect(bridge.voice.ptt.start).toHaveBeenCalledOnce());
    expect(bridge.voice.endDucking).not.toHaveBeenCalled();
    expect(await screen.findByText("Escuchando… Podés hablar.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detener interacción" })).toBeTruthy();
    act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "completed" })));
    expect(bridge.voice.ptt.start).toHaveBeenCalledOnce();
    expect(bridge.voice.speech.playChatResponse).not.toHaveBeenCalled();
  });

  it("plays no acknowledgement when a voice request completes before the delay", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      act(() => controller.publish({ status: "transcript-ready", canStart: true, sessionId: "session-fast", requestId: "voice-fast",
        turnId: "voice-turn-fast", transcript: "Hola", language: "es" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Respuesta rápida" })));
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "preparing" })));
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "speaking" })));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(bridge.voice.speech.acknowledge).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("requests one acknowledgement after the delayed voice processing threshold", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      act(() => controller.publish({ status: "transcript-ready", canStart: true, sessionId: "session-slow", requestId: "voice-slow",
        turnId: "voice-turn-slow", transcript: "Explicame algo", language: "es" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      await act(async () => { await vi.advanceTimersByTimeAsync(1_499); });
      expect(bridge.voice.speech.acknowledge).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledOnce();
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledWith({ requestId: request.requestId });
      expect(chatListeners.size).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });

  it("keeps the acknowledgement eligible after Runtime completes while main TTS is still preparing", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      act(() => controller.publish({ status: "transcript-ready", canStart: true, sessionId: "session-tts-slow", requestId: "voice-tts-slow",
        turnId: "voice-turn-tts-slow", transcript: "Nexa, dame tu diagnóstico", language: "es" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "completed", response: "Informe largo" })));
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "preparing" })));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledOnce();
      act(() => speechListeners.forEach((listener) => listener({ requestId: request.requestId, state: "speaking" })));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(bridge.voice.speech.acknowledge).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("does not request a voice acknowledgement after a cancelled chat request", async () => {
    vi.useFakeTimers();
    try {
      await mountApp();
      act(() => controller.publish({ status: "transcript-ready", canStart: true, sessionId: "session-cancelled", requestId: "voice-cancelled",
        turnId: "voice-turn-cancelled", transcript: "Consulta cancelada", language: "es" }));
      await act(async () => { await Promise.resolve(); });
      const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
      act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
        requestId: request.requestId, status: "cancelled" })));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(bridge.voice.speech.acknowledge).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("requests cancellation without marking it complete until a terminal event arrives", async () => {
    await mountApp();
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Cancelar" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    expect(screen.getAllByRole("button", { name: "Detener interacción" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Detener interacción" }));
    await waitFor(() => expect(bridge.chat.cancelRequest).toHaveBeenCalledWith(request.requestId));
    expect(screen.queryByText("Cancelación solicitada; esperando confirmación de Runtime.")).toBeNull();
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId, requestId: request.requestId, status: "cancelled" })));
    expect(screen.getByText("Cancelado")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Consulta siguiente" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledTimes(2));
  });

  it("uses one Stop control to cancel both Runtime and Voice for the same PTT interaction", async () => {
    await mountApp();
    act(() => controller.publish({ status: "transcript-ready", canStart: true, sessionId: "session-unified",
      requestId: "voice-unified", turnId: "voice-turn-unified", transcript: "Probá una respuesta", language: "es" }));
    await act(async () => { await Promise.resolve(); });
    act(() => speechListeners.forEach((listener) => listener({ requestId: "voice-unified", state: "preparing" })));
    expect(screen.getAllByRole("button", { name: "Detener interacción" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Detener interacción" }));
    await waitFor(() => {
      expect(bridge.chat.cancelRequest).toHaveBeenCalledWith("voice-unified");
      expect(bridge.voice.speech.cancel).toHaveBeenCalledWith({ requestId: "voice-unified" });
    });
    expect(screen.queryByRole("button", { name: "Solicitar cancelación del mensaje activo" })).toBeNull();
  });

  it("the unified Stop cancels Voice speech when no Runtime request is active", async () => {
    speechListeners = new Set();
    Object.assign(bridge.voice, { speech: {
      cancel: vi.fn(async ({ requestId }: { requestId: string }) => ({ ok: true as const, requestId, cancelled: true as const })),
      onEvent: vi.fn((listener: (event: import("../src/shared/ipc-contract").VoiceSpeechEvent) => void) => {
        speechListeners.add(listener);
        return () => speechListeners.delete(listener);
      }),
    } });
    await mountApp();
    act(() => speechListeners.forEach((listener) => listener({ requestId: "speech-stop", state: "preparing" })));
    fireEvent.click(screen.getByRole("button", { name: "Detener interacción" }));

    await waitFor(() => expect(bridge.voice.speech.cancel).toHaveBeenCalledWith({ requestId: "speech-stop" }));
    expect(bridge.chat.cancelRequest).not.toHaveBeenCalled();
    expect(screen.queryByText("Cancelación solicitada; esperando confirmación de Runtime.")).toBeNull();
  });

  it("releases the processing state when Main reports the request is already inactive", async () => {
    await mountApp();
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Abrir Calculadora" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    vi.mocked(bridge.chat.cancelRequest).mockResolvedValue({
      ok: false, requestId: request.requestId,
      error: { code: "request_not_found", message: "No active request matches this identifier." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Detener interacción" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Detener interacción" })).toBeNull());
    expect(screen.getAllByText("La solicitud ya no está activa. No se recibió su resultado final.")).toHaveLength(2);
    expect(bridge.chat.sendMessage).toHaveBeenCalledOnce();
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId,
      requestId: request.requestId, status: "completed", response: "Resultado tardío" })));
    expect(screen.queryByText("Resultado tardío")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Siguiente solicitud" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledTimes(2));
  });
});
