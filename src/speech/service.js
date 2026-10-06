import { speechConfig, getSpeechInstructions, speechStyles } from './config.js';
import { createOpenAISpeechProvider } from './providers/openai.js';
import { createAudioStore } from './audio-store.js';
import { createWindowsAudioPlayer } from './windows-player.js';
import { createVoiceFxProcessor } from './voice-fx.js';
import { createVoiceIdentityProcessor, nexaVoiceIdentity } from './voice-identity.js';
import { performance } from 'node:perf_hooks';

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

    async function play(audioId) {
        const initialized = await initialize();
        if (!initialized.success) return initialized;
        const reference = store.get(audioId);
        if (!reference || !await store.isAvailable(audioId)) return failure('audio_not_found', 'No existe un audio disponible con ese identificador.');
        let result;
        try { result = await player(reference.filePath); }
        catch { result = failure('audio_playback_failed', 'Windows no pudo reproducir el audio.'); }
        finally {
            // A temporary file is one-shot: an explicit playback attempt ends
            // its lifecycle whether playback succeeded or failed. The store
            // verifies the ID, directory and file type before deleting it.
            if (reference.temporary) {
                try { await store.removeTemporary(audioId); }
                catch { /* Startup/shutdown cleanup remains a second safeguard. */ }
            }
        }
        if (!result?.success) return result?.error ? result : failure('audio_playback_failed', 'Windows no pudo reproducir el audio.');
        return { success: true, audioId, played: true, temporary: reference.temporary };
    }

    async function close() {
        try { return await store.cleanupCurrentTemporaries(); }
        catch { return { success: false, removed: 0 }; }
    }

    function getLastMetrics() { return lastMetrics ? { ...lastMetrics } : null; }

    return { initialize, generate, play, close, getLastMetrics };
}

const speechService = createSpeechService();
export const initializeSpeechService = speechService.initialize;
export const generateSpeech = speechService.generate;
export const playAudio = speechService.play;
export const closeSpeechService = speechService.close;
export const getSpeechMetrics = speechService.getLastMetrics;
