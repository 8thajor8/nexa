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

export function getSpeechRequestTimeoutMs(text, env = process.env) {
    const configured = Number(env?.NEXA_TTS_TIMEOUT_MS);
    if (Number.isInteger(configured) && configured >= 30_000 && configured <= 300_000) return configured;
    return Math.min(180_000, 90_000 + 30_000 * Math.floor(Math.max(0, text.length - 1) / 1_000));
}

export const voiceIdentity = [
    novaPortenaInstructions,
    'Keep it relaxed and spontaneous, like chatting with someone you know.',
].join(' ');

export const voiceNaturalComparisonInstructions = Object.freeze({
    B: 'Speak in contemporary urban Rioplatense Spanish from Argentina. Pronounce Spanish with a natural Argentine accent where your voice supports it; use voseo naturally when the text calls for it, without adding slang or changing the words. Let meaning and punctuation shape intonation: use a natural rise for genuine questions, calm clear emphasis for warnings, and casual warmth for everyday remarks. Keep the rhythm fluid and conversational, with brief pauses only at syntactic boundaries. Use subtle humor when the words invite it, without acting. Avoid announcer, audiobook, customer-service delivery, exaggerated accent, extra filler words, or rephrasing the supplied text.',
});

export const defaultSpeechInstructionVariant = 'B';

export const speechStyles = Object.freeze({
    normal: '',
    professional: 'Use a composed, precise and confident tone while staying natural and approachable.',
    alert: 'Sound attentive and clear, with gentle urgency but no alarmist or exaggerated delivery.',
    sassy: 'Add subtle wit and playful confidence; keep it kind and never theatrical or mean.',
    calm: 'Speak gently and steadily, with relaxed pacing and a reassuring tone.',
});

export function getSpeechInstructions(style = 'normal', variant = defaultSpeechInstructionVariant) {
    const styleInstruction = speechStyles[style];
    if (!Object.hasOwn(speechStyles, style) || !['A', 'B'].includes(variant)) return null;
    const base = variant === 'A' ? voiceIdentity : voiceNaturalComparisonInstructions.B;
    return style === 'normal' ? base : `${base} ${styleInstruction}`;
}
