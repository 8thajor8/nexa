import 'dotenv/config';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAISpeechProvider } from '../src/speech/providers/openai.js';
import { createVoiceIdentityProcessor } from '../src/speech/voice-identity.js';
import { getSpeechInstructions } from '../src/speech/config.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(repositoryRoot, 'apps/desktop/resources/voice-acknowledgements');
const phrases = Object.freeze([
    ['clear.wav', 'Claro, dame un segundo.'],
    ['review.wav', 'Dale, lo reviso.'],
    ['moment.wav', 'Un momento.'],
]);

if (!process.env.OPENAI_API_KEY) {
    console.error('Falta OPENAI_API_KEY en el entorno local. No se generaron audios.');
    process.exitCode = 1;
} else {
    const provider = createOpenAISpeechProvider();
    const identity = createVoiceIdentityProcessor();
    const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'nexa-voice-ack-'));
    try {
        for (const [fileName, text] of phrases) {
            const generated = await provider.synthesize({ text, instructions: getSpeechInstructions('normal'), format: 'wav' });
            const processed = await identity.process(Buffer.from(generated), { enabled: true });
            if (processed.length < 44 || processed.toString('ascii', 0, 4) !== 'RIFF'
                || processed.toString('ascii', 8, 12) !== 'WAVE' || processed.readUInt16LE(22) !== 2) {
                throw new Error('voice_acknowledgement_audio_invalid');
            }
            await writeFile(path.join(stagingDirectory, fileName), processed, { flag: 'wx', mode: 0o600 });
        }
        await mkdir(outputDirectory, { recursive: true });
        for (const [fileName] of phrases) {
            await rename(path.join(stagingDirectory, fileName), path.join(outputDirectory, fileName));
        }
        console.info(`Audios de confirmación preparados localmente: ${phrases.length}.`);
    } catch (error) {
        const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
        const code = typeof error?.code === 'string' && /^[a-z0-9_-]{1,60}$/iu.test(error.code) ? ` [${error.code}]` : '';
        console.error(`No se pudieron preparar las confirmaciones de voz${status}${code}.`);
        process.exitCode = 1;
    } finally {
        await identity.close().catch(() => undefined);
        await rm(stagingDirectory, { recursive: true, force: true });
    }
}
