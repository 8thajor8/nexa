import { AUDIO_FORMATS, voiceConfig } from './config.js';
import { VoiceError } from './errors.js';

function exactInputRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !['audio', 'format', 'language', 'signal'].includes(key)
        || !Object.hasOwn(descriptors[key], 'value'))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function validateInput(value, config) {
    const input = exactInputRecord(value);
    if (!input || !Object.hasOwn(input, 'audio') || !Object.hasOwn(input, 'format')) {
        throw new VoiceError('voice_audio_invalid');
    }
    if (!(Buffer.isBuffer(input.audio) || input.audio instanceof Uint8Array)) {
        throw new VoiceError('voice_audio_invalid');
    }
    if (input.audio.byteLength === 0) throw new VoiceError('voice_audio_empty');
    if (input.audio.byteLength > config.maxAudioBytes) throw new VoiceError('voice_audio_too_large');

    const format = typeof input.format === 'string' ? input.format.trim().toLowerCase() : '';
    if (!Object.hasOwn(AUDIO_FORMATS, format)) throw new VoiceError('voice_format_unsupported');
    if (input.language !== undefined
        && (typeof input.language !== 'string' || !/^[a-z]{2}$/iu.test(input.language.trim()))) {
        throw new VoiceError('voice_language_invalid');
    }
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
        throw new VoiceError('voice_audio_invalid');
    }
    if (input.signal?.aborted) throw new VoiceError('voice_cancelled');

    return {
        audio: Buffer.from(input.audio),
        format,
        ...(input.language === undefined ? {} : { language: input.language.trim().toLowerCase() }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
}

function validLanguage(language) {
    return typeof language === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/iu.test(language)
        ? language
        : null;
}

function createDefaultProvider() {
    return import('./providers/openai.js').then(({ createOpenAITranscriptionProvider }) => createOpenAITranscriptionProvider());
}

export function createSpeechRecognizer({ provider, config = voiceConfig } = {}) {
    if (!config || typeof config.model !== 'string' || !config.model.trim()
        || !Number.isSafeInteger(config.maxAudioBytes) || config.maxAudioBytes < 1) {
        throw new VoiceError('voice_model_invalid');
    }
    if (provider !== undefined && typeof provider?.transcribe !== 'function') {
        throw new VoiceError('voice_provider_invalid');
    }

    let selectedProvider = provider;
    let providerPromise;
    async function resolveProvider() {
        if (selectedProvider) return selectedProvider;
        if (!providerPromise) {
            providerPromise = createDefaultProvider().then(value => {
                selectedProvider = value;
                return value;
            }).catch(() => {
                providerPromise = undefined;
                throw new VoiceError('voice_provider_invalid');
            });
        }
        return providerPromise;
    }

    async function transcribe(value) {
        const input = validateInput(value, config);
        const signal = input.signal;
        try {
            const selected = await resolveProvider();
            if (signal?.aborted) throw new VoiceError('voice_cancelled');
            const result = await selected.transcribe({ ...input, model: config.model });
            if (signal?.aborted) throw new VoiceError('voice_cancelled');
            if (!result || typeof result !== 'object' || typeof result.text !== 'string') {
                throw new VoiceError('voice_response_invalid');
            }
            return Object.freeze({ text: result.text, language: validLanguage(result.language) });
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw new VoiceError('voice_cancelled');
            if (error instanceof VoiceError) throw error;
            throw new VoiceError('voice_provider_error');
        }
    }

    return Object.freeze({ transcribe });
}
