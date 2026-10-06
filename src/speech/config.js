import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { novaPortenaInstructions } from './voice-casting-profiles.js';

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
    novaPortenaInstructions,
    'Use a youthful adult feminine voice. Be warm, friendly, lively and spontaneous, like you enjoy chatting with someone you know well.',
    'Let wit and a playful edge come naturally. Keep confidence relaxed and approachable.',
    'Never sound cold, overly serious, corporate, announcer-like, or as if presenting a script.',
].join(' ');

export const speechStyles = Object.freeze({
    normal: 'Use a warm, lively, relaxed conversational delivery. Let your personality and enjoyment show; keep the playfulness subtle and natural.',
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
