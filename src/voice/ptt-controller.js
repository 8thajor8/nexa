import { createVoiceSession } from './session.js';

const MAX_PTT_WAV_BYTES = 1_048_576;
const MAX_PTT_DURATION_SECONDS = 30;
const PTT_SAMPLE_RATE = 16_000;
const PTT_BLOCK_ALIGN = 2;
const PTT_BYTE_RATE = PTT_SAMPLE_RATE * PTT_BLOCK_ALIGN;
const PTT_EVENTS = Object.freeze([
    'voice.session.started',
    'voice.transcribing',
    'voice.transcript.final',
    'voice.cancelled',
    'voice.error',
    'voice.session.ended',
]);

const errorMessages = Object.freeze({
    VOICE_PTT_INVALID_AUDIO: 'El audio PTT no es un WAV válido para este perfil.',
    VOICE_PTT_UNSUPPORTED_FORMAT: 'El perfil PTT solo acepta audio WAV.',
    VOICE_PTT_TOO_LARGE: 'El audio PTT supera el tamaño máximo de 1 MiB.',
    VOICE_PTT_TOO_LONG: 'El audio PTT supera la duración máxima de 30 segundos.',
    VOICE_PTT_INVALID_STATE: 'La sesión PTT no está iniciada o ya finalizó.',
    VOICE_PTT_TRANSCRIPTION_FAILED: 'No se pudo completar la transcripción PTT.',
});

class PttVoiceError extends Error {
    constructor(code) {
        super(errorMessages[code] ?? errorMessages.VOICE_PTT_TRANSCRIPTION_FAILED);
        this.name = 'PttVoiceError';
        this.code = Object.hasOwn(errorMessages, code) ? code : 'VOICE_PTT_TRANSCRIPTION_FAILED';
    }
}

function pttError(code) { return new PttVoiceError(code); }

function exactInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !['audio', 'format', 'language'].includes(key)
        || !Object.hasOwn(descriptors[key], 'value'))) return null;
    const input = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
    if (!Object.hasOwn(input, 'audio') || !Object.hasOwn(input, 'format')) return null;
    return input;
}

function validatePttWav(value) {
    const input = exactInput(value);
    if (!input) throw pttError('VOICE_PTT_INVALID_AUDIO');
    if (typeof input.format !== 'string') throw pttError('VOICE_PTT_INVALID_AUDIO');
    if (input.format.toLowerCase() !== 'wav') throw pttError('VOICE_PTT_UNSUPPORTED_FORMAT');
    if (!(Buffer.isBuffer(input.audio) || input.audio instanceof Uint8Array)) throw pttError('VOICE_PTT_INVALID_AUDIO');
    if (input.audio.byteLength === 0) throw pttError('VOICE_PTT_INVALID_AUDIO');
    if (input.audio.byteLength > MAX_PTT_WAV_BYTES) throw pttError('VOICE_PTT_TOO_LARGE');

    // Copy before parsing so caller mutation cannot change validated bytes before STT.
    const audio = Buffer.from(input.audio);
    if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
        throw pttError('VOICE_PTT_INVALID_AUDIO');
    }

    const riffEnd = audio.readUInt32LE(4) + 8;
    if (riffEnd !== audio.length) throw pttError('VOICE_PTT_INVALID_AUDIO');

    let offset = 12;
    let formatSeen = false;
    let dataSeen = false;
    let dataLength = 0;
    while (offset < riffEnd) {
        if (riffEnd - offset < 8) throw pttError('VOICE_PTT_INVALID_AUDIO');
        const chunkId = audio.toString('ascii', offset, offset + 4);
        const chunkLength = audio.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + chunkLength;
        const paddedEnd = chunkEnd + (chunkLength & 1);
        if (chunkEnd > riffEnd || paddedEnd > riffEnd) throw pttError('VOICE_PTT_INVALID_AUDIO');

        if (chunkId === 'fmt ') {
            if (formatSeen || (chunkLength !== 16 && chunkLength !== 18)) throw pttError('VOICE_PTT_INVALID_AUDIO');
            formatSeen = true;
            const encoding = audio.readUInt16LE(chunkStart);
            const channels = audio.readUInt16LE(chunkStart + 2);
            const sampleRate = audio.readUInt32LE(chunkStart + 4);
            const byteRate = audio.readUInt32LE(chunkStart + 8);
            const blockAlign = audio.readUInt16LE(chunkStart + 12);
            const bitsPerSample = audio.readUInt16LE(chunkStart + 14);
            if (chunkLength === 18 && audio.readUInt16LE(chunkStart + 16) !== 0) throw pttError('VOICE_PTT_INVALID_AUDIO');
            if (encoding !== 1 || channels !== 1 || sampleRate !== PTT_SAMPLE_RATE
                || byteRate !== PTT_BYTE_RATE || blockAlign !== PTT_BLOCK_ALIGN || bitsPerSample !== 16) {
                throw pttError('VOICE_PTT_UNSUPPORTED_FORMAT');
            }
        } else if (chunkId === 'data') {
            if (dataSeen) throw pttError('VOICE_PTT_INVALID_AUDIO');
            dataSeen = true;
            dataLength = chunkLength;
        }

        offset = paddedEnd;
    }

    if (offset !== riffEnd || !formatSeen || !dataSeen || dataLength === 0 || dataLength % PTT_BLOCK_ALIGN !== 0) {
        throw pttError('VOICE_PTT_INVALID_AUDIO');
    }
    const sampleCount = dataLength / PTT_BLOCK_ALIGN;
    const durationSeconds = sampleCount / PTT_SAMPLE_RATE;
    if (durationSeconds > MAX_PTT_DURATION_SECONDS) throw pttError('VOICE_PTT_TOO_LONG');

    return { audio, language: input.language };
}

function toPublicError(error) {
    if (error instanceof PttVoiceError) return error;
    if (error?.code === 'voice_session_invalid_state') return pttError('VOICE_PTT_INVALID_STATE');
    return pttError('VOICE_PTT_TRANSCRIPTION_FAILED');
}

/**
 * Creates a Node-only PTT controller. It accepts complete WAV byte arrays and
 * never opens a microphone or accepts an AbortSignal from the caller.
 *
 * The WAV profile is RIFF/WAVE PCM signed 16-bit, mono, 16 kHz, at most 30
 * seconds and 1,048,576 bytes including headers. Validation completes before
 * the recognizer is called. Other Voice recognizer entry points are unaffected.
 *
 * `start()` starts the logical session and returns its Voice-owned sessionId.
 * `transcribe()` returns the VoiceSession result, whose turnId is also present
 * on `voice.transcribing` and terminal events. A cancelled or superseded
 * operation resolves to null. `cancel()` aborts the active STT turn; `end()`
 * cancels an active turn and ends the session idempotently.
 *
 * The caller owns capture request IDs. Associate its current request ID with
 * the synchronous `voice.transcribing` callback and the event's turnId; this
 * controller neither creates nor stores request IDs. Subscribe via `onEvent`
 * and/or `subscribe()`. Both receive the existing STT event names and payloads.
 * Unsubscribe functions are idempotent, and callback exceptions are isolated.
 *
 * Errors are safe Error objects with a `code` and public `message`; the code is
 * one of VOICE_PTT_INVALID_AUDIO, VOICE_PTT_UNSUPPORTED_FORMAT,
 * VOICE_PTT_TOO_LARGE, VOICE_PTT_TOO_LONG, VOICE_PTT_INVALID_STATE, or
 * VOICE_PTT_TRANSCRIPTION_FAILED.
 *
 * @param {{recognizer: {transcribe(input: {audio: Buffer, format: string, language?: string, signal: AbortSignal}): Promise<{text: string, language: string|null}>}, onEvent?: (event: object) => void, sessionId?: string}} options
 * @returns {{start: () => {sessionId: string}, transcribe: (input: {audio: Uint8Array, format: 'wav', language?: string}) => Promise<{sessionId: string, turnId: string, text: string, language: string|null}|null>, cancel: (reason?: 'user'|'superseded'|'session_ended'|'timeout') => boolean, end: () => void, subscribe: (listener: (event: object) => void) => () => void}}
 */
export function createPttVoiceController({ recognizer, onEvent, sessionId } = {}) {
    if (typeof recognizer?.transcribe !== 'function') throw pttError('VOICE_PTT_INVALID_STATE');
    if (onEvent !== undefined && typeof onEvent !== 'function') throw pttError('VOICE_PTT_INVALID_STATE');

    let session;
    try { session = createVoiceSession({ recognizer, ...(sessionId === undefined ? {} : { sessionId }) }); }
    catch { throw pttError('VOICE_PTT_INVALID_STATE'); }
    const listeners = new Set();
    let started = false;
    let ended = false;

    function forward(sourceEvent) {
        const event = sourceEvent.type === 'voice.error'
            ? Object.freeze({ ...sourceEvent, error: Object.freeze({
                code: 'VOICE_PTT_TRANSCRIPTION_FAILED',
                message: errorMessages.VOICE_PTT_TRANSCRIPTION_FAILED,
            }) })
            : sourceEvent;
        if (onEvent) {
            try { onEvent(event); } catch { /* Integrator callbacks cannot break Voice lifecycle. */ }
        }
        for (const listener of [...listeners]) {
            if (listener === onEvent) continue;
            try { listener(event); } catch { /* A subscriber cannot break Voice lifecycle. */ }
        }
    }

    for (const type of PTT_EVENTS) session.on(type, forward);

    function start() {
        if (ended) throw pttError('VOICE_PTT_INVALID_STATE');
        started = true;
        return Object.freeze({ sessionId: session.start() });
    }

    async function transcribe(input) {
        if (!started || ended) throw pttError('VOICE_PTT_INVALID_STATE');
        let validated;
        try { validated = validatePttWav(input); }
        catch (error) {
            if (error instanceof PttVoiceError) throw error;
            throw pttError('VOICE_PTT_INVALID_AUDIO');
        }
        try {
            return await session.transcribe({ audio: validated.audio, format: 'wav',
                ...(validated.language === undefined ? {} : { language: validated.language }) });
        } catch (error) {
            throw toPublicError(error);
        }
    }

    function cancel(reason = 'user') {
        if (ended) return false;
        try { return session.cancel(reason); }
        catch { throw pttError('VOICE_PTT_INVALID_STATE'); }
    }

    function end() {
        if (ended) return;
        ended = true;
        session.end();
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') throw pttError('VOICE_PTT_INVALID_STATE');
        listeners.add(listener);
        let subscribed = true;
        return () => {
            if (!subscribed) return;
            subscribed = false;
            listeners.delete(listener);
        };
    }

    return Object.freeze({ start, transcribe, cancel, end, subscribe });
}
