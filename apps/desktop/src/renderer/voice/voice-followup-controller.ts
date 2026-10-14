import type { VoiceDesktopApi, VoiceEventEnvelope, VoiceFollowupDiagnosticOutcome } from "../../shared/ipc-contract";
import { encodePcm16MonoWav, PTT_MAX_DURATION_SECONDS } from "../audio/ptt-microphone-capture";

const FOLLOWUP_WINDOW_MS = 5_000;
const VAD_ASSET_BASE = "nexa-vad://assets/";

export function extractNexaFollowup(text: string): string | null {
  const prefix = /^\s*[¿¡"“‘([{]*\s*(?:nexa|mexa|next)\b[\s,.:;!?¡¿—–"”’)}\]\-]*(.*)$/iu.exec(text);
  const command = (prefix ? prefix[1] : text).trim();
  return /\p{L}{2,}/u.test(command) ? command : null;
}

interface VadPort {
  start(): Promise<void>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
}

type VadCallbacks = {
  onSpeechRealStart(): void;
  onSpeechEnd(audio: Float32Array): void;
  onVADMisfire(): void;
};
type VadFactory = (callbacks: VadCallbacks) => Promise<VadPort>;

async function createLocalVad(
  callbacks: VadCallbacks,
  getDeviceId: () => string | null,
): Promise<VadPort> {
  const { MicVAD } = await import("@ricky0123/vad-web");
  return MicVAD.new({
    model: "v6", startOnLoad: false, processorType: "AudioWorklet",
    baseAssetPath: VAD_ASSET_BASE, onnxWASMBasePath: VAD_ASSET_BASE,
    minSpeechMs: 250, redemptionMs: 800, preSpeechPadMs: 300,
    ortConfig: (ort) => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; },
    getStream: () => navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true,
      ...(getDeviceId() ? { deviceId: { exact: getDeviceId()! } } : {}),
    }, video: false }),
    onSpeechRealStart: callbacks.onSpeechRealStart,
    onSpeechEnd: callbacks.onSpeechEnd,
    onVADMisfire: callbacks.onVADMisfire,
  });
}

export interface FollowupTranscript {
  text: string;
  sessionId: string;
  requestId: string;
  turnId: string;
}

export type VoiceFollowupStatus = "idle" | "preparing" | "listening";
export type VoiceFollowupFailure = {
  stage: "vad_initialization" | "main_session_start" | "vad_start" | "vad_finish" | "audio_validation" | "stt_finish";
  code: "microphone_permission_denied" | "microphone_unavailable" | "microphone_device_unavailable" | "followup_failed";
};

export interface VoiceFollowupDependencies {
  createVad?: VadFactory;
  getDeviceId?: () => string | null;
  onAcceptedTranscript: (value: FollowupTranscript) => void;
  onFailure?: (failure: VoiceFollowupFailure) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

/** One bounded listening window, using the existing Main STT session and ducking lifecycle. */
export class VoiceFollowupController {
  private vad: VadPort | null = null;
  private sessionId: string | null = null;
  private startRequestId: string | null = null;
  private finishRequestId: string | null = null;
  private duckingParentRequestId: string | null = null;
  private duckingRequestId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private active = false;
  private status: VoiceFollowupStatus = "idle";
  private finishing = false;
  private windowDeadline = 0;
  private completionAllowed = false;
  private followupStartedAt = 0;
  private vadSpeechDetected = false;
  private pendingStart: Promise<Awaited<ReturnType<VoiceDesktopApi["ptt"]["start"]>>> | null = null;
  private stopInFlight: Promise<void> | null = null;
  private endDuckingOnStop = false;
  private duckingEndReason: "followup_expired" | "stop" | "error" = "stop";
  private prepared: { generation: number; promise: Promise<VadPort> } | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private readonly createVad: VadFactory;
  private readonly schedule: typeof globalThis.setTimeout;
  private readonly unschedule: typeof globalThis.clearTimeout;

  constructor(private readonly voice: VoiceDesktopApi, private readonly dependencies: VoiceFollowupDependencies) {
    this.createVad = dependencies.createVad ?? ((callbacks) => createLocalVad(callbacks, dependencies.getDeviceId ?? (() => null)));
    this.schedule = dependencies.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.unschedule = dependencies.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  readonly getSnapshot = (): VoiceFollowupStatus => this.status;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Loads the local model while TTS is running; startOnLoad:false keeps the microphone closed. */
  prepare(): void {
    if (this.active || this.prepared || this.stopInFlight) return;
    const generation = ++this.generation;
    const promise = this.createVad({
      onSpeechRealStart: () => {
        if (!this.isCurrent(generation)) return;
        this.vadSpeechDetected = true;
        this.diagnose(this.startRequestId, "vad_speech_detected", performance.now() - this.followupStartedAt);
        this.clearWindowTimer();
      },
      onSpeechEnd: (audio) => { void this.finish(audio, generation); },
      onVADMisfire: () => {
        if (!this.isCurrent(generation)) return;
        this.diagnose(this.startRequestId, "vad_misfire", performance.now() - this.followupStartedAt);
        this.armWindowTimer(generation);
      },
    });
    this.prepared = { generation, promise };
    void promise.catch((error: unknown) => {
      this.reportFailure("vad_initialization", error);
      if (this.prepared?.promise === promise) this.prepared = null;
    });
  }

  async open(parentRequestId?: string): Promise<void> {
    if (this.stopInFlight) await this.stopInFlight;
    if (this.active) return;
    if (!this.prepared) this.prepare();
    const prepared = this.prepared;
    if (!prepared) return;
    this.prepared = null;
    const generation = prepared.generation;
    this.active = true;
    this.followupStartedAt = performance.now();
    this.vadSpeechDetected = false;
    this.status = "preparing";
    this.completionAllowed = false;
    this.unsubscribe = this.voice.onEvent((event) => this.onVoiceEvent(event));
    this.notify();
    const requestId = crypto.randomUUID();
    this.startRequestId = requestId;
    this.duckingParentRequestId = parentRequestId ?? null;
    this.duckingRequestId = requestId;
    this.endDuckingOnStop = false;
    this.duckingEndReason = "stop";
    this.diagnose(requestId, "window_opened");
    let vadClaimed = false;
    let stage: VoiceFollowupFailure["stage"] = "main_session_start";
    const releasePrepared = async () => {
      try { const vad = await prepared.promise; await vad.destroy(); }
      catch { /* The model was unavailable or already released. */ }
    };
    try {
      const start = this.voice.ptt.start({ requestId });
      this.pendingStart = start;
      const response = await start;
      this.pendingStart = null;
      if (!response.ok || response.requestId !== requestId) throw new Error("followup_session_start_failed");
      this.sessionId = response.sessionId;
      if (!this.isCurrent(generation)) {
        await releasePrepared();
        await this.cancelSession(response.sessionId, requestId);
        return;
      }
      stage = "vad_initialization";
      const vad = await prepared.promise;
      vadClaimed = true;
      if (!this.isCurrent(generation)) { await vad.destroy(); return; }
      this.vad = vad;
      stage = "vad_start";
      await vad.start();
      if (!this.isCurrent(generation)) { await vad.destroy(); return; }
      this.status = "listening";
      this.notify();
      this.windowDeadline = performance.now() + FOLLOWUP_WINDOW_MS;
      this.armWindowTimer(generation);
      this.durationTimer = this.schedule(() => { void this.stop("error"); }, PTT_MAX_DURATION_SECONDS * 1_000);
    } catch (error: unknown) {
      this.reportFailure(stage, error);
      this.pendingStart = null;
      if (!vadClaimed) await releasePrepared();
      if (this.isCurrent(generation)) void this.stop("error");
    }
  }

  async stop(reason: "cancel" | "complete" | "expired" | "error" = "cancel"): Promise<void> {
    if (reason === "cancel" && this.active && this.startRequestId) {
      this.diagnose(this.startRequestId, "cancelled", performance.now() - this.followupStartedAt);
    }
    if (reason !== "complete") {
      this.completionAllowed = false;
      this.endDuckingOnStop = true;
      this.duckingEndReason = reason === "expired" ? "followup_expired" : reason === "error" ? "error" : "stop";
    }
    if (this.stopInFlight) return this.stopInFlight;
    if (!this.active && !this.prepared) return;
    ++this.generation;
    const prepared = this.prepared;
    this.prepared = null;
    this.active = false;
    this.status = "idle";
    this.notify();
    this.clearWindowTimer();
    this.windowDeadline = 0;
    if (this.durationTimer) this.unschedule(this.durationTimer);
    this.durationTimer = null;
    const task = (async () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (prepared) {
        try { const vad = await prepared.promise; await vad.destroy(); }
        catch { /* The model was unavailable or already released. */ }
      }
      const pendingStart = this.pendingStart;
      if (pendingStart) {
        try { await pendingStart; } catch { /* No Main session was created. */ }
      }
      const vad = this.vad;
      this.vad = null;
      const sessionId = this.sessionId;
      const targetRequestId = this.finishRequestId ?? this.startRequestId;
      const duckingStartRequestId = this.startRequestId;
      const duckingRequestId = this.duckingRequestId;
      const duckingParentRequestId = this.duckingParentRequestId;
      this.duckingRequestId = null;
      this.duckingParentRequestId = null;
      this.sessionId = null;
      this.startRequestId = null;
      this.finishRequestId = null;
      this.finishing = false;
      try { await vad?.destroy(); } catch { /* Main cancellation still runs. */ }
      if (sessionId && targetRequestId) await this.cancelSession(sessionId, targetRequestId);
      if (this.endDuckingOnStop) {
        if (duckingRequestId) await this.voice.endDucking?.(duckingRequestId, this.duckingEndReason).catch(() => false);
        if (duckingStartRequestId && duckingStartRequestId !== duckingRequestId) {
          await this.voice.endDucking?.(duckingStartRequestId, this.duckingEndReason).catch(() => false);
        }
        if (duckingParentRequestId) await this.voice.endDucking?.(duckingParentRequestId, this.duckingEndReason).catch(() => false);
      }
    })();
    this.stopInFlight = task;
    try { await task; } finally { if (this.stopInFlight === task) this.stopInFlight = null; }
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.listeners.clear();
  }

  private async finish(audio: Float32Array, generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.finishing || !this.sessionId) return;
    this.finishing = true;
    this.clearWindowTimer();
    const sessionId = this.sessionId;
    const vad = this.vad;
    this.vad = null;
    try { await vad?.pause(); await vad?.destroy(); } catch (error: unknown) {
      this.reportFailure("vad_finish", error);
      await this.stop("error");
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (!audio.length || audio.length > PTT_MAX_DURATION_SECONDS * 16_000) {
      this.reportFailure("audio_validation");
      await this.stop("error");
      return;
    }
    const wav = encodePcm16MonoWav(audio);
    const requestId = crypto.randomUUID();
    this.finishRequestId = requestId;
    this.duckingRequestId = requestId;
    this.diagnose(requestId, "transcription_submitted", performance.now() - this.followupStartedAt);
    try {
      const response = await this.voice.ptt.finish({ requestId, sessionId, audio: wav, format: "wav" });
      if (!response.ok || response.requestId !== requestId || response.sessionId !== sessionId) await this.stop("error");
    } catch (error: unknown) {
      this.reportFailure("stt_finish", error);
      await this.stop("error");
    }
    finally { wav.fill(0); audio.fill(0); }
  }

  private onVoiceEvent(envelope: VoiceEventEnvelope): void {
    if (!this.active || envelope.sessionId !== this.sessionId || envelope.requestId !== this.finishRequestId) return;
    if (envelope.event.type === "voice.transcript.final") {
      const generation = this.generation;
      const command = extractNexaFollowup(envelope.event.text);
      if (!envelope.event.text.trim()) this.diagnose(envelope.requestId, "transcript_empty");
      else if (!command) this.diagnose(envelope.requestId, "transcript_unusable");
      else this.diagnose(envelope.requestId,
        command === envelope.event.text.trim() ? "transcript_accepted_without_prefix" : "transcript_accepted_prefix_removed");
      const transcript = command && envelope.turnId ? {
        text: command, sessionId: envelope.sessionId, requestId: envelope.requestId, turnId: envelope.turnId,
      } : null;
      this.completionAllowed = Boolean(transcript);
      void this.stop(transcript ? "complete" : "error").then(() => {
        if (transcript && this.completionAllowed && this.generation === generation + 1) {
          this.completionAllowed = false;
          this.diagnose(transcript.requestId, "chat_submission_requested");
          this.dependencies.onAcceptedTranscript(transcript);
        }
      });
    } else if (envelope.event.type === "voice.error" || envelope.event.type === "voice.cancelled"
      || envelope.event.type === "voice.session.ended") {
      if (envelope.event.type === "voice.error") this.diagnose(envelope.requestId, "transcription_error");
      void this.stop("error");
    }
  }

  private async cancelSession(sessionId: string, targetRequestId: string): Promise<void> {
    try { await this.voice.ptt.cancel({ requestId: crypto.randomUUID(), sessionId, targetRequestId }); }
    catch { /* A failed or already retired Main session must never reopen listening. */ }
  }

  private clearWindowTimer(): void {
    if (this.timer) this.unschedule(this.timer);
    this.timer = null;
  }

  private armWindowTimer(generation: number): void {
    this.clearWindowTimer();
    const remaining = this.windowDeadline - performance.now();
    if (remaining <= 0) { void this.stop("expired"); return; }
    this.timer = this.schedule(() => {
      if (!this.isCurrent(generation)) return;
      if (!this.vadSpeechDetected && this.startRequestId) {
        this.diagnose(this.startRequestId, "window_expired_no_speech", performance.now() - this.followupStartedAt);
      } else if (this.startRequestId) {
        this.diagnose(this.startRequestId, "window_expired_after_speech", performance.now() - this.followupStartedAt);
      }
      void this.stop("expired");
    }, remaining);
  }

  private diagnose(requestId: string | null, outcome: VoiceFollowupDiagnosticOutcome, durationMs?: number): void {
    if (!requestId || !this.voice.recordFollowupDiagnostic) return;
    void this.voice.recordFollowupDiagnostic({ requestId, outcome, ...(durationMs === undefined ? {} : { durationMs }) }).catch(() => undefined);
  }

  private isCurrent(generation: number): boolean { return this.active && generation === this.generation; }
  private reportFailure(stage: VoiceFollowupFailure["stage"], error?: unknown): void {
    const name = error instanceof DOMException || error instanceof Error ? error.name : "";
    const code: VoiceFollowupFailure["code"] = name === "NotAllowedError"
      ? "microphone_permission_denied"
      : name === "NotFoundError" ? "microphone_unavailable"
        : name === "OverconstrainedError" ? "microphone_device_unavailable" : "followup_failed";
    this.dependencies.onFailure?.({ stage, code });
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
}
