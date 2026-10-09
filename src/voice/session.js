import { randomUUID } from 'node:crypto';
import { VoiceError, toVoiceError } from './errors.js';

export const VOICE_EVENTS = Object.freeze([
    'voice.session.started',
    'voice.transcribing',
    'voice.transcript.final',
    'voice.cancelled',
    'voice.error',
    'voice.session.ended',
    'voice.speaking',
    'voice.speech.completed',
    'voice.speech.cancelled',
    'voice.speech.error',
]);

const validEvents = new Set(VOICE_EVENTS);
const validCancelReasons = new Set(['user', 'superseded', 'session_ended', 'timeout']);

export function createVoiceSession({ recognizer, sessionId = randomUUID(), idFactory = randomUUID, now = Date.now } = {}) {
    if (typeof recognizer?.transcribe !== 'function') throw new VoiceError('voice_provider_invalid');
    if (typeof sessionId !== 'string' || !sessionId || typeof idFactory !== 'function' || typeof now !== 'function') {
        throw new VoiceError('voice_session_invalid_state');
    }

    const listeners = new Map(VOICE_EVENTS.map(name => [name, new Set()]));
    let started = false;
    let ended = false;
    let active = null;

    function emit(type, turnId = null, details = {}) {
        const event = Object.freeze({ type, sessionId, turnId, timestamp: now(), ...details });
        for (const listener of [...listeners.get(type)]) {
            try { listener(event); }
            catch { /* A consumer callback cannot break the transcription lifecycle. */ }
        }
    }

    function on(type, listener) {
        if (!validEvents.has(type) || typeof listener !== 'function') throw new TypeError('voice_listener_invalid');
        const set = listeners.get(type);
        set.add(listener);
        return () => set.delete(listener);
    }

    function start() {
        if (ended) throw new VoiceError('voice_session_invalid_state');
        if (!started) {
            started = true;
            emit('voice.session.started');
        }
        return sessionId;
    }

    function cancel(reason = 'user') {
        if (!validCancelReasons.has(reason)) throw new TypeError('voice_cancel_reason_invalid');
        if (!active) return false;
        const operation = active;
        active = null;
        operation.controller.abort();
        emit('voice.cancelled', operation.turnId, { reason });
        return true;
    }

    async function transcribe(input) {
        if (!started || ended) throw new VoiceError('voice_session_invalid_state');
        if (active) cancel('superseded');

        const operation = { turnId: idFactory(), controller: new AbortController() };
        active = operation;
        emit('voice.transcribing', operation.turnId);

        let removeAbortListener;
        const cancelled = new Promise(resolve => {
            const onAbort = () => resolve({ kind: 'cancelled' });
            operation.controller.signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => operation.controller.signal.removeEventListener('abort', onAbort);
            if (operation.controller.signal.aborted) onAbort();
        });
        const transcription = Promise.resolve().then(() => recognizer.transcribe({
            audio: input?.audio,
            format: input?.format,
            ...(input?.language === undefined ? {} : { language: input.language }),
            signal: operation.controller.signal,
        })).then(
            value => ({ kind: 'result', value }),
            error => ({ kind: 'error', error }),
        );

        try {
            const outcome = await Promise.race([transcription, cancelled]);
            if (outcome.kind === 'cancelled' || active !== operation || ended) return null;
            if (outcome.kind === 'error') {
                const error = toVoiceError(outcome.error);
                active = null;
                emit('voice.error', operation.turnId, { error: Object.freeze({ code: error.code, message: error.message }) });
                throw error;
            }
            const result = outcome.value;
            active = null;
            const transcript = Object.freeze({ sessionId, turnId: operation.turnId,
                text: result.text, language: result.language ?? null });
            emit('voice.transcript.final', operation.turnId, { text: transcript.text, language: transcript.language });
            return transcript;
        } finally {
            removeAbortListener?.();
            if (active === operation) active = null;
        }
    }

    function end() {
        if (ended) return false;
        if (active) cancel('session_ended');
        ended = true;
        emit('voice.session.ended');
        return true;
    }

    return Object.freeze({ sessionId, on, start, transcribe, cancel, end });
}
