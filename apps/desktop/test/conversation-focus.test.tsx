// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOrganicLearningEvent, ConversationPanel, type ConversationChatMessage } from "../src/renderer/components/ConversationPanel";
import type { PttVoiceSnapshot } from "../src/renderer/voice/ptt-voice-controller";
import { canonicalSpotifyTrackUrl } from "../src/shared/spotify-link-validation";

afterEach(cleanup);

const snapshot: PttVoiceSnapshot = { status: "idle", canStart: true };
const callbacks = { onStart: vi.fn(), onFinish: vi.fn(), onCancel: vi.fn(), onRecover: vi.fn() };
const baseProps = { snapshot, transcripts: [], transcriptNotice: null, ...callbacks };
const userMessage: ConversationChatMessage = { id: "request-1", requestId: "request-1", conversationId: "conversation-1",
  role: "user", text: "Hola", source: "typed", status: "processing", createdAt: 1 };
const responseMessage: ConversationChatMessage = { id: "request-1:response", requestId: "request-1", conversationId: "conversation-1",
  role: "assistant", text: "Respuesta lista", source: "typed", status: "completed", createdAt: 2 };

function panel(props: Record<string, unknown> = {}) {
  return createElement(ConversationPanel, { ...baseProps, ...props } as never);
}

describe("chat composer focus", () => {
  it("returns focus after form submission and keeps it through processing and response rendering", async () => {
    const onSendMessage = vi.fn();
    const view = render(panel({ onSendMessage }));
    const input = screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Hola" } });
    input.focus();
    fireEvent.submit(input.closest("form")!);

    expect(onSendMessage).toHaveBeenCalledWith("Hola");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");

    view.rerender(panel({ onSendMessage, chatBusy: true, chatMessages: [userMessage] }));
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);

    view.rerender(panel({ onSendMessage, chatMessages: [{ ...userMessage, status: "completed" }, responseMessage] }));
    expect(await screen.findByText("Respuesta lista")).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it("returns focus after the Send button is used", () => {
    const onSendMessage = vi.fn();
    render(panel({ onSendMessage }));
    const input = screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Siguiente" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    expect(onSendMessage).toHaveBeenCalledWith("Siguiente");
    expect(document.activeElement).toBe(input);
  });

  it("shows a queued turn and lets the user cancel that pending message", () => {
    const onSendMessage = vi.fn();
    const onCancelQueuedRequest = vi.fn();
    const queuedMessage = { ...userMessage, status: "queued" as const };
    render(panel({ onSendMessage, onCancelQueuedRequest, chatMessages: [queuedMessage] }));
    expect(screen.getByText("En cola")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar mensaje en cola" }));
    expect(onCancelQueuedRequest).toHaveBeenCalledWith(userMessage.requestId);
    const input = screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Siguiente intervención" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSendMessage).toHaveBeenCalledWith("Siguiente intervención");
  });

  it("shows independent, confirmed organic learning outcomes per user message", () => {
    const first = { ...userMessage, id: "request-saved", requestId: "request-saved", text: "Dato sintético uno",
      organicLearning: { conversationId: "conversation-1", requestId: "request-saved", status: "organic_learning" as const,
        state: "saved" as const, createdCount: 1, updatedCount: 0 } };
    const second = { ...userMessage, id: "request-none", requestId: "request-none", text: "Dato sintético dos",
      organicLearning: { conversationId: "conversation-1", requestId: "request-none", status: "organic_learning" as const,
        state: "no_memory" as const, createdCount: 0, updatedCount: 0 } };
    render(panel({ chatMessages: [first, second] }));

    expect(screen.getByText("Guardado")).toBeTruthy();
    expect(screen.getByText("Sin recuerdo nuevo")).toBeTruthy();
    expect(document.querySelectorAll('[data-organic-learning-state="saved"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-organic-learning-state="no_memory"]')).toHaveLength(1);
    fireEvent.click(screen.getByText("Guardado"));
    expect(screen.getByText("Memory2 confirmó 1 recuerdo(s) creado(s) y 0 actualizado(s)." )).toBeTruthy();
    expect(screen.queryByText("contenido privado de memoria")).toBeNull();
  });

  it("distinguishes pending, evaluating and omitted learning without claiming a save", () => {
    const states = ["pending", "evaluating", "not_processed"] as const;
    const messages = states.map((state, index) => ({ ...userMessage, id: `request-${state}`, requestId: `request-${state}`,
      text: `Mensaje sintético ${index}`, organicLearning: { conversationId: "conversation-1", requestId: `request-${state}`,
        status: "organic_learning" as const, state, ...(state === "not_processed" ? { reason: "queue_limit" as const } : {}) } }));
    render(panel({ chatMessages: messages }));
    expect(screen.getByText("Aprendizaje pendiente")).toBeTruthy();
    expect(screen.getByText("Evaluando memoria")).toBeTruthy();
    expect(screen.getByText("No procesado")).toBeTruthy();
    expect(screen.queryByText("Guardado")).toBeNull();
    fireEvent.click(screen.getByText("No procesado"));
    expect(screen.getByText("Se alcanzó el límite de evaluaciones pendientes.")).toBeTruthy();
  });

  it("correlates an organic event only to the matching user message and conversation", () => {
    const otherConversation = { ...userMessage, id: "same-request-other-conversation", conversationId: "conversation-2" };
    const assistant = { ...responseMessage, id: "same-request-assistant", conversationId: "conversation-1" };
    const event = { conversationId: "conversation-1", requestId: userMessage.requestId, status: "organic_learning" as const,
      state: "saved" as const, createdCount: 1, updatedCount: 0 };
    const updated = applyOrganicLearningEvent([userMessage, otherConversation, assistant], event);
    expect(updated[0]?.organicLearning).toEqual(event);
    expect(updated[1]?.organicLearning).toBeUndefined();
    expect(updated[2]?.organicLearning).toBeUndefined();
  });

  it("does not reclaim focus moved intentionally and preserves Shift+Enter and voice controls", () => {
    const onSendMessage = vi.fn();
    const view = render(panel({ onSendMessage }));
    const input = screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Todavía escribiendo" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();

    const history = screen.getByLabelText("Historial de conversación");
    history.focus();
    view.rerender(panel({ onSendMessage, chatBusy: true, chatMessages: [userMessage] }));
    expect(document.activeElement).toBe(history);
    view.rerender(panel({ onSendMessage, chatBusy: false, chatMessages: [userMessage] }));
    fireEvent.click(screen.getByRole("button", { name: "Iniciar grabación de voz" }));
    expect(callbacks.onStart).toHaveBeenCalled();
  });

  it("auto-grows from one line to six, scrolls beyond six, shrinks, and resets after send", () => {
    const onSendMessage = vi.fn();
    render(panel({ onSendMessage }));
    const composer = screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }) as HTMLTextAreaElement;
    let measuredHeight = 22;
    Object.defineProperty(composer, "scrollHeight", { configurable: true,
      get: () => composer.value ? measuredHeight : 22 });

    fireEvent.change(composer, { target: { value: "Una línea" } });
    expect(composer.style.height).toBe("22px");
    expect(composer.style.overflowY).toBe("hidden");
    expect(composer.closest("form")?.dataset.expanded).toBe("false");

    measuredHeight = 58;
    fireEvent.change(composer, { target: { value: "Tres líneas\nsegunda\ntercera" } });
    expect(composer.style.height).toBe("58px");
    expect(composer.closest("form")?.dataset.expanded).toBe("true");

    measuredHeight = 112;
    fireEvent.change(composer, { target: { value: "Seis líneas\n2\n3\n4\n5\n6" } });
    expect(composer.style.height).toBe("112px");
    expect(composer.style.overflowY).toBe("hidden");

    measuredHeight = 150;
    const longText = "Texto largo pegado\n".repeat(40);
    fireEvent.change(composer, { target: { value: longText } });
    expect(composer.style.height).toBe("112px");
    expect(composer.style.overflowY).toBe("auto");
    expect(composer.value).toBe(longText);

    measuredHeight = 40;
    fireEvent.change(composer, { target: { value: "Dos líneas\nsegunda" } });
    expect(composer.style.height).toBe("40px");
    expect(composer.style.overflowY).toBe("hidden");
    expect(composer.closest("form")?.dataset.expanded).toBe("true");
    composer.focus();
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje a Nexa" }));
    expect(onSendMessage).toHaveBeenCalledWith("Dos líneas\nsegunda");
    expect(composer.value).toBe("");
    expect(composer.style.height).toBe("22px");
    expect(composer.closest("form")?.dataset.expanded).toBe("false");
  });

  it("keeps Send inside the expanding field and the circular voice control beside it", () => {
    const view = render(panel());
    const form = screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }).closest("form")!;
    const field = form.querySelector(".composer-field")!;
    const send = screen.getByRole("button", { name: "Enviar mensaje a Nexa" });
    const voiceGroup = screen.getByRole("group", { name: "Controles de voz" });
    const microphone = screen.getByRole("button", { name: "Iniciar grabación de voz" });

    expect(field.contains(send)).toBe(true);
    expect(field.contains(voiceGroup)).toBe(false);
    expect(voiceGroup.parentElement).toBe(form);
    expect(microphone.classList.contains("voice-ptt-button")).toBe(true);
    expect(microphone.getAttribute("data-voice-state")).toBe("idle");

    view.rerender(panel({ snapshot: { ...snapshot, status: "listening", canStart: false } }));
    expect(screen.getByRole("button", { name: "Finalizar grabación y transcribir" }).getAttribute("data-voice-state")).toBe("listening");
  });

  it("opens validated Spotify track links through the existing callback", () => {
    const onOpenSpotifyTrack = vi.fn();
    const message = { ...responseMessage, streamed: true, text: "[Abrir en Spotify](https://open.spotify.com/track/abc123)" };
    render(panel({ chatMessages: [message], onOpenSpotifyTrack }));
    fireEvent.click(screen.getByRole("link", { name: "Abrir en Spotify" }));
    expect(onOpenSpotifyTrack).toHaveBeenCalledWith("https://open.spotify.com/track/abc123");
    expect(canonicalSpotifyTrackUrl("https://open.spotify.com/track/abc123?si=synthetic")).toBe("https://open.spotify.com/track/abc123");
    expect(canonicalSpotifyTrackUrl("https://open.spotify.com.evil/track/abc123")).toBeNull();
    expect(canonicalSpotifyTrackUrl("javascript:alert(1)")).toBeNull();
  });

  it("does not route invalid Spotify links to the external-open callback", () => {
    const onOpenSpotifyTrack = vi.fn();
    const message = { ...responseMessage, streamed: true, text: "[Abrir](https://open.spotify.com.evil/track/abc123)" };
    render(panel({ chatMessages: [message], onOpenSpotifyTrack }));
    fireEvent.click(screen.getByRole("link", { name: "Abrir" }));
    expect(onOpenSpotifyTrack).not.toHaveBeenCalled();
  });

  it("sends on Enter, preserves Shift+Enter and does not submit while an IME composition is active", () => {
    const onSendMessage = vi.fn();
    render(panel({ onSendMessage }));
    const composer = screen.getByRole("textbox", { name: "Escribir mensaje a Nexa" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Enviar con Enter" } });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    expect(onSendMessage).toHaveBeenCalledWith("Enviar con Enter");
    expect(composer.value).toBe("");
    expect(document.activeElement).toBe(composer);

    fireEvent.change(composer, { target: { value: "Primera línea" } });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", shiftKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(composer.value).toBe("Primera línea");

    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(composer.value).toBe("Primera línea");
  });
});
