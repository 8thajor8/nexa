import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationPanel, type VoiceTranscriptItem } from "../src/renderer/components/ConversationPanel";
import { PresencePanel } from "../src/renderer/components/PresencePanel";
import type { PttVoiceSnapshot, PttVoiceStatus } from "../src/renderer/voice/ptt-voice-controller";

const noop = vi.fn();
const transcripts: VoiceTranscriptItem[] = [{
  sessionId: "session-1", requestId: "finish-1", turnId: "turn-1", text: "Texto transcrito real.", language: "es",
}];

function conversation(status: PttVoiceStatus, extras: Partial<PttVoiceSnapshot> = {}, entries: VoiceTranscriptItem[] = [],
  voiceSpeechStatus: { requestId: string; state: "preparing" | "speaking" | "cancelling" | "error"; message?: string } | null = null) {
  return renderToStaticMarkup(createElement(ConversationPanel, {
    snapshot: { status, canStart: status === "idle" || status === "transcript-ready", ...extras }, transcripts: entries, transcriptNotice: null,
    voiceSpeechStatus, interactionCancelable: ["starting", "listening", "finishing", "processing"].includes(status)
      || (status === "error" && extras.canStart !== true && Boolean(extras.sessionId))
      || Boolean(voiceSpeechStatus && ["preparing", "speaking", "cancelling"].includes(voiceSpeechStatus.state)),
    onCancelInteraction: noop, onStart: noop, onFinish: noop, onRecover: noop,
  }));
}

describe("PTT visual integration", () => {
  it("shows an accessible idle microphone action and an empty, enabled message composer", () => {
    const markup = conversation("idle");
    expect(markup).toContain('aria-label="Iniciar grabación de voz"');
    expect(markup).not.toContain("aria-pressed");
    expect(markup).toContain('id="message-composer" class="composer-textarea" rows="1" placeholder="Escribí un mensaje a Nexa…"');
    expect(markup).toContain('aria-label="Enviar mensaje a Nexa"');
    expect(markup).toContain('disabled=""'); // Empty text cannot be submitted.
  });

  it("provides finish and cancel actions while recording and prevents duplicate operation controls in transient states", () => {
    const listening = conversation("listening", { sessionId: "session-1" });
    expect(listening).toContain('aria-label="Finalizar grabación y transcribir"');
    expect(listening).not.toContain("aria-pressed");
    expect(listening).toContain('aria-label="Detener interacción"');
    expect(listening).not.toContain('>Cancelar</button>');

    for (const status of ["starting", "finishing", "processing", "cancelling", "recovering"] as const) {
      const markup = conversation(status, { sessionId: "session-1" });
      expect(markup).toContain("disabled=\"\"");
      expect(markup).not.toContain('aria-label="Iniciar grabación de voz"');
    }
    expect(conversation("processing", { sessionId: "session-1" })).toContain('aria-label="Detener interacción"');
  });

  it("shows explicit recovery and a controlled microphone permission error", () => {
    const recovery = conversation("recovery-required", {
      sessionId: "session-old", error: { code: "main_cancel_unconfirmed", message: "technical" },
    });
    expect(recovery).toContain('aria-label="Recuperar cancelación pendiente de Main"');
    expect(recovery).toContain("Main no confirmó la cancelación");

    const denied = conversation("error", { canStart: true, error: { code: "permission_denied", message: "permission denied" } });
    expect(denied).toContain('role="alert"');
    expect(denied).toContain("Permiso del micrófono denegado");
    expect(denied).toContain('aria-label="Reintentar grabación de voz"');
    expect(denied).not.toContain('aria-label="Cancelar sesión de voz"');

    const erroredSession = conversation("error", {
      sessionId: "session-1", error: { code: "VOICE_PTT_TRANSCRIPTION_FAILED", message: "failed" },
    });
    expect(erroredSession).toContain('aria-label="Grabación no disponible"');
    expect(erroredSession).toContain("disabled=\"\"");
    expect(erroredSession).toContain('aria-label="Detener interacción"');

    const recoveredSession = conversation("error", {
      canStart: true, sessionId: "session-1", error: { code: "VOICE_PTT_TRANSCRIPTION_FAILED", message: "failed" },
    });
    expect(recoveredSession).toContain('aria-label="Reintentar grabación de voz"');
    expect(recoveredSession).not.toContain('aria-label="Detener interacción"');
  });

  it("renders final voice transcripts as Jor's user messages with a discreet voice source marker", () => {
    const markup = conversation("transcript-ready", {}, transcripts);
    expect(markup).toContain('class="message message--user message--voice-transcript" data-message-source="voice"');
    expect(markup).toContain("<strong>Jor</strong>");
    expect(markup).toContain("<span>Voz</span>");
    expect(markup).toContain("Texto transcrito real.");
    expect(markup).not.toContain("DEMO · MOCK");
    expect(markup).not.toContain("Transcripciones de voz");
  });

  it("shows an icon-only accessible Stop control while speech is preparing or playing, and omits redundant status copy", () => {
    for (const state of ["preparing", "speaking"] as const) {
      const markup = conversation("transcript-ready", {}, transcripts, { requestId: "speech-1", state });
      expect(markup).toContain('aria-label="Detener interacción"');
      expect(markup).toContain('title="Detener interacción"');
      expect(markup).toContain('class="voice-stop-button"');
      expect(markup).not.toContain("Preparando respuesta hablada");
      expect(markup).not.toContain("Transcripción final recibida");
      expect(markup).not.toContain("Nexa está hablando");
      expect(markup).not.toContain(">Interrumpir</button>");
      expect(markup).toContain("Texto transcrito real.");
    }
    const cancelling = conversation("idle", {}, [], { requestId: "speech-1", state: "cancelling" });
    expect(cancelling).toContain('aria-label="Detener interacción"');
    expect(cancelling).toContain("disabled=\"\"");
  });

  it("places Send before the microphone at the far right of the composer", () => {
    const markup = conversation("idle");
    const inputIndex = markup.indexOf('id="message-composer"');
    const sendIndex = markup.indexOf('aria-label="Enviar mensaje a Nexa"');
    const voiceGroupIndex = markup.indexOf('aria-label="Controles de voz"');
    const microphoneIndex = markup.indexOf('aria-label="Iniciar grabación de voz"');

    expect(inputIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(inputIndex);
    expect(voiceGroupIndex).toBeGreaterThan(sendIndex);
    expect(microphoneIndex).toBeGreaterThan(voiceGroupIndex);
  });

  it("reflects voice state in Presence without introducing a renderer or avatar", () => {
    const markup = renderToStaticMarkup(createElement(PresencePanel, {
      status: "listening", statusLabel: "Escuchando",
    }));
    expect(markup).toContain('data-voice-state="listening"');
    expect(markup).toContain("Escuchando");
    expect(markup).toContain("Sin visualización");
    expect(markup).not.toContain("<canvas");
    expect(markup).not.toContain("<iframe");
  });
});
