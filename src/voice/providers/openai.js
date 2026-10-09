import { getOpenAIClient } from '../../brain/openai.js';
import { toFile } from 'openai/uploads';
import { AUDIO_FORMATS, voiceConfig } from '../config.js';
import { VoiceError } from '../errors.js';

export function createOpenAITranscriptionProvider({ clientFactory = getOpenAIClient, config = voiceConfig } = {}) {
    return Object.freeze({
        async transcribe({ audio, format, language, signal, model = config.model }) {
            if (signal?.aborted) throw new VoiceError('voice_cancelled');
            try {
                const file = await toFile(audio, `voice-audio.${format}`, { type: AUDIO_FORMATS[format] });
                const response = await clientFactory().audio.transcriptions.create({
                    file,
                    model,
                    response_format: 'json',
                    ...(language ? { language } : {}),
                }, signal ? { signal } : undefined);
                if (signal?.aborted) throw new VoiceError('voice_cancelled');
                if (!response || typeof response.text !== 'string') throw new VoiceError('voice_response_invalid');
                const detectedLanguage = Array.isArray(response.languages)
                    ? response.languages.find(item => typeof item?.code === 'string')?.code
                    : response.language;
                return { text: response.text, language: detectedLanguage ?? null };
            } catch (error) {
                if (signal?.aborted || error?.name === 'AbortError') throw new VoiceError('voice_cancelled');
                if (error instanceof VoiceError) throw error;
                throw new VoiceError('voice_provider_error');
            }
        },
    });
}
