import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const speechConfig = Object.freeze({
    provider: 'openai',
    model: 'gpt-4o-mini-tts',
    voice: 'nova',
    format: 'wav',
    voiceIdentityEnabled: process.env.NEXA_VOICE_IDENTITY !== 'off',
    maxTextLength: 3000,
    maxTemporaryAgeMs: 24 * 60 * 60 * 1000,
    temporaryDirectory: path.join(projectRoot, 'data', 'temp', 'audio'),
    persistentDirectory: path.join(projectRoot, 'data', 'audio'),
});

export const voiceIdentity = [
    'Speak in Spanish with a subtle, natural Buenos Aires / Rioplatense Argentine accent.',
    'Sound like a young woman in her mid-to-late twenties: casual, confident, clever and spontaneous.',
    'Warm and energetic, with natural changes in rhythm, intonation and pauses.',
    'It should feel like a real person talking to someone she knows well.',
    'Keep the accent noticeable but never exaggerated.',
    'Avoid virtual-assistant, GPS, corporate-presenter, announcer, narrator, customer-service, overly polished, or robotic delivery.',
].join(' ');

export const speechStyles = Object.freeze({
    normal: 'Speak naturally and conversationally, with a balanced, friendly tone.',
    professional: 'Use a composed, precise and confident tone while staying natural and approachable.',
    alert: 'Sound attentive and clear, with gentle urgency but no alarmist or exaggerated delivery.',
    sassy: 'Add subtle wit and playful confidence; keep it kind and never theatrical or mean.',
    calm: 'Speak gently and steadily, with relaxed pacing and a reassuring tone.',
});

export function getSpeechInstructions(style = 'normal') {
    const styleInstruction = speechStyles[style];
    if (!styleInstruction) return null;
    return `${voiceIdentity} ${styleInstruction}`;
}
