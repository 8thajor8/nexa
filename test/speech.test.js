import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAudioStore } from '../src/speech/audio-store.js';
import { createSpeechService } from '../src/speech/service.js';
import { speechConfig, speechStyles, voiceIdentity, getSpeechInstructions } from '../src/speech/config.js';
import { createOpenAISpeechProvider } from '../src/speech/providers/openai.js';
import { generateSpeechTool, playAudioTool, speechRegistrations } from '../src/speech/index.js';
import { checkToolPermission } from '../src/tools/permissions.js';
import { createWindowsAudioPlayer } from '../src/speech/windows-player.js';
import { digitalCastingOutputs, generateVoiceCastingSamples } from '../src/speech/voice-casting.js';
import { normalizeWavLengths } from '../src/speech/wav.js';
import { createVoiceFxProcessor, measureVoiceFxDifference, voiceFxProfiles } from '../src/speech/voice-fx.js';

async function fixture(t, { maxTemporaryAgeMs = 60_000 } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nexa-speech-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directories = {
        temporaryDirectory: path.join(root, 'data', 'temp', 'audio'),
        persistentDirectory: path.join(root, 'data', 'audio'),
        maxTemporaryAgeMs,
    };
    const store = createAudioStore(directories);
    const calls = { generated: [], played: [] };
    const provider = { async synthesize(options) { calls.generated.push(options); return Buffer.from('RIFF-mock-wav'); } };
    const player = async filePath => { calls.played.push(filePath); return { success: true }; };
    return { root, directories, store, calls, provider, player, service: createSpeechService({ provider, store, player }) };
}

function makePcmWav({ durationMs = 120, sampleRate = 24_000, channels = 1 } = {}) {
    const frames = Math.round(sampleRate * durationMs / 1000);
    const dataSize = frames * channels * 2;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(channels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * channels * 2, 28);
    wav.writeUInt16LE(channels * 2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(dataSize, 40);
    for (let frame = 0; frame < frames; frame++) {
        const sample = Math.round(6000 * Math.sin(2 * Math.PI * 440 * frame / sampleRate));
        for (let channel = 0; channel < channels; channel++) wav.writeInt16LE(sample, 44 + (frame * channels + channel) * 2);
    }
    return wav;
}

test('generates temporary audio with opaque ID, never returns a path, then plays and cleans it', async t => {
    const f = await fixture(t);
    const generated = await f.service.generate({ text: 'Hola Jor', style: 'normal' });
    assert.deepEqual(generated, {
        success: true,
        audioId: generated.audioId,
        temporary: true,
        format: 'wav',
    });
    assert.match(generated.audioId, /^audio_[a-f0-9]{24}$/u);
    assert.equal(JSON.stringify(generated).includes('audio\\'), false);
    const audioPath = f.store.get(generated.audioId).filePath;
    assert.equal((await readFile(audioPath)).toString(), 'RIFF-mock-wav');

    const played = await f.service.play(generated.audioId);
    assert.deepEqual(played, { success: true, audioId: generated.audioId, played: true, temporary: true });
    assert.equal(f.calls.played[0], audioPath);
    await assert.rejects(access(audioPath));
    assert.equal(f.store.get(generated.audioId), null);
});

test('persisted audio survives playback and service shutdown cleanup', async t => {
    const f = await fixture(t);
    const generated = await f.service.generate({ text: 'Conservar', persist: true });
    const second = await f.service.generate({ text: 'Conservar también', persist: true });
    assert.equal(generated.temporary, false);
    const audioPath = f.store.get(generated.audioId).filePath;
    assert.equal((await f.service.play(generated.audioId)).success, true);
    await f.service.close();
    assert.equal((await readFile(audioPath)).toString(), 'RIFF-mock-wav');
    const reopenedStore = createAudioStore(f.directories);
    await reopenedStore.initialize();
    assert.equal(reopenedStore.get(generated.audioId).filePath, audioPath);
    assert(reopenedStore.get(second.audioId));
});

test('failed or thrown playback attempts remove temporary audio but preserve persistent audio', async t => {
    const f = await fixture(t);
    const service = createSpeechService({
        provider: f.provider,
        store: f.store,
        player: async () => { throw new Error('native playback failed'); },
    });
    const temporary = await service.generate({ text: 'Una sola vez' });
    const temporaryPath = f.store.get(temporary.audioId).filePath;
    const failedTemporary = await service.play(temporary.audioId);
    assert.equal(failedTemporary.error.code, 'audio_playback_failed');
    await assert.rejects(access(temporaryPath));
    assert.equal(f.store.get(temporary.audioId), null);

    const persistent = await service.generate({ text: 'Conservar', persist: true });
    const persistentPath = f.store.get(persistent.audioId).filePath;
    const failedPersistent = await service.play(persistent.audioId);
    assert.equal(failedPersistent.error.code, 'audio_playback_failed');
    await access(persistentPath);
});

test('supports every fixed style while keeping a shared voice identity', async t => {
    const f = await fixture(t);
    for (const style of Object.keys(speechStyles)) {
        assert.equal((await f.service.generate({ text: 'Hola', style })).success, true);
    }
    assert.equal(Object.keys(speechStyles).join(','), 'normal,professional,alert,sassy,calm');
    assert(f.calls.generated.every(item => item.instructions.includes(voiceIdentity)));
    assert.notEqual(getSpeechInstructions('normal'), getSpeechInstructions('calm'));
});

test('rejects unsupported styles, oversized text and invalid options before provider call', async t => {
    const f = await fixture(t);
    assert.equal((await f.service.generate({ text: 'hola', style: 'pirate' })).error.code, 'invalid_speech_style');
    assert.equal((await f.service.generate({ text: 'x'.repeat(speechConfig.maxTextLength + 1) })).error.code, 'text_too_long');
    assert.equal((await f.service.generate({ text: 'hola', persist: 'yes' })).error.code, 'invalid_persist_option');
    assert.equal(f.calls.generated.length, 0);
});

test('provider failures are sanitized and do not leak their error details', async t => {
    const f = await fixture(t);
    f.provider.synthesize = async () => { throw new Error('api_key=super-secret response body'); };
    const result = await f.service.generate({ text: 'hola' });
    assert.deepEqual(result, { success: false, error: { code: 'speech_generation_failed', message: 'El proveedor de voz no pudo generar el audio.' } });
    assert.doesNotMatch(JSON.stringify(result), /secret|api_key|response body/iu);
});

test('playback only resolves IDs registered during this process; paths and unknown IDs are rejected', async t => {
    const f = await fixture(t);
    assert.equal((await f.service.play('C:\\Users\\Jor\\private.wav')).error.code, 'audio_not_found');
    assert.equal((await f.service.play('audio_000000000000000000000000')).error.code, 'audio_not_found');
    assert.equal(f.calls.played.length, 0);
});

test('provider abstraction can be replaced without changing the service API', async t => {
    const f = await fixture(t);
    let used = false;
    const service = createSpeechService({ store: f.store, player: f.player, provider: {
        async synthesize({ text, instructions }) { used = true; return Buffer.from(`${text}:${instructions.includes('female-presenting')}`); },
    } });
    const result = await service.generate({ text: 'other engine' });
    assert.equal(used, true);
    assert.equal(result.success, true);
});

test('startup cleanup deletes only expired Nexa temp files within its dedicated directory', async t => {
    const f = await fixture(t, { maxTemporaryAgeMs: 1000 });
    await f.store.initialize();
    const oldName = `audio_${'a'.repeat(24)}.wav`;
    const stalePath = path.join(f.directories.temporaryDirectory, oldName);
    const unrelatedPath = path.join(f.directories.temporaryDirectory, 'keep.wav');
    const outsidePath = path.join(f.root, oldName);
    await writeFile(stalePath, 'stale');
    await writeFile(unrelatedPath, 'keep');
    await writeFile(outsidePath, 'outside');
    const oldDate = new Date(Date.now() - 10_000);
    await utimes(stalePath, oldDate, oldDate);
    await utimes(outsidePath, oldDate, oldDate);
    const result = await f.store.cleanupOldTemporaryAudio();
    assert.deepEqual(result, { success: true, removed: 1 });
    assert.deepEqual((await readdir(f.directories.temporaryDirectory)).sort(), ['keep.wav']);
    assert.equal((await readFile(outsidePath)).toString(), 'outside');
});

test('shutdown deletes unplayed temporary files but leaves persistent audio', async t => {
    const f = await fixture(t);
    const temporary = await f.service.generate({ text: 'Temporal' });
    const persistent = await f.service.generate({ text: 'Persistente', persist: true });
    const temporaryPath = f.store.get(temporary.audioId).filePath;
    const persistentPath = f.store.get(persistent.audioId).filePath;
    await f.service.close();
    await assert.rejects(access(temporaryPath));
    await access(persistentPath);
});

test('OpenAI provider uses centralized model, voice, instructions, WAV format and current SDK endpoint', async () => {
    let request;
    const provider = createOpenAISpeechProvider({ clientFactory: () => ({ audio: { speech: { async create(options) {
        request = options;
        return { async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; } };
    } } } }) });
    assert.deepEqual(await provider.synthesize({ text: 'Hola', instructions: 'Nexa voice' }), Buffer.from([1, 2, 3]));
    assert.deepEqual(request, {
        model: 'gpt-4o-mini-tts', voice: 'marin', input: 'Hola', instructions: 'Nexa voice', response_format: 'wav',
    });
    await provider.synthesize({ text: 'Hola', instructions: 'Nexa voice', voice: 'coral' });
    assert.equal(request.voice, 'coral');
});

test('normalizes unknown OpenAI WAV length markers for Windows file playback', () => {
    const wav = Buffer.alloc(48);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(0xffffffff, 4);
    wav.write('WAVEfmt ', 8, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(0xffffffff, 40);
    const normalized = normalizeWavLengths(wav);
    assert.equal(normalized.readUInt32LE(4), 40);
    assert.equal(normalized.readUInt32LE(40), 4);
    assert.equal(normalizeWavLengths(Buffer.from('not a wav')).toString(), 'not a wav');
});

test('VoiceFX off preserves audio bytes and never mutates the source', () => {
    const processor = createVoiceFxProcessor();
    const source = makePcmWav();
    const before = Buffer.from(source);
    const output = processor.process(source, 'off');
    assert.deepEqual(output, before);
    assert.notEqual(output, source);
    assert.deepEqual(source, before);
});

test('VoiceFX presets are deterministic, preserve WAV validity and duration', () => {
    const processor = createVoiceFxProcessor();
    const source = makePcmWav({ durationMs: 800, channels: 2 });
    const sourceBefore = Buffer.from(source);
    for (const profile of ['subtle', 'digital', 'strong']) {
        const output = processor.process(source, profile);
        assert.equal(output.toString('ascii', 0, 4), 'RIFF');
        assert.equal(output.toString('ascii', 8, 12), 'WAVE');
        assert.equal(output.readUInt32LE(4) + 8, output.length);
        assert.equal(output.readUInt32LE(40), source.readUInt32LE(40));
        assert.equal(output.length, source.length);
        assert.notDeepEqual(output, source);
        assert.deepEqual(processor.process(source, profile), output);
    }
    assert.deepEqual(source, sourceBefore);
});

test('VoiceFX profiles alter real sample data with reasonably increasing strength', () => {
    const processor = createVoiceFxProcessor();
    const source = makePcmWav({ durationMs: 800 });
    const outputs = ['subtle', 'digital', 'strong'].map(profile => processor.process(source, profile));
    const difference = output => {
        let squareSum = 0;
        let peak = 0;
        let changed = 0;
        const samples = source.readUInt32LE(40) / 2;
        for (let i = 0; i < samples; i++) {
            const sourceSample = source.readInt16LE(44 + i * 2);
            const delta = output.readInt16LE(44 + i * 2) - sourceSample;
            squareSum += delta * delta;
            peak = Math.max(peak, Math.abs(delta));
            if (delta !== 0) changed++;
        }
        return { rms: Math.sqrt(squareSum / samples), peak, changed };
    };
    const differences = outputs.map(difference);
    const sourceRms = Math.sqrt(Array.from({ length: source.readUInt32LE(40) / 2 }, (_, index) => {
        const sample = source.readInt16LE(44 + index * 2);
        return sample * sample;
    }).reduce((total, square) => total + square, 0) / (source.readUInt32LE(40) / 2));
    assert(differences.every(value => value.rms > 0 && value.peak > 0 && value.changed > 0));
    assert(differences[0].rms < differences[1].rms);
    assert(differences[1].rms < differences[2].rms);
    assert(differences[0].rms / sourceRms > 0.01);
    assert(differences[1].rms / sourceRms > 0.05);
    assert(differences[2].rms / sourceRms > 0.15);
    assert.notDeepEqual(outputs[0], outputs[1]);
    assert.notDeepEqual(outputs[1], outputs[2]);
    assert.notDeepEqual(outputs[0], outputs[2]);
});

test('sci-fi FX families are distinct, duration-safe WAVs without clipping', () => {
    const processor = createVoiceFxProcessor();
    const source = makePcmWav({ durationMs: 800 });
    const sourceBefore = Buffer.from(source);
    const profiles = ['synthetic_companion', 'digital_spatial', 'nexa_hybrid'];
    const outputs = profiles.map(profile => processor.process(source, profile));
    assert.deepEqual(source, sourceBefore);
    for (let index = 0; index < profiles.length; index++) {
        const result = outputs[index];
        const metrics = measureVoiceFxDifference(source, result);
        assert.equal(result.toString('ascii', 0, 4), 'RIFF');
        assert.equal(result.toString('ascii', 8, 12), 'WAVE');
        assert.equal(result.readUInt32LE(4) + 8, result.length);
        assert.equal(metrics.durationSeconds, 0.8);
        assert(metrics.rmsDifference > 0);
        assert(metrics.changedPercent > 0);
        assert.equal(metrics.clippedSamples, 0);
        assert(metrics.peakFinal < 32767);
        assert.deepEqual(processor.process(source, profiles[index]), result);
    }
    assert.equal(outputs[0].readUInt16LE(22), 1, 'companion layer remains mono');
    assert.equal(outputs[1].readUInt16LE(22), 2, 'spatial profile renders stereo');
    assert.equal(outputs[2].readUInt16LE(22), 2, 'hybrid profile renders stereo');
    assert.notDeepEqual(outputs[0], outputs[1]);
    assert.notDeepEqual(outputs[0], outputs[2]);
    assert.notDeepEqual(outputs[1], outputs[2]);
});

test('VoiceFX rejects invalid WAV input and unknown profiles', () => {
    const processor = createVoiceFxProcessor();
    assert.throws(() => processor.process(Buffer.from('bad audio'), 'digital'), /invalid_wav/u);
    assert.throws(() => processor.process(makePcmWav(), 'metallic'), /invalid_voice_fx_profile/u);
    assert.throws(() => processor.process('bad audio', 'off'), /invalid_audio_buffer/u);
});

test('VoiceFX DSP values are centralized in immutable named presets', () => {
    assert.deepEqual(Object.keys(voiceFxProfiles), ['off', 'subtle', 'digital', 'strong', 'synthetic_companion', 'digital_spatial', 'nexa_hybrid']);
    assert(Object.isFrozen(voiceFxProfiles));
    assert(Object.values(voiceFxProfiles).every(Object.isFrozen));
    assert.equal(voiceFxProfiles.off.delayMix, 0);
    assert(voiceFxProfiles.subtle.delayMix < voiceFxProfiles.digital.delayMix);
    assert(voiceFxProfiles.digital.delayMix < voiceFxProfiles.strong.delayMix);
    assert.equal(voiceFxProfiles.synthetic_companion.family, 'filtered_companion');
    assert.equal(voiceFxProfiles.digital_spatial.family, 'early_reflections');
    assert.equal(voiceFxProfiles.nexa_hybrid.family, 'hybrid');
});

test('SpeechService integrates VoiceFX with off as the unchanged default', async t => {
    const f = await fixture(t);
    const source = makePcmWav();
    let usedProfile;
    const service = createSpeechService({
        store: f.store,
        provider: { async synthesize() { return source; } },
        voiceFxProcessor: { process(audio, profile) { usedProfile = profile; return createVoiceFxProcessor().process(audio, profile); } },
    });
    const generated = await service.generate({ text: 'Hola Nexa' });
    assert.equal(generated.success, true);
    assert.equal(usedProfile, 'off');
    assert.deepEqual(await readFile(f.store.get(generated.audioId).filePath), source);

    const fxService = createSpeechService({
        store: f.store,
        provider: { async synthesize() { return source; } },
        voiceFxProfile: 'strong',
    });
    const fxGenerated = await fxService.generate({ text: 'Un poco más digital' });
    assert.equal(fxGenerated.success, true);
    assert.notDeepEqual(await readFile(f.store.get(fxGenerated.audioId).filePath), source);
});

test('Windows playback opens WAV through MCI, waits for completion, closes it, and rejects other platforms', async () => {
    const commands = [];
    const windowsPlayer = createWindowsAudioPlayer({ platform: 'win32', sendCommand: async command => { commands.push(command); return 0; } });
    assert.deepEqual(await windowsPlayer('internal-controlled-audio.wav'), { success: true });
    assert.match(commands[0], /^open "internal-controlled-audio\.wav" type waveaudio alias NexaAudio/u);
    assert.match(commands[1], /^play NexaAudio[0-9a-f]{12} wait$/u);
    assert.match(commands[2], /^close NexaAudio[0-9a-f]{12}$/u);
    assert.equal(commands[1].split(' ')[1], commands[2].split(' ')[1]);
    const failed = await createWindowsAudioPlayer({ platform: 'win32', sendCommand: async command => command.startsWith('play ') ? 263 : 0 })('internal-controlled-audio.wav');
    assert.equal(failed.error.code, 'audio_playback_failed');
    assert.equal(commands.length, 3);
    const unsupported = await createWindowsAudioPlayer({ platform: 'linux' })('ignored.wav');
    assert.equal(unsupported.error.code, 'unsupported_platform');
    const invalidPath = await createWindowsAudioPlayer({ platform: 'win32', sendCommand: async () => 0 })('bad" path.wav');
    assert.equal(invalidPath.error.code, 'invalid_audio_reference');
});

test('sci-fi FX casting writes four named versions of one unchanged source file without TTS', async t => {
    const f = await fixture(t);
    const outputDirectory = path.join(f.root, 'voice-casting');
    const profiles = [];
    const source = makePcmWav();
    let clock = 0;
    const actualProcessor = createVoiceFxProcessor();
    const samples = await generateVoiceCastingSamples({
        sourceAudio: source,
        outputDirectory,
        now: () => { clock += 5; return clock; },
        processor: { process(audio, profile) { profiles.push(profile); assert.deepEqual(audio, source); return actualProcessor.process(audio, profile); } },
    });
    assert.deepEqual(samples.map(item => item.name), ['nexa-fx-original', 'nexa-fx-edi', 'nexa-fx-jarvis', 'nexa-fx-hybrid']);
    assert.deepEqual(samples.map(item => item.profile), ['off', 'synthetic_companion', 'digital_spatial', 'nexa_hybrid']);
    assert.deepEqual(profiles, ['synthetic_companion', 'digital_spatial', 'nexa_hybrid']);
    assert.deepEqual(source, makePcmWav());
    assert.deepEqual(samples.map(item => item.processingMs), [0, 5, 5, 5]);
    assert.deepEqual(await readFile(samples[0].path), source);
    for (const sample of samples) assert.equal((await readFile(sample.path)).toString('ascii', 0, 4), 'RIFF');
});

test('digital casting rejects a missing source instead of calling TTS or attempting FX', async t => {
    const f = await fixture(t);
    let processed = false;
    const result = await generateVoiceCastingSamples({ outputDirectory: path.join(f.root, 'cast'), processor: { process() { processed = true; throw new Error('should not run'); } } }).catch(error => error);
    assert.match(result.message, /WAV fuente/u);
    assert.equal(processed, false);
});

test('public schemas constrain style and expose only opaque identifiers', () => {
    assert.deepEqual(generateSpeechTool.parameters.properties.style.enum, ['normal', 'professional', 'alert', 'sassy', 'calm']);
    assert.equal(generateSpeechTool.parameters.properties.text.maxLength, 3000);
    assert.deepEqual(Object.keys(playAudioTool.parameters.properties), ['audioId']);
    assert.equal(playAudioTool.parameters.properties.audioId.pattern, '^audio_[a-f0-9]{24}$');
    assert.deepEqual(speechRegistrations.map(item => item.definition.name), ['generate_speech', 'play_audio']);
    assert.equal(checkToolPermission({ permission: 'external_read' }).allowed, true);
    assert.equal(checkToolPermission({ permission: 'action' }).allowed, true);
});
