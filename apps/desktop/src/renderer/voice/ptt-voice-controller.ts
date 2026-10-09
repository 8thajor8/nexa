import type { VoiceDesktopApi, VoiceEventEnvelope, VoicePttFinishResponse } from "../../shared/ipc-contract";
import { PttCaptureError, PttMicrophoneCapture } from "../audio/ptt-microphone-capture";

const MAX_PENDING_FINISH_EVENTS = 8;
const MAX_PENDING_FINISH_TEXT_CHARS = 64 * 1024;

export type PttVoiceStatus = "idle" | "starting" | "listening" | "finishing" | "processing"
  | "cancelling" | "recovering" | "transcript-ready" | "error" | "recovery-required";

export interface PttVoiceSnapshot {
  readonly status: PttVoiceStatus;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly turnId?: string;
  readonly transcript?: string;
  readonly language?: string | null;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface PttCapturePort {
  start(): Promise<{ sessionId: string; requestId: string }>;
  finish(language?: string): Promise<VoicePttFinishResponse>;
  cancel(): Promise<void>;
  readonly mainCancellationPending: boolean;
  recoverMainCancellation(target?: "preferred" | "start" | "finish"): Promise<void>;
}

export interface PttVoiceControllerDependencies {
  createCapture?: (voice: VoiceDesktopApi) => PttCapturePort;
}

interface ActiveSession {
  readonly sessionId: string;
  readonly startRequestId: string;
  finishRequestId: string | null;
  turnId: string | null;
}

function toError(error: unknown): { code: string; message: string } {
  if (error instanceof PttCaptureError) return { code: error.code, message: error.message };
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return { code: "voice_operation_failed", message: error.message };
  }
  return { code: "voice_operation_failed", message: "La operación de voz no pudo completarse." };
}

function validEnvelope(envelope: VoiceEventEnvelope): boolean {
  if (!envelope || typeof envelope !== "object" || !Number.isSafeInteger(envelope.sequence)
    || envelope.sequence < 1 || !envelope.requestId || !envelope.sessionId || !envelope.event
    || envelope.event.sessionId !== envelope.sessionId) return false;
  const eventTurnId = "turnId" in envelope.event && typeof envelope.event.turnId === "string"
    ? envelope.event.turnId : undefined;
  return eventTurnId === envelope.turnId;
}

function isFinishEvent(envelope: VoiceEventEnvelope): boolean {
  return envelope.event.type === "voice.transcribing"
    || envelope.event.type === "voice.transcript.final"
    || envelope.event.type === "voice.error"
    || envelope.event.type === "voice.session.ended";
}

function pendingTextLength(envelope: VoiceEventEnvelope): number {
  return envelope.event.type === "voice.transcript.final" ? envelope.event.text.length
    : envelope.event.type === "voice.error" ? envelope.event.error.message.length : 0;
}

/** Coordinates one microphone capture instance and the allowlisted Voice event stream. */
export class PttVoiceController {
  private readonly capture: PttCapturePort;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeVoice: () => void;
  private snapshot: PttVoiceSnapshot = { status: "idle" };
  private activeSession: ActiveSession | null = null;
  private lastSequence = 0;
  private pendingFinishEvents: VoiceEventEnvelope[] = [];
  private pendingFinishRequestId: string | null = null;
  private pendingFinishTextChars = 0;
  private pendingFinishOverflow = false;
  private startInFlight = false;
  private finishInFlight = false;
  private cancelInFlight: Promise<void> | null = null;
  private cancelRequestedDuringStart = false;
  private operation = 0;
  private destroyed = false;

  constructor(voice: VoiceDesktopApi, dependencies: PttVoiceControllerDependencies = {}) {
    this.capture = (dependencies.createCapture ?? ((api) => new PttMicrophoneCapture(api)))(voice);
    this.unsubscribeVoice = voice.onEvent((event) => this.handleVoiceEvent(event));
  }

  readonly getSnapshot = (): PttVoiceSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.destroyed) return () => undefined;
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  };

  async start(): Promise<void> {
    if (this.destroyed || this.startInFlight || this.finishInFlight || this.cancelInFlight
      || this.capture.mainCancellationPending || this.activeSession) return;
    if (!["idle", "error", "transcript-ready"].includes(this.snapshot.status)) return;

    const operation = ++this.operation;
    this.startInFlight = true;
    this.cancelRequestedDuringStart = false;
    this.resetSessionData();
    this.publish({ status: "starting" });
    try {
      const result = await this.capture.start();
      if (this.destroyed || operation !== this.operation) return;
      this.activeSession = {
        sessionId: result.sessionId, startRequestId: result.requestId, finishRequestId: null, turnId: null,
      };
      this.publish({ status: "listening", sessionId: result.sessionId });
    } catch (error) {
      if (this.destroyed || operation !== this.operation) return;
      this.publishCaptureFailure(error);
    } finally {
      this.startInFlight = false;
      if (!this.destroyed && this.cancelRequestedDuringStart) {
        this.cancelRequestedDuringStart = false;
        this.settleCancelledState();
      }
    }
  }

  async finish(language?: string): Promise<void> {
    const session = this.activeSession;
    if (this.destroyed || !session || this.snapshot.status !== "listening" || this.finishInFlight) return;
    const operation = ++this.operation;
    this.finishInFlight = true;
    session.finishRequestId = null;
    session.turnId = null;
    this.clearPendingFinishEvents();
    this.publish({ status: "finishing", sessionId: session.sessionId });
    try {
      const response = await this.capture.finish(language);
      if (this.destroyed || operation !== this.operation) return;
      if (!this.isValidFinishAck(response, session.sessionId)) {
        throw new PttCaptureError("voice_session_unavailable", "El ACK de finish no coincide con la sesión activa.");
      }
      session.finishRequestId = response.requestId;
      const buffered = this.pendingFinishEvents;
      const overflow = this.pendingFinishOverflow;
      this.pendingFinishEvents = [];
      this.pendingFinishRequestId = null;
      this.pendingFinishTextChars = 0;
      this.pendingFinishOverflow = false;

      for (const event of buffered) {
        if (event.requestId === response.requestId && event.sessionId === session.sessionId) {
          this.processSessionEvent(event, session);
        }
      }
      const statusAfterEvents = this.snapshot.status as PttVoiceStatus;
      if (overflow && !["transcript-ready", "error"].includes(statusAfterEvents)) {
        this.publish({ status: "error", sessionId: session.sessionId,
          error: { code: "voice_event_buffer_overflow", message: "Se descartaron demasiados eventos durante la confirmación." } });
      } else if (statusAfterEvents === "finishing") {
        this.publish({ status: "processing", sessionId: session.sessionId, requestId: response.requestId,
          ...(session.turnId ? { turnId: session.turnId } : {}) });
      }
    } catch (error) {
      if (this.destroyed || operation !== this.operation) return;
      this.clearPendingFinishEvents();
      if (this.capture.mainCancellationPending) {
        this.publish({ status: "recovery-required", sessionId: session.sessionId, error: toError(error) });
      } else {
        this.activeSession = null;
        this.publish({ status: "error", sessionId: session.sessionId, error: toError(error) });
      }
    } finally {
      this.finishInFlight = false;
    }
  }

  async cancel(): Promise<void> {
    if (this.destroyed || this.cancelInFlight) return this.cancelInFlight ?? Promise.resolve();
    const canCancelErrorSession = this.snapshot.status === "error" && this.activeSession !== null;
    if (!["starting", "listening", "finishing", "processing"].includes(this.snapshot.status)
      && !canCancelErrorSession) return;

    const hadStartInFlight = this.startInFlight;
    const sessionId = this.activeSession?.sessionId ?? this.snapshot.sessionId;
    ++this.operation;
    this.cancelRequestedDuringStart = hadStartInFlight;
    this.clearPendingFinishEvents();
    this.publish({ status: "cancelling", ...(sessionId ? { sessionId } : {}) });

    const task = (async () => {
      try {
        await this.capture.cancel();
        if (this.destroyed) return;
        if (this.capture.mainCancellationPending) {
          this.publish({ status: "recovery-required", ...(sessionId ? { sessionId } : {}) });
        } else if (!this.startInFlight) {
          this.activeSession = null;
          this.resetSessionData();
          this.publish({ status: "idle" });
        }
      } catch (error) {
        if (this.destroyed) return;
        if (this.capture.mainCancellationPending) {
          this.publish({ status: "recovery-required", ...(sessionId ? { sessionId } : {}), error: toError(error) });
        } else {
          // Keep ownership of the session until a terminal event or explicit cancellation confirms cleanup.
          this.publish({ status: "error", ...(sessionId ? { sessionId } : {}), error: toError(error) });
        }
      }
    })();
    this.cancelInFlight = task;
    try { await task; }
    finally { if (this.cancelInFlight === task) this.cancelInFlight = null; }
  }

  async recoverMainCancellation(target: "preferred" | "start" | "finish" = "preferred"): Promise<void> {
    if (this.destroyed || this.cancelInFlight || !this.capture.mainCancellationPending
      || this.snapshot.status !== "recovery-required") return;
    const operation = ++this.operation;
    const sessionId = this.snapshot.sessionId ?? this.activeSession?.sessionId;
    this.publish({ status: "recovering", ...(sessionId ? { sessionId } : {}) });
    try {
      await this.capture.recoverMainCancellation(target);
      if (this.destroyed || operation !== this.operation) return;
      if (this.capture.mainCancellationPending) {
        this.publish({ status: "recovery-required", ...(sessionId ? { sessionId } : {}) });
        return;
      }
      this.activeSession = null;
      this.resetSessionData();
      this.publish({ status: "idle" });
    } catch (error) {
      if (this.destroyed || operation !== this.operation) return;
      this.publish({ status: "recovery-required", ...(sessionId ? { sessionId } : {}), error: toError(error) });
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    ++this.operation;
    this.unsubscribeVoice();
    this.listeners.clear();
    this.clearPendingFinishEvents();
    try { await this.capture.cancel(); } catch { /* Main owns final window-close cleanup. */ }
    this.activeSession = null;
  }

  private handleVoiceEvent(envelope: VoiceEventEnvelope): void {
    if (this.destroyed || !validEnvelope(envelope) || envelope.sequence <= this.lastSequence) return;
    this.lastSequence = envelope.sequence;
    const session = this.activeSession;
    if (!session || envelope.sessionId !== session.sessionId) return;
    if (["cancelling", "recovery-required", "recovering"].includes(this.snapshot.status)) return;
    if (this.snapshot.status === "error" && envelope.event.type !== "voice.session.ended") return;

    if (this.snapshot.status === "finishing" && !session.finishRequestId) {
      this.bufferFinishEvent(envelope);
      return;
    }
    this.processSessionEvent(envelope, session);
  }

  private bufferFinishEvent(envelope: VoiceEventEnvelope): void {
    if (!isFinishEvent(envelope)) return;
    if (this.pendingFinishRequestId && envelope.requestId !== this.pendingFinishRequestId) return;
    if (this.pendingFinishEvents.length >= MAX_PENDING_FINISH_EVENTS
      || this.pendingFinishTextChars + pendingTextLength(envelope) > MAX_PENDING_FINISH_TEXT_CHARS) {
      this.pendingFinishOverflow = true;
      return;
    }
    this.pendingFinishRequestId ??= envelope.requestId;
    this.pendingFinishTextChars += pendingTextLength(envelope);
    this.pendingFinishEvents.push(envelope);
  }

  private processSessionEvent(envelope: VoiceEventEnvelope, session: ActiveSession): void {
    if (envelope.sessionId !== session.sessionId) return;
    const event = envelope.event;
    if (event.type === "voice.session.started") return;
    if (event.type === "voice.session.ended") {
      const expectedRequestId = session.finishRequestId ?? session.startRequestId;
      if (envelope.requestId !== expectedRequestId) return;
      this.activeSession = null;
      if (["transcript-ready", "error", "cancelling", "recovery-required", "recovering"].includes(this.snapshot.status)) return;
      this.publish({ status: "error", sessionId: session.sessionId,
        error: { code: "voice_session_ended", message: "La sesión terminó antes de completar la transcripción." } });
      return;
    }

    if (!session.finishRequestId || envelope.requestId !== session.finishRequestId) return;
    if (event.type === "voice.transcribing") {
      if (envelope.turnId !== event.turnId || (session.turnId && session.turnId !== event.turnId)) return;
      session.turnId = event.turnId;
      if (["finishing", "processing"].includes(this.snapshot.status)) {
        this.publish({ status: "processing", sessionId: session.sessionId,
          requestId: session.finishRequestId, turnId: session.turnId });
      }
      return;
    }
    if (!session.turnId || envelope.turnId !== event.turnId || session.turnId !== event.turnId) return;
    if (event.type === "voice.transcript.final") {
      this.publish({ status: "transcript-ready", sessionId: session.sessionId,
        requestId: session.finishRequestId, turnId: event.turnId, transcript: event.text, language: event.language });
    } else if (event.type === "voice.error") {
      this.publish({ status: "error", sessionId: session.sessionId,
        error: { code: event.error.code, message: event.error.message } });
    } else if (event.type === "voice.cancelled") {
      this.publish({ status: "error", sessionId: session.sessionId,
        error: { code: "voice_cancelled", message: "Voice canceló la transcripción." } });
    }
  }

  private isValidFinishAck(response: VoicePttFinishResponse, sessionId: string): response is Extract<VoicePttFinishResponse, { ok: true }> {
    return response.ok === true && response.accepted === true && response.sessionId === sessionId
      && typeof response.requestId === "string" && response.requestId.length > 0;
  }

  private publishCaptureFailure(error: unknown): void {
    if (this.capture.mainCancellationPending) this.publish({ status: "recovery-required", error: toError(error) });
    else this.publish({ status: "error", error: toError(error) });
  }

  private settleCancelledState(): void {
    if (this.capture.mainCancellationPending) {
      this.publish({ status: "recovery-required", ...(this.snapshot.sessionId ? { sessionId: this.snapshot.sessionId } : {}) });
    } else if (!this.cancelInFlight) {
      this.activeSession = null;
      this.resetSessionData();
      this.publish({ status: "idle" });
    }
  }

  private resetSessionData(): void {
    this.activeSession = null;
    this.clearPendingFinishEvents();
  }

  private clearPendingFinishEvents(): void {
    this.pendingFinishEvents = [];
    this.pendingFinishRequestId = null;
    this.pendingFinishTextChars = 0;
    this.pendingFinishOverflow = false;
  }

  private publish(snapshot: PttVoiceSnapshot): void {
    if (this.destroyed) return;
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
