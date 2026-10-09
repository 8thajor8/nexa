import { speechConfig, getSpeechInstructions, speechStyles } from './config.js';
import { createOpenAISpeechProvider } from './providers/openai.js';
import { createAudioStore } from './audio-store.js';
import { createWindowsAudioPlayer } from './windows-player.js';
import { createVoiceFxProcessor } from './voice-fx.js';
import { createVoiceIdentityProcessor, nexaVoiceIdentity } from './voice-identity.js';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const maxAudioBytes = 50 * 1024 * 1024;

function failure(code, message) {
    return { success: false, error: { code, message } };
}

export function createSpeechService({
    provider = createOpenAISpeechProvider(),
    store = createAudioStore(speechConfig),
    player = createWindowsAudioPlayer(),
    voiceIdentityProcessor = createVoiceIdentityProcessor(),
    voiceIdentityEnabled = nexaVoiceIdentity.enabled,
    voiceFxProcessor,
    voiceFxProfile = 'off',
    maxTextLength = speechConfig.maxTextLength,
} = {}) {
    let lastMetrics = null;
    async function initialize() {
        try { await store.initialize(); }
        catch { return failure('audio_storage_unavailable', 'No pude preparar el almacenamiento seguro de audio.'); }
        return { success: true };
    }

    async function generate({ text, style = 'normal', persist = false } = {}) {
        if (typeof text !== 'string' || text.trim().length === 0) return failure('invalid_text', 'El texto no puede estar vacío.');
        if (text.length > maxTextLength) return failure('text_too_long', `El texto supera el límite de ${maxTextLength} caracteres.`);
        if (typeof style !== 'string' || !Object.hasOwn(speechStyles, style)) return failure('invalid_speech_style', 'El estilo debe ser normal, professional, alert, sassy o calm.');
        if (typeof persist !== 'boolean') return failure('invalid_persist_option', 'persist debe ser true o false.');
        const initialized = await initialize();
        if (!initialized.success) return initialized;

        let audio;
        const providerStartedAt = performance.now();
        try { audio = await provider.synthesize({ text, instructions: getSpeechInstructions(style), format: speechConfig.format }); }
        catch { return failure('speech_generation_failed', 'El proveedor de voz no pudo generar el audio.'); }
        const providerGenerationMs = performance.now() - providerStartedAt;
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > maxAudioBytes) {
            return failure('invalid_provider_audio', 'El proveedor devolvió un audio no válido.');
        }

        let processingMs;
        try {
            const processingStartedAt = performance.now();
            audio = await voiceIdentityProcessor.process(Buffer.from(audio), { enabled: voiceIdentityEnabled });
            processingMs = performance.now() - processingStartedAt;
            if (voiceFxProcessor || voiceFxProfile !== 'off') {
                audio = (voiceFxProcessor ?? createVoiceFxProcessor()).process(Buffer.from(audio), voiceFxProfile);
            }
        }
        catch { return failure('audio_processing_failed', 'No pude preparar el audio para reproducirlo.'); }
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > maxAudioBytes) {
            return failure('audio_processing_failed', 'El procesador de audio devolvió un resultado no válido.');
        }

        try {
            const reference = await store.save(Buffer.from(audio), persist);
            lastMetrics = { providerGenerationMs, voiceIdentityProcessingMs: processingMs, outputBytes: audio.byteLength };
            return { success: true, ...reference };
        } catch {
            return failure('audio_storage_failed', 'No pude guardar el audio generado.');
        }
    }

    async function play(audioId, { playbackId = randomUUID() } = {}) {
        const initialized = await initialize();
        if (!initialized.success) return initialized;
        const reference = store.get(audioId);
        if (!reference || !await store.isAvailable(audioId)) return failure('audio_not_found', 'No existe un audio disponible con ese identificador.');
        let result;
        let playerSettled = false;
        try {
            result = typeof player === 'function'
                ? await player(reference.filePath)
                : await player.play(reference.filePath, { playbackId });
            playerSettled = true;
        }
        catch { result = failure('audio_playback_failed', 'Windows no pudo reproducir el audio.'); }
        finally {
            // A controlled player marks release only after terminal state and
            // MCI close are confirmed. Legacy injected functions retain their
            // historical settled-promise cleanup semantics.
            const safelyReleased = (typeof player === 'function' && playerSettled) || result?.released === true;
            if (reference.temporary && safelyReleased) {
                try { await store.removeTemporary(audioId); }
                catch { /* Startup/shutdown cleanup remains a second safeguard. */ }
            }
        }
        if (!result?.success) return result?.error ? { ...result, audioId, playbackId } : failure('audio_playback_failed', 'Windows no pudo reproducir el audio.');
        return { success: true, audioId, playbackId, played: true, temporary: reference.temporary,
            status: result.status ?? 'completed', released: result.released ?? true };
    }

    async function stopPlayback(playbackId) {
        if (typeof player?.stop !== 'function') return { playbackId, status: 'unconfirmed', confirmed: false, released: false, interrupted: false,
            error: { code: 'audio_stop_unavailable', message: 'El reproductor no permite confirmar una interrupción.' } };
        try { return await player.stop(playbackId); }
        catch { return { playbackId, status: 'unknown', confirmed: false, released: false, interrupted: false,
            error: { code: 'audio_stop_failed', message: 'Windows no pudo confirmar la interrupción.' } }; }
    }

    function getPlaybackStatus(playbackId) {
        if (typeof player?.getStatus !== 'function') return Object.freeze({ playbackId, status: 'unknown', released: false });
        try { return player.getStatus(playbackId); }
        catch { return Object.freeze({ playbackId, status: 'unknown', released: false }); }
    }

    async function removeTemporary(audioId) {
        try {
            const reference = store.get(audioId);
            if (!reference?.temporary) return false;
            return await store.removeTemporary(audioId);
        } catch { return false; }
    }

    async function close() {
        try {
            if (typeof player?.dispose === 'function') {
                const disposed = await player.dispose();
                if (!disposed?.success) return { success: false, removed: 0, playback: disposed };
            }
            return await store.cleanupCurrentTemporaries();
        }
        catch { return { success: false, removed: 0 }; }
    }

    function getLastMetrics() { return lastMetrics ? { ...lastMetrics } : null; }

    return { initialize, generate, play, stopPlayback, getPlaybackStatus, removeTemporary, close, getLastMetrics };
}

const speechService = createSpeechService();
export const initializeSpeechService = speechService.initialize;
export const generateSpeech = speechService.generate;
export const playAudio = speechService.play;
export const stopSpeechPlayback = speechService.stopPlayback;
export const getSpeechPlaybackStatus = speechService.getPlaybackStatus;
export const removeTemporarySpeech = speechService.removeTemporary;
export const closeSpeechService = speechService.close;
export const getSpeechMetrics = speechService.getLastMetrics;
