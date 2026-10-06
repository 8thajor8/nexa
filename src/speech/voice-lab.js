import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = resolve(root, 'data/voice-casting/nexa-digital-original.wav');
const outputDir = resolve(root, 'data/voice-casting');

export const voiceLabVariants = Object.freeze({
    'formant-up': Object.freeze({ semitones: 0, formantSemitones: 7, mix: 'processed' }),
    'formant-down': Object.freeze({ semitones: 0, formantSemitones: -7, mix: 'processed' }),
    dual: Object.freeze({ semitones: 8, formantSemitones: 4, mix: 'dual' }),
    synthetic: Object.freeze({ semitones: 6, formantSemitones: 8, mix: 'synthetic' }),
});

export function parseMonoPcm16Wav(wav) {
    if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new TypeError('invalid_wav');
    }
    let format;
    let data;
    for (let offset = 12; offset + 8 <= wav.length;) {
        const id = wav.toString('ascii', offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (body + size > wav.length) throw new TypeError('invalid_wav_chunk');
        if (id === 'fmt ' && size >= 16) {
            format = {
                encoding: wav.readUInt16LE(body),
                channels: wav.readUInt16LE(body + 2),
                sampleRate: wav.readUInt32LE(body + 4),
                blockAlign: wav.readUInt16LE(body + 12),
                bitsPerSample: wav.readUInt16LE(body + 14),
            };
        }
        if (id === 'data') data = { offset: body, size };
        offset = body + size + (size % 2);
    }
    if (!format || !data || format.encoding !== 1 || format.channels !== 1 || format.bitsPerSample !== 16
        || format.blockAlign !== 2 || !format.sampleRate || data.size % 2) throw new TypeError('unsupported_wav_format');
    const samples = new Float32Array(data.size / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(data.offset + i * 2) / 32768;
    return { samples, sampleRate: format.sampleRate };
}

export function encodeMonoPcm16Wav(samples, sampleRate) {
    const wav = Buffer.alloc(44 + samples.length * 2);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++) {
        const bounded = Math.max(-1, Math.min(1, samples[i]));
        wav.writeInt16LE(Math.round(bounded * (bounded < 0 ? 32768 : 32767)), 44 + i * 2);
    }
    return wav;
}

export function mixSamples(original, processed, originalGain, processedGain) {
    if (original.length !== processed.length) throw new RangeError('sample_length_mismatch');
    const mixed = new Float32Array(original.length);
    let peak = 0;
    for (let i = 0; i < mixed.length; i++) {
        mixed[i] = original[i] * originalGain + processed[i] * processedGain;
        peak = Math.max(peak, Math.abs(mixed[i]));
    }
    if (peak > 0.94) {
        const scale = 0.94 / peak;
        for (let i = 0; i < mixed.length; i++) mixed[i] *= scale;
    }
    return mixed;
}

export function measureSamples(samples, reference) {
    let square = 0;
    let peak = 0;
    let clippedSamples = 0;
    let nonFiniteSamples = 0;
    let differenceSquare = 0;
    for (let i = 0; i < samples.length; i++) {
        const value = samples[i];
        if (!Number.isFinite(value)) { nonFiniteSamples++; continue; }
        square += value * value;
        peak = Math.max(peak, Math.abs(value));
        if (value <= -1 || value >= 1) clippedSamples++;
        if (reference) {
            const difference = value - reference[i];
            differenceSquare += difference * difference;
        }
    }
    return {
        rms: Math.sqrt(square / samples.length),
        peak,
        clippedSamples,
        nonFiniteSamples,
        rmsDifference: reference ? Math.sqrt(differenceSquare / samples.length) : 0,
    };
}

const captureWorklet = `
class NexaCapture extends AudioWorkletProcessor {
  constructor() { super(); this.data = new Float32Array(1024); this.used = 0; this.firstFrame = 0; }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      if (this.used === 0) this.firstFrame = currentFrame + i;
      this.data[this.used++] = input[i];
      if (this.used === this.data.length) {
        const chunk = this.data;
        this.port.postMessage({ frame: this.firstFrame, samples: chunk.buffer }, [chunk.buffer]);
        this.data = new Float32Array(1024);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('nexa-capture', NexaCapture);
`;

function htmlPage() {
    return `<!doctype html><meta charset="utf-8"><script type="module">
        import Stretch from '/signalsmith.mjs';
        window.signalsmithStretch = Stretch;
        window.voiceLabReady = true;
    </script>`;
}

function makeServer(source) {
    const enginePath = resolve(root, 'node_modules/signalsmith-stretch/SignalsmithStretch.mjs');
    return createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        if (pathname === '/') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(htmlPage());
        } else if (pathname === '/signalsmith.mjs') {
            response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(await readFile(enginePath));
        } else if (pathname === '/capture.js') {
            response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(captureWorklet);
        } else if (pathname === '/source.wav') {
            response.writeHead(200, { 'content-type': 'audio/wav' }).end(source);
        } else response.writeHead(404).end();
    });
}

async function renderWithSignalsmith(page, variant, sourceWav) {
    return page.evaluate(async ({ settings }) => {
        const start = performance.now();
        const raw = await fetch('/source.wav').then(response => response.arrayBuffer());
        const context = new AudioContext({ sampleRate: settings.sampleRate });
        const audioBuffer = await context.decodeAudioData(raw);
        const input = new Float32Array(audioBuffer.getChannelData(0));
        const initStart = performance.now();
        const stretch = await window.signalsmithStretch(context, {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        const engineInitializationMs = performance.now() - initStart;
        const bufferPreparationStart = performance.now();
        await stretch.configure({ blockMs: 120, intervalMs: 30, splitComputation: false });
        await stretch.addBuffers([input], [input.buffer]);
        const bufferPreparationMs = performance.now() - bufferPreparationStart;
        const latencySeconds = await stretch.latency();
        await context.audioWorklet.addModule('/capture.js');
        const recorder = new AudioWorkletNode(context, 'nexa-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        recorder.connect(context.destination);
        const chunks = [];
        let firstFrame = null;
        recorder.port.onmessage = event => {
            firstFrame ??= event.data.frame;
            chunks.push(new Float32Array(event.data.samples));
        };
        stretch.connect(recorder);
        await context.resume();
        const outputTime = context.currentTime + 0.2;
        const outputFrame = Math.round(outputTime * context.sampleRate);
        await stretch.schedule({
            active: true,
            input: 0,
            output: outputTime,
            rate: 1,
            semitones: settings.semitones,
            formantSemitones: settings.formantSemitones,
            formantCompensation: false,
            formantBaseHz: 250,
        });
        const expectedFrames = audioBuffer.length;
        await new Promise(resolve => setTimeout(resolve, (audioBuffer.duration + 0.85) * 1000));
        const all = new Float32Array(chunks.reduce((count, chunk) => count + chunk.length, 0));
        let writeOffset = 0;
        for (const chunk of chunks) { all.set(chunk, writeOffset); writeOffset += chunk.length; }
        const alignedOffset = firstFrame === null ? 0 : outputFrame - firstFrame;
        const output = new Float32Array(expectedFrames);
        if (alignedOffset >= 0) output.set(all.subarray(alignedOffset, alignedOffset + expectedFrames));
        else output.set(all.subarray(0, expectedFrames), -alignedOffset);
        const processingMs = performance.now() - start;
        await context.close();
        return { output, sampleRate: settings.sampleRate, engineInitializationMs, bufferPreparationMs, latencySeconds, processingMs, captureFrames: all.length, captureFirstFrame: firstFrame, scheduledOutputFrame: outputFrame, alignedOffset };
    }, { settings: { ...variant, sampleRate: sourceWav.sampleRate } });
}

async function runVoiceLab() {
    const originalBytes = await readFile(sourcePath);
    const source = parseMonoPcm16Wav(originalBytes);
    const originalHash = createHash('sha256').update(originalBytes).digest('hex');
    const server = makeServer(originalBytes);
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    let page;
    const report = {
        source: sourcePath,
        sourceSha256: originalHash,
        durationSeconds: source.samples.length / source.sampleRate,
        engine: 'signalsmith-stretch 1.3.2 (official WASM/AudioWorklet)',
        timingNote: 'render wall time includes real-time AudioWorklet processing and capture; it is not an offline DSP throughput benchmark.',
        variants: [],
    };
    try {
        const originalOutput = resolve(outputDir, 'nexa-lab-original.wav');
        await writeFile(originalOutput, originalBytes);
        const savedOriginal = await readFile(originalOutput);
        const decodedOriginal = parseMonoPcm16Wav(savedOriginal);
        const originalMetrics = measureSamples(decodedOriginal.samples, source.samples);
        report.variants.push({
            name: 'original',
            path: originalOutput,
            durationSeconds: decodedOriginal.samples.length / decodedOriginal.sampleRate,
            engineInitializationMs: 0,
            bufferPreparationMs: 0,
            processingTimeMs: 0,
            realTimeFactor: 0,
            algorithmLatencyMs: 0,
            peak: Number(originalMetrics.peak.toFixed(6)),
            clippedSamples: originalMetrics.clippedSamples,
            rms: Number(originalMetrics.rms.toFixed(6)),
            rmsDifferenceVsOriginal: Number(originalMetrics.rmsDifference.toFixed(6)),
            sha256: createHash('sha256').update(savedOriginal).digest('hex'),
        });
        const requestedVariant = process.argv.find(argument => argument.startsWith('--variant='))?.split('=')[1];
        const entries = Object.entries(voiceLabVariants).filter(([name]) => !requestedVariant || name === requestedVariant);
        if (requestedVariant && entries.length === 0) throw new TypeError('unknown_voice_lab_variant');
        for (const [name, settings] of entries) {
            page = await browser.newPage();
            await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
            await page.waitForFunction(() => window.voiceLabReady === true);
            const rendered = await renderWithSignalsmith(page, settings, { ...source, wav: originalBytes });
            await page.close();
            page = null;
            const processed = rendered.output;
            let result = processed;
            if (settings.mix === 'dual') result = mixSamples(source.samples, processed, 0.74, 0.42);
            if (settings.mix === 'synthetic') result = mixSamples(source.samples, processed, 0.64, 0.62);
            const preflight = measureSamples(result);
            if (preflight.nonFiniteSamples > 0) throw new Error(`non_finite_voice_lab_output:${name}:${preflight.nonFiniteSamples}`);
            if (preflight.peak < 0.005) throw new Error(`silent_voice_lab_output:${name}`);
            const outputPath = resolve(outputDir, `nexa-lab-${name}.wav`);
            await writeFile(outputPath, encodeMonoPcm16Wav(result, source.sampleRate));

            // Re-read the final artifact from disk before measuring or hashing it.
            const finalBytes = await readFile(outputPath);
            const final = parseMonoPcm16Wav(finalBytes);
            const metrics = measureSamples(final.samples, source.samples);
            const rawMetrics = measureSamples(rendered.output);
            if (rawMetrics.nonFiniteSamples > 0) throw new Error(`non_finite_voice_lab_output:${name}:${rawMetrics.nonFiniteSamples}`);
            if (metrics.peak < 0.005) throw new Error(`silent_voice_lab_output:${name};frames=${rendered.captureFrames};first=${rendered.captureFirstFrame};scheduled=${rendered.scheduledOutputFrame};offset=${rendered.alignedOffset}`);
            if (metrics.clippedSamples !== 0) throw new Error(`clipped_voice_lab_output:${name}`);
            if (Math.abs(final.samples.length / final.sampleRate - report.durationSeconds) > 0.001) {
                throw new Error(`duration_changed:${name}`);
            }
            report.variants.push({
                name,
                path: outputPath,
                parameters: { pitchSemitones: settings.semitones, formantSemitones: settings.formantSemitones, mix: settings.mix },
                durationSeconds: final.samples.length / final.sampleRate,
                engineInitializationMs: Number(rendered.engineInitializationMs.toFixed(1)),
                bufferPreparationMs: Number(rendered.bufferPreparationMs.toFixed(1)),
                processingTimeMs: Number(rendered.processingMs.toFixed(1)),
                realTimeFactor: Number((rendered.processingMs / 1000 / report.durationSeconds).toFixed(3)),
                algorithmLatencyMs: Number((rendered.latencySeconds * 1000).toFixed(1)),
                captureFrames: rendered.captureFrames,
                captureFirstFrame: rendered.captureFirstFrame,
                scheduledOutputFrame: rendered.scheduledOutputFrame,
                alignedOffset: rendered.alignedOffset,
                configuredBlockMs: 120,
                peak: Number(metrics.peak.toFixed(6)),
                clippedSamples: metrics.clippedSamples,
                nonFiniteSamples: rawMetrics.nonFiniteSamples,
                rms: Number(metrics.rms.toFixed(6)),
                rmsDifferenceVsOriginal: Number(metrics.rmsDifference.toFixed(6)),
                sha256: createHash('sha256').update(finalBytes).digest('hex'),
            });
        }
        const sourceAfter = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
        report.sourceUnchanged = sourceAfter === originalHash;
        if (!report.sourceUnchanged) throw new Error('voice_lab_source_changed');
        if (report.variants.length === Object.keys(voiceLabVariants).length + 1) {
            const hashes = new Set(report.variants.map(item => item.sha256));
            if (hashes.size !== report.variants.length) throw new Error('duplicate_voice_lab_output');
            if (report.variants.slice(1).some(item => item.rmsDifferenceVsOriginal === 0)) {
                throw new Error('unchanged_voice_lab_output');
            }
        }
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (page) await page.close();
        await browser.close();
        await new Promise(resolveClose => server.close(resolveClose));
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    runVoiceLab().catch(error => {
        console.error('voice_lab_failed:', error.message);
        process.exitCode = 1;
    });
}
