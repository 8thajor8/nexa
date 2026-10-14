import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMonoPcm16Wav, parseMonoPcm16Wav, measureSamples } from '../src/speech/voice-lab.js';
import { createSignalsmithVoiceRenderer, createVoiceIdentityProcessor, nexaVoiceIdentity } from '../src/speech/voice-identity.js';

function sourceTone(durationMs = 240, sampleRate = 24_000) {
    const samples = new Float32Array(Math.round(sampleRate * durationMs / 1000));
    for (let index = 0; index < samples.length; index++) {
        const envelope = Math.min(1, index / 400, (samples.length - index) / 400);
        samples[index] = 0.2 * envelope * Math.sin(2 * Math.PI * 220 * index / sampleRate);
    }
    return { samples, sampleRate, wav: encodeMonoPcm16Wav(samples, sampleRate) };
}

test('production identity centralizes Nova/Signalsmith, companion, polish, and spatial settings', () => {
    assert.equal(nexaVoiceIdentity.engine, 'signalsmith-stretch 1.3.2 (official WASM/AudioWorklet)');
    assert.deepEqual([
        nexaVoiceIdentity.pitchSemitones,
        nexaVoiceIdentity.formantSemitones,
        nexaVoiceIdentity.secondaryMix,
        nexaVoiceIdentity.microDelayMs,
        nexaVoiceIdentity.microDelayWet,
    ], [1.1, 2.6, 0.17, 9, 0.22]);
    assert.deepEqual(nexaVoiceIdentity.spacePolish.map(({ frequencyHz, gainDb, q }) => [frequencyHz, gainDb, q]), [[2600, 1.4, 1.2], [4400, 1, 1]]);
    assert.deepEqual(nexaVoiceIdentity.spatial, {
        wet: 0.12, preDelayMs: 25, rt60Ms: 520,
        earlyReflectionDelaysMs: [19, 27, 43, 53],
        earlyReflectionGains: [0.42, 0.33, 0.25, 0.19],
        feedbackCombDelaysMs: [59, 73], feedback: [0.4567, 0.3792],
    });
});

test('identity switch off returns provider audio byte for byte and does not invoke DSP', async () => {
    const source = sourceTone();
    let calls = 0;
    const processor = createVoiceIdentityProcessor({ renderer: { async render() { calls++; throw new Error('must stay off'); } } });
    const output = await processor.process(source.wav, { enabled: false });
    assert.deepEqual(output, source.wav);
    assert.equal(calls, 0);
});

test('injected provider-independent renderer produces duration-preserving stereo identity output', async () => {
    const source = sourceTone();
    const processor = createVoiceIdentityProcessor({ renderer: {
        async render(samples) { return Float32Array.from(samples, sample => sample * 0.92 + 0.015); },
    } });
    const result = await processor.process(source.wav);
    assert.equal(result.toString('ascii', 0, 4), 'RIFF');
    assert.equal(result.readUInt16LE(22), 2);
    assert.equal(result.readUInt32LE(24), source.sampleRate);
    assert.equal(result.readUInt32LE(40), source.samples.length * 4);
    const left = new Float32Array(source.samples.length);
    const right = new Float32Array(source.samples.length);
    for (let index = 0; index < source.samples.length; index++) {
        left[index] = result.readInt16LE(44 + index * 4) / 32768;
        right[index] = result.readInt16LE(46 + index * 4) / 32768;
    }
    assert.notDeepEqual(left, source.samples);
    assert.notDeepEqual(left, right);
    assert.ok(measureSamples(left).peak < 1);
    assert.ok(measureSamples(right).peak < 1);
    assert.equal(parseMonoPcm16Wav(source.wav).samples.length, left.length);
});

test('official Signalsmith WASM renderer processes on an inaudible real-time AudioContext without TTS or audible playback', async () => {
    const source = sourceTone(720);
    const renderer = createSignalsmithVoiceRenderer({ renderingMode: 'realtime' });
    try {
        const shifted = await renderer.render(source.samples, source.sampleRate);
        assert.equal(shifted.length, source.samples.length);
        assert.ok(measureSamples(shifted, source.samples).rmsDifference > 0.002);
        assert.ok(measureSamples(shifted).peak < 1);
        assert.equal(measureSamples(shifted).nonFiniteSamples, 0);
    } finally { await renderer.close(); }
});

test('offline Signalsmith rendering preserves the realtime sample output and captures faster than audio duration', async () => {
    const source = sourceTone(720);
    const realtimeRenderer = createSignalsmithVoiceRenderer({ renderingMode: 'realtime' });
    const offlineRenderer = createSignalsmithVoiceRenderer({ renderingMode: 'offline' });
    try {
        const realtime = await realtimeRenderer.render(source.samples, source.sampleRate);
        const offline = await offlineRenderer.render(source.samples, source.sampleRate);
        assert.equal(offline.length, source.samples.length);
        assert.ok(measureSamples(offline).peak < 1);
        assert.equal(measureSamples(offline).nonFiniteSamples, 0);
        assert.ok(measureSamples(offline, realtime).rmsDifference < 0.0001);
        assert.ok(offlineRenderer.getLastMetrics().audioCaptureWaitMs < source.samples.length / source.sampleRate * 500);
    } finally {
        await Promise.all([realtimeRenderer.close(), offlineRenderer.close()]);
    }
});

test('offline identity rendering preserves all frames for a long response', async () => {
    const source = sourceTone(5_200);
    const renderer = createSignalsmithVoiceRenderer({ renderingMode: 'offline' });
    try {
        const shifted = await renderer.render(source.samples, source.sampleRate);
        assert.equal(shifted.length, source.samples.length);
        assert.equal(measureSamples(shifted).nonFiniteSamples, 0);
        assert.ok(measureSamples(shifted).peak < 1);
        assert.ok(renderer.getLastMetrics().dspProcessingMs < source.samples.length / source.sampleRate * 1_000);
        assert.ok(renderer.getLastMetrics().audioCaptureWaitMs < source.samples.length / source.sampleRate * 500);
    } finally { await renderer.close(); }
});

test('identity renderer reports an unavailable local browser with a safe code', async () => {
    const source = sourceTone(120);
    const renderer = createSignalsmithVoiceRenderer({ browserType: { async launch() { throw new Error('private executable path'); } } });
    await assert.rejects(renderer.render(source.samples, source.sampleRate), error => error.code === 'voice_identity_browser_unavailable');
    await renderer.close();
});

test('identity renderer reuses one browser page across serialized renders and closes its resources', async () => {
    const source = sourceTone(120);
    let launches = 0;
    let pages = 0;
    let navigations = 0;
    let pageCloses = 0;
    let browserCloses = 0;
    let activeEvaluations = 0;
    let maxEvaluations = 0;
    const browser = {
        async newPage() {
            pages++;
            return {
                async goto() { navigations++; },
                async waitForFunction() {},
                async evaluate(_operation, options) {
                    activeEvaluations++;
                    maxEvaluations = Math.max(maxEvaluations, activeEvaluations);
                    await new Promise(resolve => setTimeout(resolve, 5));
                    activeEvaluations--;
                    return { output: options.source, latencySeconds: 0.01, processingMs: 7,
                        setupMs: 3, captureWaitMs: 4, capturedFrames: options.source.length, alignedOffset: 0 };
                },
                async close() { pageCloses++; },
            };
        },
        async close() { browserCloses++; },
    };
    const renderer = createSignalsmithVoiceRenderer({ browserType: {
        async launch() { launches++; return browser; },
    } });
    const [first, second] = await Promise.all([
        renderer.render(source.samples, source.sampleRate),
        renderer.render(source.samples, source.sampleRate),
    ]);
    assert.deepEqual(first, second);
    assert.equal(launches, 1);
    assert.equal(pages, 1);
    assert.equal(navigations, 1);
    assert.equal(maxEvaluations, 1);
    assert.equal(renderer.getLastMetrics().dspProcessingMs, 7);
    assert.equal(renderer.getLastMetrics().audioCaptureWaitMs, 4);
    assert.equal(renderer.getLastMetrics().browserStartupMs, 0);
    assert.equal(renderer.getLastMetrics().rendererPreparationMs, 0);
    await renderer.close();
    assert.equal(pageCloses, 1);
    assert.equal(browserCloses, 1);
});
