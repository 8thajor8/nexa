import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateVoiceCastingSamples, voiceCastingDirectory } from './voice-casting.js';

try {
    const sourceAudio = await readFile(path.join(voiceCastingDirectory, 'nexa-digital-original.wav'));
    const samples = await generateVoiceCastingSamples({ sourceAudio });
    console.log('Muestras FX de una única toma nova-portena:');
    for (const sample of samples) console.log(`- ${sample.name} (${sample.profile}): ${sample.path}${sample.processingMs ? ` — FX ${sample.processingMs.toFixed(1)} ms` : ''}`);
    console.log('Casting de desarrollo solamente; la voz predeterminada de Nexa no cambia.');
} catch (error) {
    const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
    const code = typeof error?.code === 'string' && /^[a-z0-9_-]{1,60}$/iu.test(error.code) ? ` [${error.code}]` : '';
    console.error(`No se pudieron procesar las muestras FX${status}${code}. Verificá que exista nexa-digital-original.wav y que sea un WAV compatible.`);
    process.exitCode = 1;
}
