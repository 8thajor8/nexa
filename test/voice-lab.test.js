import test from 'node:test';
import assert from 'node:assert/strict';
import {
    encodeMonoPcm16Wav,
    measureSamples,
    mixSamples,
    parseMonoPcm16Wav,
    voiceLabVariants,
} from '../src/speech/voice-lab.js';

test('voice lab WAV encoding and parsing preserve valid mono PCM16 samples', () => {
    const samples = Float32Array.from([0, 0.25, -0.25, 0.9, -0.9]);
    const encoded = encodeMonoPcm16Wav(samples, 24000);
    const decoded = parseMonoPcm16Wav(encoded);
    assert.equal(decoded.sampleRate, 24000);
    assert.equal(decoded.samples.length, samples.length);
    assert.ok(Math.abs(decoded.samples[1] - samples[1]) < 0.0001);
    assert.throws(() => parseMonoPcm16Wav(Buffer.from('not a wav')), /invalid_wav/);
});

test('dual and synthetic voice lab mixes produce distinct bounded samples', () => {
    const original = Float32Array.from([0.1, 0.2, -0.1, -0.2]);
    const shifted = Float32Array.from([-0.2, 0.1, 0.2, -0.1]);
    const dual = mixSamples(original, shifted, 0.74, 0.42);
    const synthetic = mixSamples(original, shifted, 0.64, 0.62);
    assert.notDeepEqual(Array.from(dual), Array.from(original));
    assert.notDeepEqual(Array.from(dual), Array.from(synthetic));
    assert.ok(measureSamples(dual).peak < 1);
    assert.equal(measureSamples(dual).clippedSamples, 0);
    assert.throws(() => mixSamples(original, new Float32Array(3), 1, 1), /sample_length_mismatch/);
});

test('Signalsmith voice lab keeps pitch and formant controls independent', () => {
    assert.equal(voiceLabVariants['formant-up'].semitones, 0);
    assert.equal(voiceLabVariants['formant-down'].semitones, 0);
    assert.ok(voiceLabVariants['formant-up'].formantSemitones > 0);
    assert.ok(voiceLabVariants['formant-down'].formantSemitones < 0);
    assert.notEqual(voiceLabVariants.dual.semitones, voiceLabVariants.synthetic.semitones);
});
