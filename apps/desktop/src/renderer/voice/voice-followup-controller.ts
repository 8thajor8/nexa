import type { VoiceDesktopApi, VoiceEventEnvelope } from "../../shared/ipc-contract";
import { encodePcm16MonoWav, PTT_MAX_DURATION_SECONDS } from "../audio/ptt-microphone-capture";

const FOLLOWUP_WINDOW_MS = 5_000;
const VAD_ASSET_BASE = "nexa-vad://assets/";

export function extractNexaFollowup(text: string): string | null {
  const match = /^\s*nexa\b[\s,.:;!?¡¿—–-]*(.+)$/iu.exec(text);
  return match?.[1]?.trim() || null;
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

export interface VoiceFollowupDependencies {
  createVad?: VadFactory;
  getDeviceId?: () => string | null;
  onAcceptedTranscript: (value: FollowupTranscript) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

/** One bounded listening window, using the existing Main STT session and ducking lifecycle. */
export class VoiceFollowupController {
  private vad: VadPort | null = null;
  private sessionId: string | null = null;
  private startRequestId: string | null = null;
  private finishRequestId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private active = false;
  private finishing = false;
  private windowDeadline = 0;
  private completionAllowed = false;
  private pendingStart: Promise<Awaited<ReturnType<VoiceDesktopApi["ptt"]["start"]>>> | null = null;
  private stopInFlight: Promise<void> | null = null;
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

  readonly getSnapshot = (): boolean => this.active;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Loads the local model while TTS is running; startOnLoad:false keeps the microphone closed. */
  prepare(): void {
    if (this.active || this.prepared || this.stopInFlight) return;
    const generation = ++this.generation;
    const promise = this.createVad({
      onSpeechRealStart: () => { if (this.isCurrent(generation)) this.clearWindowTimer(); },
      onSpeechEnd: (audio) => { void this.finish(audio, generation); },
      onVADMisfire: () => { if (this.isCurrent(generation)) this.armWindowTimer(generation); },
    });
    this.prepared = { generation, promise };
    void promise.catch(() => { if (this.prepared?.promise === promise) this.prepared = null; });
  }

  async open(): Promise<void> {
    if (this.stopInFlight) await this.stopInFlight;
    if (this.active) return;
    if (!this.prepared) this.prepare();
    const prepared = this.prepared;
    if (!prepared) return;
    this.prepared = null;
    const generation = prepared.generation;
    this.active = true;
    this.completionAllowed = false;
    this.unsubscribe = this.voice.onEvent((event) => this.onVoiceEvent(event));
    this.notify();
    const requestId = crypto.randomUUID();
    this.startRequestId = requestId;
    let vadClaimed = false;
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
      const vad = await prepared.promise;
      vadClaimed = true;
      if (!this.isCurrent(generation)) { await vad.destroy(); return; }
      this.vad = vad;
      await vad.start();
      if (!this.isCurrent(generation)) { await vad.destroy(); return; }
      this.windowDeadline = performance.now() + FOLLOWUP_WINDOW_MS;
      this.armWindowTimer(generation);
      this.durationTimer = this.schedule(() => { void this.stop(); }, PTT_MAX_DURATION_SECONDS * 1_000);
    } catch {
      this.pendingStart = null;
      if (!vadClaimed) await releasePrepared();
      if (this.isCurrent(generation)) void this.stop();
    }
  }

  async stop(reason: "cancel" | "complete" = "cancel"): Promise<void> {
    if (reason === "cancel") this.completionAllowed = false;
    if (this.stopInFlight) return this.stopInFlight;
    if (!this.active && !this.prepared) return;
    ++this.generation;
    const prepared = this.prepared;
    this.prepared = null;
    this.active = false;
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
      this.sessionId = null;
      this.startRequestId = null;
      this.finishRequestId = null;
      this.finishing = false;
      try { await vad?.destroy(); } catch { /* Main cancellation still runs. */ }
      if (sessionId && targetRequestId) await this.cancelSession(sessionId, targetRequestId);
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
    try { await vad?.pause(); await vad?.destroy(); } catch { await this.stop(); return; }
    if (!this.isCurrent(generation)) return;
    if (!audio.length || audio.length > PTT_MAX_DURATION_SECONDS * 16_000) { await this.stop(); return; }
    const wav = encodePcm16MonoWav(audio);
    const requestId = crypto.randomUUID();
    this.finishRequestId = requestId;
    try {
      const response = await this.voice.ptt.finish({ requestId, sessionId, audio: wav, format: "wav" });
      if (!response.ok || response.requestId !== requestId || response.sessionId !== sessionId) await this.stop();
    } catch { await this.stop(); }
    finally { wav.fill(0); audio.fill(0); }
  }

  private onVoiceEvent(envelope: VoiceEventEnvelope): void {
    if (!this.active || envelope.sessionId !== this.sessionId || envelope.requestId !== this.finishRequestId) return;
    if (envelope.event.type === "voice.transcript.final") {
      const generation = this.generation;
      const command = extractNexaFollowup(envelope.event.text);
      const transcript = command && envelope.turnId ? {
        text: command, sessionId: envelope.sessionId, requestId: envelope.requestId, turnId: envelope.turnId,
      } : null;
      this.completionAllowed = Boolean(transcript);
      void this.stop("complete").then(() => {
        if (transcript && this.completionAllowed && this.generation === generation + 1) {
          this.completionAllowed = false;
          this.dependencies.onAcceptedTranscript(transcript);
        }
      });
    } else if (envelope.event.type === "voice.error" || envelope.event.type === "voice.cancelled"
      || envelope.event.type === "voice.session.ended") {
      void this.stop();
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
    if (remaining <= 0) { void this.stop(); return; }
    this.timer = this.schedule(() => { if (this.isCurrent(generation)) void this.stop(); }, remaining);
  }

  private isCurrent(generation: number): boolean { return this.active && generation === this.generation; }
  private notify(): void { for (const listener of this.listeners) listener(); }
}
