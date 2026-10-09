import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSpeaker } from '../src/voice/index.js';
import { createSpeechService } from '../src/speech/service.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('speaker delegates synthesis and playback and correlates speaking/completed events', async () => {
    const calls = [];
    const service = {
        async generate(input) { calls.push(['generate', input]); return { success: true, audioId: 'audio_test' }; },
        async play(audioId) { calls.push(['play', audioId]); return { success: true, played: true }; },
        async removeTemporary() { return true; },
    };
    const speaker = createVoiceSpeaker({
        speechService: service,
        sessionId: 'speaker-session',
        idFactory: () => 'turn-1',
        now: () => 42,
    });
    const events = [];
    speaker.on('voice.speaking', event => events.push(event));
    speaker.on('voice.speech.completed', event => events.push(event));

    const result = await speaker.speak('Hola Nexa', { style: 'calm' });
    assert.deepEqual(calls, [
        ['generate', { text: 'Hola Nexa', style: 'calm', persist: false }],
        ['play', 'audio_test'],
    ]);
    assert.deepEqual(result, { sessionId: 'speaker-session', turnId: 'turn-1', completed: true });
    assert.deepEqual(events.map(event => event.type), ['voice.speaking', 'voice.speech.completed']);
    assert.ok(events.every(event => event.sessionId === 'speaker-session' && event.turnId === 'turn-1' && event.timestamp === 42));
});

test('speaker emits sanitized generation and playback errors', async () => {
    const generationSpeaker = createVoiceSpeaker({ speechService: {
        async generate() { return { success: false, error: { code: 'provider_error', message: 'api_key=secret' } }; },
        async play() { throw new Error('must not play'); },
        async removeTemporary() { return true; },
    } });
    const generationEvents = [];
    generationSpeaker.on('voice.speech.error', event => generationEvents.push(event));
    await assert.rejects(generationSpeaker.speak('Hola'), error => error.code === 'voice_speech_generation_failed');
    assert.equal(generationEvents[0].phase, 'synthesizing');
    assert.doesNotMatch(JSON.stringify(generationEvents[0]), /secret|api_key/iu);

    const playbackSpeaker = createVoiceSpeaker({ speechService: {
        async generate() { return { success: true, audioId: 'audio_test' }; },
        async play() { return { success: false }; },
        async removeTemporary() { return true; },
    } });
    const playbackEvents = [];
    playbackSpeaker.on('voice.speech.error', event => playbackEvents.push(event));
    await assert.rejects(playbackSpeaker.speak('Hola'), error => error.code === 'voice_speech_playback_failed');
    assert.equal(playbackEvents[0].phase, 'speaking');
});

test('cancellation during synthesis returns promptly and ignores late output', async () => {
    const pendingGeneration = deferred();
    let playCalls = 0;
    const removed = [];
    const speaker = createVoiceSpeaker({ speechService: {
        generate() { return pendingGeneration.promise; },
        async play() { playCalls++; return { success: true }; },
        async removeTemporary(id) { removed.push(id); return true; },
    }, idFactory: () => 'turn-cancel' });
    const events = [];
    speaker.on('voice.speech.cancelled', event => events.push(event));
    speaker.on('voice.speaking', event => events.push(event));
    const task = speaker.speak('No reproducir');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(speaker.cancel('user'), true);
    assert.equal(await task, null);
    pendingGeneration.resolve({ success: true, audioId: 'audio_late' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(playCalls, 0);
    assert.deepEqual(removed, ['audio_late']);
    assert.deepEqual(events.map(event => event.type), ['voice.speech.cancelled']);
    assert.equal(events[0].phase, 'synthesizing');
    assert.equal(events[0].playbackInterrupted, false);
});

test('cancellation during playback is logical and reports that playback was not interrupted', async () => {
    const pendingPlayback = deferred();
    let playbackStarted = false;
    const speaker = createVoiceSpeaker({ speechService: {
        async generate() { return { success: true, audioId: 'audio_playing' }; },
        play() { playbackStarted = true; return pendingPlayback.promise; },
        async removeTemporary() { return true; },
    }, idFactory: () => 'turn-playing' });
    const events = [];
    speaker.on('voice.speech.cancelled', event => events.push(event));
    speaker.on('voice.speech.completed', event => events.push(event));
    const task = speaker.speak('Se está reproduciendo');
    while (!playbackStarted) await new Promise(resolve => setImmediate(resolve));
    assert.equal(speaker.cancel('user'), true);
    assert.equal(await task, null);
    assert.equal(events[0].phase, 'speaking');
    assert.equal(events[0].playbackInterrupted, false);
    pendingPlayback.resolve({ success: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events.map(event => event.type), ['voice.speech.cancelled']);
});

test('active playback rejects new turns promptly and accepts them after physical playback settles', async () => {
    const pendingPlayback = deferred();
    const calls = [];
    let id = 0;
    const speaker = createVoiceSpeaker({
        idFactory: () => `turn-${++id}`,
        speechService: {
            async generate({ text }) { calls.push(`generate:${text}`); return { success: true, audioId: text }; },
            play(audioId) {
                calls.push(`play:${audioId}`);
                return audioId === 'first' ? pendingPlayback.promise : Promise.resolve({ success: true });
            },
            async removeTemporary() { return true; },
        },
    });
    const events = [];
    speaker.on('voice.speech.cancelled', event => events.push(event));
    speaker.on('voice.speech.completed', event => events.push(event));
    const first = speaker.speak('first');
    while (!calls.includes('play:first')) await new Promise(resolve => setImmediate(resolve));
    assert.equal(speaker.cancel('user'), true);
    await assert.rejects(speaker.speak('second'), error => error.code === 'voice_speech_busy');
    assert.equal(await first, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.includes('play:second'), false);
    pendingPlayback.resolve({ success: true });
    await new Promise(resolve => setImmediate(resolve));
    const second = speaker.speak('second');
    const secondResult = await second;
    assert.deepEqual(secondResult, { sessionId: speaker.sessionId, turnId: 'turn-3', completed: true });
    assert.deepEqual(calls, ['generate:first', 'play:first', 'generate:second', 'play:second']);
    assert.deepEqual(events.map(event => [event.type, event.turnId]), [
        ['voice.speech.cancelled', 'turn-1'],
        ['voice.speech.completed', 'turn-3'],
    ]);
});

test('injected Speech service keeps the Voice speaker usable without loading Core, Electron, or Memory', async () => {
    let generated = false;
    const speaker = createVoiceSpeaker({ speechService: {
        async generate() { generated = true; return { success: true, audioId: 'audio_injected' }; },
        async play() { return { success: true }; },
        async removeTemporary() { return true; },
    } });
    assert.equal((await speaker.speak('Solo servicio inyectado')).completed, true);
    assert.equal(generated, true);
});

test('speaker composes with the real SpeechService using simulated TTS, storage, and playback', async () => {
    const references = new Map();
    const calls = [];
    const store = {
        async initialize() {},
        async save(audio, persist) {
            const audioId = 'audio_simulated';
            references.set(audioId, { audioId, filePath: 'memory://audio', temporary: !persist });
            calls.push(['save', Buffer.from(audio), persist]);
            return { audioId, temporary: !persist, format: 'wav' };
        },
        get(audioId) { return references.get(audioId) ?? null; },
        async isAvailable(audioId) { return references.has(audioId); },
        async removeTemporary(audioId) { return references.delete(audioId); },
        async cleanupCurrentTemporaries() { return { success: true, removed: 0 }; },
    };
    const service = createSpeechService({
        provider: { async synthesize({ text, format }) { calls.push(['synthesize', text, format]); return Buffer.from([1, 2, 3]); } },
        store,
        player: async filePath => { calls.push(['play', filePath]); return { success: true }; },
        voiceIdentityProcessor: { async process(audio) { return Buffer.from(audio); } },
        voiceIdentityEnabled: false,
    });
    const speaker = createVoiceSpeaker({ speechService: service });

    const result = await speaker.speak('Respuesta simulada', { style: 'calm' });
    assert.equal(result.completed, true);
    assert.deepEqual(calls, [
        ['synthesize', 'Respuesta simulada', 'wav'],
        ['save', Buffer.from([1, 2, 3]), false],
        ['play', 'memory://audio'],
    ]);
    assert.equal(references.size, 0, 'the existing SpeechService removes temporary audio after playback');
});

test('late cancelled synthesis removes only temporary output and preserves persistent output', async () => {
    for (const persist of [false, true]) {
        const pending = deferred();
        const removed = [];
        let played = 0;
        const speaker = createVoiceSpeaker({ speechService: {
            generate() { return pending.promise; },
            async play() { played++; return { success: true }; },
            async removeTemporary(id) { removed.push(id); return true; },
        } });
        const task = speaker.speak('late', { persist });
        await new Promise(resolve => setImmediate(resolve));
        speaker.cancel();
        assert.equal(await task, null);
        pending.resolve({ success: true, audioId: `audio_${persist}` });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(removed, persist ? [] : ['audio_false']);
        assert.equal(played, 0);
    }
});

test('never-resolving play times out, degrades the speaker, and rejects later playback without overlap', async () => {
    let plays = 0;
    let generates = 0;
    const speaker = createVoiceSpeaker({ playbackTimeoutMs: 10, speechService: {
        async generate() { generates++; return { success: true, audioId: `audio_${generates}` }; },
        play() { plays++; return new Promise(() => {}); },
        async removeTemporary() { return true; },
    } });
    const events = [];
    speaker.on('voice.speech.error', event => events.push(event));
    await assert.rejects(speaker.speak('bloqueado'), error => error.code === 'voice_speech_playback_timeout');
    assert.equal(speaker.getPlaybackState(), 'degraded');
    await assert.rejects(speaker.speak('siguiente'), error => error.code === 'voice_speech_degraded');
    assert.equal(generates, 1);
    assert.equal(plays, 1);
    assert.deepEqual(events.map(event => [event.turnId, event.error.code]), [[events[0].turnId, 'voice_speech_playback_timeout'], [events[1].turnId, 'voice_speech_degraded']]);
});
