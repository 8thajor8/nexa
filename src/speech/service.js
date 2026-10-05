import { speechConfig, getSpeechInstructions, speechStyles } from './config.js';
import { createOpenAISpeechProvider } from './providers/openai.js';
import { createAudioStore } from './audio-store.js';
import { createWindowsAudioPlayer } from './windows-player.js';

const maxAudioBytes = 50 * 1024 * 1024;

function failure(code, message) {
    return { success: false, error: { code, message } };
}

export function createSpeechService({
    provider = createOpenAISpeechProvider(),
    store = createAudioStore(speechConfig),
    player = createWindowsAudioPlayer(),
    maxTextLength = speechConfig.maxTextLength,
} = {}) {
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
        try { audio = await provider.synthesize({ text, instructions: getSpeechInstructions(style), format: speechConfig.format }); }
        catch { return failure('speech_generation_failed', 'El proveedor de voz no pudo generar el audio.'); }
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > maxAudioBytes) {
            return failure('invalid_provider_audio', 'El proveedor devolvió un audio no válido.');
        }

        try {
            const reference = await store.save(Buffer.from(audio), persist);
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
        const result = await player(reference.filePath);
        if (!result?.success) return result?.error ? result : failure('audio_playback_failed', 'Windows no pudo reproducir el audio.');
        if (reference.temporary) await store.removeTemporary(audioId);
        return { success: true, audioId, played: true, temporary: reference.temporary };
    }

    async function close() {
        try { return await store.cleanupCurrentTemporaries(); }
        catch { return { success: false, removed: 0 }; }
    }

    return { initialize, generate, play, close };
}

const speechService = createSpeechService();
export const initializeSpeechService = speechService.initialize;
export const generateSpeech = speechService.generate;
export const playAudio = speechService.play;
export const closeSpeechService = speechService.close;
