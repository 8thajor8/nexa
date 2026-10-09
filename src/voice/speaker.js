import { randomUUID } from 'node:crypto';
import { VoiceError } from './errors.js';

const validCancelReasons = new Set(['user', 'superseded', 'session_ended']);
const validOptions = new Set(['style', 'persist']);
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
    return import('../speech/service.js').then(({ generateSpeech, playAudio, removeTemporarySpeech }) => ({ generate: generateSpeech, play: playAudio, removeTemporary: removeTemporarySpeech }));
}

export function createVoiceSpeaker({ speechService, sessionId = randomUUID(), idFactory = randomUUID, now = Date.now, playbackTimeoutMs = defaultPlaybackTimeoutMs } = {}) {
    if (speechService !== undefined && (typeof speechService?.generate !== 'function' || typeof speechService?.play !== 'function'
        || typeof speechService?.removeTemporary !== 'function')) throw new VoiceError('voice_speech_service_invalid');
    if (typeof sessionId !== 'string' || !sessionId || typeof idFactory !== 'function' || typeof now !== 'function'
        || !Number.isSafeInteger(playbackTimeoutMs) || playbackTimeoutMs < 1) throw new VoiceError('voice_session_invalid_state');

    let selectedService = speechService;
    let servicePromise;
    let active = null;
    let synthesisInFlight = false;
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

    const listeners = new Map(['voice.speaking', 'voice.speech.completed', 'voice.speech.cancelled', 'voice.speech.error'].map(type => [type, new Set()]));
    function emit(type, operation, details = {}) {
        const event = Object.freeze({ type, sessionId, turnId: operation?.turnId ?? null, timestamp: now(), ...details });
        for (const listener of [...listeners.get(type)]) { try { listener(event); } catch { /* Listener failures do not affect playback. */ } }
    }
    function on(type, listener) {
        const bucket = listeners.get(type);
        if (!bucket || typeof listener !== 'function') throw new TypeError('voice_listener_invalid');
        bucket.add(listener);
        return () => bucket.delete(listener);
    }
    function makeOperation(text, options) {
        let resolveCancellation;
        const cancellation = new Promise(resolve => { resolveCancellation = resolve; });
        return { turnId: idFactory(), text, options, phase: 'synthesizing', cancelled: false, cancellation, resolveCancellation };
    }
    function failFast(operation, code) {
        const error = new VoiceError(code);
        emit('voice.speech.error', operation, { phase: 'queued', error: Object.freeze({ code: error.code, message: error.message }) });
        return Promise.reject(error);
    }
    function cancel(reason = 'user') {
        if (!validCancelReasons.has(reason)) throw new TypeError('voice_cancel_reason_invalid');
        if (!active) return false;
        const operation = active;
        active = null;
        operation.cancelled = true;
        operation.resolveCancellation(null);
        emit('voice.speech.cancelled', operation, { reason, phase: operation.phase, playbackInterrupted: false });
        return true;
    }

    async function run(operation) {
        let service;
        let generated;
        try {
            service = await resolveService();
            if (active !== operation) return null;
            synthesisInFlight = true;
            try { generated = await service.generate({ text: operation.text, ...operation.options }); }
            finally { synthesisInFlight = false; }
            if (active !== operation) {
                if (generated?.success && typeof generated.audioId === 'string' && !operation.options.persist) {
                    cleanupInFlight = true;
                    try { await service.removeTemporary(generated.audioId); }
                    catch { /* Speech startup/shutdown expiry cleanup is the fallback. */ }
                    finally { cleanupInFlight = false; }
                }
                return null;
            }
            if (!generated?.success || typeof generated.audioId !== 'string') throw new VoiceError('voice_speech_generation_failed');

            operation.phase = 'speaking';
            playbackState = 'playing';
            emit('voice.speaking', operation);
            const observedPlay = Promise.resolve().then(() => service.play(generated.audioId)).then(
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
            playbackState = 'idle';
            if (active !== operation) return null;
            if (outcome.kind === 'error' || !outcome.value?.success) throw new VoiceError('voice_speech_playback_failed');
            active = null;
            emit('voice.speech.completed', operation);
            return Object.freeze({ sessionId, turnId: operation.turnId, completed: true });
        } catch (error) {
            if (active !== operation) return null;
            active = null;
            const safeError = error instanceof VoiceError ? error : new VoiceError(operation.phase === 'speaking' ? 'voice_speech_playback_failed' : 'voice_speech_generation_failed');
            emit('voice.speech.error', operation, { phase: operation.phase, error: Object.freeze({ code: safeError.code, message: safeError.message }) });
            throw safeError;
        }
    }

    function speak(text, options = {}) {
        if (typeof text !== 'string' || !text.trim()) throw new VoiceError('voice_speech_invalid_input');
        const normalizedOptions = normalizeOptions(options);
        const operation = makeOperation(text, normalizedOptions);
        if (playbackState === 'degraded') return failFast(operation, 'voice_speech_degraded');
        if (active || synthesisInFlight || cleanupInFlight || playbackState === 'playing') return failFast(operation, 'voice_speech_busy');
        active = operation;
        const work = run(operation);
        return Promise.race([work, operation.cancellation]);
    }

    return Object.freeze({ sessionId, on, speak, cancel, getPlaybackState: () => playbackState });
}
