import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { VoiceError } from './errors.js';

const validCancelReasons = new Set(['user', 'superseded', 'session_ended']);
const validOptions = new Set(['style', 'persist']);
const safeSpeechStages = new Set(['audio_preparation', 'synthesis', 'identity_processing']);

function safeSpeechMetrics(value) {
    if (!value || typeof value !== 'object') return null;
    const duration = key => Number.isFinite(value[key]) && value[key] >= 0 ? Math.round(value[key]) : null;
    return Object.freeze({
        model: value.model === 'gpt-4o-mini-tts' ? value.model : null,
        voice: value.voice === 'nova' ? value.voice : null,
        identityProfile: value.identityProfile === 'nova-portena' ? value.identityProfile : null,
        identityProcessing: typeof value.identityProcessing === 'boolean' ? value.identityProcessing : null,
        failureStage: safeSpeechStages.has(value.failureStage) ? value.failureStage : null,
        storageInitializationMs: duration('storageInitializationMs'), synthesisMs: duration('synthesisMs'),
        ttsSdkResponseMs: duration('ttsSdkResponseMs'), ttsBodyReadMs: duration('ttsBodyReadMs'),
        identityProcessingMs: duration('identityProcessingMs'), identityServerStartupMs: duration('identityServerStartupMs'),
        identityBrowserStartupMs: duration('identityBrowserStartupMs'), identityRendererPreparationMs: duration('identityRendererPreparationMs'),
        identityDspSetupMs: duration('identityDspSetupMs'), identityDspProcessingMs: duration('identityDspProcessingMs'),
        identityAudioCaptureWaitMs: duration('identityAudioCaptureWaitMs'), identityPostProcessingMs: duration('identityPostProcessingMs'),
        audioSaveMs: duration('audioSaveMs'), audioReadyMs: duration('audioReadyMs'),
    });
}
export const defaultPlaybackTimeoutMs = 300_000;

function normalizeOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) throw new VoiceError('voice_speech_invalid_input');
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !validOptions.has(key) || !Object.hasOwn(descriptors[key], 'value'))) throw new VoiceError('voice_speech_invalid_input');
    const values = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
    if (values.style !== undefined && typeof values.style !== 'string') throw new VoiceError('voice_speech_invalid_input');
    if (values.persist !== undefined && typeof values.persist !== 'boolean') throw new VoiceError('voice_speech_invalid_input');
    return { style: values.style ?? 'normal', persist: values.persist ?? false };
}

function defaultServiceLoader() {
    const serviceUrl = new URL('../speech/service.js', import.meta.url);
        return import(serviceUrl.href).then(({ generateSpeech, playAudio, stopSpeechPlayback, getSpeechPlaybackStatus, removeTemporarySpeech, getSpeechMetrics }) => ({
            generate: generateSpeech, play: playAudio, stopPlayback: stopSpeechPlayback, getPlaybackStatus: getSpeechPlaybackStatus, removeTemporary: removeTemporarySpeech,
            getLastMetrics: getSpeechMetrics,
    }));
}

export function createVoiceSpeaker({ speechService, sessionId = randomUUID(), idFactory = randomUUID, now = Date.now, playbackTimeoutMs = defaultPlaybackTimeoutMs } = {}) {
    if (speechService !== undefined && (typeof speechService?.generate !== 'function' || typeof speechService?.play !== 'function'
        || typeof speechService?.removeTemporary !== 'function')) throw new VoiceError('voice_speech_service_invalid');
    if (typeof sessionId !== 'string' || !sessionId || typeof idFactory !== 'function' || typeof now !== 'function'
        || !Number.isSafeInteger(playbackTimeoutMs) || playbackTimeoutMs < 1) throw new VoiceError('voice_session_invalid_state');

    let selectedService = speechService;
    let servicePromise;
    let active = null;
    let synthesisTail = Promise.resolve();
    let cleanupInFlight = false;
    let playbackState = 'idle';

    function resolveService() {
        if (selectedService) return Promise.resolve(selectedService);
        if (!servicePromise) servicePromise = defaultServiceLoader().then(service => {
            if (typeof service?.generate !== 'function' || typeof service?.play !== 'function' || typeof service?.removeTemporary !== 'function') throw new VoiceError('voice_speech_service_invalid');
            selectedService = service;
            return service;
        }).catch(error => {
            servicePromise = undefined;
            if (error instanceof VoiceError) throw error;
            throw new VoiceError('voice_speech_service_invalid');
        });
        return servicePromise;
    }

    const listeners = new Map(['voice.speaking', 'voice.playback.started', 'voice.speech.completed', 'voice.speech.cancelled', 'voice.speech.error'].map(type => [type, new Set()]));
    function emit(type, operation, details = {}) {
        const event = Object.freeze({ type, sessionId, turnId: operation?.turnId ?? null,
            playbackId: operation?.playbackId ?? null, timestamp: now(), ...details });
        for (const listener of [...listeners.get(type)]) { try { listener(event); } catch { /* Listener failures do not affect playback. */ } }
    }
    function on(type, listener) {
        const bucket = listeners.get(type);
        if (!bucket || typeof listener !== 'function') throw new TypeError('voice_listener_invalid');
        bucket.add(listener);
        return () => bucket.delete(listener);
    }
    function makeOperation(text, options, preparedAudio = null) {
        let resolveCancellation;
        const cancellation = new Promise(resolve => { resolveCancellation = resolve; });
        const controller = new AbortController();
        return { turnId: idFactory(), text, options, preparedAudio, phase: 'synthesizing', startedAt: performance.now(), phaseStartedAt: performance.now(),
            cancelled: false, cancellation, resolveCancellation, controller };
    }
    function discardGenerated(operation) {
        if (operation.options.persist || !operation.generatedAudioId || typeof operation.service?.removeTemporary !== 'function') return Promise.resolve(false);
        if (!operation.cleanupPromise) {
            cleanupInFlight = true;
            operation.cleanupPromise = Promise.resolve().then(() => operation.service.removeTemporary(operation.generatedAudioId))
                .catch(() => false).finally(() => { cleanupInFlight = false; });
        }
        return operation.cleanupPromise;
    }
    function failFast(operation, code) {
        const error = new VoiceError(code);
        emit('voice.speech.error', operation, { phase: 'queued', error: Object.freeze({ code: error.code, message: error.message }) });
        return Promise.reject(error);
    }
    function enqueueSynthesis(operation, service) {
        const previous = synthesisTail;
        let release;
        synthesisTail = new Promise(resolve => { release = resolve; });
        return previous.then(async () => {
            try {
                if (active !== operation) return null;
                return await service.generate({ text: operation.text, ...operation.options, signal: operation.controller.signal });
            } finally {
                release();
            }
        });
    }
    function cancel(reason = 'user') {
        if (!validCancelReasons.has(reason)) throw new TypeError('voice_cancel_reason_invalid');
        if (!active) return false;
        const operation = active;
        operation.cancelled = true;
        operation.cancelReason = reason;
        operation.controller.abort();
        operation.resolveCancellation(null);
        if (operation.phase !== 'speaking') {
            active = null;
            emit('voice.speech.cancelled', operation, { reason, phase: operation.phase, playbackInterrupted: false, interruptionStatus: 'not_playing' });
            operation.cancelEventEmitted = true;
            return true;
        }
        if (!operation.playStarted) {
            active = null;
            playbackState = 'idle';
            void discardGenerated(operation);
            emit('voice.speech.cancelled', operation, { reason, phase: operation.phase, playbackInterrupted: false, interruptionStatus: 'not_started' });
            operation.cancelEventEmitted = true;
            return true;
        }
        if (typeof operation.service?.stopPlayback !== 'function') {
            active = null;
            emit('voice.speech.cancelled', operation, { reason, phase: operation.phase, playbackInterrupted: false, interruptionStatus: 'unavailable' });
            operation.cancelEventEmitted = true;
            return true;
        }
        operation.stopPromise = Promise.resolve().then(() => operation.service.stopPlayback(operation.playbackId)).then(result => {
            const interrupted = result?.status === 'stopped' && result?.interrupted === true
                && result?.confirmed === true && result?.released === true;
            if (result?.released === true) playbackState = 'idle';
            else playbackState = 'degraded';
            if (active === operation) active = null;
            if (!operation.cancelEventEmitted) {
                const nativeCode = result?.error?.code;
                const interruptionErrorCode = nativeCode === 'audio_stop_timeout' || nativeCode === 'audio_status_timeout'
                    ? 'voice_speech_stop_timeout' : 'voice_speech_stop_failed';
                emit('voice.speech.cancelled', operation, { reason, phase: operation.phase, playbackInterrupted: interrupted,
                    interruptionStatus: interrupted ? 'confirmed' : result?.status === 'already_finished' ? 'already_finished' : 'unconfirmed',
                    ...(!interrupted && result?.status !== 'already_finished'
                        ? { interruptionError: Object.freeze({ code: interruptionErrorCode, backendCode: String(nativeCode ?? 'audio_stop_unconfirmed') }) }
                        : {}) });
                operation.cancelEventEmitted = true;
            }
            return result;
        }).catch(() => {
            playbackState = 'degraded';
            if (active === operation) active = null;
            if (!operation.cancelEventEmitted) {
                emit('voice.speech.cancelled', operation, { reason, phase: operation.phase, playbackInterrupted: false, interruptionStatus: 'unconfirmed',
                    interruptionError: Object.freeze({ code: 'voice_speech_stop_failed' }) });
                operation.cancelEventEmitted = true;
            }
            return null;
        });
        return true;
    }

    async function run(operation) {
        let service;
        let generated;
        try {
            service = await resolveService();
            if (active !== operation) return null;
            generated = operation.preparedAudio
                ? await service.prepareAudio(operation.preparedAudio)
                : await enqueueSynthesis(operation, service);
            if (active !== operation) {
                operation.service = service;
                operation.generatedAudioId = generated?.audioId;
                if (generated?.success) await discardGenerated(operation);
                return null;
            }
            operation.speechMetrics = typeof service.getLastMetrics === 'function' ? safeSpeechMetrics(service.getLastMetrics()) : null;
            if (!generated?.success || typeof generated.audioId !== 'string') {
                const underlying = generated?.error?.code;
                const mapped = ({ audio_storage_unavailable: 'voice_audio_storage_unavailable',
                    speech_generation_failed: 'voice_tts_generation_failed', speech_generation_timeout: 'voice_tts_generation_timeout',
                    invalid_provider_audio: 'voice_tts_response_invalid',
                    audio_processing_failed: 'voice_audio_processing_failed', voice_identity_browser_unavailable: 'voice_identity_browser_unavailable',
                    audio_storage_failed: 'voice_audio_storage_failed' })[underlying];
                operation.errorStage = operation.speechMetrics?.failureStage ?? 'synthesis';
                throw new VoiceError(mapped ?? 'voice_speech_generation_failed');
            }

            operation.phase = 'speaking';
            operation.phaseStartedAt = performance.now();
            operation.service = service;
            operation.generatedAudioId = generated.audioId;
            operation.playbackId = randomUUID();
            playbackState = 'playing';
            emit('voice.speaking', operation, { diagnostics: Object.freeze({ stage: 'playback', state: 'started', metrics: operation.speechMetrics }) });
            const observedPlay = Promise.resolve().then(() => {
                if (operation.cancelled || active !== operation) return { success: false, status: 'stopped', released: true };
                operation.playStarted = true;
                return service.play(generated.audioId, { playbackId: operation.playbackId, onStarted: () => {
                    if (active === operation && !operation.cancelled) emit('voice.playback.started', operation, { diagnostics: Object.freeze({
                        stage: 'playback', state: 'started', durationMs: Math.round(performance.now() - operation.phaseStartedAt),
                        metrics: operation.speechMetrics }) });
                } });
            }).then(
                value => ({ kind: 'result', value }),
                () => ({ kind: 'error' }),
            );
            let timer;
            const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), playbackTimeoutMs); });
            const outcome = await Promise.race([observedPlay, timeout]);
            clearTimeout(timer);
            if (outcome.kind === 'timeout') {
                playbackState = 'degraded';
                throw new VoiceError('voice_speech_playback_timeout');
            }
            playbackState = outcome.kind === 'error' || outcome.value?.released === false ? 'degraded' : 'idle';
            if (operation.cancelled) {
                if (!operation.stopPromise) {
                    if (active === operation) active = null;
                    if (!operation.cancelEventEmitted) {
                        emit('voice.speech.cancelled', operation, { reason: operation.cancelReason ?? 'user', phase: operation.phase, playbackInterrupted: false, interruptionStatus: 'already_finished' });
                        operation.cancelEventEmitted = true;
                    }
                }
                return null;
            }
            if (active !== operation) return null;
            if (outcome.kind === 'error' || !outcome.value?.success) {
                const backendCode = outcome.value?.error?.code;
                const code = backendCode === 'audio_start_timeout' ? 'voice_speech_start_timeout'
                    : backendCode === 'audio_completion_timeout' || backendCode === 'audio_status_timeout' ? 'voice_speech_playback_timeout'
                        : backendCode === 'audio_player_degraded' ? 'voice_speech_degraded'
                            : backendCode === 'audio_player_busy' ? 'voice_speech_busy' : 'voice_speech_playback_failed';
                throw new VoiceError(code);
            }
            active = null;
            emit('voice.speech.completed', operation, { diagnostics: Object.freeze({ stage: 'playback', state: 'success',
                durationMs: Math.round(performance.now() - operation.phaseStartedAt), metrics: operation.speechMetrics }) });
            return Object.freeze({ sessionId, turnId: operation.turnId, completed: true });
        } catch (error) {
            if (active !== operation || operation.cancelled) return null;
            active = null;
            const safeError = error instanceof VoiceError ? error : new VoiceError(operation.phase === 'speaking' ? 'voice_speech_playback_failed' : 'voice_speech_generation_failed');
            emit('voice.speech.error', operation, { phase: operation.phase, error: Object.freeze({ code: safeError.code, message: safeError.message }),
                diagnostics: Object.freeze({ stage: operation.errorStage ?? (operation.phase === 'speaking' ? 'playback' : 'synthesis'),
                    state: 'error', durationMs: Math.round(performance.now() - operation.phaseStartedAt), metrics: operation.speechMetrics }) });
            throw safeError;
        }
    }

    function start(operation) {
        if (playbackState === 'degraded') return failFast(operation, 'voice_speech_degraded');
        if (active || cleanupInFlight || playbackState === 'playing') return failFast(operation, 'voice_speech_busy');
        active = operation;
        const work = run(operation);
        return Promise.race([work, operation.cancellation]);
    }

    function speak(text, options = {}) {
        if (typeof text !== 'string' || !text.trim()) throw new VoiceError('voice_speech_invalid_input');
        return start(makeOperation(text, normalizeOptions(options)));
    }

    function speakPrepared(audio, options = {}) {
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0) throw new VoiceError('voice_speech_invalid_input');
        return start(makeOperation('', normalizeOptions(options), Buffer.from(audio)));
    }

    return Object.freeze({ sessionId, on, speak, speakPrepared, cancel, getPlaybackState: () => playbackState });
}
