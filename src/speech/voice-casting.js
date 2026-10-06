import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createOpenAISpeechProvider } from './providers/openai.js';
import { castingVariants } from './voice-casting-profiles.js';
import { createVoiceFxProcessor } from './voice-fx.js';

export const digitalCastingText = 'Jor... creo que ahora sí estamos llegando a algún lado. Sigo siendo yo, solamente que ahora sueno un poquito más... digital. Admitilo, te gusta.';
export const digitalCastingOutputs = Object.freeze([
    Object.freeze({ name: 'nexa-digital-original', profile: 'off' }),
    Object.freeze({ name: 'nexa-digital-subtle', profile: 'subtle' }),
    Object.freeze({ name: 'nexa-digital', profile: 'digital' }),
    Object.freeze({ name: 'nexa-digital-strong', profile: 'strong' }),
]);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const voiceCastingDirectory = path.join(projectRoot, 'data', 'voice-casting');

export async function generateVoiceCastingSamples({
    provider = createOpenAISpeechProvider(),
    processor = createVoiceFxProcessor(),
    outputDirectory = voiceCastingDirectory,
    now = () => performance.now(),
} = {}) {
    await mkdir(outputDirectory, { recursive: true });
    // One TTS request is shared by all FX variants, so interpretation is fixed.
    const source = await provider.synthesize({
        text: digitalCastingText,
        instructions: castingVariants[2].instructions,
        voice: 'nova',
        format: 'wav',
    });
    if (!(Buffer.isBuffer(source) || source instanceof Uint8Array) || source.byteLength === 0) {
        throw new Error('El provider devolvió audio no válido para el casting digital.');
    }

    const originalPath = path.join(outputDirectory, `${digitalCastingOutputs[0].name}.wav`);
    await writeFile(originalPath, source, { mode: 0o600 });
    const generated = [{ ...digitalCastingOutputs[0], path: originalPath, processingMs: 0 }];

    for (const variant of digitalCastingOutputs.slice(1)) {
        const started = now();
        const processed = processor.process(source, variant.profile);
        const processingMs = Math.max(0, now() - started);
        if (!(Buffer.isBuffer(processed) || processed instanceof Uint8Array) || processed.byteLength === 0) {
            throw new Error(`El procesador devolvió audio no válido para ${variant.name}.`);
        }
        const outputPath = path.join(outputDirectory, `${variant.name}.wav`);
        await writeFile(outputPath, processed, { mode: 0o600 });
        generated.push({ ...variant, path: outputPath, processingMs });
    }
    return generated;
}
