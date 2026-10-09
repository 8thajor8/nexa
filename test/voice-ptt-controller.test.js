import test from 'node:test';
import assert from 'node:assert/strict';
import { createPttVoiceController, createSpeechRecognizer } from '../src/voice/index.js';

const MAX_BYTES = 1_048_576;

function makeWav({ dataBytes = 32_000, sampleRate = 16_000, channels = 1, bitsPerSample = 16,
    encoding = 1, junkBytes = 0 } = {}) {
    const blockAlign = channels * bitsPerSample / 8;
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(encoding, 8);
    fmt.writeUInt16LE(channels, 10);
    fmt.writeUInt32LE(sampleRate, 12);
    fmt.writeUInt32LE(sampleRate * blockAlign, 16);
    fmt.writeUInt16LE(blockAlign, 20);
    fmt.writeUInt16LE(bitsPerSample, 22);

    const junk = junkBytes ? Buffer.alloc(8 + junkBytes) : Buffer.alloc(0);
    if (junkBytes) {
        junk.write('JUNK', 0, 'ascii');
        junk.writeUInt32LE(junkBytes, 4);
    }
    const dataChunk = Buffer.alloc(8 + dataBytes + (dataBytes & 1));
    dataChunk.write('data', 0, 'ascii');
    dataChunk.writeUInt32LE(dataBytes, 4);
    const chunks = Buffer.concat([fmt, junk, dataChunk]);
    const wav = Buffer.alloc(12 + chunks.length);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVE', 8, 'ascii');
    chunks.copy(wav, 12);
    return wav;
}

function deferred() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    return { promise, resolve };
}

async function until(predicate) {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('ptt_test_condition_timeout');
        await new Promise(resolve => setImmediate(resolve));
    }
}

function createController(provider, options = {}) {
    const recognizer = createSpeechRecognizer({ provider });
    return createPttVoiceController({ recognizer, ...options });
}

test('PTT controller accepts one, ten, and thirty second PCM16 mono WAV and preserves Voice turn IDs', async () => {
    const requests = [];
    const events = [];
    const controller = createController({ async transcribe(input) {
        requests.push(input);
        return { text: 'listo', language: 'es' };
    } }, { sessionId: 'ptt-session', onEvent: event => events.push(event) });
    assert.deepEqual(controller.start(), { sessionId: 'ptt-session' });

    for (const seconds of [1, 10, 30]) {
        const result = await controller.transcribe({ audio: makeWav({ dataBytes: seconds * 32_000 }), format: 'wav' });
        assert.equal(result.sessionId, 'ptt-session');
        assert.equal(typeof result.turnId, 'string');
        assert.equal(result.text, 'listo');
        assert.equal(result.language, 'es');
        const transcribing = events.findLast(event => event.type === 'voice.transcribing');
        const final = events.findLast(event => event.type === 'voice.transcript.final');
        assert.equal(transcribing.turnId, result.turnId);
        assert.equal(final.turnId, result.turnId);
        assert.equal(final.sessionId, result.sessionId);
    }
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.format === 'wav' && Buffer.isBuffer(request.audio)));
    assert.deepEqual(events.map(event => event.type), [
        'voice.session.started',
        'voice.transcribing', 'voice.transcript.final',
        'voice.transcribing', 'voice.transcript.final',
        'voice.transcribing', 'voice.transcript.final',
    ]);
});

test('PTT accepts a structurally valid WAV exactly at the 1 MiB limit', async () => {
    const wav = makeWav({ dataBytes: 2, junkBytes: MAX_BYTES - 54 });
    assert.equal(wav.byteLength, MAX_BYTES);
    let calls = 0;
    const controller = createController({ async transcribe() { calls++; return { text: 'ok', language: null }; } });
    controller.start();
    assert.equal((await controller.transcribe({ audio: wav, format: 'wav' })).text, 'ok');
    assert.equal(calls, 1);
});

test('PTT rejects oversize and over-duration audio before calling the recognizer provider', async () => {
    let calls = 0;
    const controller = createController({ async transcribe() { calls++; return { text: 'should not happen' }; } });
    controller.start();
    await assert.rejects(controller.transcribe({ audio: makeWav({ dataBytes: 2, junkBytes: MAX_BYTES - 52 }), format: 'wav' }),
        error => error.code === 'VOICE_PTT_TOO_LARGE');
    await assert.rejects(controller.transcribe({ audio: makeWav({ dataBytes: 960_002 }), format: 'wav' }),
        error => error.code === 'VOICE_PTT_TOO_LONG');
    assert.equal(calls, 0);
});

test('PTT rejects malformed RIFF, chunk boundaries, inconsistent sizes, and unaligned samples', async () => {
    const badFiles = [];
    const fake = makeWav(); fake.write('NOPE', 0, 'ascii'); badFiles.push(fake);
    badFiles.push(makeWav().subarray(0, 100));
    const badRiffLength = makeWav(); badRiffLength.writeUInt32LE(badRiffLength.length, 4); badFiles.push(badRiffLength);
    const badChunkLength = makeWav(); badChunkLength.writeUInt32LE(0xffff_ffff, 40); badFiles.push(badChunkLength);
    badFiles.push(makeWav({ dataBytes: 1 }));
    const missingData = makeWav(); missingData.write('JUNK', 36, 'ascii'); badFiles.push(missingData);

    let calls = 0;
    const controller = createController({ async transcribe() { calls++; return { text: 'no' }; } });
    controller.start();
    for (const audio of badFiles) {
        await assert.rejects(controller.transcribe({ audio, format: 'wav' }), error => error.code === 'VOICE_PTT_INVALID_AUDIO');
    }
    await assert.rejects(controller.transcribe({ audio: 'not bytes', format: 'wav' }), error => error.code === 'VOICE_PTT_INVALID_AUDIO');
    await assert.rejects(controller.transcribe({ audio: Buffer.alloc(0), format: 'wav' }), error => error.code === 'VOICE_PTT_INVALID_AUDIO');
    await assert.rejects(controller.transcribe({ audio: makeWav(), format: 'wav', signal: new AbortController().signal }),
        error => error.code === 'VOICE_PTT_INVALID_AUDIO');
    assert.equal(calls, 0);
});

test('PTT rejects non-PCM, non-mono, and incompatible sample rates as unsupported formats', async () => {
    const invalidProfiles = [
        { encoding: 3 },
        { bitsPerSample: 8 },
        { channels: 2, dataBytes: 64_000 },
        { sampleRate: 44_100 },
    ];
    let calls = 0;
    const controller = createController({ async transcribe() { calls++; return { text: 'no' }; } });
    controller.start();
    for (const profile of invalidProfiles) {
        await assert.rejects(controller.transcribe({ audio: makeWav(profile), format: 'wav' }),
            error => error.code === 'VOICE_PTT_UNSUPPORTED_FORMAT');
    }
    await assert.rejects(controller.transcribe({ audio: makeWav(), format: 'mp3' }),
        error => error.code === 'VOICE_PTT_UNSUPPORTED_FORMAT');
    assert.equal(calls, 0);
});

test('cancellation before provider dispatch aborts STT and resolves the PTT operation with null', async () => {
    let providerCalls = 0;
    const controller = createController({ async transcribe() { providerCalls++; return { text: 'late' }; } });
    controller.start();
    const task = controller.transcribe({ audio: makeWav(), format: 'wav' });
    assert.equal(controller.cancel('user'), true);
    assert.equal(await task, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(providerCalls, 0);
    assert.equal(controller.cancel('user'), false);
});

test('cancellation during STT aborts provider signal and discards its late result', async () => {
    const pending = deferred();
    let signal;
    const events = [];
    const controller = createController({ transcribe(input) { signal = input.signal; return pending.promise; } }, {
        sessionId: 'cancel-session', onEvent: event => events.push(event),
    });
    controller.start();
    const task = controller.transcribe({ audio: makeWav(), format: 'wav' });
    await until(() => signal !== undefined);
    const turnId = events.find(event => event.type === 'voice.transcribing').turnId;
    assert.equal(controller.cancel('user'), true);
    assert.equal(signal.aborted, true);
    assert.equal(await task, null);
    pending.resolve({ text: 'late private transcript', language: 'es' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events.filter(event => event.type === 'voice.cancelled').map(event => [event.sessionId, event.turnId, event.reason]),
        [['cancel-session', turnId, 'user']]);
    assert.equal(events.some(event => event.type === 'voice.transcript.final'), false);
});

test('replacing an STT turn cancels the previous turn and publishes only the new transcript', async () => {
    const old = deferred();
    let calls = 0;
    const events = [];
    const controller = createController({ transcribe() {
        calls++;
        return calls === 1 ? old.promise : Promise.resolve({ text: 'new result', language: null });
    } }, { sessionId: 'replace-session', onEvent: event => events.push(event) });
    controller.start();
    const firstTask = controller.transcribe({ audio: makeWav(), format: 'wav' });
    await until(() => calls === 1);
    const firstTurn = events.find(event => event.type === 'voice.transcribing').turnId;
    const secondTask = controller.transcribe({ audio: makeWav(), format: 'wav' });
    const second = await secondTask;
    assert.equal(await firstTask, null);
    old.resolve({ text: 'stale', language: 'en' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.text, 'new result');
    const finals = events.filter(event => event.type === 'voice.transcript.final');
    assert.equal(finals.length, 1);
    assert.equal(finals[0].turnId, second.turnId);
    const cancellations = events.filter(event => event.type === 'voice.cancelled');
    assert.deepEqual(cancellations.map(event => [event.turnId, event.reason]), [[firstTurn, 'superseded']]);
});

test('PTT exposes safe structured failures and preserves event names and IDs', async () => {
    const events = [];
    const controller = createController({ async transcribe() { throw new Error('token=secret audio=private'); } }, {
        sessionId: 'error-session', onEvent: event => events.push(event),
    });
    controller.start();
    await assert.rejects(controller.transcribe({ audio: makeWav(), format: 'wav' }), error => {
        assert.equal(error.code, 'VOICE_PTT_TRANSCRIPTION_FAILED');
        assert.equal(error.message.includes('secret'), false);
        return true;
    });
    const event = events.find(item => item.type === 'voice.error');
    assert.equal(event.sessionId, 'error-session');
    assert.equal(event.error.code, 'VOICE_PTT_TRANSCRIPTION_FAILED');
    assert.equal(event.error.message.includes('secret'), false);
});

test('PTT start and end are idempotent; ending cancels once and blocks later operations', async () => {
    const pending = deferred();
    let signal;
    const events = [];
    const controller = createController({ transcribe(input) { signal = input.signal; return pending.promise; } }, {
        sessionId: 'end-session', onEvent: event => events.push(event),
    });
    const firstStart = controller.start();
    assert.deepEqual(controller.start(), firstStart);
    const task = controller.transcribe({ audio: makeWav(), format: 'wav' });
    await until(() => signal !== undefined);
    controller.end();
    controller.end();
    assert.equal(await task, null);
    assert.equal(signal.aborted, true);
    assert.equal(events.filter(event => event.type === 'voice.session.started').length, 1);
    assert.equal(events.filter(event => event.type === 'voice.session.ended').length, 1);
    assert.equal(events.filter(event => event.type === 'voice.cancelled').length, 1);
    assert.throws(() => controller.start(), error => error.code === 'VOICE_PTT_INVALID_STATE');
    await assert.rejects(controller.transcribe({ audio: makeWav(), format: 'wav' }), error => error.code === 'VOICE_PTT_INVALID_STATE');
});

test('subscribe is idempotently removable and does not duplicate onEvent delivery', () => {
    const shared = [];
    const other = [];
    const sharedListener = event => shared.push(event.type);
    const controller = createController({ async transcribe() { return { text: '', language: null }; } }, { onEvent: sharedListener });
    const unsubscribeShared = controller.subscribe(sharedListener);
    const unsubscribeOther = controller.subscribe(event => other.push(event.type));
    controller.start();
    unsubscribeShared();
    unsubscribeShared();
    unsubscribeOther();
    controller.end();
    assert.deepEqual(shared, ['voice.session.started', 'voice.session.ended']);
    assert.deepEqual(other, ['voice.session.started']);
});

test('PTT profile does not narrow the general recognizer formats or size limit', async () => {
    let received;
    const recognizer = createSpeechRecognizer({ provider: { async transcribe(input) {
        received = input;
        return { text: 'general format', language: null };
    } } });
    assert.deepEqual(await recognizer.transcribe({ audio: Buffer.from([1]), format: 'mp3' }),
        { text: 'general format', language: null });
    assert.equal(received.format, 'mp3');
    assert.equal(received.audio.byteLength, 1);
});
