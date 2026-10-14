// @vitest-environment jsdom

import { createElement, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NexaDesktopApi, VoiceEventEnvelope } from "../src/shared/ipc-contract";
import App from "../src/renderer/App";
import type { PttVoiceController, PttVoiceSnapshot } from "../src/renderer/voice/ptt-voice-controller";
import { MicrophoneDeviceStore } from "../src/renderer/audio/microphone-device-store";

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

function setScrollMetrics(element: HTMLElement, values: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  let scrollTop = values.scrollTop;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => values.scrollHeight },
    clientHeight: { configurable: true, get: () => values.clientHeight },
    scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
  });
}

beforeEach(async () => {
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
      ptt: {
        start: vi.fn(async () => ({ ok: false, requestId: "unused", error: { code: "invalid_request", message: "unused" } })),
        finish: vi.fn(async () => ({ ok: false, requestId: "unused", error: { code: "invalid_request", message: "unused" } })),
        cancel: vi.fn(async () => ({ ok: false, requestId: "unused", error: { code: "invalid_request", message: "unused" } })),
      },
      speech: {
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
  });

  it("retains automatic Chat, Weather and Spotify initialization in normal mode", async () => {
    await mountApp();

    expect(bridge.chat.createConversation).toHaveBeenCalled();
    expect(bridge.weather.getCurrent).toHaveBeenCalled();
    expect(bridge.spotify.getLiveStatus).toHaveBeenCalled();
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

  it("cancels from the listening state through the explicit cancel control", async () => {
    controller.publish({ status: "listening", canStart: false, sessionId: "session-live" });
    await mountApp();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar sesión de voz" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Cancelar sesión de voz" }));
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

  it("sends a typed message once and displays only its correlated Runtime event", async () => {
    await mountApp();
    fireEvent.change(screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }), { target: { value: "Hola Nexa" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    await waitFor(() => expect(bridge.chat.sendMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.chat.sendMessage).mock.calls[0][0];
    expect(request).toMatchObject({ text: "Hola Nexa", source: "typed" });
    expect(screen.getByText("Hola Nexa").closest("[data-message-source='typed']")).toBeTruthy();
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId, requestId: request.requestId, status: "completed", response: "Respuesta real" })));
    expect(screen.getByText("Respuesta real").closest("[data-message-source='runtime']")).toBeTruthy();
    expect(bridge.chat.sendMessage).toHaveBeenCalledOnce();
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
    fireEvent.click(screen.getByRole("button", { name: "Solicitar cancelación del mensaje activo" }));
    await waitFor(() => expect(bridge.chat.cancelRequest).toHaveBeenCalledWith(request.requestId));
    expect(screen.getByText("Cancelación solicitada; esperando confirmación de Runtime.")).toBeTruthy();
    act(() => chatListeners.forEach((listener) => listener({ conversationId: request.conversationId, requestId: request.requestId, status: "cancelled" })));
    expect(screen.getByText("Cancelado")).toBeTruthy();
  });

  it("Stop cancels only Voice speech and does not request Runtime cancellation", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Detener respuesta hablada" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Solicitar cancelación del mensaje activo" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Solicitar cancelación del mensaje activo" })).toBeNull());
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
