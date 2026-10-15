// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "../src/renderer/components/ConversationPanel";
import type { ConversationChatMessage } from "../src/renderer/components/ConversationPanel";
import type { PttVoiceSnapshot } from "../src/renderer/voice/ptt-voice-controller";

const idleSnapshot: PttVoiceSnapshot = { status: "idle", canStart: true };

const assistantMessage = (text: string): ConversationChatMessage => ({
  id: "request-1:response",
  requestId: "request-1",
  conversationId: "conversation-1",
  role: "assistant",
  text,
  source: "typed",
  status: "completed",
  createdAt: 1,
});

const pendingUserMessage: ConversationChatMessage = {
  id: "request-1",
  requestId: "request-1",
  conversationId: "conversation-1",
  role: "user",
  text: "Pregunta de prueba",
  source: "typed",
  status: "processing",
  createdAt: 0,
};

function conversation(chatBusy = false, messages: readonly ConversationChatMessage[] = []) {
  return createElement(
    ConversationPanel,
    {
      snapshot: idleSnapshot,
      transcripts: [],
      chatMessages: messages,
      chatBusy,
      transcriptNotice: null,
      onStart: vi.fn(),
      onFinish: vi.fn(),
      onCancel: vi.fn(),
      onRecover: vi.fn(),
    },
  );
}

function renderConversation(chatBusy = false, messages: readonly ConversationChatMessage[] = []) {
  return render(conversation(chatBusy, messages));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Nexa chat animations", () => {
  it("shows only glowing-dot markup while processing and keeps its description accessible", () => {
    renderConversation(true, [pendingUserMessage]);

    const status = document.querySelector(".assistant-processing");
    expect(status?.getAttribute("data-phase")).toBe("visible");
    expect(status?.querySelector(".assistant-processing-dots")?.getAttribute("aria-hidden")).toBe("true");
    expect(status?.querySelectorAll(".assistant-processing-dots > span")).toHaveLength(3);
    expect(status?.querySelector(".sr-only")?.textContent).toBe("Nexa está procesando la respuesta.");
    expect(status?.textContent).not.toContain("pensando");
    expect(status?.textContent).not.toContain("Enviando");
    expect(screen.queryByText("Enviando…")).toBeNull();
  });

  it("fades the dots when a full Runtime response arrives and progressively reveals the intact answer", () => {
    vi.useFakeTimers();
    const answer = "La respuesta completa se conserva sin pérdidas.";
    const view = renderConversation(true, [pendingUserMessage]);

    expect(document.querySelector(".assistant-processing")?.getAttribute("data-phase")).toBe("visible");
    view.rerender(conversation(false, [{ ...pendingUserMessage, status: "completed" }, assistantMessage(answer)]));

    const dots = document.querySelector(".assistant-processing");
    expect(dots?.getAttribute("data-phase")).toBe("fading");
    const response = document.querySelector("[data-message-source='runtime']");
    const visualText = response?.querySelector(".assistant-response-visual");
    expect(response).not.toBeNull();
    expect(visualText?.getAttribute("aria-hidden")).toBe("true");
    expect(visualText?.textContent).toContain("▍");
    expect(visualText?.textContent).not.toBe(answer);

    act(() => { vi.advanceTimersByTime(1_300); });
    expect(document.querySelector(".assistant-processing")).toBeNull();
    expect(visualText?.textContent).toBe(answer);
    expect(response?.querySelector(".assistant-typing-cursor")).toBeNull();
    expect(response?.querySelector(".sr-only")?.textContent).toBe(answer);
  });

  it("renders the complete response immediately when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })));
    const answer = "Respuesta sin animación.";

    renderConversation(false, [assistantMessage(answer)]);

    const visualText = document.querySelector(".assistant-response-visual");
    expect(visualText?.textContent).toBe(answer);
    expect(document.querySelector(".assistant-typing-cursor")).toBeNull();
  });

  it.each([
    ["error", "Runtime no disponible"],
    ["cancelled", "Cancelado"],
  ] as const)("removes processing dots after Runtime status %s", (status, detail) => {
    vi.useFakeTimers();
    const errorMessage: ConversationChatMessage = {
      ...assistantMessage("Mensaje del usuario"),
      id: "request-error",
      role: "user",
    };
    const view = renderConversation(true, [pendingUserMessage]);
    expect(document.querySelector(".assistant-processing")).not.toBeNull();

    view.rerender(conversation(false, [{ ...errorMessage, status, error: detail }]));

    expect(document.querySelector(".assistant-processing")?.getAttribute("data-phase")).toBe("fading");
    act(() => { vi.advanceTimersByTime(200); });
    expect(document.querySelector(".assistant-processing")).toBeNull();
    expect(document.querySelector("[data-message-source='runtime']")).toBeNull();
  });

  it("does not show processing dots while only preparing a conversation", () => {
    renderConversation(true);
    expect(document.querySelector(".assistant-processing")).toBeNull();
  });

  it("shows the welcome in an empty conversation and removes it once messages exist", () => {
    const view = render(createElement(ConversationPanel, { snapshot: idleSnapshot, transcripts: [], chatMessages: [],
      welcomeMessage: "Buen día, Jor. ¿Qué hacemos hoy?", transcriptNotice: null, onStart: vi.fn(), onFinish: vi.fn(), onRecover: vi.fn() }));
    expect(screen.getByRole("heading", { name: "Buen día, Jor. ¿Qué hacemos hoy?" })).toBeTruthy();
    view.rerender(createElement(ConversationPanel, { snapshot: idleSnapshot, transcripts: [], chatMessages: [pendingUserMessage],
      welcomeMessage: "Buen día, Jor. ¿Qué hacemos hoy?", transcriptNotice: null, onStart: vi.fn(), onFinish: vi.fn(), onRecover: vi.fn() }));
    expect(screen.queryByRole("heading", { name: "Buen día, Jor. ¿Qué hacemos hoy?" })).toBeNull();
  });
});
