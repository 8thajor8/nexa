import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAudioStore } from '../src/speech/audio-store.js';
import { speechConfig } from '../src/speech/config.js';
import { createSpeechService } from '../src/speech/service.js';

export const voiceNaturalEvaluationPhrases = Object.freeze([
    'Che, ¿sabías que los pulpos tienen tres corazones?',
    'No te recomendaría borrar todas las copias de seguridad. Si algo falla, podrías perder tus archivos.',
    'Dale, perfecto. Lo dejamos así por ahora.',
    '¿Querés que revise las opciones antes de decidir?',
    'La reunión es a las 15:30 y el presupuesto es de 1.250 euros.',
    'Mmm, no estoy tan segura. Yo probaría otra alternativa.',
]);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isInside(parent, candidate) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parseArguments(args) {
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        if (!['--variant', '--phrase'].includes(name) || typeof args[index + 1] !== 'string' || values.has(name)) return null;
        values.set(name, args[index + 1]);
    }
    const variant = values.get('--variant');
    const phrase = Number(values.get('--phrase'));
    if (!['A', 'B'].includes(variant) || !Number.isInteger(phrase) || phrase < 1 || phrase > voiceNaturalEvaluationPhrases.length) return null;
    return { variant, phraseIndex: phrase - 1 };
}

function wavDurationMs(audio) {
    if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF'
        || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('comparison_audio_not_wav');
    let byteRate = 0;
    let dataBytes = 0;
    for (let offset = 12; offset + 8 <= audio.length;) {
        const id = audio.toString('ascii', offset, offset + 4);
        const size = audio.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (size === 0xffffffff || body + size > audio.length) throw new Error('comparison_audio_wav_invalid');
        if (id === 'fmt ' && size >= 16) byteRate = audio.readUInt32LE(body + 8);
        if (id === 'data') dataBytes = size;
        offset = body + size + (size % 2);
    }
    if (!byteRate || !dataBytes) throw new Error('comparison_audio_wav_invalid');
    return Math.round(dataBytes / byteRate * 1_000);
}

export async function generateVoiceNaturalSample({ variant, phraseIndex, localAppData = process.env.LOCALAPPDATA } = {}) {
    if (!['A', 'B'].includes(variant) || !Number.isInteger(phraseIndex)
        || phraseIndex < 0 || phraseIndex >= voiceNaturalEvaluationPhrases.length) throw new TypeError('comparison_selection_invalid');
    if (typeof localAppData !== 'string' || !localAppData.trim()) throw new Error('LOCALAPPDATA_unavailable');
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_unavailable');

    const outputRoot = path.resolve(localAppData, 'Nexa', 'voice-natural-02');
    if (isInside(repositoryRoot, outputRoot)) throw new Error('comparison_output_must_be_outside_repository');
    const variantName = variant === 'A' ? 'A-current' : 'B-natural';
    const sampleName = `${variantName}-${String(phraseIndex + 1).padStart(2, '0')}`;
    const audioPath = path.join(outputRoot, `${sampleName}.wav`);
    const metricsPath = path.join(outputRoot, `${sampleName}.json`);
    await mkdir(outputRoot, { recursive: true });

    const store = createAudioStore({
        temporaryDirectory: path.join(outputRoot, 'working'),
        persistentDirectory: path.join(outputRoot, 'registry'),
        maxTemporaryAgeMs: Number.MAX_SAFE_INTEGER,
    });
    const service = createSpeechService({
        store,
        voiceIdentityEnabled: true,
        speechInstructionVariant: variant,
    });
    try {
        const text = voiceNaturalEvaluationPhrases[phraseIndex];
        const result = await service.generate({ text, style: 'normal', persist: false, includeAudio: true });
        if (!result.success || !(result.audio instanceof Uint8Array)) throw new Error(result.error?.code ?? 'comparison_generation_failed');
        const audio = Buffer.from(result.audio);
        const metrics = service.getLastMetrics() ?? {};
        const identityDspProcessingMs = metrics.identityDspProcessingMs;
        const identityPostProcessingMs = metrics.identityPostProcessingMs;
        const record = {
            variant,
            phrase: phraseIndex + 1,
            text,
            model: metrics.model,
            voice: metrics.voice,
            identityProfile: metrics.identityProfile,
            identityProcessing: metrics.identityProcessing,
            audioDurationMs: wavDurationMs(audio),
            synthesisMs: metrics.synthesisMs,
            ttsSdkResponseMs: metrics.ttsSdkResponseMs,
            ttsBodyReadMs: metrics.ttsBodyReadMs,
            identityDspSetupMs: metrics.identityDspSetupMs,
            identityDspProcessingMs,
            dspProcessingMs: identityDspProcessingMs,
            identityPostProcessingMs,
            identityProcessingMs: metrics.identityProcessingMs,
            audioReadyMs: metrics.audioReadyMs,
        };
        await writeFile(audioPath, audio, { flag: 'wx', mode: 0o600 });
        try { await writeFile(metricsPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
            await rm(audioPath, { force: true }).catch(() => {});
            throw error;
        }
        if (result.audioId) await service.removeTemporary(result.audioId);
        return { audioPath, metricsPath, record };
    } finally {
        await service.close();
    }
}

async function main(args) {
    const selection = parseArguments(args);
    if (!selection) throw new Error('Uso: node scripts/voice-natural-comparison.mjs --variant A|B --phrase 1..6');
    const result = await generateVoiceNaturalSample(selection);
    process.stdout.write(`${JSON.stringify(result.record)}\nAudio: ${result.audioPath}\nMétricas: ${result.metricsPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(error => {
        process.stderr.write(`VOICE-NATURAL-02: ${error.message}\n`);
        process.exitCode = 1;
    });
}
