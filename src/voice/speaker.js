import { randomUUID } from 'node:crypto';
import { VoiceError } from './errors.js';

const validCancelReasons = new Set(['user', 'superseded', 'session_ended']);
const validOptions = new Set(['style', 'persist']);

function normalizeOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
        throw new VoiceError('voice_speech_invalid_input');
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !validOptions.has(key)
        || !Object.hasOwn(descriptors[key], 'value'))) throw new VoiceError('voice_speech_invalid_input');
    const values = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
    if (values.style !== undefined && typeof values.style !== 'string') throw new VoiceError('voice_speech_invalid_input');
    if (values.persist !== undefined && typeof values.persist !== 'boolean') throw new VoiceError('voice_speech_invalid_input');
    return { style: values.style ?? 'normal', persist: values.persist ?? false };
}

function defaultServiceLoader() {
    return import('../speech/service.js').then(({ generateSpeech, playAudio }) => ({ generate: generateSpeech, play: playAudio }));
}

export function createVoiceSpeaker({ speechService, sessionId = randomUUID(), idFactory = randomUUID, now = Date.now } = {}) {
    if (speechService !== undefined && (typeof speechService?.generate !== 'function' || typeof speechService?.play !== 'function')) {
        throw new VoiceError('voice_speech_service_invalid');
    }
    if (typeof sessionId !== 'string' || !sessionId || typeof idFactory !== 'function' || typeof now !== 'function') {
        throw new VoiceError('voice_session_invalid_state');
    }

    let selectedService = speechService;
    let servicePromise;
    let active = null;
    let speechQueue = Promise.resolve();

    function resolveService() {
        if (selectedService) return Promise.resolve(selectedService);
        if (!servicePromise) {
            servicePromise = defaultServiceLoader().then(service => {
                if (typeof service?.generate !== 'function' || typeof service?.play !== 'function') {
                    throw new VoiceError('voice_speech_service_invalid');
                }
                selectedService = service;
                return service;
            }).catch(error => {
                servicePromise = undefined;
                if (error instanceof VoiceError) throw error;
                throw new VoiceError('voice_speech_service_invalid');
            });
        }
        return servicePromise;
    }

    const listeners = new Map([
        'voice.speaking', 'voice.speech.completed', 'voice.speech.cancelled', 'voice.speech.error',
    ].map(type => [type, new Set()]));

    function emit(type, operation, details = {}) {
        const event = Object.freeze({ type, sessionId, turnId: operation?.turnId ?? null, timestamp: now(), ...details });
        for (const listener of [...listeners.get(type)]) {
            try { listener(event); }
            catch { /* Consumer callbacks cannot break speech output. */ }
        }
    }

    function on(type, listener) {
        const bucket = listeners.get(type);
        if (!bucket || typeof listener !== 'function') throw new TypeError('voice_listener_invalid');
        bucket.add(listener);
        return () => bucket.delete(listener);
    }

    /**
     * Cancellation suppresses future Voice events and steps. SpeechService has
     * no cancellation API: an in-flight MCI playback continues until it ends,
     * and audio generated after a synthesis cancellation remains subject to the
     * existing temporary-audio cleanup lifecycle.
     */
    function cancel(reason = 'user') {
        if (!validCancelReasons.has(reason)) throw new TypeError('voice_cancel_reason_invalid');
        if (!active) return false;
        const operation = active;
        active = null;
        operation.cancelled = true;
        operation.resolveCancellation(null);
        emit('voice.speech.cancelled', operation, {
            reason,
            phase: operation.phase,
            playbackInterrupted: false,
        });
        return true;
    }

    async function run(operation) {
        if (active !== operation) return null;
        let service;
        try {
            service = await resolveService();
            if (active !== operation) return null;

            operation.phase = 'synthesizing';
            const generated = await service.generate({ text: operation.text, ...operation.options });
            if (active !== operation) return null;
            if (!generated?.success || typeof generated.audioId !== 'string') {
                throw new VoiceError('voice_speech_generation_failed');
            }

            operation.phase = 'speaking';
            emit('voice.speaking', operation);
            if (active !== operation) return null;
            const played = await service.play(generated.audioId);
            if (active !== operation) return null;
            if (!played?.success) throw new VoiceError('voice_speech_playback_failed');

            active = null;
            const result = Object.freeze({ sessionId, turnId: operation.turnId, completed: true });
            emit('voice.speech.completed', operation);
            return result;
        } catch (error) {
            if (active !== operation) return null;
            active = null;
            const safeError = error instanceof VoiceError
                ? error
                : new VoiceError(operation.phase === 'speaking' ? 'voice_speech_playback_failed' : 'voice_speech_generation_failed');
            emit('voice.speech.error', operation, {
                phase: operation.phase,
                error: Object.freeze({ code: safeError.code, message: safeError.message }),
            });
            throw safeError;
        }
    }

    function speak(text, options = {}) {
        if (typeof text !== 'string' || !text.trim()) throw new VoiceError('voice_speech_invalid_input');
        const normalizedOptions = normalizeOptions(options);
        if (active) cancel('superseded');

        let resolveCancellation;
        const operation = {
            turnId: idFactory(),
            text,
            options: normalizedOptions,
            phase: 'queued',
            cancelled: false,
            cancellation: new Promise(resolve => { resolveCancellation = resolve; }),
            resolveCancellation: value => resolveCancellation(value),
        };
        active = operation;

        const work = speechQueue.then(() => run(operation));
        speechQueue = work.then(() => undefined, () => undefined);
        return Promise.race([work, operation.cancellation]);
    }

    return Object.freeze({ sessionId, on, speak, cancel });
}
