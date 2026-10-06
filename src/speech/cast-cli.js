import 'dotenv/config';
import { generateVoiceCastingSamples } from './voice-casting.js';

try {
    const samples = await generateVoiceCastingSamples();
    console.log('Muestras de voz generadas:');
    for (const sample of samples) console.log(`- ${sample.voice}: ${sample.path}`);
    console.log('Escuchalas y elegí; Nexa conserva marin como voz predeterminada.');
} catch (error) {
    const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
    const code = typeof error?.code === 'string' && /^[a-z0-9_-]{1,60}$/iu.test(error.code) ? ` [${error.code}]` : '';
    console.error(`No se pudieron generar las muestras de voz${status}${code}. Revisá la conexión y la configuración de OpenAI.`);
    process.exitCode = 1;
}
