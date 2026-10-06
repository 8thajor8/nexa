import 'dotenv/config';
import { generateVoiceCastingSamples } from './voice-casting.js';

try {
    const samples = await generateVoiceCastingSamples();
    console.log('Muestras FX de una única toma nova-portena:');
    for (const sample of samples) console.log(`- ${sample.name} (${sample.profile}): ${sample.path}${sample.processingMs ? ` — FX ${sample.processingMs.toFixed(1)} ms` : ''}`);
    console.log('Casting de desarrollo solamente; la voz predeterminada de Nexa no cambia.');
} catch (error) {
    const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
    const code = typeof error?.code === 'string' && /^[a-z0-9_-]{1,60}$/iu.test(error.code) ? ` [${error.code}]` : '';
    console.error(`No se pudieron generar las muestras de voz${status}${code}. Revisá la conexión y la configuración de OpenAI.`);
    process.exitCode = 1;
}
