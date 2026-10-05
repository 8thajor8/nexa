import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const speechConfig = Object.freeze({
    provider: 'openai',
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    format: 'wav',
    maxTextLength: 3000,
    maxTemporaryAgeMs: 24 * 60 * 60 * 1000,
    temporaryDirectory: path.join(projectRoot, 'data', 'temp', 'audio'),
    persistentDirectory: path.join(projectRoot, 'data', 'audio'),
});

export const voiceIdentity = [
    'Female-presenting young adult voice.',
    'Intelligent and confident, natural and conversational.',
    'Warm but not overly sweet; clear diction; technological but human.',
    'Use a subtle Argentine / Buenos Aires Spanish accent. Do not exaggerate the accent.',
    'Avoid corporate assistant or announcer delivery.',
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
