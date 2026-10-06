import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOpenAISpeechProvider } from './providers/openai.js';

export const castingText = 'Jor... ¿en serio me hiciste probar cuatro voces para esto? Bueno, está bien. Soy Nexa. Y esta vez creo que estamos bastante más cerca. Igual no te emociones, todavía me falta aprender a escucharte.';

export const castingVariants = Object.freeze([
    {
        name: 'nova-natural',
        voice: 'nova',
        instructions: 'Speak in Spanish like a young woman around 25 to 30, having an informal conversation with someone she knows well. Relaxed, warm, spontaneous and natural. Use human rhythm, varied intonation and natural pauses. Prioritize sounding like a real person talking, not reading text. Avoid virtual-assistant, announcer or narrator delivery.',
    },
    {
        name: 'nova-canchera',
        voice: 'nova',
        instructions: 'Speak in Spanish like a young woman who is confident, quick-witted and fun, with a slight smile in her voice. Add subtle mischief and light sarcasm. Play naturally with pauses and gently emphasize a few words when it fits. Keep it conversational and spontaneous; never caricatured or overacted.',
    },
    {
        name: 'nova-portena',
        voice: 'nova',
        instructions: 'Speak casually in natural Buenos Aires Rioplatense Spanish. Use voseo and Argentine musicality naturally when the text allows. Sound young and relaxed. Keep naturalness more important than accent intensity; do not imitate stereotypes or exaggerate the Argentine accent.',
    },
    {
        name: 'nova-nexa',
        voice: 'nova',
        instructions: 'Speak in Spanish as a young, natural woman with a subtle Buenos Aires accent: intelligent, warm, confident, witty and spontaneous, with a little sass. Sound like a real person talking to someone she knows well, not an AI reading an answer. Show personality and humor without constantly performing. Avoid corporate or virtual assistant, GPS, announcer, narrator or customer-service delivery; avoid overly polished diction, exaggerated enthusiasm, robotic cadence and an exaggerated Argentine accent.',
    },
]);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const voiceCastingDirectory = path.join(projectRoot, 'data', 'voice-casting');

export async function generateVoiceCastingSamples({ provider = createOpenAISpeechProvider(), outputDirectory = voiceCastingDirectory } = {}) {
    await mkdir(outputDirectory, { recursive: true });
    const generated = [];
    for (const variant of castingVariants) {
        const audio = await provider.synthesize({ text: castingText, instructions: variant.instructions, voice: variant.voice, format: 'wav' });
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0) {
            throw new Error(`El provider devolvió audio no válido para ${variant.name}.`);
        }
        const outputPath = path.join(outputDirectory, `${variant.name}.wav`);
        await writeFile(outputPath, audio, { mode: 0o600 });
        generated.push({ name: variant.name, voice: variant.voice, path: outputPath });
    }
    return generated;
}
