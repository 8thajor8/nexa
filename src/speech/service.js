import { defaultSpeechInstructionVariant, speechConfig, getSpeechInstructions, speechStyles } from './config.js';
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
    speechInstructionVariant = defaultSpeechInstructionVariant,
} = {}) {
    if (!['A', 'B'].includes(speechInstructionVariant)) throw new TypeError('speech_instruction_variant_invalid');
    let lastMetrics = null;
    async function initialize(metrics = null) {
        const startedAt = performance.now();
        try { await store.initialize(); }
        catch {
            if (metrics) { metrics.storageInitializationMs = performance.now() - startedAt; metrics.failureStage = 'audio_preparation'; lastMetrics = { ...metrics }; }
            return failure('audio_storage_unavailable', 'No pude preparar el almacenamiento seguro de audio.');
        }
        if (metrics) metrics.storageInitializationMs = performance.now() - startedAt;
        return { success: true };
    }

    async function generate({ text, style = 'normal', persist = false, signal, includeAudio = false } = {}) {
        const audioReadyStartedAt = performance.now();
        if (typeof text !== 'string' || text.trim().length === 0) return failure('invalid_text', 'El texto no puede estar vacío.');
        if (text.length > maxTextLength) return failure('text_too_long', `El texto supera el límite de ${maxTextLength} caracteres.`);
        if (typeof style !== 'string' || !Object.hasOwn(speechStyles, style)) return failure('invalid_speech_style', 'El estilo debe ser normal, professional, alert, sassy o calm.');
        if (typeof persist !== 'boolean') return failure('invalid_persist_option', 'persist debe ser true o false.');
        if (typeof includeAudio !== 'boolean') return failure('invalid_audio_return_option', 'includeAudio debe ser true o false.');
        const metrics = { model: speechConfig.model, voice: speechConfig.voice, identityProfile: 'nova-portena',
            identityProcessing: voiceIdentityEnabled, storageInitializationMs: null, synthesisMs: null,
            ttsSdkResponseMs: null, ttsBodyReadMs: null, ttsInputCharacters: text.length,
            identityProcessingMs: null, identityServerStartupMs: null, identityBrowserStartupMs: null,
            identityRendererPreparationMs: null, identityDspSetupMs: null, identityDspProcessingMs: null,
            identityAudioCaptureWaitMs: null, identityPostProcessingMs: null,
            audioSaveMs: null, audioReadyMs: null, outputBytes: null, failureStage: null };
        const initialized = await initialize(metrics);
        if (!initialized.success) return initialized;
        if (signal?.aborted) return failure('voice_cancelled', 'La generación de voz fue cancelada.');

        let audio;
        const providerStartedAt = performance.now();
        try { audio = await provider.synthesize({ text, instructions: getSpeechInstructions(style, speechInstructionVariant), format: speechConfig.format, signal,
            onTiming: timing => { Object.assign(metrics, timing); } }); }
        catch (error) {
            metrics.synthesisMs = performance.now() - providerStartedAt; metrics.failureStage = 'synthesis'; lastMetrics = { ...metrics };
            if (signal?.aborted) return failure('voice_cancelled', 'La generación de voz fue cancelada.');
            if (error?.code === 'speech_generation_timeout') return failure('speech_generation_timeout', 'La síntesis de voz tardó demasiado.');
            return failure('speech_generation_failed', 'El proveedor de voz no pudo generar el audio.');
        }
        metrics.synthesisMs = performance.now() - providerStartedAt;
        if (signal?.aborted) return failure('voice_cancelled', 'La generación de voz fue cancelada.');
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > maxAudioBytes) {
            metrics.failureStage = 'synthesis'; lastMetrics = { ...metrics };
            return failure('invalid_provider_audio', 'El proveedor devolvió un audio no válido.');
        }

        let processingStartedAt = performance.now();
        try {
            audio = await voiceIdentityProcessor.process(Buffer.from(audio), { enabled: voiceIdentityEnabled });
            metrics.identityProcessingMs = performance.now() - processingStartedAt;
            const identityMetrics = voiceIdentityProcessor.getLastMetrics?.() ?? {};
            metrics.identityServerStartupMs = identityMetrics.serverStartupMs ?? null;
            metrics.identityBrowserStartupMs = identityMetrics.browserStartupMs ?? null;
            metrics.identityRendererPreparationMs = identityMetrics.rendererPreparationMs ?? null;
            metrics.identityDspSetupMs = identityMetrics.dspSetupMs ?? null;
            metrics.identityDspProcessingMs = identityMetrics.dspProcessingMs ?? null;
            metrics.identityAudioCaptureWaitMs = identityMetrics.audioCaptureWaitMs ?? null;
            metrics.identityPostProcessingMs = identityMetrics.postProcessingMs ?? null;
            if (voiceFxProcessor || voiceFxProfile !== 'off') {
                processingStartedAt = performance.now();
                audio = (voiceFxProcessor ?? createVoiceFxProcessor()).process(Buffer.from(audio), voiceFxProfile);
                metrics.identityProcessingMs += performance.now() - processingStartedAt;
            }
        } catch (error) {
            metrics.identityProcessingMs = (metrics.identityProcessingMs ?? 0) + performance.now() - processingStartedAt;
            const identityMetrics = voiceIdentityProcessor.getLastMetrics?.() ?? {};
            metrics.identityServerStartupMs = identityMetrics.serverStartupMs ?? null;
            metrics.identityBrowserStartupMs = identityMetrics.browserStartupMs ?? null;
            metrics.identityRendererPreparationMs = identityMetrics.rendererPreparationMs ?? null;
            metrics.identityDspSetupMs = identityMetrics.dspSetupMs ?? null;
            metrics.identityDspProcessingMs = identityMetrics.dspProcessingMs ?? null;
            metrics.identityAudioCaptureWaitMs = identityMetrics.audioCaptureWaitMs ?? null;
            metrics.identityPostProcessingMs = identityMetrics.postProcessingMs ?? null;
            metrics.failureStage = 'identity_processing'; lastMetrics = { ...metrics };
            return error?.code === 'voice_identity_browser_unavailable'
                ? failure('voice_identity_browser_unavailable', 'No está disponible el motor local requerido por la identidad vocal.')
                : failure('audio_processing_failed', 'No pude preparar el audio para reproducirlo.');
        }
        if (signal?.aborted) return failure('voice_cancelled', 'La generación de voz fue cancelada.');
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > maxAudioBytes) {
            metrics.failureStage = 'identity_processing'; lastMetrics = { ...metrics };
            return failure('audio_processing_failed', 'El procesador de audio devolvió un resultado no válido.');
        }

        const saveStartedAt = performance.now();
        try {
            const reference = await store.save(Buffer.from(audio), persist);
            metrics.audioSaveMs = performance.now() - saveStartedAt;
            metrics.audioReadyMs = performance.now() - audioReadyStartedAt;
            metrics.voiceIdentityProcessingMs = metrics.identityProcessingMs;
            metrics.outputBytes = audio.byteLength;
            lastMetrics = { ...metrics };
            return { success: true, ...reference, ...(includeAudio ? { audio: Buffer.from(audio) } : {}) };
        } catch {
            metrics.audioSaveMs = performance.now() - saveStartedAt; metrics.failureStage = 'audio_preparation'; lastMetrics = { ...metrics };
            return failure('audio_storage_failed', 'No pude guardar el audio generado.');
        }
    }

    async function prepareAudio(audio) {
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > maxAudioBytes) {
            return failure('invalid_provider_audio', 'El audio preparado no es válido.');
        }
        const initialized = await initialize();
        if (!initialized.success) return initialized;
        try {
            return { success: true, ...(await store.save(Buffer.from(audio), false)) };
        } catch {
            return failure('audio_storage_failed', 'No pude guardar el audio preparado.');
        }
    }

    async function play(audioId, { playbackId = randomUUID(), onStarted } = {}) {
        const initialized = await initialize();
        if (!initialized.success) return initialized;
        const reference = store.get(audioId);
        if (!reference || !await store.isAvailable(audioId)) return failure('audio_not_found', 'No existe un audio disponible con ese identificador.');
        let result;
        let playerSettled = false;
        try {
            result = typeof player === 'function'
                ? await player(reference.filePath)
                : await player.play(reference.filePath, { playbackId, ...(onStarted ? { onStarted } : {}) });
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
            if (typeof voiceIdentityProcessor?.close === 'function') await voiceIdentityProcessor.close();
            return await store.cleanupCurrentTemporaries();
        }
        catch { return { success: false, removed: 0 }; }
    }

    function getLastMetrics() { return lastMetrics ? { ...lastMetrics } : null; }

    return { initialize, generate, prepareAudio, play, stopPlayback, getPlaybackStatus, removeTemporary, close, getLastMetrics };
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
