import { getOpenAIClient } from '../../brain/openai.js';
import { speechConfig, getSpeechRequestTimeoutMs } from '../config.js';
import { normalizeWavLengths } from '../wav.js';
import { performance } from 'node:perf_hooks';

export function createOpenAISpeechProvider({ clientFactory = getOpenAIClient, settings = speechConfig,
    timeoutForText = getSpeechRequestTimeoutMs } = {}) {
    return {
        async synthesize({ text, instructions, voice = settings.voice, signal, onTiming }) {
            const timeoutMs = timeoutForText(text);
            const timeoutController = new AbortController();
            const deadline = setTimeout(() => timeoutController.abort(), timeoutMs);
            const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
            const startedAt = performance.now();
            let onAbort;
            const cancelled = new Promise((_, reject) => {
                onAbort = () => reject(combinedSignal.reason);
                if (combinedSignal.aborted) onAbort();
                else combinedSignal.addEventListener('abort', onAbort, { once: true });
            });
            try {
                const response = await Promise.race([clientFactory().audio.speech.create({
                    model: settings.model,
                    voice,
                    input: text,
                    instructions,
                    response_format: settings.format,
                }, { signal: combinedSignal, timeout: timeoutMs, maxRetries: 0 }), cancelled]);
                onTiming?.({ ttsSdkResponseMs: performance.now() - startedAt, ttsInputCharacters: text.length });
                const bodyStartedAt = performance.now();
                const audio = Buffer.from(await Promise.race([response.arrayBuffer(), cancelled]));
                onTiming?.({ ttsBodyReadMs: performance.now() - bodyStartedAt });
                return settings.format === 'wav' ? normalizeWavLengths(audio) : audio;
            } catch (error) {
                if (timeoutController.signal.aborted && !signal?.aborted) {
                    const timeoutError = new Error('TTS request deadline exceeded');
                    timeoutError.code = 'speech_generation_timeout';
                    throw timeoutError;
                }
                throw error;
            } finally {
                clearTimeout(deadline);
                combinedSignal.removeEventListener('abort', onAbort);
            }
        },
    };
}
