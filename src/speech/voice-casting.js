import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOpenAISpeechProvider } from './providers/openai.js';

export const castingVoices = Object.freeze(['coral', 'nova', 'shimmer', 'sage']);
export const castingText = 'Hola Jor, soy Nexa. Bueno... parece que finalmente me diste una voz.\nYa era hora, ¿no? Igual te aviso: ahora que puedo hablar, no prometo quedarme callada.';
export const castingInstructions = [
    'Speak in Spanish with a subtle Buenos Aires / Rioplatense Argentine accent.',
    'Sound like a young woman in her mid-to-late twenties: casual, confident, clever and spontaneous.',
    'Be warm and energetic, with a slight smile in the voice. Conversational rather than polished.',
    'Be playful and subtly sarcastic when appropriate. Use natural changes in rhythm, intonation and pauses.',
    'It should feel like a real person talking to someone she knows well.',
    'Avoid sounding like a virtual assistant, GPS, corporate presenter, radio announcer or narrator; avoid overly formal, overly polished or robotic delivery.',
    'Make the Argentine accent noticeable but natural and not exaggerated.',
].join(' ');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const voiceCastingDirectory = path.join(projectRoot, 'data', 'voice-casting');

export async function generateVoiceCastingSamples({ provider = createOpenAISpeechProvider(), outputDirectory = voiceCastingDirectory } = {}) {
    await mkdir(outputDirectory, { recursive: true });
    const generated = [];
    for (const voice of castingVoices) {
        const audio = await provider.synthesize({ text: castingText, instructions: castingInstructions, voice, format: 'wav' });
        if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array) || audio.byteLength === 0) {
            throw new Error(`El provider devolvió audio no válido para ${voice}.`);
        }
        const outputPath = path.join(outputDirectory, `${voice}.wav`);
        await writeFile(outputPath, audio, { mode: 0o600 });
        generated.push({ voice, path: outputPath });
    }
    return generated;
}
