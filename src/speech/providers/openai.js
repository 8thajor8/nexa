import { getOpenAIClient } from '../../brain/openai.js';
import { speechConfig } from '../config.js';
import { normalizeWavLengths } from '../wav.js';

export function createOpenAISpeechProvider({ clientFactory = getOpenAIClient, settings = speechConfig } = {}) {
    return {
        async synthesize({ text, instructions, voice = settings.voice }) {
            const response = await clientFactory().audio.speech.create({
                model: settings.model,
                voice,
                input: text,
                instructions,
                response_format: settings.format,
            });
            const audio = Buffer.from(await response.arrayBuffer());
            return settings.format === 'wav' ? normalizeWavLengths(audio) : audio;
        },
    };
}
