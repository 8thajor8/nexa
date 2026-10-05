import { getOpenAIClient } from '../../brain/openai.js';
import { speechConfig } from '../config.js';

export function createOpenAISpeechProvider({ clientFactory = getOpenAIClient, settings = speechConfig } = {}) {
    return {
        async synthesize({ text, instructions }) {
            const response = await clientFactory().audio.speech.create({
                model: settings.model,
                voice: settings.voice,
                input: text,
                instructions,
                response_format: settings.format,
            });
            return Buffer.from(await response.arrayBuffer());
        },
    };
}
