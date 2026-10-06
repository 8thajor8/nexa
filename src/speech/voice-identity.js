import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechConfig } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const signalsmithModule = path.join(root, 'node_modules/signalsmith-stretch/SignalsmithStretch.mjs');

function parseMonoPcm16Wav(wav) {
    if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new TypeError('invalid_wav');
    let format;
    let data;
    for (let offset = 12; offset + 8 <= wav.length;) {
        const id = wav.toString('ascii', offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (size === 0xffffffff || body + size > wav.length) throw new TypeError('invalid_wav_chunk');
        if (id === 'fmt ' && size >= 16) format = {
            encoding: wav.readUInt16LE(body), channels: wav.readUInt16LE(body + 2),
            sampleRate: wav.readUInt32LE(body + 4), blockAlign: wav.readUInt16LE(body + 12),
            bitsPerSample: wav.readUInt16LE(body + 14),
        };
        if (id === 'data') data = { offset: body, size };
        offset = body + size + (size % 2);
    }
    if (!format || !data || format.encoding !== 1 || format.channels !== 1 || format.bitsPerSample !== 16
        || format.blockAlign !== 2 || !format.sampleRate || data.size % 2) throw new TypeError('unsupported_wav_format');
    const samples = new Float32Array(data.size / 2);
    for (let index = 0; index < samples.length; index++) samples[index] = wav.readInt16LE(data.offset + index * 2) / 32768;
    return { samples, sampleRate: format.sampleRate };
}
const captureWorklet = `
class NexaIdentityCapture extends AudioWorkletProcessor {
  constructor() { super(); this.chunk = new Float32Array(1024); this.used = 0; this.firstFrame = 0; }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!input) {
      if (this.used > 0) {
        const chunk = this.chunk.slice(0, this.used);
        this.port.postMessage({ frame: this.firstFrame, samples: chunk.buffer }, [chunk.buffer]);
        this.chunk = new Float32Array(1024);
        this.used = 0;
      }
      return true;
    }
    for (let i = 0; i < input.length; i++) {
      if (this.used === 0) this.firstFrame = currentFrame + i;
      this.chunk[this.used++] = input[i];
      if (this.used === this.chunk.length) {
        const chunk = this.chunk;
        this.port.postMessage({ frame: this.firstFrame, samples: chunk.buffer }, [chunk.buffer]);
        this.chunk = new Float32Array(1024);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('nexa-identity-capture', NexaIdentityCapture);
`;

// The production identity is deliberately one fixed, reviewable recipe.
// The voice remains dry and dominant; Signalsmith only creates its companion layer.
export const nexaVoiceIdentity = Object.freeze({
    enabled: speechConfig.voiceIdentityEnabled,
    engine: 'signalsmith-stretch 1.3.2 (official WASM/AudioWorklet)',
    pitchSemitones: 1.1,
    formantSemitones: 2.6,
    formantBaseHz: 250,
    secondaryMix: 0.17,
    microDelayMs: 9,
    microDelayWet: 0.22,
    spacePolish: Object.freeze([
        Object.freeze({ frequencyHz: 2600, gainDb: 1.4, q: 1.2 }),
        Object.freeze({ frequencyHz: 4400, gainDb: 1.0, q: 1.0 }),
    ]),
    spatial: Object.freeze({
        wet: 0.07,
        preDelayMs: 22,
        rt60Ms: 400,
        earlyReflectionDelaysMs: Object.freeze([19, 27, 43, 53]),
        earlyReflectionGains: Object.freeze([0.32, 0.24, 0.17, 0.12]),
        feedbackCombDelaysMs: Object.freeze([59, 73]),
        feedback: Object.freeze([0.361, 0.2827]),
    }),
});

function createRendererServer() {
    return createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        if (pathname === '/') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><script type="module">import Stretch from '/stretch.mjs';window.Stretch=Stretch;</script>`);
        } else if (pathname === '/stretch.mjs') {
            response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(await readFile(signalsmithModule));
        } else if (pathname === '/capture.js') {
            response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(captureWorklet);
        } else response.writeHead(404).end();
    });
}

// Signalsmith's official Worklet currently emits silence in OfflineAudioContext,
// so use an active, inaudible AudioContext and capture its exact output in memory.
export function createSignalsmithVoiceRenderer({ browserType = chromium } = {}) {
    let lastMetrics = null;
    return {
        async render(samples, sampleRate, settings = nexaVoiceIdentity) {
            const server = createRendererServer();
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            let browser;
            try {
                browser = await browserType.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
                const page = await browser.newPage();
                await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
                await page.waitForFunction(() => typeof window.Stretch === 'function');
                const rendered = await page.evaluate(async ({ source, sampleRate: rate, pitch, formant, baseHz }) => {
                    const input = Float32Array.from(source);
                    const started = performance.now();
                    const context = new AudioContext({ sampleRate: rate });
                    const audioBuffer = context.createBuffer(1, input.length, rate);
                    audioBuffer.copyToChannel(input, 0);
                    const stretch = await window.Stretch(context, {
                        numberOfInputs: 0,
                        numberOfOutputs: 1,
                        outputChannelCount: [1],
                    });
                    await stretch.configure({ blockMs: 120, intervalMs: 30, splitComputation: false });
                    await stretch.addBuffers([input], [input.buffer]);
                    const latencySeconds = await stretch.latency();
                    await context.audioWorklet.addModule('/capture.js');
                    const capture = new AudioWorkletNode(context, 'nexa-identity-capture', {
                        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
                    });
                    capture.connect(context.destination);
                    const chunks = [];
                    let firstFrame = null;
                    capture.port.onmessage = event => {
                        firstFrame ??= event.data.frame;
                        chunks.push(new Float32Array(event.data.samples));
                    };
                    stretch.connect(capture);
                    await context.resume();
                    const outputTime = context.currentTime + 0.2;
                    const outputFrame = Math.round(outputTime * rate);
                    await stretch.schedule({
                        active: true, input: 0, output: outputTime, rate: 1,
                        semitones: pitch, formantSemitones: formant,
                        formantCompensation: false, formantBaseHz: baseHz,
                    });
                    await new Promise(resolve => setTimeout(resolve, (audioBuffer.duration + 0.9) * 1000));
                    const captured = new Float32Array(chunks.reduce((count, chunk) => count + chunk.length, 0));
                    let offset = 0;
                    for (const chunk of chunks) { captured.set(chunk, offset); offset += chunk.length; }
                    const alignedOffset = firstFrame === null ? 0 : outputFrame - firstFrame;
                    const output = new Float32Array(audioBuffer.length);
                    if (alignedOffset >= 0) output.set(captured.subarray(alignedOffset, alignedOffset + output.length));
                    else output.set(captured.subarray(0, output.length), -alignedOffset);
                    if (firstFrame === null || captured.length < outputFrame - firstFrame + output.length) throw new Error('signalsmith_capture_incomplete');
                    const processingMs = performance.now() - started;
                    await context.close();
                    return { output: Array.from(output), latencySeconds, processingMs, capturedFrames: captured.length, alignedOffset };
                }, {
                    source: Array.from(samples), sampleRate,
                    pitch: settings.pitchSemitones,
                    formant: settings.formantSemitones,
                    baseHz: settings.formantBaseHz,
                });
                await page.close();
                if (rendered.output.length !== samples.length || rendered.output.every(value => value === 0)) throw new Error(`signalsmith_render_invalid:${JSON.stringify({ output: rendered.output.length, captured: rendered.capturedFrames, offset: rendered.alignedOffset })}`);
                lastMetrics = { processingMs: rendered.processingMs, algorithmLatencyMs: rendered.latencySeconds * 1000 };
                const output = Float32Array.from(rendered.output);
                return output;
            } finally {
                if (browser) await browser.close();
                await new Promise(resolve => server.close(resolve));
            }
        },
        getLastMetrics() { return lastMetrics ? { ...lastMetrics } : null; },
    };
}

function peakFilter(samples, sampleRate, { frequencyHz, gainDb, q }) {
    const amplitude = 10 ** (gainDb / 40);
    const omega = 2 * Math.PI * frequencyHz / sampleRate;
    const alpha = Math.sin(omega) / (2 * q);
    const a0 = 1 + alpha / amplitude;
    const b0 = (1 + alpha * amplitude) / a0;
    const b1 = (-2 * Math.cos(omega)) / a0;
    const b2 = (1 - alpha * amplitude) / a0;
    const a1 = (-2 * Math.cos(omega)) / a0;
    const a2 = (1 - alpha / amplitude) / a0;
    const output = new Float32Array(samples.length);
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    for (let index = 0; index < samples.length; index++) {
        const x = samples[index];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        output[index] = y;
    }
    return output;
}

function processSecondary(source, shifted, sampleRate, settings) {
    const delayFrames = Math.round(sampleRate * settings.microDelayMs / 1000);
    const contribution = new Float32Array(source.length);
    for (let index = 0; index < source.length; index++) {
        const delayed = index >= delayFrames ? shifted[index - delayFrames] : 0;
        contribution[index] = settings.secondaryMix * (shifted[index] * (1 - settings.microDelayWet) + delayed * settings.microDelayWet);
    }
    let polished = contribution;
    for (const filter of settings.spacePolish) polished = peakFilter(polished, sampleRate, filter);
    const mixed = new Float32Array(source.length);
    for (let index = 0; index < source.length; index++) mixed[index] = source[index] + polished[index];
    return mixed;
}

function processSpatialStereo(mono, sampleRate, settings) {
    const spatial = settings.spatial;
    const predelay = Math.round(sampleRate * spatial.preDelayMs / 1000);
    const reflectionFrames = spatial.earlyReflectionDelaysMs.map(value => Math.round(sampleRate * value / 1000));
    const combFrames = spatial.feedbackCombDelaysMs.map(value => Math.round(sampleRate * value / 1000));
    const [leftComb, rightComb] = combFrames;
    const wetLeft = new Float64Array(mono.length);
    const wetRight = new Float64Array(mono.length);
    let peak = 0;
    for (let index = 0; index < mono.length; index++) {
        const delayed = index >= predelay ? mono[index - predelay] : 0;
        const reflection = reflectionFrames.map((delay, tap) => index >= predelay + delay ? mono[index - predelay - delay] * spatial.earlyReflectionGains[tap] : 0);
        const leftInput = delayed + reflection[0] + reflection[2];
        const rightInput = delayed + reflection[1] + reflection[3];
        wetLeft[index] = leftInput + (index >= leftComb ? wetLeft[index - leftComb] * spatial.feedback[0] : 0);
        wetRight[index] = rightInput + (index >= rightComb ? wetRight[index - rightComb] * spatial.feedback[1] : 0);
        peak = Math.max(peak, Math.abs(mono[index] * (1 - spatial.wet) + wetLeft[index] * spatial.wet), Math.abs(mono[index] * (1 - spatial.wet) + wetRight[index] * spatial.wet));
    }
    const scale = peak > 0.97 ? 0.97 / peak : 1;
    const stereo = new Float32Array(mono.length * 2);
    for (let index = 0; index < mono.length; index++) {
        stereo[index * 2] = (mono[index] * (1 - spatial.wet) + wetLeft[index] * spatial.wet) * scale;
        stereo[index * 2 + 1] = (mono[index] * (1 - spatial.wet) + wetRight[index] * spatial.wet) * scale;
    }
    return stereo;
}

function encodeStereoPcm16Wav(samples, sampleRate) {
    const wav = Buffer.alloc(44 + samples.length * 2);
    wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8, 'ascii');
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii'); wav.writeUInt32LE(samples.length * 2, 40);
    for (let index = 0; index < samples.length; index++) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        wav.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + index * 2);
    }
    return wav;
}

export function createVoiceIdentityProcessor({ renderer = createSignalsmithVoiceRenderer() } = {}) {
    return {
        async process(audio, { enabled = nexaVoiceIdentity.enabled } = {}) {
            if (!Buffer.isBuffer(audio) && !(audio instanceof Uint8Array)) throw new TypeError('invalid_audio_buffer');
            if (!enabled) return Buffer.from(audio);
            const { samples, sampleRate } = parseMonoPcm16Wav(Buffer.from(audio));
            const shifted = await renderer.render(samples, sampleRate, nexaVoiceIdentity);
            if (!(shifted instanceof Float32Array) || shifted.length !== samples.length || shifted.some(value => !Number.isFinite(value))) throw new TypeError('invalid_signalsmith_output');
            const companion = processSecondary(samples, shifted, sampleRate, nexaVoiceIdentity);
            const stereo = processSpatialStereo(companion, sampleRate, nexaVoiceIdentity);
            const result = encodeStereoPcm16Wav(stereo, sampleRate);
            // Validate the final artifact format and duration before storage.
            if (result.toString('ascii', 0, 4) !== 'RIFF' || result.toString('ascii', 8, 12) !== 'WAVE'
                || result.readUInt16LE(22) !== 2 || result.readUInt16LE(34) !== 16
                || result.readUInt32LE(24) !== sampleRate || result.readUInt32LE(40) !== samples.length * 4) {
                throw new TypeError('invalid_voice_identity_wav');
            }
            return result;
        },
    };
}
