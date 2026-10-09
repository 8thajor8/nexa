import { VoiceError } from './errors.js';

export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-transcribe';
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const AUDIO_FORMATS = Object.freeze({
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    m4a: 'audio/mp4',
    mpeg: 'audio/mpeg',
    mpga: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    webm: 'audio/webm',
});

export function getVoiceConfig(env = process.env) {
    const candidate = typeof env?.NEXA_STT_MODEL === 'string'
        ? env.NEXA_STT_MODEL.trim()
        : '';
    const model = candidate || DEFAULT_TRANSCRIPTION_MODEL;
    if (model.length > 128 || /[\u0000-\u0020\u007f]/u.test(model)) {
        throw new VoiceError('voice_model_invalid');
    }
    return Object.freeze({ model, maxAudioBytes: MAX_AUDIO_BYTES });
}

export const voiceConfig = getVoiceConfig();
