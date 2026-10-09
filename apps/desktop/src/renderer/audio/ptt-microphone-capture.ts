import type { VoiceDesktopApi, VoiceEventEnvelope } from "../../shared/ipc-contract";
import { isVoicePttCancelResponse } from "../../shared/voice-ipc-validation";

export const PTT_SAMPLE_RATE = 16_000;
export const PTT_MAX_DURATION_SECONDS = 30;
export const PTT_MAX_AUDIO_BYTES = 1_048_576;
const WAV_HEADER_BYTES = 44;

export type PttCaptureErrorCode = "capture_in_progress" | "capture_cancelled" | "permission_denied"
  | "microphone_unavailable" | "microphone_error" | "audio_conversion_failed"
  | "audio_too_large" | "audio_too_long" | "voice_session_unavailable"
  | "main_cancel_unconfirmed" | "session_cleanup_required";

export class PttCaptureError extends Error {
  constructor(readonly code: PttCaptureErrorCode, message: string = code) {
    super(message);
    this.name = "PttCaptureError";
  }
}

export interface PttAudioBufferLike {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface PttAudioContextLike {
  readonly sampleRate: number;
  readonly destination: AudioNode;
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode;
  createScriptProcessor(bufferSize?: number, inputChannels?: number, outputChannels?: number): ScriptProcessorNode;
  createGain(): GainNode;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface PttOfflineAudioContextLike {
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  startRendering(): Promise<PttAudioBufferLike>;
  readonly destination: AudioNode;
}

export interface PttCaptureDependencies {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  createAudioContext?: () => PttAudioContextLike;
  createOfflineAudioContext?: (channels: number, length: number, sampleRate: number) => PttOfflineAudioContextLike;
  createRequestId?: () => string;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  maxDurationSeconds?: number;
}

interface CaptureState {
  generation: number;
  stream: MediaStream | null;
  context: PttAudioContextLike | null;
  sampleRate: number;
  source: MediaStreamAudioSourceNode | null;
  processor: ScriptProcessorNode | null;
  mute: GainNode | null;
  chunks: Float32Array[];
  recordedFrames: number;
  maxFrames: number;
  sessionId: string | null;
  startRequestId: string | null;
  finishRequestId: string | null;
  finishSent: boolean;
  cancelPromise: Promise<void> | null;
  unsubscribe: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  phase: "starting" | "recording" | "finishing" | "pending" | "cancelled" | "ended";
  cancelled: boolean;
  maxDurationReached: boolean;
  deviceDisconnected: boolean;
  resourcesReleased: boolean;
  releasePromise: Promise<void> | null;
}

interface PendingMainCancellation {
  readonly sessionId: string;
  readonly startRequestId: string;
  readonly finishRequestId: string | null;
  readonly preferredTargetRequestId: string;
  reconciling: boolean;
}

function browserMediaDevices(): Pick<MediaDevices, "getUserMedia"> {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new PttCaptureError("microphone_unavailable");
  return globalThis.navigator.mediaDevices;
}

function browserAudioContext(): PttAudioContextLike {
  const Constructor = globalThis.AudioContext;
  if (!Constructor) throw new PttCaptureError("audio_conversion_failed");
  return new Constructor();
}

function browserOfflineAudioContext(channels: number, length: number, sampleRate: number): PttOfflineAudioContextLike {
  const Constructor = globalThis.OfflineAudioContext;
  if (!Constructor) throw new PttCaptureError("audio_conversion_failed");
  return new Constructor(channels, length, sampleRate);
}

function defaultRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") throw new PttCaptureError("microphone_error");
  return globalThis.crypto.randomUUID();
}

function normalizeCaptureError(error: unknown): PttCaptureError {
  if (error instanceof PttCaptureError) return error;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) {
    return new PttCaptureError("permission_denied");
  }
  if (["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(name)) {
    return new PttCaptureError("microphone_unavailable");
  }
  return new PttCaptureError("microphone_error");
}

function toMono(channels: readonly Float32Array[], frameCount: number): Float32Array {
  if (!channels.length || !Number.isSafeInteger(frameCount) || frameCount < 1
    || channels.some((channel) => channel.length < frameCount)) {
    throw new PttCaptureError("audio_conversion_failed");
  }
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[frame];
    mono[frame] = sum / channels.length;
  }
  return mono;
}

export async function resamplePttAudio(
  channels: readonly Float32Array[],
  sourceSampleRate: number,
  createOfflineContext = browserOfflineAudioContext,
  maxDurationSeconds = PTT_MAX_DURATION_SECONDS,
): Promise<Float32Array> {
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate < 1 || !channels.length
    || !Number.isSafeInteger(maxDurationSeconds) || maxDurationSeconds < 1) {
    throw new PttCaptureError("audio_conversion_failed");
  }
  const frameCount = Math.min(...channels.map((channel) => channel.length));
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new PttCaptureError("audio_conversion_failed");
  if (frameCount > Math.floor(sourceSampleRate * maxDurationSeconds)) {
    throw new PttCaptureError("audio_too_long");
  }
  const boundedFrames = Math.min(frameCount, Math.floor(sourceSampleRate * maxDurationSeconds));
  const mono = toMono(channels, boundedFrames);
  const targetFrames = Math.min(
    Math.floor(PTT_SAMPLE_RATE * maxDurationSeconds),
    Math.max(1, Math.round(boundedFrames * PTT_SAMPLE_RATE / sourceSampleRate)),
  );
  try {
    const offline = createOfflineContext(1, targetFrames, PTT_SAMPLE_RATE);
    const input = offline.createBuffer(1, mono.length, sourceSampleRate);
    input.getChannelData(0).set(mono);
    const source = offline.createBufferSource();
    source.buffer = input;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0).subarray(0, targetFrames);
    if (samples.length !== targetFrames) throw new Error("resampler_output_incomplete");
    return new Float32Array(samples);
  } catch {
    throw new PttCaptureError("audio_conversion_failed");
  } finally {
    mono.fill(0);
  }
}

export function encodePcm16MonoWav(samples: Float32Array): Uint8Array {
  if (!(samples instanceof Float32Array) || samples.length < 1) throw new PttCaptureError("audio_conversion_failed");
  const dataBytes = samples.length * 2;
  const wavBytes = WAV_HEADER_BYTES + dataBytes;
  if (samples.length / PTT_SAMPLE_RATE > PTT_MAX_DURATION_SECONDS) throw new PttCaptureError("audio_too_long");
  if (wavBytes > PTT_MAX_AUDIO_BYTES) throw new PttCaptureError("audio_too_large");

  const wav = new Uint8Array(wavBytes);
  const view = new DataView(wav.buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let index = 0; index < tag.length; index += 1) wav[offset + index] = tag.charCodeAt(index);
  };
  writeTag(0, "RIFF"); view.setUint32(4, wavBytes - 8, true); writeTag(8, "WAVE");
  writeTag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, PTT_SAMPLE_RATE, true);
  view.setUint32(28, PTT_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); writeTag(36, "data"); view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(WAV_HEADER_BYTES + index * 2, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);
  }
  return wav;
}

function concatenate(chunks: readonly Float32Array[], frameCount: number): Float32Array {
  const result = new Float32Array(frameCount);
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.length, frameCount - offset);
    if (count <= 0) break;
    result.set(chunk.subarray(0, count), offset);
    offset += count;
  }
  return result;
}

export class PttMicrophoneCapture {
  private readonly voice: VoiceDesktopApi;
  private readonly mediaDevices: Pick<MediaDevices, "getUserMedia">;
  private readonly makeAudioContext: () => PttAudioContextLike;
  private readonly makeOfflineAudioContext: PttCaptureDependencies["createOfflineAudioContext"];
  private readonly createRequestId: () => string;
  private readonly schedule: typeof globalThis.setTimeout;
  private readonly unschedule: typeof globalThis.clearTimeout;
  private readonly maxDurationSeconds: number;
  private current: CaptureState | null = null;
  private pendingMainCancellation: PendingMainCancellation | null = null;
  private lastVoiceSequence = 0;
  private generation = 0;

  constructor(voice: VoiceDesktopApi, dependencies: PttCaptureDependencies = {}) {
    this.voice = voice;
    this.mediaDevices = dependencies.mediaDevices ?? browserMediaDevices();
    this.makeAudioContext = dependencies.createAudioContext ?? browserAudioContext;
    this.makeOfflineAudioContext = dependencies.createOfflineAudioContext;
    this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
    this.schedule = dependencies.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.unschedule = dependencies.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.maxDurationSeconds = dependencies.maxDurationSeconds ?? PTT_MAX_DURATION_SECONDS;
    if (!Number.isSafeInteger(this.maxDurationSeconds) || this.maxDurationSeconds < 1
      || this.maxDurationSeconds > PTT_MAX_DURATION_SECONDS) throw new RangeError("invalid_ptt_capture_duration");
  }

  async start(): Promise<{ sessionId: string; requestId: string }> {
    if (this.pendingMainCancellation) throw new PttCaptureError("session_cleanup_required");
    if (this.current) throw new PttCaptureError("capture_in_progress");
    const state = this.createState();
    this.current = state;
    try {
      // Start/resume the context while the renderer is still handling the user's gesture.
      state.context = this.makeAudioContext();
      state.sampleRate = state.context.sampleRate;
      await state.context.resume();
      if (state.cancelled) throw new PttCaptureError("capture_cancelled");
      const stream = await this.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true }, video: false,
      });
      if (state.cancelled) {
        for (const track of stream.getTracks()) track.stop();
        throw new PttCaptureError("capture_cancelled");
      }
      state.stream = stream;

      state.startRequestId = this.createRequestId();
      const response = await this.voice.ptt.start({ requestId: state.startRequestId });
      if (!response.ok) throw new PttCaptureError("voice_session_unavailable", response.error.message);
      state.sessionId = response.sessionId;
      if (!this.isCurrent(state)) {
        await this.cancelMainSession(state);
        throw new PttCaptureError("capture_cancelled");
      }

      this.subscribeToSession(state);
      await this.openAudioGraph(state);
      if (!this.isCurrent(state)) throw new PttCaptureError("capture_cancelled");
      state.phase = "recording";
      state.timer = this.schedule(() => {
        state.maxDurationReached = true;
        void this.stopCaptureGraph(state);
      }, this.maxDurationSeconds * 1000);
      return { sessionId: state.sessionId, requestId: state.startRequestId! };
    } catch (error) {
      await this.releaseResources(state);
      if (state.sessionId && !state.cancelled) {
        try { await this.cancelMainSession(state); }
        catch (cancelError) {
          if (this.current === state) this.current = null;
          throw cancelError;
        }
      }
      if (this.current === state) this.current = null;
      if (error instanceof PttCaptureError && error.code === "main_cancel_unconfirmed") throw error;
      if (state.cancelled) throw new PttCaptureError("capture_cancelled");
      throw normalizeCaptureError(error);
    }
  }

  async finish(language?: string): Promise<Awaited<ReturnType<VoiceDesktopApi["ptt"]["finish"]>>> {
    const state = this.current;
    if (!state || state.phase !== "recording" || state.cancelled) throw new PttCaptureError("voice_session_unavailable");
    state.phase = "finishing";
    if (state.timer) this.unschedule(state.timer);
    state.timer = null;
    await this.stopCaptureGraph(state);
    await this.releaseResources(state);
    if (state.deviceDisconnected) {
      await this.abortLocalSession(state);
      throw new PttCaptureError("microphone_unavailable");
    }
    if (state.cancelled || !this.isCurrent(state)) throw new PttCaptureError("capture_cancelled");

    const sourceSamples = concatenate(state.chunks, state.recordedFrames);
    state.chunks.forEach((chunk) => chunk.fill(0));
    state.chunks = [];
    if (!sourceSamples.length) {
      sourceSamples.fill(0);
      await this.abortLocalSession(state);
      throw new PttCaptureError("microphone_error", "microphone_capture_empty");
    }

    let wav: Uint8Array;
    try {
      const samples = await resamplePttAudio(
        [sourceSamples], state.sampleRate, this.makeOfflineAudioContext, this.maxDurationSeconds,
      );
      wav = encodePcm16MonoWav(samples);
      samples.fill(0);
    } catch (error) {
      sourceSamples.fill(0);
      await this.abortLocalSession(state);
      throw error instanceof PttCaptureError ? error : new PttCaptureError("audio_conversion_failed");
    }
    if (state.cancelled || !this.isCurrent(state) || !state.sessionId || !state.startRequestId) {
      wav.fill(0);
      sourceSamples.fill(0);
      throw new PttCaptureError("capture_cancelled");
    }

    state.finishRequestId = this.createRequestId();
    state.finishSent = true;
    let response: Awaited<ReturnType<VoiceDesktopApi["ptt"]["finish"]>>;
    try {
      response = await this.voice.ptt.finish({
        requestId: state.finishRequestId, sessionId: state.sessionId, audio: wav, format: "wav",
        ...(language === undefined ? {} : { language }),
      });
    } catch (error) {
      await this.abortLocalSession(state);
      throw error;
    } finally {
      wav.fill(0);
      sourceSamples.fill(0);
    }
    if (!response.ok) {
      await this.abortLocalSession(state);
      throw new PttCaptureError("voice_session_unavailable", response.error.message);
    }
    if (this.isCurrent(state)) state.phase = "pending";
    return response;
  }

  async cancel(): Promise<void> {
    const state = this.current;
    if (!state || state.cancelled || state.phase === "ended") return;
    state.cancelled = true;
    state.phase = "cancelled";
    if (state.timer) this.unschedule(state.timer);
    state.timer = null;
    await this.releaseResources(state);
    state.chunks.forEach((chunk) => chunk.fill(0));
    state.chunks = [];
    let cancelError: unknown;
    try {
      if (state.sessionId) await this.cancelMainSession(state);
    } catch (error) {
      cancelError = error;
    } finally {
      state.unsubscribe?.();
      state.unsubscribe = null;
      // Keep a start operation in-flight until its late Main response is reconciled.
      if (this.current === state && state.sessionId) this.current = null;
    }
    if (cancelError) throw cancelError;
  }

  get mainCancellationPending(): boolean {
    return this.pendingMainCancellation !== null;
  }

  /** Explicitly reconciles the pinned old session; it never retries in the background. */
  async recoverMainCancellation(target: "preferred" | "start" | "finish" = "preferred"): Promise<void> {
    const pending = this.pendingMainCancellation;
    if (!pending) return;
    if (pending.reconciling) throw new PttCaptureError("capture_in_progress");
    const targetRequestId = target === "start" ? pending.startRequestId
      : target === "finish" ? pending.finishRequestId : pending.preferredTargetRequestId;
    if (!targetRequestId) throw new PttCaptureError("main_cancel_unconfirmed", "No finish request is available to reconcile.");

    pending.reconciling = true;
    try {
      await this.sendMainCancellation(pending, targetRequestId);
      if (this.pendingMainCancellation === pending) this.pendingMainCancellation = null;
    } finally {
      pending.reconciling = false;
    }
  }

  private createState(): CaptureState {
    return {
      generation: ++this.generation, stream: null, context: null, sampleRate: 0,
      source: null, processor: null, mute: null, chunks: [], recordedFrames: 0, maxFrames: 0,
      sessionId: null, startRequestId: null, finishRequestId: null, finishSent: false,
      cancelPromise: null, unsubscribe: null, timer: null,
      phase: "starting", cancelled: false, maxDurationReached: false, deviceDisconnected: false,
      resourcesReleased: false, releasePromise: null,
    };
  }

  private isCurrent(state: CaptureState): boolean {
    return this.current === state && this.current.generation === state.generation && !state.cancelled;
  }

  private async openAudioGraph(state: CaptureState): Promise<void> {
    if (!state.stream || !state.context) throw new PttCaptureError("microphone_unavailable");
    const context = state.context;
    state.maxFrames = Math.floor(context.sampleRate * this.maxDurationSeconds);
    const source = context.createMediaStreamSource(state.stream);
    const processor = context.createScriptProcessor(4096, 2, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    state.source = source;
    state.processor = processor;
    state.mute = mute;
    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.isCurrent(state) || (state.phase !== "starting" && state.phase !== "recording")) return;
      const input = event.inputBuffer;
      const frames = Math.min(input.length, state.maxFrames - state.recordedFrames);
      if (frames <= 0) {
        state.maxDurationReached = true;
        void this.stopCaptureGraph(state);
        return;
      }
      const channels = Array.from({ length: input.numberOfChannels }, (_, index) => input.getChannelData(index));
      const mono = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (const channel of channels) sum += channel[frame];
        mono[frame] = sum / Math.max(1, channels.length);
      }
      state.chunks.push(mono);
      state.recordedFrames += frames;
      if (state.recordedFrames >= state.maxFrames) {
        state.maxDurationReached = true;
        void this.stopCaptureGraph(state);
      }
    };
    for (const track of state.stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (!state.resourcesReleased && !state.cancelled && !state.maxDurationReached) {
          state.deviceDisconnected = true;
          void this.releaseResources(state);
        }
      }, { once: true });
    }
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
  }

  private stopCaptureGraph(state: CaptureState): Promise<void> {
    if (state.timer) this.unschedule(state.timer);
    state.timer = null;
    if (state.processor) state.processor.onaudioprocess = null;
    try { state.source?.disconnect(); } catch { /* Already disconnected. */ }
    try { state.processor?.disconnect(); } catch { /* Already disconnected. */ }
    try { state.mute?.disconnect(); } catch { /* Already disconnected. */ }
    return this.releaseResources(state);
  }

  private releaseResources(state: CaptureState): Promise<void> {
    if (state.releasePromise) return state.releasePromise;
    state.resourcesReleased = true;
    state.releasePromise = (async () => {
      if (state.timer) this.unschedule(state.timer);
      state.timer = null;
      if (state.processor) state.processor.onaudioprocess = null;
      try { state.source?.disconnect(); } catch { /* Already disconnected. */ }
      try { state.processor?.disconnect(); } catch { /* Already disconnected. */ }
      try { state.mute?.disconnect(); } catch { /* Already disconnected. */ }
      for (const track of state.stream?.getTracks() ?? []) {
        try { track.stop(); } catch { /* Device was already stopped. */ }
      }
      try { await state.context?.close(); } catch { /* AudioContext was already closed. */ }
      state.stream = null;
      state.context = null;
      state.source = null;
      state.processor = null;
      state.mute = null;
    })();
    return state.releasePromise;
  }

  private subscribeToSession(state: CaptureState): void {
    state.unsubscribe = this.voice.onEvent((envelope: VoiceEventEnvelope) => {
      if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence <= this.lastVoiceSequence
        || envelope.event.sessionId !== envelope.sessionId) return;
      this.lastVoiceSequence = envelope.sequence;
      const expectedRequestId = state.finishRequestId ?? state.startRequestId;
      if (envelope.sessionId !== state.sessionId || envelope.event.type !== "voice.session.ended"
        || !expectedRequestId || envelope.requestId !== expectedRequestId) return;
      state.phase = "ended";
      state.chunks.forEach((chunk) => chunk.fill(0));
      state.chunks = [];
      state.unsubscribe?.();
      state.unsubscribe = null;
      if (this.current === state) this.current = null;
    });
  }

  private cancelMainSession(state: CaptureState): Promise<void> {
    if (state.cancelPromise) return state.cancelPromise;
    if (!state.sessionId || !state.startRequestId) return Promise.resolve();
    const targetRequestId = state.finishSent && state.finishRequestId ? state.finishRequestId : state.startRequestId;
    const pending: PendingMainCancellation = {
      sessionId: state.sessionId, startRequestId: state.startRequestId,
      finishRequestId: state.finishRequestId, preferredTargetRequestId: targetRequestId, reconciling: false,
    };
    this.pendingMainCancellation = pending;
    state.cancelPromise = this.sendMainCancellation(pending, targetRequestId).then(() => {
      if (this.pendingMainCancellation === pending) this.pendingMainCancellation = null;
    });
    return state.cancelPromise;
  }

  private async sendMainCancellation(pending: PendingMainCancellation, targetRequestId: string): Promise<void> {
    const requestId = this.createRequestId();
    let response: Awaited<ReturnType<VoiceDesktopApi["ptt"]["cancel"]>>;
    try {
      response = await this.voice.ptt.cancel({ requestId, sessionId: pending.sessionId, targetRequestId });
    } catch {
      throw new PttCaptureError("main_cancel_unconfirmed", "Main cancellation response was not received.");
    }

    if (!isVoicePttCancelResponse(response) || response.requestId !== requestId) {
      throw new PttCaptureError("main_cancel_unconfirmed", "Main cancellation response could not be correlated.");
    }
    if (response.ok) {
      if (response.sessionId !== pending.sessionId || response.targetRequestId !== targetRequestId) {
        throw new PttCaptureError("main_cancel_unconfirmed", "Main cancellation response did not match the session.");
      }
      return;
    }
    // Main returns this only after checking the exact sessionId supplied with this request.
    if (response.error.code === "session_unavailable") return;
    throw new PttCaptureError("main_cancel_unconfirmed", response.error.message);
  }

  private async abortLocalSession(state: CaptureState): Promise<void> {
    state.cancelled = true;
    state.phase = "cancelled";
    await this.releaseResources(state);
    state.chunks.forEach((chunk) => chunk.fill(0));
    state.chunks = [];
    let cancelError: unknown;
    try {
      if (state.sessionId) await this.cancelMainSession(state);
    } catch (error) {
      cancelError = error;
    } finally {
      state.unsubscribe?.();
      state.unsubscribe = null;
      if (this.current === state) this.current = null;
    }
    if (cancelError) throw cancelError;
  }
}
